import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readRecords, toolsFrom, header } from '../scripts/forensics/lib/transcripts.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-skill-tests-'));
const skill = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let counter = 0;
const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
function fixture(id, events, home = path.join(root, 'home-' + ++counter)) {
  const dir = path.join(home, 'sessions', 'workspace', id); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(events.map(e => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))));
  return { home, file };
}
function run(script, home, args = []) {
  const p = spawnSync(process.execPath, [path.join(skill, script + '.mjs'), ...args, '--home', home], { encoding: 'utf8', cwd });
  return { status: p.status, result: JSON.parse((p.stdout || p.stderr).trim()), raw: p.stdout + p.stderr };
}
const start = { type: 'session/header', cwd, data: { title: 'Test session' } };
const call = (id, name = 'edit', file = 'src/a.js', at = 1700000000000) => ({ type: 'tool/call', time: at, data: { id, name, arguments: JSON.stringify({ path: file, secret: 'ARG_SECRET' }) } });
after(() => {
  const p = path.resolve(root), rel = path.relative(path.resolve(os.tmpdir()), p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(p).startsWith('detect-skill-tests-')) fs.rmSync(p, { recursive: true, force: true });
});

test('short multi-frame JSONL and records spanning frame boundaries decode completely', () => {
  const f = fixture('session-small', [start, call('1')]);
  const r = readRecords(f.file); assert.equal(r.complete, true); assert.equal(r.frames, 2); assert.equal(r.records.length, 2);
  const bytes = Buffer.from(JSON.stringify(start) + '\n' + JSON.stringify(call('2')) + '\n');
  fs.writeFileSync(f.file, Buffer.concat([bytes.subarray(0, 17), bytes.subarray(17, 80), bytes.subarray(80)].map(b => zlib.zstdCompressSync(b))));
  assert.equal(readRecords(f.file).records.length, 2);
});
test('list filters workspace before presenting rows and reports bounded output', () => {
  const home = path.join(root, 'multi');
  for (let i = 0; i < 7; i++) fixture('session-related-' + i, [start], home);
  fixture('session-other', [{ ...start, cwd: path.join(root, 'another') }], home);
  const r = run('list-sessions', home);
  assert.equal(r.status, 0); assert.equal(r.result.sessions.total, 7); assert.equal(r.result.sessions.items.length, 5); assert.equal(r.result.sessions.more, true);
  assert.ok(!r.raw.includes('session-other'));
  assert.equal(run('list-sessions', home, ['--all']).result.sessions.total, 8);
});
test('list file timestamp filtering is explicit and does not claim sessions are active', () => {
  const f = fixture('session-old', [start]); fs.utimesSync(f.file, new Date(0), new Date(0));
  const r = run('list-sessions', f.home, ['--since', '2020-01-01T00:00:00Z']);
  assert.equal(r.result.sessions.total, 0); assert.equal(r.result.coverage, 'header-metadata-only');
});
test('unknown cwd is visible as an issue rather than silently absent', () => {
  const f = fixture('session-unknown', [{ type: 'session/header', data: { title: 'Unknown' } }]);
  const r = run('list-sessions', f.home);
  assert.equal(r.status, 1); assert.ok(r.result.issues.items.some(i => i.type === 'cwd_unknown'));
});
test('peek selects recent matching calls, omits unrelated tools and user text', () => {
  const events = [start, { type: 'user/message', data: { message: { role: 'user', content: 'PRIVATE_CHAT_SENTINEL' } } }];
  for (let i = 0; i < 25; i++) events.push(call(String(i)));
  events.push(call('unrelated', 'read', 'other/file.js'));
  const f = fixture('session-recent', events);
  const r = run('peek-session', f.home, ['session-recent', '--path', path.join(cwd, 'src/a.js')]);
  assert.equal(r.status, 0); assert.equal(r.result.tools.total, 25); assert.equal(r.result.tools.items[0].callId, '24');
  assert.ok(!r.raw.includes('PRIVATE_CHAT_SENTINEL')); assert.ok(!r.raw.includes('ARG_SECRET'));
  assert.equal(r.result.tools.items[0].outcome, 'unknown');
});
test('optional arguments are snippets and preserve truncation status', () => {
  const e = call('args'); e.data.arguments = JSON.stringify({ path: 'src/a.js', text: 'x'.repeat(700) });
  const f = fixture('session-args', [start, e]);
  const r = run('peek-session', f.home, ['session-args', '--path', path.join(cwd, 'src/a.js'), '--include-args']);
  assert.equal(r.result.tools.items[0].args.length, 240); assert.equal(r.result.tools.items[0].argsTruncated, true);
});
test('ambiguous session prefixes fail; exact session and positional limit work', () => {
  const home = path.join(root, 'ambiguous'); fixture('session-alpha-one', [start, call('1'), call('2')], home); fixture('session-alpha-two', [start], home);
  assert.equal(run('peek-session', home, ['session-alpha']).result.error, 'AMBIGUOUS_SESSION');
  assert.equal(run('peek-session', home, ['session-alpha-one', '1']).result.tools.items.length, 1);
  assert.equal(run('peek-session', home).result.error, 'ARGUMENT');
});
test('missing session root is an error, not no matching sessions', () => {
  const r = run('list-sessions', path.join(root, 'missing'));
  assert.equal(r.status, 2); assert.equal(r.result.error, 'SESSIONS_ROOT_MISSING');
});
test('damaged frames and invalid JSON return incomplete instead of skipping silently', () => {
  const f = fixture('session-bad', [start, call('1')]);
  fs.appendFileSync(f.file, 'garbage');
  const r = run('peek-session', f.home, ['session-bad']); assert.equal(r.status, 1); assert.equal(r.result.complete, false);
  fs.writeFileSync(f.file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(start) + '\n{broken\n')));
  assert.equal(readRecords(f.file).complete, false);
});
test('truncated final frame is explicitly incomplete', () => {
  const f = fixture('session-tail', [start, call('1')]); const b = fs.readFileSync(f.file); fs.writeFileSync(f.file, b.subarray(0, b.length - 1));
  const r = readRecords(f.file); assert.equal(r.complete, false); assert.ok(r.issues.some(i => i.type === 'INCOMPLETE_FRAME'));
});
test('header prefix limit exposes unknown metadata beyond its window', () => {
  const events = Array.from({ length: 65 }, () => ({ type: 'noise', data: {} })); events.push(start);
  const f = fixture('session-late-header', events);
  const r = run('list-sessions', f.home);
  assert.equal(r.status, 1); assert.ok(r.result.issues.items.some(i => i.type === 'cwd_unknown'));
});
test('tool results correlate by call id, without claiming final file effects', () => {
  const records = [start, call('a'), { type: 'tool/result', data: { toolCallId: 'a', isError: false } }, call('b'), { type: 'tool/result', data: { tool_call_id: 'b', ok: false } }].map((event, i) => ({ line: i + 1, event }));
  const r = toolsFrom(records);
  assert.equal(r.calls.find(c => c.callId === 'a').outcome, 'success');
  assert.equal(r.calls.find(c => c.callId === 'b').outcome, 'error');
});
test('nested function calls and structured content retain their parent tool ids', () => {
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'do not parse me' }], tool_calls: [{ id: 'nested-id', function: { name: 'mcp__file.edit-text', arguments: { file_path: 'src/a.js' } } }] } } };
  const r = toolsFrom([{ line: 1, event: start }, { line: 2, event }], { path: path.join(cwd, 'src/a.js') });
  assert.equal(r.calls[0].callId, 'nested-id'); assert.equal(r.calls[0].name, 'mcp__file.edit-text');
  assert.equal(r.calls[0].match, 'structured-path'); assert.equal(r.calls[0].kind, 'write');
  assert.equal(header([{ line: 1, event: { data: [{ cwd, title: 'array metadata' }] } }]).cwd, cwd);
});
test('actual DSH nested tool message result shape associates with the call', () => {
  const result = { type: 'tool/result', data: { turn: 'turn-1', step: 'step-1', message: { role: 'tool', source: 'synthetic', toolCallId: 'nested-result', content: [{ type: 'text', text: 'private output' }], isError: false, id: 'message-id' } } };
  const rows = [start, call('nested-result'), result].map((event, i) => ({ line: i + 1, event }));
  const r = toolsFrom(rows);
  assert.equal(r.calls[0].resultObserved, true); assert.equal(r.calls[0].outcome, 'success');
  assert.ok(!JSON.stringify(r.calls).includes('private output'));
});
test('unrecognised tool call layouts are explicitly flagged', () => {
  const f = fixture('session-unsupported', [start, { type: 'tool/call', data: { operation: 'edit', payload: {} } }]);
  const r = run('peek-session', f.home, ['session-unsupported']);
  assert.equal(r.status, 1); assert.ok(r.result.issues.items.some(i => i.type === 'unrecognised_tool_events'));
});
test('timestamp filter keeps unknown time as uncertain evidence', () => {
  const events = [start, call('old'), call('new', 'edit', 'src/a.js', Date.now()), { type: 'tool/call', data: { name: 'write', id: 'unknown-time', arguments: { path: 'src/a.js' } } }];
  const f = fixture('session-time', events);
  const r = run('peek-session', f.home, ['session-time', '--since', '2025-01-01T00:00:00Z']);
  assert.equal(r.result.tools.total, 2); assert.equal(r.result.tools.items[0].timeUnknown, true);
});
test('opaque shell path matches are labelled as literal candidates', () => {
  const f = fixture('session-shell', [start, { type: 'tool/call', data: { name: 'exec_command', arguments: { cmd: 'node tool.js --target src/a.js', cwd } } }]);
  const r = run('peek-session', f.home, ['session-shell', '--path', path.join(cwd, 'src/a.js')]);
  assert.equal(r.result.tools.total, 1); assert.equal(r.result.tools.items[0].match, 'literal-text-candidate');
  assert.equal(r.result.tools.items[0].kind, 'shell');
});
test('CLI option validation rejects invalid pagination', () => {
  const f = fixture('session-options', [start]);
  assert.equal(run('list-sessions', f.home, ['--limit', '21']).status, 2);
  assert.equal(run('peek-session', f.home, ['session-options', '--offset', '-1']).status, 2);
});
