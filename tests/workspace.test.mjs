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
  // A manual page is the user's document: untouched, and no page is invented
  // next to it that would compete for the same role.
  assert.equal(fs.readFileSync(file, 'utf8'), 'old content');
  assert.equal(fs.existsSync(path.join(ws, 'AGENTS.md')), false);
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
// The default artifact directory must be a single flat directory in the
// workspace root. It used to be `conversations/<id>`, which wrapped every
// per-conversation directory in a container that bought nothing and pushed the
// shared surface one level out of view. Every other test passes `directory`
// explicitly, so the default itself went untested -- which is how the layout
// drifted away from the intended convention unnoticed.
test('the default artifact directory is flat in the workspace root, not wrapped', () => {
  const ws = workspace();
  // No explicit directory: the task id alone decides where it lands.
  const p = path.join(suite, `input-${++sequence}.json`);
  fs.writeFileSync(p, JSON.stringify({ id: 'fix-export', goal: '修复导出', state: 'doing', writes: [], next: '' }));
  const made = run(ws, 'task', { session: 'child-a', file: p });

  assert.equal(made.directory, 'fix-export');
  assert.equal(fs.existsSync(path.join(ws, 'fix-export')), true);
  assert.equal(fs.readFileSync(path.join(ws, 'fix-export/.session-id'), 'utf8').trim(), 'child-a');
  // No wrapper container is created, and nothing lives under `conversations/`.
  assert.equal(fs.existsSync(path.join(ws, 'conversations')), false);
  // The directory is visible in the shared root, which is what makes `ls` a
  // usable inventory for the coordinator.
  assert.ok(fs.readdirSync(ws).includes('fix-export'));
  // An explicit directory still wins, for dated names or nested layouts.
  task(ws, 'custom', 'child-b', { directory: 'conversation-2026-10-19-custom' });
  assert.equal(fs.existsSync(path.join(ws, 'conversation-2026-10-19-custom')), true);
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
  const p = path.join(ws, 'AGENTS.md'), before = fs.readFileSync(p, 'utf8');
  run(ws, 'summary', { session: 'main' });
  // A repeated summary must not rewrite the page: same task set, same bytes.
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  assert.equal(run(ws, 'check').ok, true);
});
test('missing/modified ownership markers are explicit scan problems', () => {
  const ws = workspace(); task(ws);
  fs.writeFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'another');
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'owner_mismatch'));
});
test('summary removal or unrelated replacement is detected', () => {
  const ws = workspace(); run(ws, 'summary', { session: 'main' });
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'unrelated content');
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'summary_content_changed'));
  fs.unlinkSync(path.join(ws, 'AGENTS.md'));
  assert.ok(run(ws, 'check').alerts.items.some(a => a.type === 'summary_missing_or_unreadable'));
});
// The page is generated into the file agent harnesses already inject before the
// first request, so "what is this directory for" is answered without anybody
// opening anything. The name is the whole point and must not drift back.
test('summary writes the coordination page to AGENTS.md and explains the directory', () => {
  const ws = workspace(); task(ws);
  const made = run(ws, 'summary', { session: 'main' });
  assert.equal(made.summary, 'AGENTS.md');
  assert.equal(fs.existsSync(path.join(ws, 'sum.md')), false);
  const page = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.ok(page.startsWith('<!-- workspace-main-conversation:agents:v1 -->'));
  // It has to answer the question a fresh agent asks, not only list tasks.
  assert.match(page, /共享工作区/);
  assert.match(page, /\.workspace\/tasks\//);
  assert.match(page, /未声明文件：0 个/);
  // The skill owns its own page: it must never be reported as undeclared.
  assert.equal(run(ws, 'audit').undeclaredCount, undefined);
  assert.equal(run(ws, 'context', { session: 'main' }).undeclaredCount, undefined);
});
test('a hand-written AGENTS.md is never overwritten by summary', () => {
  const ws = workspace(); task(ws);
  const mine = '- 本仓库用 pnpm；提交前跑 pnpm test。\n';
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), mine);
  throwsCode(() => run(ws, 'summary', { session: 'main' }), 'AGENTS_FOREIGN');
  assert.equal(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), mine);
});
test('a v2.4 sum.md generated by this skill is migrated to AGENTS.md', () => {
  const ws = workspace(); task(ws);
  const legacy = ['<!-- workspace-main-conversation:v2 -->', '# 工作区统筹', '', '旧页', ''].join('\n');
  fs.writeFileSync(path.join(ws, 'sum.md'), legacy);
  const made = run(ws, 'summary', { session: 'main' });
  assert.equal(made.migratedFrom, 'sum.md');
  assert.equal(fs.existsSync(path.join(ws, 'sum.md')), false);
  assert.ok(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8').includes('共享工作区'));
  assert.equal(run(ws, 'check').ok, true);
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
// A child that could not read its own id used to see `taskCount: 0` — the same
// bytes as a conversation with nothing to do — so it correctly did nothing and
// the work stayed invisible. The state must announce itself.
test('an unresolved identity is reported as a problem, not as an empty clean view', () => {
  const ws = workspace();
  const anon = run(ws, 'context');
  assert.equal(anon.role, 'unknown');
  assert.equal(anon.identity.status, 'unknown');
  assert.match(anon.identity.hint, /DSH_SESSION_ID/);
  assert.match(anon.identity.hint, /pwsh/);
  // A resolved conversation carries no identity block at all: the field marks
  // the broken case, so its presence is the signal.
  assert.equal(run(ws, 'context', { session: 'child-a' }).identity, undefined);
  assert.equal(run(ws, 'context', { session: 'main' }).identity, undefined);
});
test('the runtime session variable is used by the CLI, and never by in-process callers', () => {
  const ws = workspace();
  run(ws, 'task', { session: 'child-a', file: (() => {
    const p = path.join(suite, `input-${++sequence}.json`);
    fs.writeFileSync(p, JSON.stringify({ id: 'task-a', goal: '修复导出', state: 'doing', directory: 'conversations/task-a', writes: [], next: '验证结果' }));
    return p;
  })() });
  const cli = (...extra) => {
    const args = ['scripts/workspace.mjs', 'context', '--workspace', ws, ...extra];
    return spawnSync(process.execPath, args, {
      cwd: pkg, encoding: 'utf8',
      env: { ...process.env, DSH_SESSION_ID: 'child-a' },
    });
  };
  // With no --session the CLI falls back to the exported runtime variable.
  assert.equal(JSON.parse(cli().stdout).role, 'child');
  // An explicit id still wins.
  assert.equal(JSON.parse(cli('--session', 'main').stdout).role, 'main');
  // The exported function ignores the ambient environment entirely: the test
  // suite runs under pwsh, where DSH_SESSION_ID names the real conversation.
  assert.equal(execute(['context', '--workspace', ws]).role, 'unknown');
});
// Knowing `role=child` without knowing the id is still useless: the same
// conversation must then be able to register and claim. The fallback therefore
// applies to every identity-taking command, not to `context` alone.
test('the session fallback also reaches mutating commands', () => {
  const ws = workspace();
  const input = path.join(suite, `input-${++sequence}.json`);
  fs.writeFileSync(input, JSON.stringify({ id: 'task-env', goal: '修复导出', state: 'doing', directory: 'conversations/task-env', writes: [], next: '验证结果' }));
  const run = (...args) => spawnSync(process.execPath, ['scripts/workspace.mjs', ...args], {
    cwd: pkg, encoding: 'utf8', env: { ...process.env, DSH_SESSION_ID: 'child-env' },
  });
  const registered = run('task', '--workspace', ws, '--file', input);
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).id, 'task-env');
  // The task is owned by the id from the environment, not by `unknown`.
  const seen = JSON.parse(run('context', '--workspace', ws, '--session', 'child-env').stdout);
  assert.equal(seen.taskCount, 1);
  assert.equal(seen.tasks.items[0].id, 'task-env');
});

// ── finished records must not hold the workspace hostage ────────────────────
// A directory chosen wrongly used to be permanent: `task` refused any change
// with "explicitly migrate instead" while no migrate command existed, so the
// documented rule against hanging artifacts off the repository root could not
// be obeyed once broken. These tests pin both the escape hatch and the limits.
test('migrating a task directory moves the record, the marker and its own writes', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced', writes: ['misplaced/notes.md', 'shared.json'] });
  fs.writeFileSync(path.join(ws, 'misplaced/notes.md'), 'work');
  fs.writeFileSync(path.join(ws, 'shared.json'), 'shared');

  const moved = run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'conversations/task-a', 'expect-rev': 1, 'move-files': true });
  assert.equal(moved.rev, 2);
  assert.equal(moved.from, 'misplaced');
  assert.equal(moved.directory, 'conversations/task-a');
  // Content followed the move, so the declared resource still describes it.
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/notes.md'), 'utf8'), 'work');
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'utf8').trim(), 'child-a');
  assert.equal(fs.existsSync(path.join(ws, 'misplaced')), true); // emptied, not deleted
  // Writes inside the old directory follow it; unrelated declarations do not move.
  assert.deepEqual(moved.writes, ['conversations/task-a/notes.md', 'shared.json']);
  // A migration is an ordinary revision: stale callers are still refused.
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'elsewhere', 'expect-rev': 1 }), 'REVISION_MISMATCH');
  throwsCode(() => run(ws, 'migrate', { session: 'child-b', task: 'task-a', to: 'elsewhere', 'expect-rev': 2 }), 'OWNER_MISMATCH');
});
test('the directory-change error names a command that exists', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  // The reported dead end: updating the same task with a different directory.
  try {
    task(ws, 'task-a', 'child-a', { directory: 'conversations/task-a' }, { 'expect-rev': 1 });
    assert.fail('expected DIRECTORY_CHANGED');
  } catch (e) {
    assert.equal(e.code, 'DIRECTORY_CHANGED');
    // The suggested invocation must actually work, or the message is a lie.
    const [cmd, ...rest] = e.details.migrate;
    const args = [cmd];
    for (let i = 0; i < rest.length; i += 2) args.push(rest[i], String(rest[i + 1]));
    const after = execute(['migrate', ...args.slice(1)]);
    assert.equal(after.directory, 'conversations/task-a');
  }
});
// A migration must not become the way around the rules `register` enforces.
// It used to check only directory overlap -- against a version of the record
// with no writes at all -- so it accepted targets that `register` itself
// refused, and could even write a resource overlap that `register` would have
// rejected. These four tests pin each gate.
test('a live task still blocks the directory a migration targets', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  task(ws, 'task-b', 'child-b', { directory: 'conversations/task-b' });
  // The live owner's marker stops it even earlier than the overlap check; both
  // are refusals, so accept whichever gate answers first.
  assert.throws(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'conversations/task-b', 'expect-rev': 1 }),
    e => ['RESOURCE_CONFLICT', 'OWNER_MISMATCH'].includes(e.code));
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: '../escape', 'expect-rev': 1 }), 'INVALID_DIRECTORY');
});
test('a migration cannot take a directory marked by another conversation', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  fs.mkdirSync(path.join(ws, 'theirs'));
  fs.writeFileSync(path.join(ws, 'theirs', '.session-id'), 'child-b' + String.fromCharCode(10));
  // Same gate as register: a marker is a claim of authorship, not a suggestion.
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'theirs', 'expect-rev': 1 }), 'OWNER_MISMATCH');
  throwsCode(() => task(ws, 'task-b', 'child-a', { directory: 'theirs' }), 'OWNER_MISMATCH');
});
test('a migration cannot absorb an unmarked nonempty directory without --adopt', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  fs.mkdirSync(path.join(ws, 'orphan'));
  fs.writeFileSync(path.join(ws, 'orphan', 'data.txt'), 'someone else');
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'orphan', 'expect-rev': 1 }), 'ADOPTION_REQUIRED');
  // The same explicit confirmation that register requires also unlocks migrate,
  // and it writes the same ownership marker.
  const moved = run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'orphan', 'expect-rev': 1, adopt: true });
  assert.equal(moved.directory, 'orphan');
  assert.equal(fs.readFileSync(path.join(ws, 'orphan/.session-id'), 'utf8').trim(), 'child-a');
});
test('rewritten writes cannot land on a live task claim', () => {
  const ws = workspace();
  // `task-a` declares a file inside its directory; migrating rewrites that
  // declaration to follow the move, and the rewritten path is already claimed.
  task(ws, 'task-a', 'child-a', { directory: 'misplaced', writes: ['misplaced/report.md'] });
  task(ws, 'task-b', 'child-b', { directory: 'conversations/other', writes: ['conversations/shared/report.md'] });
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'conversations/shared', 'expect-rev': 1 }), 'RESOURCE_CONFLICT');
  // Nothing was written: the record still describes where it really is.
  // Canonical paths round-trip through the 8.3 short name on Windows, so compare
  // the trailing segment rather than an exact absolute path.
  assert.equal(run(ws, 'detail', { task: 'task-a' }).directory.toLowerCase().endsWith('misplaced'), true);
  // An unrelated declaration that does not move is still free, so a migration
  // is only refused for the claims it would actually create.
  const moved = run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'conversations/free', 'expect-rev': 1 });
  assert.equal(moved.directory, 'conversations/free');
});
test('a finished task releases its directory, so a cancelled mistake can be repaired', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversations/task-a', state: 'cancelled' });
  // The cancelled record no longer blocks the directory on the registry side.
  assert.deepEqual(run(ws, 'context', { session: 'main' }).alerts.items.filter(a => a.type === 'directory_overlap'), []);
  // The ownership marker is a separate lock and still wins: a directory another
  // conversation marked cannot be claimed by declaring it. That is the operator's
  // call, not a silent takeover -- the registry stays silent, the marker speaks.
  throwsCode(() => task(ws, 'task-b', 'child-b', { directory: 'conversations/task-a' }), 'OWNER_MISMATCH');
  // With the marker gone (the artifacts were discarded with the task), the
  // released directory is claimable again -- and nothing else complains.
  fs.rmSync(path.join(ws, 'conversations/task-a'), { recursive: true, force: true });
  assert.equal(task(ws, 'task-b', 'child-b', { directory: 'conversations/task-a' }).rev, 1);
  assert.deepEqual(run(ws, 'context', { session: 'main' }).alerts.items, []);
});
test('a finished task whose directory was cleared does not block check or summary', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { state: 'done' });
  task(ws, 'task-b', 'child-b', { state: 'cancelled' });
  // The user's normal tidy-up: the artifacts are no longer needed.
  fs.rmSync(path.join(ws, 'conversations/task-a'), { recursive: true, force: true });
  fs.rmSync(path.join(ws, 'conversations/task-b'), { recursive: true, force: true });

  const checked = run(ws, 'check');
  assert.equal(checked.alerts.items.some(a => ['owner_unknown', 'missing_path', 'owner_mismatch'].includes(a.type)), false);
  assert.equal(checked.complete, true);
  // The baseline this enables is the whole point: it used to be unreachable.
  assert.equal(run(ws, 'summary', { session: 'main' }).complete, true);
  assert.equal(run(ws, 'check').ok, true);
});
test('editing a finished record does not recreate its deleted directory', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { state: 'cancelled' });
  fs.rmSync(path.join(ws, 'conversations/task-a'), { recursive: true, force: true });
  task(ws, 'task-a', 'child-a', { state: 'cancelled', result: '已归档' }, { 'expect-rev': 1 });
  assert.equal(fs.existsSync(path.join(ws, 'conversations/task-a')), false);
  // A live task still gets its directory and marker created on demand.
  task(ws, 'task-b', 'child-b');
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-b/.session-id'), 'utf8').trim(), 'child-b');
});
test('a coordinator can archive its own finished record without losing artifacts', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { state: 'cancelled' });
  fs.writeFileSync(path.join(ws, 'conversations/task-a/keep.txt'), 'do not delete');
  // Unfinished work cannot be archived away, and a child cannot archive at all.
  task(ws, 'task-b', 'child-b');
  throwsCode(() => run(ws, 'archive', { session: 'main', task: 'task-b', 'expect-rev': 1, reason: 'x' }), 'INVALID_STATE');
  throwsCode(() => run(ws, 'archive', { session: 'child-a', task: 'task-a', 'expect-rev': 1, reason: 'x' }), 'NOT_MAIN');
  throwsCode(() => run(ws, 'archive', { session: 'main', task: 'task-a', 'expect-rev': 1 }), 'INVALID');
  throwsCode(() => run(ws, 'archive', { session: 'main', task: 'task-a', 'expect-rev': 9, reason: 'x' }), 'REVISION_MISMATCH');

  const done = run(ws, 'archive', { session: 'main', task: 'task-a', 'expect-rev': 1, reason: '历史记录清理' });
  assert.equal(done.directoryKept, true);
  assert.match(done.archived, /^\.workspace\/archive\//);
  // The record left the registry but its audit and its files survive.
  assert.equal(fs.existsSync(path.join(ws, '.workspace/tasks/task-a.json')), false);
  assert.equal(fs.readFileSync(path.join(ws, '.workspace/archive', path.basename(done.archived)), 'utf8').includes('历史记录清理'), true);
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/keep.txt'), 'utf8'), 'do not delete');
  assert.deepEqual(run(ws, 'context', { session: 'main' }).tasks.items.map(t => t.id), ['task-b']);
});
test('archiving is what makes a poisoned baseline recoverable end to end', () => {
  const ws = workspace();
  // The reported deadlock: a cancelled record pointing at a directory the user
  // already deleted. summary refused, so the check baseline never appeared.
  task(ws, 'task-a', 'child-a', { state: 'cancelled' });
  fs.rmSync(path.join(ws, 'conversations/task-a'), { recursive: true, force: true });
  assert.equal(run(ws, 'check').ok, false); // baseline_missing, not a scan failure
  assert.equal(run(ws, 'summary', { session: 'main' }).complete, true);
  assert.equal(run(ws, 'check').ok, true);
  const archived = run(ws, 'archive', { session: 'main', task: 'task-a', 'expect-rev': 1, reason: '目录已清理' });
  assert.equal(archived.state, 'cancelled');
  // Archiving changes registry state, so the baseline legitimately goes stale,
  // and is re-established by the next summary — the loop now terminates.
  run(ws, 'summary', { session: 'main' });
  assert.equal(run(ws, 'check').ok, true);
});

// ── undeclared-file audit ───────────────────────────────────────────────────
// `check` only walks what tasks declare, so a file nobody declared is invisible;
// two conversations could edit the same source file and `check` would still say
// ok. `unregistered` covers marked-but-unregistered directories; these cover
// loose files belonging to no artifact directory. Inventory only, never a gate.
test('audit inventories files no live task declares', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a' });
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/main.ts'), 'entry');
  fs.writeFileSync(path.join(ws, 'index.html'), 'page');
  fs.writeFileSync(path.join(ws, 'conversation-task-a/mine.txt'), 'declared');

  const audit = run(ws, 'audit');
  assert.equal(audit.undeclaredFiles, 2);
  assert.equal(audit.complete, true);
  assert.equal(audit.scope, 'undeclared-files');
  assert.deepEqual(audit.issues.items.map(g => g.path).sort(), ['.', 'src/']);
  assert.equal(audit.issues.items.some(g => g.path.includes('conversation-task-a')), false);
});
test('a declared file does not declare its whole parent directory', () => {
  const ws = workspace();
  // The regression that made audit under-report: the shared overlap helper is
  // symmetric, so one declared file under src/ marked all of src/ accounted for.
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a', writes: ['src/view/sprites.ts'] });
  fs.mkdirSync(path.join(ws, 'src/view'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src/view/sprites.ts'), 'declared');
  fs.writeFileSync(path.join(ws, 'src/view/renderer.ts'), 'orphan');
  fs.writeFileSync(path.join(ws, 'src/main.ts'), 'orphan');
  assert.equal(run(ws, 'audit').undeclaredFiles, 2);
  // Declaring the whole directory does account for everything below it.
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a', writes: ['src'] }, { 'expect-rev': 1 });
  assert.equal(run(ws, 'audit').undeclaredFiles, 0);
});
test('audit reports shape by directory and can be paged', () => {
  const ws = workspace();
  for (let i = 0; i < 7; i++) { fs.mkdirSync(path.join(ws, 'd' + i)); fs.writeFileSync(path.join(ws, 'd' + i + '/f.txt'), 'x'); }
  const first = run(ws, 'audit', { limit: 5 });
  assert.equal(first.undeclaredFiles, 7);
  assert.equal(first.issues.total, 7);
  assert.equal(first.issues.items.length, 5);
  assert.equal(first.issues.more, true);
  assert.equal(run(ws, 'audit', { limit: 5, offset: 5 }).issues.items.length, 2);
});
test('a finished task stops declaring its files, and audit never fails check', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a', state: 'cancelled', writes: ['notes.md'] });
  fs.writeFileSync(path.join(ws, 'notes.md'), 'x');
  // A finished task releases its claims, so both the declared file and the
  // artifact directory (with its marker) are undeclared again: 2 paths.
  assert.equal(run(ws, 'audit').undeclaredFiles, 2);
  // Inventory must never be a gate: the baseline still establishes, and check
  // stays ok even though an undeclared file exists.
  run(ws, 'summary', { session: 'main' });
  assert.equal(run(ws, 'check').ok, true);
});
test('context surfaces the count to the coordinator, and summary records it', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a' });
  fs.writeFileSync(path.join(ws, 'orphan.txt'), 'x');
  assert.equal(run(ws, 'context', { session: 'main' }).undeclaredCount, 1);
  assert.equal(run(ws, 'context', { session: 'child-a' }).undeclaredCount, undefined);
  fs.unlinkSync(path.join(ws, 'orphan.txt'));
  assert.equal(run(ws, 'context', { session: 'main' }).undeclaredCount, undefined);
  fs.writeFileSync(path.join(ws, 'orphan.txt'), 'x');
  run(ws, 'summary', { session: 'main' });
  assert.match(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /未声明文件：1 个/);
});
test('audit on an unenabled workspace reports rather than failing', () => {
  const ws = workspace(false);
  const r = run(ws, 'audit');
  assert.equal(r.ok, false);
  assert.equal(r.issues.items[0].type, 'not_enabled');
  assert.deepEqual(fs.readdirSync(ws), []);
});

// ── workspace shape and artifact layout ─────────────────────────────────────
// A flat default is right for an empty lot and wrong for a workspace root that
// is itself a project: its src/, tests/ and manifest must not be interleaved
// with a directory per conversation. The shape decides the default, and
// move-artifacts relocates an existing workspace.
function projectWorkspace() {
  const ws = path.join(suite, String(++sequence));
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'package.json'), '{}');
  fs.mkdirSync(path.join(ws, 'src'));
  run(ws, 'init', { session: 'main' });
  return ws;
}
test('a project root keeps its own tree and adds conversation directories beside it', () => {
  const ws = projectWorkspace();
  const p = path.join(suite, `input-${++sequence}.json`);
  fs.writeFileSync(p, JSON.stringify({ id: 'mv', goal: '做 MV', state: 'doing', writes: [], next: '' }));
  const made = run(ws, 'task', { session: 'child-a', file: p });
  // Flat by default even here: the project's own directories are untouched, and
  // the conversation directory sits beside them under its own name.
  assert.equal(made.directory, 'mv');
  const root = fs.readdirSync(ws).sort();
  assert.deepEqual(root.filter(n => !n.startsWith('.')), ['mv', 'package.json', 'src']);
});
test('the shape is reported so the layout can be explained', () => {
  const vacant = workspace();
  assert.equal(run(vacant, 'audit').workspaceShape.shape, 'vacant');
  assert.equal(run(vacant, 'audit').layout, 'flat');

  const project = projectWorkspace();
  const audit = run(project, 'audit');
  assert.equal(audit.workspaceShape.shape, 'project');
  // Flat is the default for every shape; the shape only describes the root.
  assert.equal(audit.layout, 'flat');
  assert.ok(audit.workspaceShape.evidence.includes('package.json'));
  assert.ok(audit.workspaceShape.evidence.includes('src/'));

  // A task directory in the root beside a project makes the shape "mixed".
  task(project, 'task-a', 'child-a', { directory: 'conversation-task-a' });
  assert.equal(run(project, 'audit').workspaceShape.shape, 'mixed');
  assert.deepEqual(run(project, 'audit').workspaceShape.flatConversationDirectories, ['conversation-task-a']);
});
test('move-artifacts relocates every task and its writes, both directions', () => {
  const ws = projectWorkspace();
  // Start from a container layout so there is something to flatten.
  run(ws, 'move-artifacts', { session: 'main', artifacts: 'shared', 'expect-epoch': 1 });
  task(ws, 'alpha', 'child-a', { directory: 'shared/alpha', writes: ['shared/alpha/a.txt'] });
  fs.writeFileSync(path.join(ws, 'shared/alpha/a.txt'), 'x');

  const flat = run(ws, 'move-artifacts', { session: 'main', artifacts: 'flat', 'expect-epoch': 1 });
  assert.equal(flat.layout, 'flat');
  assert.deepEqual(flat.moved, [{ task: 'alpha', from: 'shared/alpha', to: 'alpha' }]);
  // Content and the declaration both followed the move.
  assert.equal(fs.existsSync(path.join(ws, 'alpha/a.txt')), true);
  const detail = run(ws, 'detail', { task: 'alpha' });
  assert.equal(detail.directory.toLowerCase().endsWith('alpha'), true);
  assert.equal(detail.writes[0].toLowerCase().endsWith('alpha\\a.txt'), true);
  // The emptied container is gone, so "flat" really means flat.
  assert.equal(fs.existsSync(path.join(ws, 'shared')), false);

  const back = run(ws, 'move-artifacts', { session: 'main', artifacts: 'shared', 'expect-epoch': 1 });
  assert.deepEqual(back.moved, [{ task: 'alpha', from: 'alpha', to: 'shared/alpha' }]);
  assert.equal(fs.existsSync(path.join(ws, 'shared/alpha/a.txt')), true);
});
test('move-artifacts is coordinator-only and refuses to overwrite', () => {
  const ws = projectWorkspace();
  run(ws, 'move-artifacts', { session: 'main', artifacts: 'shared', 'expect-epoch': 1 });
  task(ws, 'alpha', 'child-a', { directory: 'shared/alpha', writes: ['shared/alpha/a.txt'] });
  throwsCode(() => run(ws, 'move-artifacts', { session: 'child-a', artifacts: 'flat', 'expect-epoch': 1 }), 'NOT_MAIN');
  throwsCode(() => run(ws, 'move-artifacts', { session: 'main', artifacts: 'flat', 'expect-epoch': 9 }), 'EPOCH_MISMATCH');
  throwsCode(() => run(ws, 'move-artifacts', { session: 'main', 'expect-epoch': 1 }), 'INVALID');
  // An occupied target must stop the whole move, leaving the workspace untouched.
  fs.mkdirSync(path.join(ws, 'alpha'));
  fs.writeFileSync(path.join(ws, 'alpha/occupied.txt'), 'x');
  throwsCode(() => run(ws, 'move-artifacts', { session: 'main', artifacts: 'flat', 'expect-epoch': 1 }), 'DIRECTORY_NOT_EMPTY');
  assert.equal(fs.existsSync(path.join(ws, 'shared/alpha')), true);
});
test('init accepts an explicit layout for either shape', () => {
  // A project that wants flat directories anyway.
  const proj = path.join(suite, String(++sequence));
  fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  assert.equal(run(proj, 'init', { session: 'main', artifacts: 'flat' }).layout, 'flat');
  // A vacant lot that wants a container.
  const lot = path.join(suite, String(++sequence));
  fs.mkdirSync(lot);
  const made = run(lot, 'init', { session: 'main', artifacts: 'work' });
  assert.equal(made.layout, 'container');
  assert.equal(made.artifacts, 'work');
  const p = path.join(suite, `input-${++sequence}.json`);
  fs.writeFileSync(p, JSON.stringify({ id: 't', goal: 'g', state: 'doing', writes: [], next: '' }));
  assert.equal(run(lot, 'task', { session: 'c', file: p }).directory, 'work/t');
});

// ── coordinator authority ───────────────────────────────────────────────────
// The coordinator is not a peer of the conversations it coordinates. Treating it
// as one left it unable to move a child's misplaced directory — the exact work it
// was appointed to do. The owner keeps exclusive control of content; the
// coordinator acts on placement and must state a reason, which is recorded.
test('the coordinator may move a child task directory, and the marker stays with the owner', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  fs.writeFileSync(path.join(ws, 'misplaced/work.txt'), 'x');

  const moved = run(ws, 'migrate', { session: 'main', task: 'task-a', to: 'child-work', 'expect-rev': 1, 'move-files': true, reason: '目录应放在产物目录下' });
  assert.equal(moved.directory, 'child-work');
  assert.equal(moved.actedAs, 'coordinator');
  assert.equal(moved.owner, 'child-a');
  // The directory belongs to the task, so the marker still names the child.
  assert.equal(fs.readFileSync(path.join(ws, 'child-work/.session-id'), 'utf8').trim(), 'child-a');
  assert.equal(fs.readFileSync(path.join(ws, 'child-work/work.txt'), 'utf8'), 'x');
  // The record keeps the real owner and remembers who acted.
  const detail = run(ws, 'detail', { task: 'task-a' });
  assert.equal(detail.owner, 'child-a');
  assert.equal(detail.lastActor, 'main');
  assert.equal(detail.lastReason, '目录应放在产物目录下');
});
test('a coordinator override without a reason is refused', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  throwsCode(() => run(ws, 'migrate', { session: 'main', task: 'task-a', to: 'elsewhere', 'expect-rev': 1 }), 'REASON_REQUIRED');
  // A child still cannot touch another child's task at all.
  task(ws, 'task-b', 'child-b', { directory: 'other' });
  throwsCode(() => run(ws, 'migrate', { session: 'child-a', task: 'task-b', to: 'elsewhere', 'expect-rev': 1, reason: 'x' }), 'OWNER_MISMATCH');
});
test('the coordinator may repair writes but may not seize goal or state', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced', writes: ['old/notes.md'] });
  // Placement and declarations are coordination work.
  const fixed = task(ws, 'task-a', 'child-a', { directory: 'misplaced', writes: ['new/notes.md'], next: '继续' }, { 'expect-rev': 1, reason: '修正声明', session: 'main' }, 'main');
  assert.equal(fixed.rev, 2);
  assert.equal(run(ws, 'detail', { task: 'task-a' }).owner, 'child-a');
});
test('migrate --follow remaps declarations that moved with a project', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a', writes: ['src', 'assets/logo.png', 'unrelated.txt'] });
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src/a.ts'), 'x');
  fs.mkdirSync(path.join(ws, 'assets'));
  fs.writeFileSync(path.join(ws, 'assets/logo.png'), 'x');
  fs.writeFileSync(path.join(ws, 'unrelated.txt'), 'x');
  // The project was dragged into the task directory by hand; --follow tells the
  // migration where those declarations went, so no `missing_path` storm follows.
  fs.renameSync(path.join(ws, 'src'), path.join(ws, 'conversation-task-a/src'));
  fs.renameSync(path.join(ws, 'assets'), path.join(ws, 'conversation-task-a/assets'));

  const moved = run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'conversation-task-a', 'expect-rev': 1, follow: ['src=>conversation-task-a/src', 'assets=>conversation-task-a/assets'] });
  // The directory already matches, so only the declarations change.
  assert.equal(moved.rev === 2 || moved.noChanges === true, true, JSON.stringify(moved));
  assert.equal(moved.warning, undefined, JSON.stringify(moved));
  const writes = run(ws, 'detail', { task: 'task-a' }).writes.map(w => w.replaceAll('\\', '/').split('code_workspace').pop() ?? w);
  assert.equal(writes.some(w => w.includes('conversation-task-a/src')), true);
});
test('migrate reports declarations that will be missing instead of silently keeping them', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced', writes: ['gone.txt'] });
  const moved = run(ws, 'migrate', { session: 'child-a', task: 'task-a', to: 'moved', 'expect-rev': 1 });
  // Reported, not guessed: the tool does not decide where a stale claim should go.
  assert.ok(moved.orphanedWrites.includes('gone.txt'));
  assert.match(moved.warning, /no longer exist/);
});
test('a project kept inside a conversation directory is not reported as vacant', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a' });
  fs.writeFileSync(path.join(ws, 'conversation-task-a/package.json'), '{}');
  fs.mkdirSync(path.join(ws, 'conversation-task-a/src'));
  const shape = run(ws, 'audit').workspaceShape;
  assert.equal(shape.shape, 'per-conversation-projects');
  assert.equal(shape.conversationProjects[0].directory, 'conversation-task-a');
  assert.ok(shape.conversationProjects[0].evidence.includes('package.json'));
  assert.ok(shape.conversationProjects[0].evidence.includes('src/'));
});
test('a relocation is reported as moved, not as many modifications', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'conversation-task-a' });
  fs.mkdirSync(path.join(ws, 'conversation-task-a/lib'));
  for (const n of ['a.js', 'b.js']) fs.writeFileSync(path.join(ws, 'conversation-task-a/lib/' + n), 'content-' + n);
  run(ws, 'summary', { session: 'main' });
  // Move the whole lib elsewhere, keeping content identical.
  fs.mkdirSync(path.join(ws, 'conversation-task-a/vendor'));
  for (const n of ['a.js', 'b.js']) fs.renameSync(path.join(ws, 'conversation-task-a/lib/' + n), path.join(ws, 'conversation-task-a/vendor/' + n));
  const r = run(ws, 'check');
  const stale = r.alerts.items.find(a => a.type === 'summary_files_stale');
  // Paired moves collapse into ONE entry each: the pair is not counted twice.
  assert.equal(stale.count, 2);
  assert.equal(stale.moved, 2);
  assert.equal(stale.modified, 0);
  assert.equal(stale.added, 0);
  assert.equal(stale.deleted, 0);
  const movedChange = r.changes.items.find(c => c.change === 'moved');
  assert.equal(movedChange.from, 'conversation-task-a/lib/a.js');
  // A real edit still lands in the modified bucket. Re-baseline first, so the
  // comparison is against the moved file rather than the original location.
  run(ws, 'summary', { session: 'main' });
  fs.writeFileSync(path.join(ws, 'conversation-task-a/vendor/a.js'), 'changed');
  const r2 = run(ws, 'check');
  const stale2 = r2.alerts.items.find(a => a.type === 'summary_files_stale');
  assert.equal(stale2.modified, 1);
  assert.equal(stale2.moved, 0);
});
test('audit reports a recorded layout that no longer matches the tree', () => {
  const ws = projectWorkspace();
  // Record a container, then organise by hand into the root.
  run(ws, 'move-artifacts', { session: 'main', artifacts: 'shared', 'expect-epoch': 1 });
  task(ws, 'task-a', 'child-a', { directory: 'shared/task-a' });
  fs.renameSync(path.join(ws, 'shared/task-a'), path.join(ws, 'task-a'));
  const drift = run(ws, 'audit').layoutDrift;
  assert.ok(drift);
  assert.equal(drift.recorded, 'shared');
  assert.deepEqual(drift.directories, ['task-a']);
});

// A record-only migration (no --move-files) is how a task gets pointed at a
// directory that already exists elsewhere. It must still leave a marked
// directory behind — and the marker must name the task's owner, not whoever ran
// the command. Both were broken for coordinator migrations, which no existing
// test exercised because they all passed --move-files.
test('a record-only migration leaves a directory marked for the task owner', () => {
  const ws = workspace();
  task(ws, 'task-a', 'child-a', { directory: 'misplaced' });
  const moved = run(ws, 'migrate', { session: 'main', task: 'task-a', to: 'elsewhere', 'expect-rev': 1, reason: '整理目录' });
  assert.equal(moved.moved, false);
  assert.equal(moved.directory, 'elsewhere');
  // The directory exists and belongs to the child, not to the coordinator.
  assert.equal(fs.readFileSync(path.join(ws, 'elsewhere/.session-id'), 'utf8').trim(), 'child-a');
  // And the child can still act on it afterwards.
  assert.equal(run(ws, 'detail', { task: 'task-a' }).owner, 'child-a');
  assert.equal(task(ws, 'task-a', 'child-a', { directory: 'elsewhere', next: '继续' }, { 'expect-rev': 2 }).rev, 3);
});
