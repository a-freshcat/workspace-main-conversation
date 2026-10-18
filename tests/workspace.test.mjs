import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import { execute } from '../scripts/workspace.mjs';
import { decodeAll, splitZstdFrames } from '../zstd-frames.mjs';

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-skill-test-'));
const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let sequence = 0;
function workspace(enabled = true) {
  const ws = path.join(suite, String(++sequence)); fs.mkdirSync(ws);
  if (enabled) run(ws, 'init', { session: 'main' });
  return ws;
}
function run(ws, cmd, opts = {}) {
  const args = [cmd, '--workspace', ws];
  for (const [key, value] of Object.entries(opts)) { args.push('--' + key); if (value !== true) args.push(String(value)); }
  return execute(args);
}
function task(ws, id = 'task-a', owner = 'child-a', fields = {}, extra = {}) {
  const p = path.join(suite, `input-${++sequence}.json`);
  fs.writeFileSync(p, JSON.stringify({ id, goal: '修复导出', state: 'doing', directory: `conversations/${id}`, writes: [], next: '验证结果', ...fields }));
  return run(ws, 'task', { session: owner, file: p, ...extra });
}
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);
after(() => {
  const target = path.resolve(suite), rel = path.relative(path.resolve(os.tmpdir()), target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(target).startsWith('workspace-skill-test-')) fs.rmSync(target, { recursive: true, force: true });
});

test('unenabled workspace stays unmodified during context read', () => {
  const ws = workspace(false);
  assert.equal(run(ws, 'context', { session: 'child' }).enabled, false);
  assert.deepEqual(fs.readdirSync(ws), []);
});
test('coordinator identity is stable and another init cannot replace it', () => {
  const ws = workspace();
  throwsCode(() => run(ws, 'init', { session: 'other' }), 'MAIN_EXISTS');
  assert.equal(run(ws, 'context', { session: 'main' }).role, 'main');
  assert.equal(run(ws, 'context', { session: 'other' }).role, 'child');
  assert.equal(run(ws, 'context').role, 'unknown');
});
test('legacy sum remains intact and requires explicit adoption of management', () => {
  const ws = workspace(false), file = path.join(ws, 'sum.md'); fs.writeFileSync(file, 'old content');
  throwsCode(() => run(ws, 'init', { session: 'main' }), 'LEGACY_WORKSPACE');
  run(ws, 'init', { session: 'main', 'ack-legacy': true });
  throwsCode(() => run(ws, 'summary', { session: 'main' }), 'LEGACY_SUMMARY');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old content');
});
test('task has an explicit marker, no-op updates preserve revision, stale writes fail', () => {
  const ws = workspace();
  assert.equal(task(ws).rev, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'utf8').trim(), 'child-a');
  assert.equal(task(ws, 'task-a', 'child-a', {}, { 'expect-rev': 1 }).noChanges, true);
  assert.equal(task(ws, 'task-a', 'child-a', { next: '提交结果' }, { 'expect-rev': 1 }).rev, 2);
  throwsCode(() => task(ws, 'task-a', 'child-a', {}, { 'expect-rev': 1 }), 'REVISION_MISMATCH');
  throwsCode(() => task(ws, 'task-a', 'child-b'), 'OWNER_MISMATCH');
});
test('ordinary project directories are outside registered ownership audit', () => {
  const ws = workspace(); fs.mkdirSync(path.join(ws, 'src')); fs.mkdirSync(path.join(ws, 'docs'));
  run(ws, 'summary', { session: 'main' });
  assert.equal(run(ws, 'check').ok, true);
});
test('README references do not grant ownership; adoption is explicit', () => {
  const ws = workspace(), dir = path.join(ws, 'existing'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'Related session: child-a');
  throwsCode(() => task(ws, 'task-a', 'child-a', { directory: 'existing' }), 'ADOPTION_REQUIRED');
  task(ws, 'task-a', 'child-a', { directory: 'existing' }, { adopt: true });
  assert.equal(fs.readFileSync(path.join(dir, '.session-id'), 'utf8').trim(), 'child-a');
});
test('directory nesting and active resource prefix collisions are rejected', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversations/a', writes: ['src'] });
  throwsCode(() => task(ws, 'task-b', 'child-b', { directory: 'conversations/a/nested' }), 'RESOURCE_CONFLICT');
  throwsCode(() => task(ws, 'task-b', 'child-b', { writes: ['src/export.mjs'] }), 'RESOURCE_CONFLICT');
  task(ws, 'task-a', 'child-a', { directory: 'conversations/a', writes: ['src'], state: 'done' }, { 'expect-rev': 1 });
  assert.equal(task(ws, 'task-b', 'child-b', { writes: ['src/export.mjs'] }).rev, 1);
});
test('Windows aliases cannot bypass resource overlap checks', { skip: process.platform !== 'win32' }, () => {
  const ws = workspace(); fs.mkdirSync(path.join(ws, 'src'));
  task(ws, 'task-a', 'child-a', { writes: ['SRC'] });
  throwsCode(() => task(ws, 'task-b', 'child-b', { writes: ['src/export.mjs'] }), 'RESOURCE_CONFLICT');
});
test('metadata and outside-workspace artifact paths are rejected', () => {
  const ws = workspace();
  throwsCode(() => task(ws, 'task-a', 'child-a', { directory: '../escape' }), 'INVALID_DIRECTORY');
  throwsCode(() => task(ws, 'task-a', 'child-a', { writes: ['.workspace/config.json'] }), 'INVALID');
});
test('child brief contains only own tasks and changed views use bounded deltas', () => {
  const ws = workspace(); task(ws); task(ws, 'task-b', 'child-b');
  const a = run(ws, 'context', { session: 'child-a' });
  assert.deepEqual(a.tasks.items.map(t => t.id), ['task-a']);
  assert.equal(run(ws, 'context', { session: 'child-a', since: a.stamp }).noChanges, true);
  const main = run(ws, 'context', { session: 'main' });
  task(ws, 'task-b', 'child-b', { next: '新的下一步' }, { 'expect-rev': 1 });
  const delta = run(ws, 'context', { session: 'main', since: main.stamp });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.tasks.items.map(t => t.id), ['task-b']);
});
test('pagination retains the previous stamp until all delta pages can be read', () => {
  const ws = workspace();
  for (let i = 0; i < 7; i++) task(ws, 'task-' + i);
  const old = run(ws, 'context', { session: 'main', limit: 20 });
  for (let i = 0; i < 7; i++) task(ws, 'task-' + i, 'child-a', { next: 'changed' }, { 'expect-rev': 1 });
  const first = run(ws, 'context', { session: 'main', since: old.stamp, limit: 5 });
  assert.equal(first.tasks.more, true);
  const second = run(ws, 'context', { session: 'main', since: old.stamp, offset: 5, limit: 5 });
  assert.equal(second.mode, 'delta'); assert.equal(second.tasks.items.length, 2);
  assert.equal(second.stamp, first.stamp);
});
test('lost cache safely resets to full snapshot and new contexts do not reuse hidden cursors', () => {
  const ws = workspace(); task(ws);
  const c = run(ws, 'context', { session: 'main', since: 'missing-cache-version' });
  assert.equal(c.reset, true); assert.equal(c.tasks.total, 1);
  assert.equal(run(ws, 'context', { session: 'main' }).mode, 'snapshot');
});
test('handoff changes role; old coordinator loses summary rights', () => {
  const ws = workspace(), before = run(ws, 'context', { session: 'main' });
  throwsCode(() => run(ws, 'handoff', { session: 'main', to: 'new', 'expect-epoch': 9 }), 'EPOCH_MISMATCH');
  run(ws, 'handoff', { session: 'main', to: 'new', 'expect-epoch': 1 });
  throwsCode(() => run(ws, 'summary', { session: 'main' }), 'NOT_MAIN');
  const after = run(ws, 'context', { session: 'main', since: before.stamp });
  assert.equal(after.role, 'child'); assert.equal(after.epoch, 2);
  assert.equal(run(ws, 'context', { session: 'new' }).role, 'main');
});
test('recursive content scan catches deep/root modifications even with preserved mtime', () => {
  const ws = workspace(); task(ws, 'task-a', 'child-a', { writes: ['shared.json'] });
  const nested = path.join(ws, 'conversations/task-a/src'); fs.mkdirSync(nested);
  const source = path.join(nested, 'app.js'), shared = path.join(ws, 'shared.json');
  fs.writeFileSync(source, 'old'); fs.writeFileSync(shared, 'old');
  run(ws, 'summary', { session: 'main' });
  const st = fs.statSync(source); fs.writeFileSync(source, 'new'); fs.utimesSync(source, st.atime, st.mtime);
  fs.writeFileSync(shared, 'new');
  const r = run(ws, 'check');
  assert.equal(r.ok, false); assert.equal(r.complete, true);
  assert.deepEqual(r.changes.items.map(c => c.path).sort(), ['conversations/task-a/src/app.js', 'shared.json']);
});
test('recursive scan reports file deletion and missing resources without false success', () => {
  const ws = workspace(); task(ws);
  const p = path.join(ws, 'conversations/task-a/data.txt'); fs.writeFileSync(p, 'data');
  run(ws, 'summary', { session: 'main' }); fs.unlinkSync(p);
  assert.equal(run(ws, 'check').changes.items[0].change, 'deleted');
  task(ws, 'task-a', 'child-a', { writes: ['missing-file'] }, { 'expect-rev': 1 });
  assert.equal(run(ws, 'check').complete, false);
});
test('summary baseline is generated only by main and repeated scans are stable', () => {
  const ws = workspace(); task(ws);
  throwsCode(() => run(ws, 'summary', { session: 'child-a' }), 'NOT_MAIN');
  run(ws, 'summary', { session: 'main' });
  const p = path.join(ws, 'sum.md'), mtime = fs.statSync(p).mtimeMs;
  run(ws, 'summary', { session: 'main' });
  assert.equal(fs.statSync(p).mtimeMs, mtime); assert.equal(run(ws, 'check').ok, true);
});
test('missing/modified ownership markers are explicit scan problems', () => {
  const ws = workspace(); task(ws);
  fs.writeFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'another');
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'owner_mismatch'));
});
test('summary removal or unrelated replacement is detected', () => {
  const ws = workspace(); run(ws, 'summary', { session: 'main' });
  fs.writeFileSync(path.join(ws, 'sum.md'), 'unrelated content');
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'summary_content_changed'));
  fs.unlinkSync(path.join(ws, 'sum.md'));
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'summary_missing_or_unreadable'));
});
test('corrupted disposable cache falls back to a full snapshot', () => {
  const ws = workspace(), c = run(ws, 'context', { session: 'main' });
  const dir = path.join(ws, '.workspace/cache');
  for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '[null,{"stamp":"broken","view":{}}]');
  task(ws);
  assert.equal(run(ws, 'context', { session: 'main', since: c.stamp }).reset, true);
});
test('symlink metadata cannot redirect writes', t => {
  const ws = workspace(false), target = path.join(suite, 'outside-' + ++sequence); fs.mkdirSync(target);
  try { fs.symlinkSync(target, path.join(ws, '.workspace'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip(`Windows denied junction creation (${error.code})`);
      return;
    }
    throw error;
  }
  throwsCode(() => run(ws, 'init', { session: 'main' }), 'LINK');
  assert.deepEqual(fs.readdirSync(target), []);
});
test('unreadable/corrupt registry does not get reported as no changes', () => {
  const ws = workspace(); task(ws);
  fs.writeFileSync(path.join(ws, '.workspace/tasks/task-a.json'), '{broken');
  assert.throws(() => run(ws, 'context', { session: 'main' }));
});
test('large file scan is explicitly incomplete and cannot establish a baseline', () => {
  const ws = workspace(); task(ws);
  fs.writeFileSync(path.join(ws, 'conversations/task-a/large'), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(run(ws, 'check').complete, false);
  throwsCode(() => run(ws, 'summary', { session: 'main' }), 'INCOMPLETE');
});
test('concurrent init leaves exactly one coordinator', async () => {
  const ws = workspace(false);
  const child = name => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(pkg, 'scripts/workspace.mjs'), 'init', '--workspace', ws, '--session', name]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err }));
  });
  const results = await Promise.all([child('alpha'), child('beta')]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  const c = JSON.parse(fs.readFileSync(path.join(ws, '.workspace/config.json'), 'utf8'));
  assert.ok(['alpha', 'beta'].includes(c.main));
});

test('small and larger concatenated zstd frames roundtrip exactly', () => {
  for (const texts of [['first\n', 'second\n', 'third\n'], ['a'.repeat(300), 'b'.repeat(400), 'c'.repeat(500)]]) {
    const p = path.join(suite, `zstd-${++sequence}`), bytes = Buffer.concat(texts.map(t => zlib.zstdCompressSync(Buffer.from(t))));
    fs.writeFileSync(p, bytes);
    assert.equal(splitZstdFrames(bytes).length, 3);
    const r = decodeAll(p); assert.equal(r.text, texts.join('')); assert.equal(r.complete, true);
  }
});
test('garbage, empty input, truncated frame and trailing garbage are rejected', () => {
  const valid = zlib.zstdCompressSync(Buffer.from('valid'));
  for (const bytes of [Buffer.alloc(0), Buffer.from('garbage'), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('bad')])]) assert.throws(() => splitZstdFrames(bytes));
});
test('skippable frame is skipped by its declared size', () => {
  const h = Buffer.alloc(8); h.writeUInt32LE(0x184d2a50); h.writeUInt32LE(4, 4);
  const p = path.join(suite, `skip-${++sequence}`);
  fs.writeFileSync(p, Buffer.concat([h, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), zlib.zstdCompressSync(Buffer.from('yes'))]));
  assert.equal(decodeAll(p).text, 'yes');
});
test('CLI decoding fails nonzero for malformed files, short valid sessions pass smoke test', () => {
  const bad = path.join(suite, 'bad.zstd'), good = path.join(suite, 'good.zstd');
  fs.writeFileSync(bad, 'not-zstd'); fs.writeFileSync(good, zlib.zstdCompressSync(Buffer.from('{}\n')));
  assert.notEqual(spawnSync(process.execPath, [path.join(pkg, 'zstd-frames.mjs'), bad]).status, 0);
  assert.equal(spawnSync(process.execPath, [path.join(pkg, 'selftest-portable.mjs'), good]).status, 0);
});

// ── unregistered claims ──────────────────────────────────────────────────────
// A conversation can write into the workspace without registering. `context`
// used to read only the registry, so such a conversation was invisible to the
// coordinator no matter how much it wrote. These tests pin the marker-based
// detection that closes that gap, and the negative cases that keep it from
// turning into "every directory is suspect".
test('a marked but unregistered directory is reported to the coordinator', () => {
  const ws = workspace();
  const dir = path.join(ws, 'conversation-unregistered-example');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.session-id'), 'child-lost\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'work');

  const seen = run(ws, 'context', { session: 'main' });
  assert.equal(seen.unregisteredCount, 1);
  const [claim] = seen.unregistered.items;
  assert.equal(claim.path, 'conversation-unregistered-example');
  assert.equal(claim.owner, 'child-lost');
  assert.equal(claim.files, 2); // .session-id + notes.md
});
test('an unregistered claim is visible only to the conversation named in its marker', () => {
  const ws = workspace();
  const mine = path.join(ws, 'mine'), theirs = path.join(ws, 'theirs');
  for (const [dir, owner] of [[mine, 'child-a'], [theirs, 'child-b']]) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, '.session-id'), owner + '\n');
  }
  const a = run(ws, 'context', { session: 'child-a' });
  assert.equal(a.unregisteredCount, 1);
  assert.equal(a.unregistered.items[0].path, 'mine');
  assert.equal(run(ws, 'context', { session: 'child-b' }).unregistered.items[0].path, 'theirs');
  // A conversation with no claim of its own sees none, and is not told about others'.
  assert.equal(run(ws, 'context', { session: 'child-c' }).unregisteredCount, undefined);
});
test('registration clears the claim; ordinary directories and unmarked ones are never reported', () => {
  const ws = workspace();
  const claimed = path.join(ws, 'claimed');
  fs.mkdirSync(claimed); fs.writeFileSync(path.join(claimed, '.session-id'), 'child-a\n');
  fs.mkdirSync(path.join(ws, 'src'));        // ordinary project dir, no marker
  fs.mkdirSync(path.join(ws, 'unmarked'));   // directory without a marker
  fs.writeFileSync(path.join(ws, 'unmarked', 'a.txt'), 'x');
  assert.equal(run(ws, 'context', { session: 'main' }).unregisteredCount, 1);

  task(ws, 'task-a', 'child-a', { directory: 'claimed' }, { adopt: true });
  assert.equal(run(ws, 'context', { session: 'main' }).unregisteredCount, undefined);
});
test('a claim is reported once, not per file, and excluded roots stay excluded', () => {
  const ws = workspace();
  const dir = path.join(ws, 'busy');
  fs.mkdirSync(path.join(dir, 'deep', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.session-id'), 'child-a\n');
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'deep', 'deeper', `f${i}.txt`), 'x');
  // node_modules is excluded from the file count and never walked for markers.
  fs.mkdirSync(path.join(ws, 'node_modules')); fs.writeFileSync(path.join(ws, 'node_modules', '.session-id'), 'ghost\n');

  const seen = run(ws, 'context', { session: 'main' });
  assert.equal(seen.unregisteredCount, 1);
  assert.equal(seen.unregistered.items[0].files, 6); // marker + 5 nested files
});
