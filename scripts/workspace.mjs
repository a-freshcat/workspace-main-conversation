import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const META = '.workspace';
const ACTIVE = new Set(['planned', 'doing', 'blocked']);
const STATES = new Set([...ACTIVE, 'done', 'cancelled']);
const EXCLUDED = new Set(['.git', META, 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__']);
const SCHEMA = 2;
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const present = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const inside = (base, p) => { const rel = path.relative(base, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
function text(value, name, max = 400) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('INVALID', `${name} must be single-line text, max ${max}`);
  return value;
}
function session(value, modifying = false) {
  text(value, 'session', 160);
  if (!value || (modifying && value === 'unknown')) fail('IDENTITY_UNKNOWN', 'Use the actual session id for mutations');
  return value;
}
function taskId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail('INVALID', 'Task id: lowercase letters, digits, hyphens, max 64');
  return value;
}
function noLink(p) {
  if (present(p) && fs.lstatSync(p).isSymbolicLink()) fail('LINK', `Metadata path must not be a link: ${p}`);
}
function metadata(ws, create = false) {
  const root = path.join(ws, META);
  noLink(root);
  if (create) fs.mkdirSync(root, { recursive: true });
  for (const name of ['tasks', 'cache']) {
    const dir = path.join(root, name);
    noLink(dir);
    if (create) fs.mkdirSync(dir, { recursive: true });
  }
  return root;
}
function atomic(p, value) {
  noLink(p);
  const body = typeof value === 'string' ? value : JSON.stringify(value) + '\n';
  if (present(p) && fs.readFileSync(p, 'utf8') === body) return;
  const temp = path.join(path.dirname(p), `.tmp-${randomUUID()}`);
  try { fs.writeFileSync(temp, body, { flag: 'wx' }); fs.renameSync(temp, p); }
  finally { if (present(temp)) fs.unlinkSync(temp); }
}
function locked(ws, action) {
  const root = metadata(ws, true);
  const lock = path.join(root, '.write-lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') fail('BUSY', 'Workspace metadata is busy; retry after the other command finishes'); throw e; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return action(root); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function config(ws) {
  const file = path.join(metadata(ws), 'config.json');
  if (!present(file)) return null;
  noLink(file);
  const c = json(file);
  if (c.schema !== SCHEMA || !Number.isSafeInteger(c.epoch) || c.epoch < 1) fail('SCHEMA', 'Unsupported or malformed workspace config');
  session(c.main, true);
  if (c.workspace !== ws) fail('WORKSPACE_MOVED', 'Workspace location changed; explicitly migrate the registry');
  return c;
}
function needConfig(ws) { const c = config(ws); if (!c) fail('NOT_ENABLED', 'Workspace management has not been enabled'); return c; }
function canonical(ws, value) {
  text(value, 'path', 2048);
  if (!value) fail('INVALID', 'Empty path');
  let p = path.resolve(ws, value);
  const tail = [];
  while (!present(p)) { const parent = path.dirname(p); if (parent === p) break; tail.unshift(path.basename(p)); p = parent; }
  p = path.join(fs.realpathSync(p), ...tail);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
function artifact(ws, value) {
  const p = canonical(ws, value);
  const base = canonical(ws, '.');
  const meta = canonical(ws, META);
  if (!inside(base, p) || p === base || inside(meta, p) || EXCLUDED.has(path.relative(base, p).split(path.sep)[0])) fail('INVALID_DIRECTORY', 'Artifact directory must be inside the workspace, outside metadata/dependency directories');
  return p;
}
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);
function normalizeTask(ws, input, owner) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID', 'Task must be an object');
  const allowed = new Set(['id', 'goal', 'state', 'directory', 'writes', 'next', 'result', 'evidence']);
  if (Object.keys(input).some(k => !allowed.has(k))) fail('INVALID', 'Unknown task fields');
  const id = taskId(input.id);
  const goal = text(input.goal, 'goal');
  if (!goal || !STATES.has(input.state)) fail('INVALID', 'Task requires goal and valid state');
  const directory = artifact(ws, input.directory || `conversations/${id}`);
  if (!Array.isArray(input.writes) || input.writes.length > 64) fail('INVALID', 'writes must be an array of at most 64 paths');
  const writes = [...new Set(input.writes.map(p => canonical(ws, p)))].sort();
  if (writes.some(p => overlaps(p, canonical(ws, META)))) fail('INVALID', 'Declare only task resources; metadata has its own writer');
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 20) fail('INVALID', 'evidence must contain at most 20 references');
  evidence.forEach(e => text(e, 'evidence reference', 1024));
  return { id, owner, goal, state: input.state, directory, writes, next: text(input.next ?? '', 'next'), result: text(input.result ?? '', 'result', 800), evidence };
}
function readTasks(ws) {
  const dir = path.join(metadata(ws), 'tasks');
  if (!present(dir)) fail('REGISTRY_DAMAGED', 'Task registry is missing');
  const entries = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  if (entries.length > 1000) fail('REGISTRY_LIMIT', 'More than 1000 tasks; archive completed records explicitly');
  return entries.map(name => {
    const p = path.join(dir, name); noLink(p);
    if (fs.statSync(p).size > 128 * 1024) fail('REGISTRY_DAMAGED', `Task record too large: ${name}`);
    const r = json(p);
    const { rev, updatedAt, ...input } = r;
    const { owner, ...body } = input;
    session(owner, true);
    const normalized = normalizeTask(ws, body, owner);
    if (normalized.id + '.json' !== name || !Number.isSafeInteger(rev) || rev < 1 || !Number.isFinite(Date.parse(updatedAt))) fail('REGISTRY_DAMAGED', `Invalid task record: ${name}`);
    return { ...normalized, rev, updatedAt };
  });
}
function readClaims(ws) {
  const dir = path.join(metadata(ws), 'claims');
  noLink(dir);
  if (!present(dir)) return [];
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  if (names.length > 1000) fail('REGISTRY_LIMIT', 'Archive completed organization plans explicitly');
  return names.map(name => {
    const file = path.join(dir, name); noLink(file);
    if (fs.statSync(file).size > 256 * 1024) fail('SCHEMA', 'Organization plan too large');
    const c = json(file);
    if (c.schema !== 1 || c.id + '.json' !== name || !Array.isArray(c.entries) || c.entries.length > 50 || !Number.isSafeInteger(c.rev) || c.rev < 1 || !['proposed','accepted','copying','copied','complete','cancelled'].includes(c.status)) fail('SCHEMA', 'Invalid organization plan');
    taskId(c.id); taskId(c.task); session(c.owner, true);
    return c;
  });
}
function alertsFor(tasks, claims = []) {
  const alerts = [];
  for (let a = 0; a < tasks.length; a++) for (let b = a + 1; b < tasks.length; b++) {
    const x = tasks[a], y = tasks[b];
    if (overlaps(x.directory, y.directory)) alerts.push({ type: 'directory_overlap', tasks: [x.id, y.id], path: x.directory });
    if (!ACTIVE.has(x.state) || !ACTIVE.has(y.state)) continue;
    for (const p of x.writes) for (const q of y.writes) if (overlaps(p, q)) alerts.push({ type: 'resource_overlap', tasks: [x.id, y.id], path: p, otherPath: q });
  }
  for (const c of claims.filter(c => !['complete','cancelled'].includes(c.status))) {
    for (const t of tasks.filter(t => t.id !== c.task && ACTIVE.has(t.state))) {
      for (const e of c.entries) for (const p of t.writes) if (overlaps(p, e.source) || overlaps(p, e.target)) alerts.push({ type: 'organization_resource_overlap', tasks: [c.task,t.id], plan: c.id, path: p });
    }
  }
  return alerts;
}
/**
 * Directories that carry a `.session-id` marker but belong to no registered task.
 *
 * The marker is the skill's own claim of authorship (`task` writes it when it
 * adopts a directory), so a marked-but-unregistered directory is a conversation
 * that has written into this workspace WITHOUT registering — the exact blind spot
 * that let three sibling conversations build 90+ files, invisible to the
 * coordinator, until someone ran `ls`. `context` alone could never surface them:
 * it reads the registry, and an unregistered conversation has no registry entry
 * to read.
 *
 * Deliberately keyed on the marker, not on "a directory exists": ordinary
 * project directories (`src/`, `docs/`) must never be reported, and a name or
 * mtime is not ownership. Excluded roots and links are skipped for the same
 * reason the file scan skips them.
 *
 * @returns Unregistered claims, each naming the directory, the session in its
 *   marker, and how many files it holds.
 */
function unregisteredDirectories(ws, tasks) {
  const base = canonical(ws, '.');
  const registered = tasks.map(t => t.directory);
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 4 || found.length >= 50) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= 50) return;
      if (!entry.isDirectory()) continue;
      if (EXCLUDED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      // A registered directory and everything above/below it is accounted for.
      if (registered.some(r => overlaps(r, full))) continue;
      const marker = path.join(full, '.session-id');
      if (present(marker)) {
        try {
          if (fs.lstatSync(marker).isSymbolicLink()) continue;
          if (fs.lstatSync(marker).size > 1024) continue;
          const owner = fs.readFileSync(marker, 'utf8').trim();
          if (owner) {
            found.push({ path: portable(ws, full), owner, files: countFilesShallow(full) });
            continue; // one alert per marked directory; its children are its own
          }
        } catch { /* unreadable marker is not a claim */ }
      }
      walk(full, depth + 1);
    }
  };
  walk(base, 0);
  return found;
}
/** Count regular files below a directory, bounded so one huge tree cannot stall `context`. */
function countFilesShallow(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 8 || total >= 5000) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (total >= 5000) return;
      if (entry.isDirectory()) { if (!EXCLUDED.has(entry.name)) walk(path.join(d, entry.name), depth + 1); }
      else total += 1;
    }
  };
  walk(dir, 0);
  return total;
}
function snapshot(ws) {
  const c = needConfig(ws), tasks = readTasks(ws), claims = readClaims(ws);
  return { config: c, tasks, claims, alerts: alertsFor(tasks, claims), unregistered: unregisteredDirectories(ws, tasks) };
}
export function inspectWorkspace(workspace) {
  const ws = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(ws).isDirectory()) fail('INVALID', 'Workspace must be a directory');
  return { workspace: ws, ...(config(ws) ? snapshot(ws) : { config: null, tasks: [], claims: [], alerts: [] }) };
}
export function coordinate(workspace, action) {
  const ws = fs.realpathSync(path.resolve(workspace));
  return locked(ws, root => action({ workspace: ws, root, ...snapshot(ws) }));
}
function page(items, options) {
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 5);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('INVALID', 'offset >= 0, limit between 1 and 20');
  const next = Math.min(items.length, offset + limit);
  return { total: items.length, items: items.slice(offset, next), more: next < items.length, ...(next < items.length ? { nextOffset: next } : {}) };
}
const portable = (ws, p) => inside(canonical(ws, '.'), p) ? path.relative(canonical(ws, '.'), p).split(path.sep).join('/') : p;
function brief(ws, t) { return { id: t.id, owner: t.owner, rev: t.rev, state: t.state, goal: t.goal, directory: portable(ws, t.directory), next: t.next, ...(t.result ? { result: t.result } : {}) }; }
function context(ws, options) {
  const who = session(options.session ?? 'unknown');
  if (!config(ws)) return { schema: SCHEMA, role: 'unknown', enabled: false, legacy: present(path.join(ws, 'sum.md')) || present(path.join(ws, 'main.md')), action: 'Continue the user task; init requires an explicit coordinator assignment' };
  return locked(ws, root => {
    const s = snapshot(ws), role = who === s.config.main ? 'main' : who === 'unknown' ? 'unknown' : 'child';
    const ownIds = new Set(s.tasks.filter(t => t.owner === who).map(t => t.id));
    const ordered = s.tasks.filter(t => role === 'main' || ownIds.has(t.id)).sort((a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || a.id.localeCompare(b.id));
    const view = { epoch: s.config.epoch, role, tasks: ordered.map(t => brief(ws, t)), alerts: s.alerts.filter(a => role === 'main' || a.tasks.some(id => ownIds.has(id))) };
    // An unregistered claim is addressed to its OWN conversation: that child can
    // act on it (register, or say why the directory is not its business), and no
    // one else can. The coordinator sees all of them because chasing them down
    // is its job; `main` never registers on a child's behalf.
    const unregistered = role === 'main' ? s.unregistered : s.unregistered.filter(u => u.owner === who);
    if (unregistered.length) view.unregistered = unregistered;
    const pending = s.claims.filter(c => !['complete','cancelled'].includes(c.status) && (role === 'main' || c.owner === who)).map(c => ({ id: c.id, task: c.task, owner: c.owner, status: c.status, count: c.entries.length, rev: c.rev }));
    if (pending.length) view.claims = pending;
    const stamp = sha(view).slice(0, 24);
    if (options.since === stamp) return { stamp, noChanges: true, scope: 'declared-metadata' };
    const cache = path.join(root, 'cache', sha(who) + '.json');
    let history = [];
    if (present(cache)) { noLink(cache); try {
      history = json(cache);
      history = Array.isArray(history) ? history.filter(h => h && h.view && Array.isArray(h.view.tasks) && Array.isArray(h.view.alerts) && h.stamp === sha(h.view).slice(0, 24)) : [];
    } catch { history = []; } }
    const previous = options.since ? history.find(h => h.stamp === options.since)?.view : null;
    const changed = (now, before, key) => now.filter(n => !before.some(b => key(n) === key(b) && sha(n) === sha(b)));
    const tasks = previous ? changed(view.tasks, previous.tasks, t => t.id) : view.tasks;
    const alerts = previous ? changed(view.alerts, previous.alerts, sha) : view.alerts;
    const removedTasks = previous ? previous.tasks.filter(t => !view.tasks.some(n => n.id === t.id)).map(t => t.id) : [];
    const resolvedAlerts = previous ? previous.alerts.filter(a => !view.alerts.some(n => sha(n) === sha(a))) : [];
    const claims = previous ? changed(view.claims || [], previous.claims || [], c => c.id) : view.claims || [];
    const resolvedClaims = previous ? (previous.claims || []).filter(c => !(view.claims || []).some(n => n.id === c.id)).map(c => c.id) : [];
    const unregisteredDelta = previous ? changed(view.unregistered || [], previous.unregistered || [], u => u.path) : view.unregistered || [];
    const registeredDirs = previous ? (previous.unregistered || []).filter(u => !(view.unregistered || []).some(n => n.path === u.path)).map(u => u.path) : [];
    history = [{ stamp, view }, ...history.filter(h => h.stamp !== stamp)].slice(0, 2);
    atomic(cache, history);
    return { stamp, role, epoch: view.epoch, mode: previous ? 'delta' : 'snapshot', ...(options.since && !previous ? { reset: true } : {}), scope: 'declared-metadata', taskCount: view.tasks.length, alertCount: view.alerts.length, tasks: page(tasks, options), alerts: page(alerts, options), removedTasks: page(removedTasks, options), resolvedAlerts: page(resolvedAlerts, options), ...(view.unregistered ? { unregisteredCount: view.unregistered.length, unregistered: page(unregisteredDelta, options), ...(registeredDirs.length ? { registeredDirectories: page(registeredDirs, options) } : {}) } : {}), ...(pending.length || resolvedClaims.length ? { claims: page(claims,options), resolvedClaims: page(resolvedClaims,options) } : {}) };
  });
}
function register(ws, options) {
  const who = session(options.session, true);
  if (!options.file) fail('INVALID', 'task requires --file');
  const input = json(path.resolve(options.file));
  return locked(ws, root => {
    const s = snapshot(ws), current = normalizeTask(ws, input, who);
    const old = s.tasks.find(t => t.id === current.id);
    if (old && old.owner !== who) fail('OWNER_MISMATCH', 'Task belongs to another session');
    if (old && String(old.rev) !== options['expect-rev']) fail('REVISION_MISMATCH', 'Pass the latest --expect-rev', { actualRev: old.rev });
    if (!old && options['expect-rev'] !== undefined) fail('REVISION_MISMATCH', 'New task has no prior revision');
    if (old && old.directory !== current.directory) fail('DIRECTORY_CHANGED', 'Task artifact directory is stable; explicitly migrate instead');
    const { rev: _r, updatedAt: _u, ...oldBody } = old || {};
    if (old && sha(oldBody) === sha(current)) return { id: old.id, rev: old.rev, noChanges: true };
    const others = s.tasks.filter(t => t.id !== current.id);
    const clashes = alertsFor([...others, current], s.claims).filter(a => a.tasks.includes(current.id));
    if (clashes.length) fail('RESOURCE_CONFLICT', 'Declared resources overlap another task', page(clashes, options));
    const sid = path.join(current.directory, '.session-id');
    if (present(current.directory)) {
      if (!fs.statSync(current.directory).isDirectory()) fail('INVALID_DIRECTORY', 'Artifact path is not a directory');
      noLink(sid);
      if (present(sid) && fs.readFileSync(sid, 'utf8').trim() !== who) fail('OWNER_MISMATCH', 'Artifact directory has another owner');
      if (!present(sid) && fs.readdirSync(current.directory).length && !options.adopt) fail('ADOPTION_REQUIRED', 'Existing nonempty directory needs confirmed ownership and --adopt');
    }
    fs.mkdirSync(current.directory, { recursive: true });
    if (!present(sid)) fs.writeFileSync(sid, who + '\n', { flag: 'wx' });
    const record = { ...current, rev: (old?.rev ?? 0) + 1, updatedAt: new Date().toISOString() };
    atomic(path.join(root, 'tasks', current.id + '.json'), record);
    return { id: record.id, rev: record.rev, state: record.state, directory: portable(ws, record.directory) };
  });
}

function scanFiles(ws, tasks) {
  const files = [], issues = [], seen = new Set();
  let bytes = 0, stopped = false;
  const budget = { files: 5000, fileBytes: 16 * 1024 * 1024, bytes: 64 * 1024 * 1024 };
  function visit(p, explicit = false) {
    if (stopped) return;
    const label = portable(ws, p);
    if (seen.has(p)) return;
    seen.add(p);
    if (seen.size > 20000 || files.length >= budget.files || bytes >= budget.bytes) { issues.push({ type: 'scan_limit', path: label }); stopped = true; return; }
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { issues.push({ type: 'link_not_scanned', path: label }); return; }
      if (st.isDirectory()) {
        if (!explicit && EXCLUDED.has(path.basename(p))) return;
        for (const e of fs.readdirSync(p).sort()) { if (stopped) break; visit(path.join(p, e)); }
      } else if (st.isFile()) {
        if (st.size > budget.fileBytes || bytes + st.size > budget.bytes) { issues.push({ type: 'file_size_limit', path: label }); return; }
        const content = fs.readFileSync(p), after = fs.lstatSync(p);
        bytes += content.length;
        if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ino !== after.ino) issues.push({ type: 'changed_during_scan', path: label });
        files.push({ path: label, hash: sha(content) });
      } else issues.push({ type: 'special_file_not_scanned', path: label });
    } catch (e) { issues.push({ type: e.code === 'ENOENT' ? 'missing_path' : 'read_error', path: label, code: e.code ?? 'ERROR' }); }
  }
  for (const task of tasks) {
    if (stopped) break;
    const sid = path.join(task.directory, '.session-id');
    try { noLink(sid); if (fs.readFileSync(sid, 'utf8').trim() !== task.owner) issues.push({ type: 'owner_mismatch', task: task.id }); }
    catch { issues.push({ type: 'owner_unknown', task: task.id }); }
    visit(task.directory, true);
    for (const p of task.writes) visit(p, true);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, issues, bytes, complete: issues.length === 0, scope: 'registered-directories-and-writes' };
}
function compareFiles(before, after) {
  const old = new Map(before.map(f => [f.path, f.hash])), now = new Map(after.map(f => [f.path, f.hash]));
  return [...new Set([...old.keys(), ...now.keys()])].sort().filter(p => old.get(p) !== now.get(p)).map(p => ({ path: p, change: !old.has(p) ? 'added' : !now.has(p) ? 'deleted' : 'modified' }));
}
function checked(ws) {
  const s = snapshot(ws), scan = scanFiles(ws, s.tasks);
  const baselinePath = path.join(metadata(ws), 'summary.json');
  let baseline = null;
  if (present(baselinePath)) { noLink(baselinePath); baseline = json(baselinePath); if (baseline.schema !== SCHEMA || !Array.isArray(baseline.files) || typeof baseline.summaryHash !== 'string') fail('SCHEMA', 'Invalid summary baseline'); }
  const stateHash = sha(s);
  const changes = baseline ? compareFiles(baseline.files, scan.files) : [];
  const alerts = [...s.alerts, ...scan.issues];
  if (!baseline) alerts.push({ type: 'baseline_missing' });
  else {
    if (baseline.stateHash !== stateHash) alerts.push({ type: 'summary_metadata_stale' });
    try {
      const sum = path.join(ws, 'sum.md'); noLink(sum);
      if (sha(fs.readFileSync(sum)) !== baseline.summaryHash) alerts.push({ type: 'summary_content_changed' });
    } catch { alerts.push({ type: 'summary_missing_or_unreadable' }); }
  }
  if (changes.length) alerts.push({ type: 'summary_files_stale', count: changes.length });
  return { s, scan, changes, alerts, stateHash };
}
function check(ws, options) {
  if (!config(ws)) return { ok: false, complete: false, alerts: page([{ type: 'not_enabled' }], options) };
  return locked(ws, () => {
    const r = checked(ws);
    return { ok: r.alerts.length === 0, complete: r.scan.complete, scope: r.scan.scope, fileCount: r.scan.files.length, bytesRead: r.scan.bytes, alerts: page(r.alerts, options), changes: page(r.changes, options) };
  });
}
function summarize(ws, options) {
  const who = session(options.session, true);
  return locked(ws, root => {
    const r = checked(ws);
    if (who !== r.s.config.main) fail('NOT_MAIN', 'Only the current main session can generate sum.md');
    if (!r.scan.complete || r.s.alerts.length) fail('INCOMPLETE', 'Resolve scan issues and resource conflicts before establishing a baseline', page([...r.s.alerts, ...r.scan.issues], options));
    const sum = path.join(ws, 'sum.md'), marker = '<!-- workspace-main-conversation:v2 -->';
    noLink(sum);
    if (present(sum) && !fs.readFileSync(sum, 'utf8').startsWith(marker)) fail('LEGACY_SUMMARY', 'Keep or move the existing manual/v1 sum.md before generating v2');
    const escape = s => String(s).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
    const rows = r.s.tasks.map(t => `| ${[t.id, t.owner, t.state, t.goal, portable(ws, t.directory), t.rev].map(escape).join(' | ')} |`);
    const body = [marker, '# 工作区统筹', '', `主对话：${who}；交接版本：${r.s.config.epoch}`, '', '| 任务 | 对话 | 状态 | 目标 | 产物 | 版本 |', '|---|---|---|---|---|---|', ...rows, '', `声明资源检查：无重叠；扫描 ${r.scan.files.length} 个文件。`, '检查范围与排除项见 skill 命令参考；本页不代表未登记活动已被检查。', '详细结果见 .workspace/tasks/；修改本页请通过 summary 命令。', ''].join('\n');
    atomic(sum, body);
    atomic(path.join(root, 'summary.json'), { schema: SCHEMA, stateHash: r.stateHash, summaryHash: sha(body), files: r.scan.files });
    return { summary: 'sum.md', taskCount: r.s.tasks.length, fileCount: r.scan.files.length, complete: true };
  });
}
function init(ws, options) {
  const who = session(options.session, true);
  return locked(ws, root => {
    const c = config(ws);
    if (c) { if (c.main !== who) fail('MAIN_EXISTS', 'Another coordinator already exists'); return { main: c.main, epoch: c.epoch, noChanges: true }; }
    if (!options['ack-legacy'] && ['sum.md', 'main.md'].some(n => present(path.join(ws, n)))) fail('LEGACY_WORKSPACE', 'Read migration reference and pass --ack-legacy after explicit appointment');
    atomic(path.join(root, 'config.json'), { schema: SCHEMA, workspace: ws, main: who, epoch: 1 });
    return { enabled: true, main: who, epoch: 1 };
  });
}
function handoff(ws, options) {
  const who = session(options.session, true), next = session(options.to, true);
  return locked(ws, root => {
    const c = needConfig(ws);
    if (c.main !== who) fail('NOT_MAIN', 'Only the current coordinator can hand off');
    if (String(c.epoch) !== options['expect-epoch']) fail('EPOCH_MISMATCH', 'Pass the current --expect-epoch');
    atomic(path.join(root, 'config.json'), { ...c, main: next, epoch: c.epoch + 1 });
    return { main: next, epoch: c.epoch + 1 };
  });
}
function owners(ws, options) {
  if (!config(ws)) return { ok: false, scope: 'registered-directories', issues: page([{ type: 'not_enabled' }], options) };
  return locked(ws, () => {
    const tasks = readTasks(ws), rows = [], issues = [];
    for (const t of tasks) {
      const sid = path.join(t.directory, '.session-id');
      let observed = null;
      try { noLink(sid); observed = fs.readFileSync(sid, 'utf8').trim(); } catch { }
      rows.push({ task: t.id, directory: portable(ws, t.directory), owner: t.owner, verified: observed === t.owner });
      if (observed !== t.owner) issues.push({ type: observed ? 'owner_mismatch' : 'owner_unknown', task: t.id });
    }
    return { ok: !issues.length, scope: 'registered-directories', owners: page(rows, options), issues: page(issues, options) };
  });
}
const HELP = 'Commands: init, task, context, detail, owners, check, summary, handoff. See references/commands.md; common: --workspace PATH --session ID. context/check: --limit 1..20 --offset N.';
function parse(argv) {
  const command = argv[0], options = {};
  const flags = new Set(['adopt', 'ack-legacy']);
  const allowed = new Set(['workspace', 'session', 'to', 'file', 'task', 'since', 'expect-rev', 'expect-epoch', 'limit', 'offset', ...flags]);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!allowed.has(key) || key in options) fail('INVALID', 'Unknown or repeated option: ' + argv[i]);
    if (flags.has(key)) options[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID', 'Missing value: ' + key); options[key] = argv[++i]; }
  }
  return { command, options };
}
export function execute(argv) {
  if (!argv.length || argv[0] === '--help') return { help: HELP };
  const { command, options } = parse(argv);
  if (!options.workspace) fail('INVALID', '--workspace is required');
  const ws = fs.realpathSync(path.resolve(options.workspace));
  if (!fs.statSync(ws).isDirectory()) fail('INVALID', 'Workspace must be an existing directory');
  switch (command) {
    case 'init': return init(ws, options);
    case 'task': return register(ws, options);
    case 'context': return context(ws, options);
    case 'detail': {
      return locked(ws, () => {
        const t = snapshot(ws).tasks.find(t => t.id === taskId(options.task));
        if (!t) fail('NOT_FOUND', 'Task not found');
        return t;
      });
    }
    case 'owners': return owners(ws, options);
    case 'check': return check(ws, options);
    case 'summary': return summarize(ws, options);
    case 'handoff': return handoff(ws, options);
    default: fail('INVALID', HELP);
  }
}
export function cli(argv = process.argv.slice(2)) {
  try {
    const result = execute(argv);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (e) {
    console.error(JSON.stringify({ error: e.code || 'ERROR', message: e.message, ...(e.details ? { details: e.details } : {}) }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
