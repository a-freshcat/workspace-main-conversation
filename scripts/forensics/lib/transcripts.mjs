import { frameBounds as endOfFrame } from '../../../zstd-frames.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

const problem = (code, message) => Object.assign(new Error(message), { code });
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const npath = p => { const out = path.resolve(p).replaceAll('\\', '/').replace(/\/$/, ''); return process.platform === 'win32' ? out.toLowerCase() : out; };
export const related = (a, b) => { a = npath(a); b = npath(b); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); };
export function options(argv, positional = false) {
  const out = { limit: 5, offset: 0 };
  const keys = new Set(['workspace', 'home', 'limit', 'offset', 'since', 'path']);
  const flags = new Set(['all', 'include-args']);
  const seen = new Set();
  for (const arg of argv) {
    if (arg === '--help') return { help: true };
  }
  let i = 0;
  if (positional && argv[0] && !argv[0].startsWith('--')) { out.session = argv[i++]; if (argv[i] && /^\d+$/.test(argv[i])) out.limit = Number(argv[i++]); }
  for (; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if ((!keys.has(key) && !flags.has(key)) || seen.has(key)) throw problem('ARGUMENT', 'Unknown or repeated option: ' + argv[i]);
    seen.add(key);
    if (flags.has(key)) out[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw problem('ARGUMENT', 'Missing value for ' + key); out[key] = argv[++i]; }
  }
  out.limit = Number(out.limit); out.offset = Number(out.offset);
  if (!Number.isSafeInteger(out.limit) || out.limit < 1 || out.limit > 20 || !Number.isSafeInteger(out.offset) || out.offset < 0) throw problem('ARGUMENT', 'limit=1..20, offset>=0');
  if (out.since !== undefined) { out.since = timestamp(out.since); if (out.since === null) throw problem('ARGUMENT', 'Invalid since timestamp'); }
  out.home = path.resolve(out.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  if (out.workspace) out.workspace = path.resolve(out.workspace);
  if (out.path) out.path = path.resolve(out.workspace || process.cwd(), out.path);
  return out;
}
export function page(rows, opt) {
  const end = Math.min(rows.length, opt.offset + opt.limit);
  return { total: rows.length, items: rows.slice(opt.offset, end), more: end < rows.length, ...(end < rows.length ? { nextOffset: end } : {}) };
}
export function timestamp(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  }
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
export function sessions(home) {
  const root = path.join(home, 'sessions'), rows = [], issues = [];
  if (!fs.existsSync(root)) throw problem('SESSIONS_ROOT_MISSING', 'DSH sessions directory does not exist');
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory() || ws.isSymbolicLink()) continue;
    const dir = path.join(root, ws.name);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { issues.push({ type: 'unreadable_workspace', workspace: ws.name, code: e.code }); continue; }
    for (const item of entries) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const file = path.join(dir, item.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink()) { issues.push({ type: 'log_not_regular', id: item.name }); continue; }
        rows.push({ id: item.name, file, modifiedAt: st.mtime.toISOString(), mtime: st.mtimeMs, bytes: st.size });
      } catch (e) { if (e.code !== 'ENOENT') issues.push({ type: 'log_unreadable', id: item.name, code: e.code }); }
    }
  }
  return { rows, issues };
}

export function readRecords(file, { headerOnly = false } = {}) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw problem('RUNTIME', 'Node runtime does not support zstdDecompressSync');
  const before = fs.statSync(file), maxInput = headerOnly ? 256 * 1024 : MAX_LOG_BYTES;
  const maxOutput = headerOnly ? 1024 * 1024 : MAX_LOG_BYTES;
  const buf = Buffer.alloc(Math.min(before.size, maxInput));
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try { while (read < buf.length) { const n = fs.readSync(fd, buf, read, buf.length - read, read); if (!n) break; read += n; } }
  finally { fs.closeSync(fd); }
  const data = buf.subarray(0, read), chunks = [], issues = [];
  let p = 0, frames = 0, decoded = 0, limited = before.size > maxInput;
  if (!data.length) issues.push({ type: 'empty_log' });
  while (p < data.length) {
    if (headerOnly && frames >= 60) { limited = true; break; }
    try {
      const f = endOfFrame(data, p);
      if (!f.skip) {
        const chunk = zlib.zstdDecompressSync(data.subarray(p, f.end), { maxOutputLength: maxOutput - decoded });
        decoded += chunk.length; chunks.push(chunk); frames++;
      }
      p = f.end;
    } catch (e) {
      if (!(headerOnly && limited && e.code === 'INCOMPLETE_FRAME')) issues.push({ type: e.code || 'DECODE_ERROR', atByte: p });
      break;
    }
    if (decoded >= maxOutput && p < data.length) { limited = true; break; }
  }
  if (!headerOnly && limited) issues.push({ type: 'read_limit' });
  if (!frames) issues.push({ type: 'no_data_frames' });
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) issues.push({ type: 'log_changed_during_read' });
  const body = Buffer.concat(chunks).toString('utf8'), lines = body.split('\n'), records = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const event = JSON.parse(lines[i]);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('not object');
      records.push({ line: i + 1, event });
    } catch {
      if (!(headerOnly && limited && i === lines.length - 1)) issues.push({ type: i === lines.length - 1 ? 'incomplete_json_tail' : 'invalid_json', line: i + 1 });
    }
  }
  return { records, frames, bytesRead: read, decodedBytes: decoded, headerOnly, limited, complete: !issues.length && (headerOnly || !limited), issues };
}
export function header(records) {
  let cwd = '', title = '';
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (!cwd && typeof value.cwd === 'string') cwd = value.cwd;
    if (!title && typeof (value.title ?? value.sessionTitle) === 'string') title = (value.title ?? value.sessionTitle).replace(/[\r\n]/g, ' ').slice(0, 100);
    for (const [k, v] of Object.entries(value)) if (!['arguments', 'text'].includes(k)) walk(v, depth + 1);
  }
  for (const { event } of records) { walk(event); if (cwd && title) break; }
  return { cwd, title };
}

function walkObjects(value, visit, pointer = 'data', depth = 0, parentId) {
  if (!value || typeof value !== 'object' || depth > 20) return;
  visit(value, pointer, parentId);
  for (const [key, child] of Object.entries(value)) {
    if (['arguments', 'text'].includes(key)) continue;
    walkObjects(child, visit, pointer + '.' + key, depth + 1, idOf(value) ?? parentId);
  }
}
const idOf = o => o.toolCallId ?? o.tool_call_id ?? o.callId ?? o.call_id ?? o.id;
const PATH_FIELDS = new Set(['path', 'file_path', 'filePath', 'file', 'target', 'src', 'dest', 'destination', 'old_path', 'new_path', 'directory']);
function argumentPaths(args) {
  const paths = [];
  function walk(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 10) return;
    for (const [k, v] of Object.entries(o)) {
      if (PATH_FIELDS.has(k) && typeof v === 'string') paths.push(v);
      if (typeof v === 'object') walk(v, depth + 1);
    }
  }
  walk(args); return [...new Set(paths)];
}
function category(name) {
  if (/(?:^|[_.-])(read|glob|list|ls|stat|search)(?:$|[_.-])/.test(name)) return 'read';
  if (/(?:^|[_.-])(write|edit|replace|delete|remove|rename|move|mkdir|apply_patch)(?:$|[_.-])/.test(name)) return 'write';
  if (/(?:bash|powershell|pwsh|shell|exec_command)/.test(name)) return 'shell';
  return 'unknown';
}
export function toolsFrom(records, opt = {}) {
  const meta = header(records), calls = [], ids = new Set(), results = new Map();
  let unrecognisedToolEvents = 0;
  for (const { line, event } of records) {
    const type = String(event.type ?? ''), data = event.data ?? event;
    if (/tool[\/_:.-](?:result|return|response)/i.test(type)) {
      walkObjects(data, value => {
        const resultId = idOf(value);
        if (!resultId) return;
        let outcome = 'unknown';
        if (value.isError === true || value.success === false || value.ok === false || (value.error !== undefined && value.error !== null && value.error !== false)) outcome = 'error';
        else if (value.isError === false || value.success === true || value.ok === true) outcome = 'success';
        results.set(String(resultId), outcome);
      });
      continue;
    }
    let count = 0;
    walkObjects(data, (o, pointer, parentId) => {
      if (typeof o.name !== 'string' || !Object.hasOwn(o, 'arguments') || o.name.length > 160) return;
      const id = idOf(o) ?? parentId ?? idOf(data);
      const key = id ? String(id) : line + ':' + pointer;
      count++;
      if (ids.has(key)) return; ids.add(key);
      let args = o.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Opaque arguments remain evidence, not parsed actions. */ } }
      const raw = typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments);
      const paths = argumentPaths(args);
      const cwd = event.cwd || data.cwd || meta.cwd || opt.workspace;
      let match = 'not-filtered';
      if (opt.path) {
        const q = npath(opt.path);
        const structured = paths.some(p => (path.isAbsolute(p) || cwd) && related(path.resolve(cwd || process.cwd(), p), opt.path));
        const needles = [q, cwd ? path.relative(cwd, opt.path).replaceAll('\\', '/') : ''].filter(s => s && !s.startsWith('../'));
        const haystack = raw.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase();
        match = structured ? 'structured-path' : needles.some(s => haystack.includes(s.toLowerCase())) ? 'literal-text-candidate' : '';
        if (!match) return;
      }
      const at = timestamp(event.time ?? event.timestamp);
      if (opt.since !== undefined && at !== null && at < opt.since) return;
      calls.push({ line, ...(id ? { callId: String(id) } : {}), ...(at !== null ? { at: new Date(at).toISOString() } : { timeUnknown: true }), name: o.name, kind: category(o.name), paths, match, ...(opt['include-args'] ? { args: raw.replace(/[\r\n]/g, ' ').slice(0, 240), argsTruncated: raw.length > 240 } : {}) });
    });
    if (!count && /tool[\/_:.-]call/i.test(type)) unrecognisedToolEvents++;
  }
  for (const call of calls) { call.resultObserved = Boolean(call.callId && results.has(call.callId)); call.outcome = call.resultObserved ? results.get(call.callId) : 'unknown'; }
  calls.sort((a, b) => b.line - a.line);
  return { calls, unrecognisedToolEvents, ...meta };
}
export function output(action) {
  try { const result = action(); console.log(JSON.stringify(result)); process.exitCode = result.complete === false ? 1 : 0; }
  catch (e) { console.error(JSON.stringify({ complete: false, error: e.code || 'ERROR', message: e.message })); process.exitCode = 2; }
}
