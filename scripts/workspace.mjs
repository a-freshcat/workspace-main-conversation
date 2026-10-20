import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sessionRecords } from './session-records.mjs';

const META = '.workspace';
const ACTIVE = new Set(['planned', 'doing', 'blocked']);
const STATES = new Set([...ACTIVE, 'done', 'cancelled']);
const EXCLUDED = new Set(['.git', META, 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__']);
const SCHEMA = 2;
const OWNED = new Set(['sum.md', 'main.md']);
// Files/directories that mean "this workspace root is itself a project", not an
// empty lot where conversations park their artifacts. The distinction decides
// the default layout: a project root must not be littered with per-conversation
// directories, because its build tools, relative paths and IDE config all point
// at the root.
const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml', 'build.gradle', 'CMakeLists.txt', 'composer.json', 'Gemfile', 'Makefile', '.git'];
const PROJECT_DIRS = ['src', 'lib', 'app', 'tests', 'test', 'docs', 'cmd', 'pkg'];
// The container used for conversation artifacts in a project-shaped workspace.
// Chosen so a project root keeps exactly one extra entry regardless of how many
// conversations work in it, and so the per-task directory name does not repeat
// the container's meaning (no `conversations/conversation-x`).

/**
 * Is this workspace root an empty lot or a project?
 *
 * The skill's own rule ("do not treat the repository root as your artifact
 * directory") assumed the root was empty ground. A project-shaped workspace
 * breaks that assumption: its root legitimately holds src/, tests/ and a
 * manifest, so flat per-conversation directories have to interleave with them.
 * Detecting the shape is what lets the default layout be right for both.
 *
 * @returns The detected shape, the evidence for it, and how many conversation
 *   directories already sit directly in the root.
 */
function shapeOf(ws) {
  const markers = PROJECT_MARKERS.filter(n => present(path.join(ws, n)));
  const dirs = PROJECT_DIRS.filter(n => { const f = path.join(ws, n); try { return present(f) && fs.statSync(f).isDirectory(); } catch { return false; } });
  const project = markers.length > 0 || dirs.length > 0;
  const loose = conversationDirectories(ws);
  // A project does not have to sit in the workspace root. Conversations commonly
  // keep a whole project inside their own artifact directory, and reporting that
  // as "vacant" told the next reader the opposite of the truth: that the root was
  // empty ground where anything could be created. One level is enough to tell
  // the two apart, and it is the level the registry already names.
  const nested = loose.map(d => ({ directory: d, evidence: projectEvidence(d) })).filter(x => x.evidence.length);
  const shape = project ? (loose.length ? 'mixed' : 'project') : nested.length ? 'per-conversation-projects' : 'vacant';
  return {
    shape,
    evidence: [...markers, ...dirs.map(d => d + '/')],
    flatConversationDirectories: loose.map(d => portable(ws, d)),
    ...(nested.length ? { conversationProjects: nested.map(x => ({ directory: portable(ws, x.directory), evidence: x.evidence })) } : {}),
  };
}
/** Project markers found directly inside one directory. */
function projectEvidence(dir) {
  const out = PROJECT_MARKERS.filter(n => present(path.join(dir, n)));
  for (const n of PROJECT_DIRS) {
    const f = path.join(dir, n);
    try { if (present(f) && fs.statSync(f).isDirectory()) out.push(n + '/'); } catch { /* ignore */ }
  }
  return out;
}
/** Directories in the workspace root that look like a conversation artifact dir. */
function conversationDirectories(ws) {
  const base = canonical(ws, '.');
  const found = [];
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUDED.has(e.name) || e.name === META) continue;
    const full = path.join(base, e.name);
    if (present(path.join(full, '.session-id'))) found.push(full);
  }
  return found;
}
/** Configured artifact container, or null when artifacts are flat in the root. */
function artifactRoot(ws) {
  const c = config(ws);
  return c && typeof c.artifacts === 'string' && c.artifacts ? c.artifacts : null;
}
/** Workspace-relative container name must stay a plain directory name. */
function artifactContainer(value) {
  text(value, 'artifacts', 64);
  const name = value.replace(/\\/g, '/');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..' || EXCLUDED.has(name) || name === META) fail('INVALID', 'Artifact container must be a single plain directory name');
  return name;
}
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const present = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const inside = (base, p) => { const rel = path.relative(base, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
function text(value, name, max = 400) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('INVALID', `${name} must be single-line text, max ${max}`);
  return value;
}
// The only authoritative source for "which conversation am I" is the variable
// the DSH runtime exports into its shell. It is NOT visible to every executor:
// `pwsh` receives it, `ops_bash` does not (the bash IPC layer is handed a bare
// PATH). So a caller that probed `env` from bash sees nothing and is tempted to
// pass `unknown` — which is exactly the state this fallback removes. Reading it
// here means the id still resolves when the caller forgot to pass one, instead
// of relying on the conversation to know which tool exposes it.
const ENV_SESSION = 'DSH_SESSION_ID';
function envSession(env) {
  const value = env?.[ENV_SESSION];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[\x21-\x7e]{1,160}$/.test(trimmed) ? trimmed : undefined;
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
  if (c.artifacts !== undefined && c.artifacts !== null) artifactContainer(c.artifacts);
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
/**
 * Default artifact directory for a task, flat in the workspace root.
 *
 * Deriving it from the id keeps the default predictable and self-describing:
 * `fix-export` becomes `conversation-fix-export`. Callers that want a dated
 * name pass `directory` explicitly; this only removes the old
 * `conversations/<id>` wrapper, which no rule depended on.
 */
function defaultDirectory(id, root) { return root ? `${root}/${id}` : id; }
function normalizeTask(ws, input, owner) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID', 'Task must be an object');
  const allowed = new Set(['id', 'goal', 'state', 'directory', 'writes', 'next', 'result', 'evidence', 'lastActor', 'lastReason']);
  if (Object.keys(input).some(k => !allowed.has(k))) fail('INVALID', 'Unknown task fields');
  const id = taskId(input.id);
  const goal = text(input.goal, 'goal');
  if (!goal || !STATES.has(input.state)) fail('INVALID', 'Task requires goal and valid state');
  // The default artifact directory sits flat in the workspace root, named after
  // the task, e.g. `conversation-2026-10-19-fix-export`. It used to be
  // `conversations/<id>`, which added a container level that bought nothing: the
  // workspace root is the shared surface every conversation reads (`ls`), and a
  // wrapper merely pushed the per-conversation directories one level out of it.
  // One conversation, one directory, directly visible -- that is the whole point
  // of the registry. See `references/commands.md` for the naming convention.
  const directory = artifact(ws, input.directory || defaultDirectory(id, artifactRoot(ws)));
  if (!Array.isArray(input.writes) || input.writes.length > 64) fail('INVALID', 'writes must be an array of at most 64 paths');
  const writes = [...new Set(input.writes.map(p => canonical(ws, p)))].sort();
  if (writes.some(p => overlaps(p, canonical(ws, META)))) fail('INVALID', 'Declare only task resources; metadata has its own writer');
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 20) fail('INVALID', 'evidence must contain at most 20 references');
  evidence.forEach(e => text(e, 'evidence reference', 1024));
  const lastActor = input.lastActor === undefined ? '' : text(input.lastActor, 'lastActor', 160);
  const lastReason = input.lastReason === undefined ? '' : text(input.lastReason, 'lastReason', 400);
  return { id, owner, goal, state: input.state, directory, writes, next: text(input.next ?? '', 'next'), result: text(input.result ?? '', 'result', 800), evidence, ...(lastActor ? { lastActor, lastReason } : {}) };
}
function readTasks(ws) {
  const dir = path.join(metadata(ws), 'tasks');
  if (!present(dir)) fail('REGISTRY_DAMAGED', 'Task registry is missing');
  const entries = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  if (entries.length > 1000) fail('REGISTRY_LIMIT', 'More than 1000 tasks; archive completed records explicitly');
  return entries.map(name => {
    const p = path.join(dir, name); noLink(p);
    if (fs.statSync(p).size > 128 * 1024) fail('REGISTRY_DAMAGED', `Task record too large: ${name}`);
    const record = storedTask(ws, json(p));
    if (record.id + '.json' !== name) fail('REGISTRY_DAMAGED', `Invalid task record: ${name}`);
    return record;
  });
}
function storedTask(ws, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('REGISTRY_DAMAGED', 'Invalid task record');
  const { rev, updatedAt, owner, ...body } = r;
  session(owner, true);
  const normalized = normalizeTask(ws, body, owner);
  if (!Number.isSafeInteger(rev) || rev < 1 || !Number.isFinite(Date.parse(updatedAt))) fail('REGISTRY_DAMAGED', 'Invalid task revision or timestamp');
  return { ...normalized, rev, updatedAt };
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
    // A finished task releases what it claimed, its directory included. Gating
    // only `resource_overlap` left `directory_overlap` behind, so "cancel the
    // task, then claim that directory properly" — the obvious repair for a
    // directory chosen wrongly — stayed blocked by a permanent alert on two
    // records that no longer do any work.
    if (!ACTIVE.has(x.state) || !ACTIVE.has(y.state)) continue;
    if (overlaps(x.directory, y.directory)) alerts.push({ type: 'directory_overlap', tasks: [x.id, y.id], path: x.directory });
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
 * that left unregistered work invisible to the coordinator until someone
 * inspected the workspace manually. `context` alone could never surface it:
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
  const recovery = pendingRecovery(ws);
  return { config: c, tasks, claims, recovery, alerts: [...alertsFor(tasks, claims), ...(recovery ? [{ type: 'recovery_pending', tasks: [recovery.task], recovery: recovery.id }] : [])], unregistered: unregisteredDirectories(ws, tasks) };
}
export function inspectWorkspace(workspace) {
  const ws = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(ws).isDirectory()) fail('INVALID', 'Workspace must be a directory');
  return { workspace: ws, ...(config(ws) ? snapshot(ws) : { config: null, tasks: [], claims: [], alerts: [] }) };
}
export function coordinate(workspace, action) {
  const ws = fs.realpathSync(path.resolve(workspace));
  return locked(ws, root => { const s = snapshot(ws); requireNoRecovery(s); return action({ workspace: ws, root, ...s }); });
}
function page(items, options) {
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 5);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('INVALID', 'offset >= 0, limit between 1 and 20');
  const next = Math.min(items.length, offset + limit);
  return { total: items.length, items: items.slice(offset, next), more: next < items.length, ...(next < items.length ? { nextOffset: next } : {}) };
}
const portable = (ws, p) => inside(canonical(ws, '.'), p) ? path.relative(canonical(ws, '.'), p).split(path.sep).join('/') : p;
function brief(ws, t) { return { id: t.id, owner: t.owner, rev: t.rev, state: t.state, goal: t.goal, directory: portable(ws, t.directory), next: t.next, ...(t.result ? { result: t.result } : {}) }; }
// A role of `unknown` used to render as `taskCount: 0`, which is byte-identical
// to "this conversation has nothing registered" — so a child that could not
// read its id saw a clean bill of health and did nothing. The state is not
// normal, and the output now says so where the caller is already looking.
const IDENTITY_HINT = 'Pass the current conversation id explicitly. In DSH, use the runtime DSH_SESSION_ID (the CLI reads it automatically in its provided pwsh environment); in Codex, use the current task thread id with the `codex:` prefix. Do not launch PowerShell from another executor to search for DSH_SESSION_ID or guess an id from a title. Until the current id is known this view cannot tell your tasks from another conversation\'s, and nothing may be registered or claimed.';
function identity(who) {
  return who === 'unknown'
    ? { status: 'unknown', hint: IDENTITY_HINT }
    : { status: 'resolved' };
}
function ownerRecords(s, options) {
  const owners = [...new Set(s.tasks.filter(t => ACTIVE.has(t.state) && t.owner !== s.config.main).map(t => t.owner))];
  if (!options['sessions-home']) return { status: 'not-configured', scope: 'session-record-presence', owners: [], issues: [] };
  text(options['sessions-home'], 'sessions-home', 2048);
  return sessionRecords(options['sessions-home'], owners);
}
function checkSessions(ws, options) {
  const who = session(options.session, true);
  needConfig(ws);
  return locked(ws, () => {
    const s = snapshot(ws);
    if (s.config.main !== who) fail('NOT_MAIN', 'Only the current coordinator can inspect all task owners');
    if (!options['sessions-home']) fail('SESSION_SOURCE_REQUIRED', 'Pass --sessions-home DSH_HOME; missing records are not proof of deletion');
    const r = ownerRecords(s, options);
    return { ...r, owners: page(r.owners.map(o => ({ ...o, tasks: s.tasks.filter(t => ACTIVE.has(t.state) && t.owner === o.owner).map(t => t.id) })), options), issues: page(r.issues, options) };
  });
}
function context(ws, options) {
  const who = session(options.session ?? 'unknown');
  if (!config(ws)) return { schema: SCHEMA, role: 'unknown', enabled: false, legacy: present(path.join(ws, 'sum.md')) || present(path.join(ws, 'main.md')), action: 'Continue the user task; init requires an explicit coordinator assignment' };
  return locked(ws, root => {
    const s = snapshot(ws), role = who === s.config.main ? 'main' : who === 'unknown' ? 'unknown' : 'child';
    const ownIds = new Set(s.tasks.filter(t => t.owner === who).map(t => t.id));
    const ordered = s.tasks.filter(t => role === 'main' || ownIds.has(t.id)).sort((a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || a.id.localeCompare(b.id));
    const view = { epoch: s.config.epoch, role, tasks: ordered.map(t => brief(ws, t)), alerts: s.alerts.filter(a => role === 'main' || a.tasks.some(id => ownIds.has(id))) };
    if (role === 'main' && s.tasks.some(t => ACTIVE.has(t.state) && t.owner !== who)) {
      const { owners, issues, ...checked } = ownerRecords(s, options);
      view.sessionCheck = checked;
      for (const o of owners.filter(o => o.status === 'record_missing')) view.alerts.push({ type: 'owner_record_missing', owner: o.owner, tasks: s.tasks.filter(t => ACTIVE.has(t.state) && t.owner === o.owner).map(t => t.id) });
      if (checked.complete === false) view.alerts.push({ type: 'session_check_incomplete', tasks: [], issues: issues.map(i => i.type) });
    }
    // An unregistered claim is addressed to its OWN conversation: that child can
    // act on it (register, or say why the directory is not its business), and no
    // one else can. The coordinator sees all of them because chasing them down
    // is its job; `main` never registers on a child's behalf.
    const unregistered = role === 'main' ? s.unregistered : s.unregistered.filter(u => u.owner === who);
    if (unregistered.length) view.unregistered = unregistered;
    const pending = s.claims.filter(c => !['complete','cancelled'].includes(c.status) && (role === 'main' || c.owner === who)).map(c => ({ id: c.id, task: c.task, owner: c.owner, status: c.status, count: c.entries.length, rev: c.rev }));
    if (pending.length) view.claims = pending;
    // Cheap signal, not an inventory: the coordinator needs to know that an
    // audit is worth running, without paying for a full walk on every brief.
    // Only `main` gets it -- chasing undeclared files is a coordination job,
    // and a child cannot act on another conversation's leftovers. Listing the
    // files here would flood the brief, so only the count appears; `audit`
    // gives the detail.
    if (role === 'main') {
      const undeclared = undeclaredCount(ws, s.tasks);
      if (undeclared > 0) view.undeclaredCount = undeclared;
    }
    const stamp = sha(view).slice(0, 24);
    const scope = view.sessionCheck?.scope === 'dsh-record-presence' ? 'declared-metadata+session-record-presence' : 'declared-metadata';
    if (options.since === stamp) return { stamp, noChanges: true, scope };
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
    return { stamp, role, epoch: view.epoch, mode: previous ? 'delta' : 'snapshot', ...(options.since && !previous ? { reset: true } : {}), scope, ...(view.sessionCheck ? { sessionCheck: view.sessionCheck } : {}), ...(role === 'unknown' ? { identity: identity(who) } : {}), ...(view.undeclaredCount ? { undeclaredCount: view.undeclaredCount } : {}), taskCount: view.tasks.length, alertCount: view.alerts.length, tasks: page(tasks, options), alerts: page(alerts, options), removedTasks: page(removedTasks, options), resolvedAlerts: page(resolvedAlerts, options), ...(view.unregistered ? { unregisteredCount: view.unregistered.length, unregistered: page(unregisteredDelta, options), ...(registeredDirs.length ? { registeredDirectories: page(registeredDirs, options) } : {}) } : {}), ...(pending.length || resolvedClaims.length ? { claims: page(claims,options), resolvedClaims: page(resolvedClaims,options) } : {}) };
  });
}
function register(ws, options) {
  const who = session(options.session, true);
  if (!options.file) fail('INVALID', 'task requires --file');
  const input = json(path.resolve(options.file));
  return locked(ws, root => {
    const s = snapshot(ws); requireNoRecovery(s);
    const current = normalizeTask(ws, input, who), old = s.tasks.find(t => t.id === current.id);
    // The coordinator may repair placement and declarations of any task, but it
    // must not seize one: the recorded owner stays whoever is doing the work.
    const actor = old ? authority(s, old, who, options) : 'owner';
    if (old && actor === 'coordinator') {
      if (current.goal !== old.goal) fail('INVALID', 'The coordinator may change placement and writes, not another session\'s goal');
      if (current.state !== old.state) fail('INVALID', 'The coordinator may change placement and writes, not another session\'s state; use recover-task to cancel or reassign');
    }
    const ownerOf = old ? old.owner : who;
    if (old && String(old.rev) !== options['expect-rev']) fail('REVISION_MISMATCH', 'Pass the latest --expect-rev', { actualRev: old.rev });
    if (!old && options['expect-rev'] !== undefined) fail('REVISION_MISMATCH', 'New task has no prior revision');
    // A directory chosen wrongly used to be unrecoverable: the error told the
    // caller to "explicitly migrate" but no such command existed, and no other
    // command could change it. Name the real command and print its arguments.
    if (old && old.directory !== current.directory)
      fail('DIRECTORY_CHANGED', 'Task artifact directory is stable; change it with the migrate command', {
        migrate: ['migrate', '--workspace', ws, '--session', who, '--task', old.id, '--to', portable(ws, current.directory), '--expect-rev', old.rev],
        directory: portable(ws, old.directory),
        requested: portable(ws, current.directory),
      });
    const { rev: _r, updatedAt: _u, ...oldBody } = old || {};
    if (old && sha(oldBody) === sha(current)) return { id: old.id, rev: old.rev, noChanges: true };
    const others = s.tasks.filter(t => t.id !== current.id);
    const clashes = alertsFor([...others, current], s.claims).filter(a => a.tasks.includes(current.id));
    if (clashes.length) fail('RESOURCE_CONFLICT', 'Declared resources overlap another task', page(clashes, options));
    const sid = path.join(current.directory, '.session-id');
    // A finished task is a historical record: its directory is the user's to
    // keep or delete. Recreating it here meant that editing nothing but the
    // `result` text resurrected an empty shell, so cleanup could never stay done.
    // Ownership is still verified for a directory that happens to exist.
    const hasLiveDirectory = !old || ACTIVE.has(old.state) || ACTIVE.has(current.state);
    claimDirectory(ws, current.directory, ownerOf, options);
    if (hasLiveDirectory) {
      fs.mkdirSync(current.directory, { recursive: true });
      if (!present(sid)) fs.writeFileSync(sid, ownerOf + '\n', { flag: 'wx' });
    }
    const record = { ...current, owner: ownerOf, rev: (old?.rev ?? 0) + 1, updatedAt: new Date().toISOString(), ...(actor === 'coordinator' ? { lastActor: who, lastReason: options.reason } : {}) };
    atomic(path.join(root, 'tasks', current.id + '.json'), record);
    return { id: record.id, rev: record.rev, state: record.state, directory: portable(ws, record.directory) };
  });
}

function requireNoRecovery(s) {
  if (s.recovery) fail('RECOVERY_PENDING', 'Resume the pending task recovery before changing workspace records', { recovery: s.recovery.id });
}
function recoveryId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}-r[1-9][0-9]{0,15}$/.test(value)) fail('INVALID', 'Invalid recovery id');
  return value;
}
function readRecovery(file) {
  noLink(file);
  if (fs.statSync(file).size > 512 * 1024) fail('REGISTRY_DAMAGED', 'Recovery record too large');
  return json(file);
}
function readCompletedRecovery(ws, file) {
  const op = validateRecovery(ws, readRecovery(file));
  if (!Number.isFinite(Date.parse(op.completedAt))) fail('REGISTRY_DAMAGED', 'Recovery audit is not complete');
  session(op.completedBy, true);
  return op;
}
function validateRecovery(ws, op) {
  if (!op || op.schema !== 1 || !['cancel', 'reassign'].includes(op.action)) fail('REGISTRY_DAMAGED', 'Invalid recovery record');
  taskId(op.task); recoveryId(op.id); session(op.by, true);
  if (!text(op.reason, 'recovery reason') || !Number.isFinite(Date.parse(op.at))) fail('REGISTRY_DAMAGED', 'Invalid recovery reason or timestamp');
  const before = storedTask(ws, op.before), after = storedTask(ws, op.after);
  if (before.id !== op.task || !ACTIVE.has(before.state) || !Number.isSafeInteger(before.rev + 1) || op.id !== `${op.task}-r${before.rev + 1}`) fail('REGISTRY_DAMAGED', 'Invalid recovery target or revision');
  const expected = storedTask(ws, { ...before, owner: op.action === 'reassign' ? after.owner : before.owner, state: op.action === 'cancel' ? 'cancelled' : before.state === 'blocked' ? 'blocked' : 'planned', rev: before.rev + 1, updatedAt: op.at });
  if (sha(after) !== sha(expected) || (op.action === 'reassign' && (after.owner === before.owner || typeof op.marker !== 'string' || op.marker.length > 512 || op.marker.trim() !== before.owner))) fail('REGISTRY_DAMAGED', 'Recovery snapshots disagree');
  return op;
}
function pendingRecovery(ws) {
  const file = path.join(metadata(ws), 'recovery-pending.json');
  return present(file) ? validateRecovery(ws, readRecovery(file)) : null;
}
function artifactMarker(ws, directory) {
  if (!inside(ws, directory) || directory === ws) fail('INVALID_DIRECTORY', 'Recovery directory must be inside the workspace');
  let current = ws;
  for (const part of path.relative(ws, directory).split(path.sep).filter(Boolean)) { current = path.join(current, part); noLink(current); }
  if (!fs.statSync(directory).isDirectory()) fail('INVALID_DIRECTORY', 'Artifact directory is missing');
  const marker = path.join(directory, '.session-id'); noLink(marker);
  if (!fs.statSync(marker).isFile() || fs.statSync(marker).size > 512) fail('OWNER_MISMATCH', 'Expected a regular ownership marker');
  return marker;
}
function auditDirectory(root) {
  const dir = path.join(root, 'recoveries'); noLink(dir);
  fs.mkdirSync(dir, { recursive: true }); return dir;
}
function completeRecovery(ws, root, op, caller) {
  validateRecovery(ws, op);
  const file = path.join(root, 'tasks', op.task + '.json'); noLink(file);
  const raw = json(file), current = storedTask(ws, raw);
  if (raw.directory !== op.before.directory || ![sha(storedTask(ws, op.before)), sha(storedTask(ws, op.after))].includes(sha(current))) fail('RECOVERY_CHANGED', 'Task changed outside the pending recovery; preserve the journal and review it');
  if (readClaims(ws).some(c => c.task === op.task && !['complete', 'cancelled'].includes(c.status))) fail('PENDING_ORGANIZATION', 'Cancel or finish the task organization plans before recovery');
  let marker;
  if (op.action === 'reassign') {
    marker = artifactMarker(ws, op.before.directory);
    const observed = fs.readFileSync(marker, 'utf8');
    if (observed !== op.marker && observed !== op.after.owner + '\n') fail('RECOVERY_CHANGED', 'Ownership marker changed; preserve the journal and review it');
  }
  const audit = path.join(auditDirectory(root), op.id + '.json');
  let completed;
  if (present(audit)) {
    completed = readCompletedRecovery(ws, audit);
    const { completedAt: _a, completedBy: _b, ...original } = completed;
    if (sha(original) !== sha(op)) fail('RECOVERY_CHANGED', 'Recovery audit already exists with different contents');
  } else completed = { ...op, completedAt: new Date().toISOString(), completedBy: caller };
  // The journal remains until marker, task and audit agree. A retry accepts
  // either side of each write, but refuses any unrelated change.
  if (marker) atomic(marker, op.after.owner + '\n');
  atomic(file, op.after);
  atomic(audit, completed);
  fs.unlinkSync(path.join(root, 'recovery-pending.json'));
  return { recovery: op.id, task: op.task, action: op.action, owner: op.after.owner, state: op.after.state, rev: op.after.rev, audit: `.workspace/recoveries/${op.id}.json` };
}
function recoverTask(ws, options) {
  const caller = session(options.session, true);
  needConfig(ws);
  return locked(ws, root => {
    const c = needConfig(ws);
    if (c.main !== caller) fail('NOT_MAIN', 'Only the current coordinator can recover a child task');
    const pending = pendingRecovery(ws);
    if (options.resume) {
      if (['action', 'task', 'from', 'to', 'reason', 'expect-rev', 'confirm-unavailable'].some(k => options[k] !== undefined)) fail('INVALID', 'Use --resume without new recovery arguments');
      const id = options.resume === 'pending' ? pending?.id : recoveryId(options.resume);
      if (pending) {
        if (pending.id !== id) fail('RECOVERY_PENDING', 'A different recovery is pending', { recovery: pending.id });
        return completeRecovery(ws, root, pending, caller);
      }
      if (!id) fail('NOT_FOUND', 'No pending recovery');
      const file = path.join(root, 'recoveries', id + '.json'); noLink(path.dirname(file));
      if (!present(file)) fail('NOT_FOUND', 'Recovery not found');
      if (readCompletedRecovery(ws, file).id !== id) fail('REGISTRY_DAMAGED', 'Recovery filename does not match its record');
      return { recovery: id, status: 'complete', noChanges: true };
    }
    if (pending) fail('RECOVERY_PENDING', 'Resume the pending recovery first', { recovery: pending.id });
    if (!options['confirm-unavailable']) fail('CONFIRMATION_REQUIRED', 'Obtain explicit user confirmation that the old owner is unavailable, then use --confirm-unavailable');
    if (!['cancel', 'reassign'].includes(options.action) || !text(options.reason, 'recovery reason')) fail('INVALID', 'Use --action cancel or reassign and a nonempty --reason');
    const s = snapshot(ws), before = s.tasks.find(t => t.id === taskId(options.task));
    if (!before) fail('NOT_FOUND', 'Task not found');
    if (before.owner === c.main) fail('INVALID', 'This command recovers child tasks, not coordinator tasks');
    if (session(options.from, true) !== before.owner) fail('OWNER_MISMATCH', 'Pass the exact current owner using --from');
    if (String(before.rev) !== options['expect-rev']) fail('REVISION_MISMATCH', 'Pass the latest task --expect-rev', { actualRev: before.rev });
    if (!ACTIVE.has(before.state)) fail('INVALID_STATE', 'Only unfinished tasks need recovery');
    if (s.claims.some(plan => plan.task === before.id && !['complete', 'cancelled'].includes(plan.status))) fail('PENDING_ORGANIZATION', 'Cancel or finish the task organization plans first', s.claims.filter(plan => plan.task === before.id && !['complete', 'cancelled'].includes(plan.status)).map(plan => ({ id: plan.id, rev: plan.rev, status: plan.status })));
    const to = options.action === 'reassign' ? session(options.to, true) : before.owner;
    if (options.action === 'cancel' && options.to !== undefined) fail('INVALID', '--to applies only to reassign');
    if (options.action === 'reassign' && to === before.owner) fail('INVALID', 'Choose a different new owner');
    const at = new Date().toISOString(), id = `${before.id}-r${before.rev + 1}`;
    let marker;
    if (options.action === 'reassign') {
      const raw = json(path.join(root, 'tasks', before.id + '.json'));
      if (raw.directory !== before.directory) fail('DIRECTORY_CHANGED', 'Task directory changed; review ownership before recovery');
      marker = fs.readFileSync(artifactMarker(ws, before.directory), 'utf8');
      if (marker.trim() !== before.owner) fail('OWNER_MISMATCH', 'Directory marker must match the old owner');
    }
    const after = { ...before, owner: to, state: options.action === 'cancel' ? 'cancelled' : before.state === 'blocked' ? 'blocked' : 'planned', rev: before.rev + 1, updatedAt: at };
    const op = validateRecovery(ws, { schema: 1, id, task: before.id, action: options.action, by: caller, reason: options.reason, at, before, after, ...(marker !== undefined ? { marker } : {}) });
    const audit = path.join(auditDirectory(root), id + '.json');
    if (present(audit)) fail('RECOVERY_CHANGED', 'Recovery id is already in use');
    atomic(path.join(root, 'recovery-pending.json'), op);
    return completeRecovery(ws, root, op, caller);
  });
}

/**
 * Take ownership of an artifact directory that already exists.
 *
 * `register` and `migrate` both hand a conversation a directory, and both must
 * apply the same three rules or one of them becomes a way around the other:
 *   1. a marker written by another conversation is a hard stop (`OWNER_MISMATCH`)
 *      -- a marker is a claim of authorship, not a suggestion;
 *   2. content the tool has never seen adopted needs explicit `--adopt`
 *      (`ADOPTION_REQUIRED`), so no one silently absorbs someone else's work;
 *   3. metadata paths and links are refused.
 *
 * This used to live inline in `register` only, which is exactly how `migrate`
 * came to accept another conversation's directory and to absorb an unmarked
 * non-empty one without confirmation.
 */
/**
 * Who may change a task, and on what authority.
 *
 * Two roles act on a task record: its **owner** (the conversation doing the work)
 * and the **coordinator** (the conversation responsible for the whole workspace).
 * Treating them as peers was a mistake: it left the coordinator unable to move a
 * child's misplaced directory or correct its declarations, even though that is
 * exactly the coordination it was appointed to do.
 *
 * The owner keeps exclusive control of *content* — nobody else may rewrite the
 * goal, next step or result of work they are not doing. The coordinator may act
 * on *placement and metadata* (directory, writes) so it can resolve the messes it
 * is asked to resolve. Every coordinator action is recorded in the task record as
 * `lastActor`, so the audit trail never loses track of who touched what.
 *
 * @returns 'owner' or 'coordinator', or throws when neither applies.
 */
function authority(s, task, who, options) {
  if (task.owner === who) return 'owner';
  if (s.config.main !== who) fail('OWNER_MISMATCH', 'Task belongs to another session');
  // A coordinator moving someone else's work must say why. This is the only
  // friction added: it makes the override deliberate instead of accidental,
  // and it lands verbatim in the record for the owner to read later.
  if (!options.reason) fail('REASON_REQUIRED', 'A coordinator acting on another session\'s task must pass --reason explaining the change');
  text(options.reason, 'coordinator reason', 400);
  return 'coordinator';
}
/**
 * The session a directory must belong to.
 *
 * Ownership of an artifact directory follows the *task*, not whoever happens to
 * run the command: when the coordinator moves a child's directory, the marker
 * inside it must still name the child. Checking against the actor here is what
 * made coordinator migrations impossible.
 */
function directoryOwnerOf(task) { return task.owner; }

function claimDirectory(ws, dir, expected, options) {
  const sid = path.join(dir, '.session-id');
  if (!present(dir)) return sid;
  if (!fs.statSync(dir).isDirectory()) fail('INVALID_DIRECTORY', 'Artifact path is not a directory');
  noLink(sid);
  if (present(sid) && fs.readFileSync(sid, 'utf8').trim() !== expected) fail('OWNER_MISMATCH', 'Artifact directory has another owner');
  if (!present(sid) && fs.readdirSync(dir).length && !options.adopt) fail('ADOPTION_REQUIRED', 'Existing nonempty directory needs confirmed ownership and --adopt');
  return sid;
}
/**
 * Move a task's artifact directory.
 *
 * Registration freezes `directory` so that a task cannot silently drift away
 * from the resources it claims, but the freeze had no escape hatch: a directory
 * chosen wrongly was wrong forever, and the documented rule ("do not treat the
 * repository root as your artifact directory") became unenforceable in practice
 * because the only repair was hand-editing the registry.
 *
 * The freeze therefore stays, and this is the explicit unfreeze. It is
 * deliberately no more permissive than a re-registration would be:
 *   - the target must clear the same ownership/adoption rules as `register`
 *     (`claimDirectory`), or migration becomes the way around them;
 *   - the *finished* record must be conflict-free. `--move-files` additionally
 *     relocates resource claims that the new directory creates, so those must be
 *     free too; without it no file moves and those claims stay with the old path;
 *   - `writes` inside the old directory are rewritten to follow the move, and
 *     must not collide with a live task once rewritten;
 *   - content is only moved with `--move-files`, and only into a destination
 *     that is empty.
 *
 * @returns The new revision, both directories, and whether files were moved.
 */
function migrateTask(ws, options) {
  const who = session(options.session, true);
  return locked(ws, (root) => {
    const s = snapshot(ws); requireNoRecovery(s);
    const old = s.tasks.find(t => t.id === taskId(options.task));
    if (!old) fail('NOT_FOUND', 'Task not found');
    const actor = authority(s, old, who, options);
    if (String(old.rev) !== options['expect-rev']) fail('REVISION_MISMATCH', 'Pass the latest --expect-rev', { actualRev: old.rev });
    if (!options.to) fail('INVALID', 'migrate requires --to DIRECTORY');
    const target = artifact(ws, options.to);
    const sameDirectory = target === old.directory;
    if (sameDirectory && !options.follow) return { id: old.id, rev: old.rev, directory: portable(ws, old.directory), noChanges: true };
    // The directory belongs to the task, not to whoever runs the command: when
    // the coordinator moves a child's directory the marker must still name the
    // child. Same ownership and adoption gate as `register`.
    if (!sameDirectory) claimDirectory(ws, target, directoryOwnerOf(old), options);

    const from = old.directory, moving = Boolean(options['move-files']) && !sameDirectory;
    // `writes` are declared resources, not a copy of the directory. Entries
    // inside the old directory follow it, and so do entries that were physically
    // moved into it: a project that lived in the workspace root and was then
    // dragged inside a task directory leaves every declaration pointing at the
    // old location, which used to surface as dozens of `missing_path` alerts with
    // no hint about the cause. `--follow` paths map old -> new explicitly.
    const followMap = new Map();
    for (const pair of options.follow ?? []) {
      const [a, b] = String(pair).split('=>');
      if (!a || !b) fail('INVALID', 'Each --follow takes OLD=>NEW');
      followMap.set(canonical(ws, a), canonical(ws, b));
    }
    const follow = (q) => {
      if (inside(from, q) || q === from) return path.join(target, path.relative(from, q));
      for (const [a, b] of followMap) if (q === a || inside(a, q)) return path.join(b, path.relative(a, q));
      return q;
    };
    const writes = [...new Set(old.writes.map(follow))].sort();
    // Predict what will be missing after the move so the caller is not left
    // guessing from a wall of check alerts. Reported, never silently "fixed":
    // guessing that a declaration *should* point somewhere is how claims rot.
    const willExist = (q) => {
      if (followMap.size || moving) {
        for (const [a, b] of followMap) if (q === a || inside(a, q)) return present(path.join(b, path.relative(a, q)));
        if (inside(from, q) || q === from) return present(path.join(target, path.relative(from, q)));
      }
      return present(q);
    };
    const orphanedWrites = old.writes.filter(q => !willExist(follow(q))).map(q => portable(ws, q));
    // Conflicts are judged on what the migrated record will actually claim.
    // Checking a version with `writes: []` only caught directory overlaps, so a
    // rewritten path could land on a live task's claim and write an overlap that
    // `register` would have refused (`migrate` became a hole in the check).
    const planned = { ...old, directory: target, writes };
    const clashes = alertsFor([...s.tasks.filter(t => t.id !== old.id), planned], s.claims).filter(a => a.tasks.includes(old.id));
    if (clashes.length) fail('RESOURCE_CONFLICT', 'Target directory or rewritten writes overlap another live task', page(clashes.map(a => ({ type: a.type, tasks: a.tasks, path: portable(ws, a.path), ...(a.otherPath ? { otherPath: portable(ws, a.otherPath) } : {}) })), options));
    if (moving && present(from)) {
      if (!fs.statSync(from).isDirectory()) fail('INVALID_DIRECTORY', 'Current artifact path is not a directory');
      if (present(target) && fs.readdirSync(target).length) fail('DIRECTORY_NOT_EMPTY', 'Destination already has content; migrate the record only, or empty it first');
    }
    const record = storedTask(ws, { ...old, directory: target, writes, rev: old.rev + 1, updatedAt: new Date().toISOString(), ...(actor === 'coordinator' ? { lastActor: who, lastReason: options.reason } : {}) });
    if (moving && present(from)) {
      const sid = path.join(from, '.session-id');
      if (present(sid) && fs.readFileSync(sid, 'utf8').trim() !== directoryOwnerOf(old)) fail('OWNER_MISMATCH', 'Artifact directory has another owner');
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        const source = path.join(from, entry), dest = path.join(target, entry);
        if (present(dest)) fail('DIRECTORY_NOT_EMPTY', `Destination is missing ${entry} but not empty`);
        fs.renameSync(source, dest);
      }
    }
    // The directory a record points at should exist and carry the task owner's
    // marker, whether or not files were moved: a migration is also how a record
    // gets pointed at a directory that was created elsewhere.
    const marker = path.join(target, '.session-id');
    fs.mkdirSync(target, { recursive: true });
    noLink(marker);
    if (!present(marker)) fs.writeFileSync(marker, directoryOwnerOf(old) + '\n', { flag: 'wx' });
    atomic(path.join(root, 'tasks', old.id + '.json'), record);
    return {
      id: record.id, rev: record.rev, state: record.state,
      from: portable(ws, from), directory: portable(ws, target),
      moved: moving && present(target), writes: writes.map(q => portable(ws, q)),
      ...(actor === 'coordinator' ? { actedAs: 'coordinator', owner: old.owner } : {}),
      ...(orphanedWrites.length ? { warning: 'Some declarations point at paths that no longer exist; re-register or pass --follow OLD=>NEW to remap them', orphanedWrites } : {}),
    };
  });
}
/**
 * Drop a finished task record after archiving it.
 *
 * `recover-task` is deliberately for child tasks whose owner vanished, which
 * left the coordinator unable to tidy up its OWN history: a cancelled task it
 * registered itself could not be cancelled or removed by any command. Those
 * records accumulate and, before the scan was limited to live tasks, poisoned
 * `check` permanently. Archiving is the coordinator's own cleanup: it applies to
 * finished records only (an unfinished task must be cancelled or recovered
 * first, so that no live claim disappears silently), it copies the record to
 * `.workspace/archive/` with the time and actor, and it never touches files.
 */
function archiveTask(ws, options) {
  const who = session(options.session, true);
  return locked(ws, (root) => {
    const s = snapshot(ws); requireNoRecovery(s);
    const c = s.config;
    if (c.main !== who) fail('NOT_MAIN', 'Only the current coordinator can archive task records');
    const before = s.tasks.find(t => t.id === taskId(options.task));
    if (!before) fail('NOT_FOUND', 'Task not found');
    if (String(before.rev) !== options['expect-rev']) fail('REVISION_MISMATCH', 'Pass the latest --expect-rev', { actualRev: before.rev });
    if (ACTIVE.has(before.state)) fail('INVALID_STATE', 'Cancel or recover the task before archiving; only finished records are history', { state: before.state });
    if (!text(options.reason, 'archive reason')) fail('INVALID', 'Pass a nonempty --reason');
    if (readClaims(ws).some(p => p.task === before.id && !['complete', 'cancelled'].includes(p.status))) fail('PENDING_ORGANIZATION', 'Cancel or finish the task organization plans first');
    const dir = path.join(metadata(ws), 'archive'); noLink(dir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${before.id}-${stamp}.json`);
    atomic(file, { schema: 1, archivedAt: new Date().toISOString(), archivedBy: who, reason: options.reason, record: before });
    fs.unlinkSync(path.join(root, 'tasks', before.id + '.json'));
    // The directory and its marker are the owner's artifacts, not registry
    // data: archiving a record must never delete the work it describes.
    return { id: before.id, archived: `.workspace/archive/${path.basename(file)}`, state: before.state, directory: portable(ws, before.directory), directoryKept: present(before.directory) };
  });
}

/**
 * Files in the workspace that no live task declares.
 *
 * `check` can only answer "are the things people declared in conflict?" -- it
 * walks `tasks[].directory` and `tasks[].writes`, so a file nobody declared is
 * invisible to it, and two conversations could edit the same `src/main.ts`
 * while `check` reported `ok: true`. `unregistered` covers the other half of
 * the same blind spot (marked directories with no task); this covers loose
 * files that belong to no artifact directory at all.
 *
 * Deliberately a read-only inventory, not a validator: it never fails `check`
 * and never guesses ownership. `hint` is a naming-based description of what
 * kind of file it looks like, and is explicitly not an attribution.
 *
 * Results are grouped by directory because "src/sim/ holds 22 files" is more
 * actionable than 22 rows, and are paged so a large repository cannot flood a
 * reply. `complete` is false whenever the walk hit a limit, so an empty list is
 * never mistaken for a clean workspace.
 */
/**
 * Walk the workspace root and report every file no live task declares.
 *
 * Both the cheap `context` count and the full `audit` inventory need exactly this
 * walk. Keeping two copies is how they drifted apart once already: one used a
 * symmetric overlap test and silently swallowed whole source trees. One
 * implementation with an optional `collect` keeps them honest.
 *
 * `limit` bounds the walk so a large repository cannot stall a brief; the
 * inventory turns "stopped early" into `complete: false`.
 */
function walkUndeclared(ws, tasks, { collect = false, limit = 5000 } = {}) {
  const base = canonical(ws, '.');
  const covered = declaredSet(tasks, base);
  const found = [];
  let stopped = false;
  const walk = (dir, depth) => {
    if (stopped) return;
    if (depth > 8) { stopped = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { stopped = true; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (covered(full)) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (found.length >= limit) { stopped = true; return; }
      let size = 0;
      if (collect) { try { size = fs.lstatSync(full).size; } catch { continue; } }
      found.push({ path: portable(ws, full), size });
    }
  };
  walk(base, 0);
  return { found, complete: !stopped };
}
/** Cheap undeclared-file count for `context`: no sizes, no grouping. */
function undeclaredCount(ws, tasks) { return walkUndeclared(ws, tasks).found.length; }
/**
 * Files in the workspace that no live task declares.
 *
 * `check` can only answer "are the things people declared in conflict?" -- it
 * walks `tasks[].directory` and `tasks[].writes`, so a file nobody declared is
 * invisible to it, and two conversations could edit the same `src/main.ts`
 * while `check` reported `ok: true`. `unregistered` covers the other half of
 * the same blind spot (marked directories with no task); this covers loose
 * files that belong to no artifact directory at all.
 *
 * Deliberately a read-only inventory, not a validator: it never fails `check`
 * and never guesses ownership. `hint` is a naming-based description of what
 * kind of file it looks like, and is explicitly not an attribution.
 *
 * Results are grouped by directory because "src/sim/ holds 22 files" is more
 * actionable than 22 rows, and are paged so a large repository cannot flood a
 * reply. `complete` is false whenever the walk hit a limit, so an empty list is
 * never mistaken for a clean workspace.
 */
/**
 * Predicate: is this path inside something a live task declared?
 *
 * Deliberately one-directional. The overlap helper used everywhere else is
 * symmetric, which is correct for "do these two claims collide" and wrong for
 * "is this file accounted for": a declared file does not declare its parent
 * directory, so a symmetric test made one declared file under a source tree
 * swallow the whole tree and hide every undeclared sibling -- the exact blind
 * spot this feature exists to close.
 */
function declaredSet(tasks, ws) {
  const declared = tasks.filter(t => ACTIVE.has(t.state)).flatMap(t => [t.directory, ...t.writes]);
  return p => {
    if (ws && OWNED.has(path.basename(p)) && path.dirname(p) === ws) return true;
    return declared.some(d => d === p || inside(d, p));
  };
}
function undeclaredAudit(ws, options) {
  const s = snapshot(ws);
  const live = s.tasks.filter(t => ACTIVE.has(t.state));
  const { found, complete: walkComplete } = walkUndeclared(ws, s.tasks, { collect: true });
  if (options.scope === 'root') found.splice(0, found.length, ...found.filter(f => !f.path.includes('/')));
  // Group by the containing directory so the coordinator sees shape, not noise.
  const groups = new Map();
  for (const f of found) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) + '/' : '';
    if (!groups.has(dir)) groups.set(dir, { path: dir || '.', files: 0, bytes: 0 });
    const g = groups.get(dir);
    g.files += 1; g.bytes += f.size;
  }
  const shape = [...groups.values()].map(g => {
    const first = found.find(f => (g.path === '.' ? !f.path.includes('/') : f.path.startsWith(g.path + '/')));
    return { ...g, hint: g.path === '.' ? 'root-level-file' : EXCLUDED.has(g.path.split('/')[0]) ? 'excluded-tree' : 'undeclared-tree', ...(g.files === 1 ? { example: first?.path } : {}) };
  }).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
  return {
    schema: SCHEMA,
    scope: 'undeclared-files',
    workspaceShape: shapeOf(ws),
    layout: artifactRoot(ws) ? 'container' : 'flat',
    ...(() => { const d = layoutDrift(ws); return d ? { layoutDrift: d } : {}; })(),
    declaredFiles: live.reduce((n, t) => n + t.writes.length, 0),
    declaredDirectories: live.length,
    undeclaredFiles: found.length,
    undeclaredBytes: found.reduce((n, f) => n + f.size, 0),
    issues: page(shape, options),
    complete: walkComplete,
    note: 'Inventory only: undeclared files are not a conflict and never fail check. hint describes the path shape, not ownership.',
  };
}
/**
 * Does the recorded layout still describe reality?
 *
 * `config.artifacts` is written once at `init`. A user reorganising the tree by
 * hand leaves it stale, and then every default path quietly points somewhere
 * that no longer matches. Reported, never auto-corrected: the tool does not get
 * to decide that a hand-made rearrangement was wrong.
 */
function layoutDrift(ws) {
  const root = artifactRoot(ws);
  if (!root) return null;
  const dir = canonical(ws, root);
  if (!present(dir)) return { recorded: root, observed: 'absent', hint: 'The configured artifact container does not exist; layout may have been changed by hand. Use move-artifacts to record the current arrangement.' };
  const strays = conversationDirectories(ws).filter(d => !inside(dir, d));
  return strays.length ? { recorded: root, observed: 'flat-directories-present', directories: strays.map(d => portable(ws, d)), hint: 'Conversation directories exist outside the recorded container. Use move-artifacts to record the current arrangement.' } : null;
}
function audit(ws, options) {
  if (!config(ws)) return { ok: false, complete: false, scope: 'undeclared-files', issues: page([{ type: 'not_enabled' }], options) };
  return locked(ws, () => undeclaredAudit(ws, options));
}
/**
 * Change where this workspace keeps conversation artifacts.
 *
 * The layout is chosen at `init` from the shape of the root, but a workspace can
 * predate that decision, or be reorganised once the user sees the result. Flat
 * directories in a project-shaped root are exactly the complaint this addresses:
 * they interleave with src/ and package.json, and every build tool and IDE
 * config assumes the root is the project.
 *
 * Only the coordinator can do this, because it moves every conversation's
 * artifacts at once. It is deliberately all-or-nothing and refuses to overwrite:
 * a half-moved layout is worse than a messy one.
 *
 * @param artifacts Target container name, or null/'flat' for the root itself.
 * @returns The new layout and each directory that moved.
 */
function moveArtifacts(ws, options) {
  const who = session(options.session, true);
  return locked(ws, (root) => {
    const c = needConfig(ws);
    if (c.main !== who) fail('NOT_MAIN', 'Only the current coordinator can change the artifact layout');
    if (options.artifacts === undefined) fail('INVALID', 'Pass --artifacts NAME, or --artifacts flat');
    text(options.artifacts, 'artifacts', 64);
    const target = options.artifacts === 'flat' ? null : artifactContainer(options.artifacts);
    if (target === (c.artifacts ?? null)) return { layout: target ? 'container' : 'flat', artifacts: target, noChanges: true };
    const s = snapshot(ws); requireNoRecovery(s);
    const pending = s.claims.filter(x => !['complete', 'cancelled'].includes(x.status));
    if (pending.length) fail('PENDING_ORGANIZATION', 'Cancel or finish the task organization plans first', pending.map(x => ({ id: x.id, status: x.status })));
    if (String(c.epoch) !== options['expect-epoch']) fail('EPOCH_MISMATCH', 'Pass the current --expect-epoch');

    // Everything is expressed relative to the CURRENT container, so the same
    // code handles root -> container, container -> root and container -> other
    // container. Task directories outside the current container are left alone:
    // they were placed explicitly and this command only relocates the default
    // layout, not someone's deliberate choice.
    const currentRoot = c.artifacts ? canonical(ws, c.artifacts) : canonical(ws, '.');
    const nextRoot = target === null ? canonical(ws, '.') : canonical(ws, target);
    if (nextRoot !== canonical(ws, '.') && present(nextRoot) && !fs.statSync(nextRoot).isDirectory()) fail('INVALID_DIRECTORY', 'Artifact container is not a directory');

    const plan = [];
    for (const t of s.tasks) {
      if (!inside(currentRoot, t.directory) || t.directory === currentRoot) continue;
      const rel = path.relative(currentRoot, t.directory);
      const to = nextRoot === canonical(ws, '.') ? canonical(ws, rel.split(path.sep).join('/')) : path.join(nextRoot, rel);
      if (to === t.directory) continue;
      plan.push({ task: t, from: t.directory, to });
    }
    const seen = new Set();
    for (const m of plan) {
      if (present(m.to)) fail('DIRECTORY_NOT_EMPTY', 'Target already exists; empty it or choose another layout', { task: m.task.id, target: portable(ws, m.to) });
      if (seen.has(m.to)) fail('RESOURCE_CONFLICT', 'Two tasks would share one directory', { target: portable(ws, m.to) });
      seen.add(m.to);
    }
    const moved = [];
    for (const m of plan) {
      const parent = path.dirname(m.to);
      if (parent !== canonical(ws, '.')) fs.mkdirSync(parent, { recursive: true });
      if (present(m.from)) fs.renameSync(m.from, m.to);
      const follow = (q) => (q === m.from || inside(m.from, q) ? path.join(m.to, path.relative(m.from, q)) : q);
      const writes = [...new Set(m.task.writes.map(follow))].sort();
      atomic(path.join(root, 'tasks', m.task.id + '.json'), { ...m.task, directory: m.to, writes, updatedAt: new Date().toISOString() });
      moved.push({ task: m.task.id, from: portable(ws, m.from), to: portable(ws, m.to) });
    }
    // An emptied container is removed so "flat" really means flat.
    if (c.artifacts) { try { const old = canonical(ws, c.artifacts); if (present(old) && !fs.readdirSync(old).length) fs.rmdirSync(old); } catch { /* leave it */ } }
    atomic(path.join(root, 'config.json'), { ...c, artifacts: target });
    return { layout: target ? 'container' : 'flat', artifacts: target, moved, taskCount: s.tasks.length };
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
  // Only live tasks own resources. Scanning finished records made history a
  // permanent liability: a cancelled task whose directory the user tidied up
  // produced `owner_unknown` + `missing_path` forever, which blocked `summary`,
  // which is the only way to establish the `check` baseline — so one deleted
  // directory disabled both commands for the whole workspace, with no command
  // able to remove the record that caused it.
  for (const task of tasks.filter(t => ACTIVE.has(t.state))) {
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
  const changed = [...new Set([...old.keys(), ...now.keys()])].sort().filter(p => old.get(p) !== now.get(p));
  // Pair an addition with a deletion that carries the identical content: that is
  // a move, not a modification. Without this, relocating a project reported every
  // file as "changed", which reads as tampering and buries the real edits in the
  // same number. Content hashes make the pairing exact; a genuine edit changes
  // the hash and stays in the modified bucket.
  const goneByHash = new Map();
  for (const p of changed) {
    if (now.has(p)) continue;
    const h = old.get(p);
    if (!goneByHash.has(h)) goneByHash.set(h, []);
    goneByHash.get(h).push(p);
  }
  const moved = [];
  const claimed = new Set();
  for (const p of changed) {
    if (!now.has(p) || old.has(p)) continue;
    const candidates = (goneByHash.get(now.get(p)) ?? []).filter(q => !claimed.has(q));
    if (!candidates.length) continue;
    claimed.add(p); claimed.add(candidates[0]);
    moved.push({ path: p, from: candidates[0], change: 'moved' });
  }
  const classified = changed.filter(p => !claimed.has(p)).map(p => ({ path: p, change: !old.has(p) ? 'added' : !now.has(p) ? 'deleted' : 'modified' }));
  return [...moved, ...classified].sort((a, b) => a.path.localeCompare(b.path));
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
  if (changes.length) {
    const tally = { moved: 0, modified: 0, added: 0, deleted: 0 };
    for (const c of changes) tally[c.change] += 1;
    // The bare count alone could not distinguish "117 files were relocated" from
    // "117 files were rewritten", and those demand opposite reactions.
    alerts.push({ type: 'summary_files_stale', count: changes.length, ...tally });
  }
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
    // Record the undeclared count so it cannot go unnoticed forever: every stage
    // summary states it and the next reader sees whether it is growing. A remark,
    // never a gate -- undeclared files are inventory, not a conflict.
    const undeclared = undeclaredCount(ws, r.s.tasks);
    const rows = r.s.tasks.map(t => `| ${[t.id, t.owner, t.state, t.goal, portable(ws, t.directory), t.rev].map(escape).join(' | ')} |`);
    const body = [marker, '# 工作区统筹', '', `主对话：${who}；交接版本：${r.s.config.epoch}`, '', '| 任务 | 对话 | 状态 | 目标 | 产物 | 版本 |', '|---|---|---|---|---|---|', ...rows, '', `声明资源检查：无重叠；扫描 ${r.scan.files.length} 个文件。`, `未声明文件：${undeclared} 个（详见 audit 命令）。`, '检查范围与排除项见 skill 命令参考；本页不代表未登记活动已被检查。', '详细结果见 .workspace/tasks/；修改本页请通过 summary 命令。', ''].join('\n');
    atomic(sum, body);
    atomic(path.join(root, 'summary.json'), { schema: SCHEMA, stateHash: r.stateHash, summaryHash: sha(body), files: r.scan.files });
    return { summary: 'sum.md', taskCount: r.s.tasks.length, fileCount: r.scan.files.length, undeclaredFiles: undeclared, complete: true };
  });
}
function init(ws, options) {
  const who = session(options.session, true);
  return locked(ws, root => {
    const c = config(ws);
    if (c) { if (c.main !== who) fail('MAIN_EXISTS', 'Another coordinator already exists'); return { main: c.main, epoch: c.epoch, noChanges: true, layout: c.artifacts ? 'container' : 'flat', artifacts: c.artifacts ?? null }; }
    if (!options['ack-legacy'] && ['sum.md', 'main.md'].some(n => present(path.join(ws, n)))) fail('LEGACY_WORKSPACE', 'Read migration reference and pass --ack-legacy after explicit appointment');
    // The layout is decided once, here, from what the root already contains.
    // A project-shaped root keeps its tree intact and gets a single container for
    // conversation artifacts; an empty lot keeps them flat, which is the whole
    // point of a shared surface. Guessing wrong would either litter a project
    // root or bury artifacts nobody can see, so the caller may also state it.
    const detected = shapeOf(ws);
    let artifacts = null;
    if (options.artifacts !== undefined) {
      text(options.artifacts, 'artifacts', 64);
      artifacts = options.artifacts === 'flat' ? null : artifactContainer(options.artifacts);
    }
    atomic(path.join(root, 'config.json'), { schema: SCHEMA, workspace: ws, main: who, epoch: 1, artifacts });
    return { enabled: true, main: who, epoch: 1, layout: artifacts ? 'container' : 'flat', artifacts, detected };
  });
}
function handoff(ws, options) {
  const who = session(options.session, true), next = session(options.to, true);
  return locked(ws, root => {
    const c = needConfig(ws);
    if (c.main !== who) fail('NOT_MAIN', 'Only the current coordinator can hand off');
    requireNoRecovery({ recovery: pendingRecovery(ws) });
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
const HELP = 'Commands: init, task, migrate, archive, audit, move-artifacts, context, detail, owners, check, summary, handoff, session-check, recover-task. See references/commands.md and references/recovery.md; common: --workspace PATH --session ID. context/check: --limit 1..20 --offset N. migrate: --task ID --to DIR --expect-rev N [--move-files]. archive: --task ID --expect-rev N --reason TEXT.';
// Options that may be given more than once.
const REPEATABLE = new Set(['follow']);
function parse(argv) {
  const command = argv[0], options = {};
  const flags = new Set(['adopt', 'ack-legacy', 'confirm-unavailable', 'move-files']);
  const allowed = new Set(['workspace', 'session', 'to', 'file', 'task', 'since', 'expect-rev', 'expect-epoch', 'limit', 'offset', 'sessions-home', 'action', 'from', 'reason', 'resume', 'scope', 'artifacts', 'follow', ...flags]);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    // Repeatable options accumulate instead of being rejected; everything else
    // stays single-valued so a typo cannot silently overwrite a flag.
    if (!allowed.has(key) || (key in options && !REPEATABLE.has(key))) fail('INVALID', 'Unknown or repeated option: ' + argv[i]);
    if (flags.has(key)) options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID', 'Missing value: ' + key);
      const value = argv[++i];
      if (!REPEATABLE.has(key)) options[key] = value;
      else (options[key] ??= []).push(...String(value).split(',').filter(Boolean));
    }
  }
  return { command, options };
}
export function execute(argv, env) {
  if (!argv.length || argv[0] === '--help') return { help: HELP };
  const { command, options } = parse(argv);
  if (!options.workspace) fail('INVALID', '--workspace is required');
  // The environment is only consulted by the CLI entry point, never by the
  // exported function: an in-process caller (the test suite) must not inherit
  // whatever conversation happened to launch it.
  //
  // The fallback covers every command that needs an identity, not just
  // `context`: a child that learns `role=child` but still has no id to pass
  // would be told its tasks exist and then be unable to register or claim them.
  if (!options.session) {
    const fromEnv = envSession(env);
    if (fromEnv) options.session = fromEnv;
  }
  if (['context', 'session-check'].includes(command) && !options['sessions-home']) {
    if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim()) options['sessions-home'] = env.DSH_HOME;
    else if (envSession(env)) options['sessions-home'] = path.join(os.homedir(), '.dsh');
  }
  const ws = fs.realpathSync(path.resolve(options.workspace));
  if (!fs.statSync(ws).isDirectory()) fail('INVALID', 'Workspace must be an existing directory');
  switch (command) {
    case 'init': return init(ws, options);
    case 'task': return register(ws, options);
    case 'migrate': return migrateTask(ws, options);
    case 'archive': return archiveTask(ws, options);
    case 'audit': return audit(ws, options);
    case 'move-artifacts': return moveArtifacts(ws, options);
    case 'context': return context(ws, options);
    case 'session-check': return checkSessions(ws, options);
    case 'recover-task': return recoverTask(ws, options);
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
    const result = execute(argv, process.env);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (e) {
    console.error(JSON.stringify({ error: e.code || 'ERROR', message: e.message, ...(e.details ? { details: e.details } : {}) }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
