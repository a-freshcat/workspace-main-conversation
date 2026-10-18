import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execute } from '../scripts/workspace.mjs';
import { executeOrganize } from '../scripts/organize.mjs';
import { sessionRecords } from '../scripts/session-records.mjs';

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-recovery-test-'));
const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let seq = 0;
const args = (ws, cmd, opts = {}) => [cmd, '--workspace', ws, ...Object.entries(opts).flatMap(([k, v]) => v === true ? ['--' + k] : ['--' + k, String(v)])];
const run = (ws, cmd, opts) => execute(args(ws, cmd, opts));
const org = (ws, cmd, opts) => executeOrganize(args(ws, cmd, opts));
const input = value => { const p = path.join(suite, `input-${++seq}.json`); fs.writeFileSync(p, JSON.stringify(value)); return p; };
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);
const taskFile = (ws, id = 'task-a') => path.join(ws, '.workspace/tasks', id + '.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function workspace() {
  const ws = path.join(suite, `ws-${++seq}`); fs.mkdirSync(ws); run(ws, 'init', { session: 'main' }); return ws;
}
function task(ws, id = 'task-a', owner = 'child-a', fields = {}, extra = {}) {
  return run(ws, 'task', { session: owner, file: input({ id, goal: '合成任务', state: 'doing', directory: `conversations/${id}`, writes: ['shared.js'], next: '继续验证', ...fields }), ...extra });
}
function recover(ws, opts = {}) {
  return run(ws, 'recover-task', { session: 'main', action: 'cancel', task: 'task-a', from: 'child-a', 'expect-rev': 1, 'confirm-unavailable': true, reason: '用户已确认原对话不可恢复', ...opts });
}
function home() { const p = path.join(suite, `dsh-${++seq}`); fs.mkdirSync(path.join(p, 'sessions'), { recursive: true }); return p; }
function log(dsh, owner) {
  const p = path.join(dsh, 'sessions/project', owner, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'PRIVATE_LOG_BODY_NOT_ZSTD'); return p;
}
function interrupted(ws, result, change = () => {}) {
  const audit = read(path.join(ws, result.audit));
  const { completedAt, completedBy, ...op } = audit;
  fs.writeFileSync(taskFile(ws), JSON.stringify(op.before));
  change(op);
  fs.writeFileSync(path.join(ws, '.workspace/recovery-pending.json'), JSON.stringify(op));
  return op;
}
after(() => {
  const p = path.resolve(suite), rel = path.relative(path.resolve(os.tmpdir()), p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(p).startsWith('workspace-recovery-test-')) fs.rmSync(p, { recursive: true, force: true });
});

test('session checks read record presence without parsing private transcript bodies', () => {
  const ws = workspace(), dsh = home(); task(ws); log(dsh, 'child-a');
  const r = run(ws, 'session-check', { session: 'main', 'sessions-home': dsh });
  assert.equal(r.complete, true); assert.equal(r.liveness, 'unknown');
  assert.equal(r.owners.items[0].status, 'record_present');
  assert.deepEqual(r.owners.items[0].tasks, ['task-a']);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_LOG_BODY'));
});
test('session inspection and recovery do not initialize an unmanaged workspace', () => {
  const ws = path.join(suite, `unmanaged-${++seq}`); fs.mkdirSync(ws);
  throwsCode(() => run(ws, 'session-check', { session: 'main', 'sessions-home': home() }), 'NOT_ENABLED');
  throwsCode(() => recover(ws), 'NOT_ENABLED');
  assert.deepEqual(fs.readdirSync(ws), []);
});
test('removing a session log changes the main delta, keeps the task, and clears when restored', () => {
  const ws = workspace(), dsh = home(); task(ws); const file = log(dsh, 'child-a');
  const opts = { session: 'main', 'sessions-home': dsh };
  const before = run(ws, 'context', opts);
  fs.unlinkSync(file);
  const after = run(ws, 'context', { ...opts, since: before.stamp });
  assert.equal(after.mode, 'delta');
  assert.ok(after.alerts.items.some(a => a.type === 'owner_record_missing' && a.owner === 'child-a'));
  assert.equal(read(taskFile(ws)).state, 'doing');
  log(dsh, 'child-a');
  const restored = run(ws, 'context', { ...opts, since: after.stamp });
  assert.ok(restored.resolvedAlerts.items.some(a => a.type === 'owner_record_missing'));
});
test('an unavailable session store reports incomplete rather than declaring every owner missing', () => {
  const ws = workspace(); task(ws);
  const r = run(ws, 'context', { session: 'main', 'sessions-home': path.join(suite, 'absent') });
  assert.equal(r.sessionCheck.complete, false);
  assert.ok(r.alerts.items.some(a => a.type === 'session_check_incomplete'));
  assert.ok(!r.alerts.items.some(a => a.type === 'owner_record_missing'));
});
test('bounded session enumeration leaves absent owners unverified when coverage is incomplete', () => {
  const dsh = home(); log(dsh, 'unrelated');
  const limited = sessionRecords(dsh, ['missing'], { maxEntries: 1 });
  assert.equal(limited.complete, false); assert.equal(limited.owners[0].status, 'unverified');
  const full = sessionRecords(dsh, ['missing']);
  assert.equal(full.complete, true); assert.equal(full.owners[0].status, 'record_missing');
});
test('context discloses an unconfigured check and does not consult ambient environment in process', () => {
  const ws = workspace(); task(ws);
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home();
  try { assert.equal(run(ws, 'context', { session: 'main' }).sessionCheck.status, 'not-configured'); }
  finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; }
  assert.equal(run(ws, 'context', { session: 'child-a', 'sessions-home': home() }).sessionCheck, undefined);
  throwsCode(() => run(ws, 'session-check', { session: 'main' }), 'SESSION_SOURCE_REQUIRED');
  throwsCode(() => run(ws, 'session-check', { session: 'child-a', 'sessions-home': home() }), 'NOT_MAIN');
});
test('CLI uses the runtime session store while an explicit store takes priority', () => {
  const ws = workspace(), dsh = home(), other = home(); task(ws); log(dsh, 'child-a');
  const invoke = extra => spawnSync(process.execPath, ['scripts/workspace.mjs', ...args(ws, 'context'), ...extra], { cwd: pkg, encoding: 'utf8', env: { ...process.env, DSH_SESSION_ID: 'main', DSH_HOME: dsh } });
  const automatic = invoke([]); assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(JSON.parse(automatic.stdout).sessionCheck.complete, true);
  assert.equal(JSON.parse(automatic.stdout).alertCount, 0);
  assert.ok(JSON.parse(invoke(['--sessions-home', other]).stdout).alerts.items.some(a => a.type === 'owner_record_missing'));
});
test('session checks paginate child owners and exclude completed tasks', () => {
  const ws = workspace(), dsh = home();
  for (let i = 0; i < 7; i++) task(ws, `task-${i}`, `child-${i}`, { writes: [] });
  task(ws, 'finished', 'past-child', { state: 'done', writes: [] });
  const first = run(ws, 'session-check', { session: 'main', 'sessions-home': dsh });
  assert.equal(first.owners.total, 7); assert.equal(first.owners.items.length, 5);
  const last = run(ws, 'session-check', { session: 'main', 'sessions-home': dsh, offset: 5 });
  assert.equal(last.owners.items.length, 2);
});
test('recovery requires the main, explicit confirmation, exact owner and current revision', () => {
  const ws = workspace(); task(ws); const before = fs.readFileSync(taskFile(ws), 'utf8');
  throwsCode(() => recover(ws, { session: 'child-a' }), 'NOT_MAIN');
  throwsCode(() => run(ws, 'recover-task', { session: 'main', action: 'cancel', task: 'task-a' }), 'CONFIRMATION_REQUIRED');
  throwsCode(() => recover(ws, { from: 'other' }), 'OWNER_MISMATCH');
  throwsCode(() => recover(ws, { 'expect-rev': 9 }), 'REVISION_MISMATCH');
  throwsCode(() => recover(ws, { reason: '' }), 'INVALID');
  assert.equal(fs.readFileSync(taskFile(ws), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(ws, '.workspace/recovery-pending.json')), false);
});
test('cancelled orphan tasks release shared writes while retaining files, provenance and audit', () => {
  const ws = workspace(); task(ws);
  const dir = path.join(ws, 'conversations/task-a'), file = path.join(dir, 'work.txt'); fs.writeFileSync(file, 'keep me');
  const result = recover(ws);
  assert.equal(result.state, 'cancelled'); assert.equal(result.rev, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(dir, '.session-id'), 'utf8').trim(), 'child-a');
  assert.deepEqual(Object.keys(read(taskFile(ws))).sort(), ['id', 'owner', 'goal', 'state', 'directory', 'writes', 'next', 'result', 'evidence', 'rev', 'updatedAt'].sort());
  assert.equal(read(path.join(ws, result.audit)).before.owner, 'child-a');
  assert.equal(task(ws, 'replacement', 'new-child').rev, 1);
  assert.equal(run(ws, 'context', { session: 'main' }).tasks.items.find(t => t.id === 'task-a').state, 'cancelled');
});
test('reassignment transfers the existing directory and leaves update authority with the new owner', () => {
  const ws = workspace(); task(ws);
  const file = path.join(ws, 'conversations/task-a/keep.txt'); fs.writeFileSync(file, 'keep');
  const result = recover(ws, { action: 'reassign', to: 'new-child' });
  assert.equal(result.state, 'planned'); assert.equal(result.owner, 'new-child');
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'utf8').trim(), 'new-child');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.equal(run(ws, 'context', { session: 'new-child' }).tasks.items[0].id, 'task-a');
  throwsCode(() => task(ws, 'task-a', 'child-a', {}, { 'expect-rev': 2 }), 'OWNER_MISMATCH');
  assert.equal(task(ws, 'task-a', 'new-child', { state: 'planned' }, { 'expect-rev': 2 }).noChanges, true);
  assert.equal(task(ws, 'task-a', 'new-child', {}, { 'expect-rev': 2 }).rev, 3);
  assert.equal(read(path.join(ws, result.audit)).after.rev, 2);
});
test('reassigning a blocked task preserves its blocker instead of declaring it runnable', () => {
  const ws = workspace(); task(ws, 'task-a', 'child-a', { state: 'blocked', next: '等待依赖修复' });
  recover(ws, { action: 'reassign', to: 'new-child' });
  const t = read(taskFile(ws)); assert.equal(t.state, 'blocked'); assert.equal(t.next, '等待依赖修复');
});
test('finished tasks, coordinator tasks and ambiguous recovery actions are rejected', () => {
  const ws = workspace(); task(ws);
  throwsCode(() => recover(ws, { action: 'reassign', to: 'child-a' }), 'INVALID');
  throwsCode(() => recover(ws, { action: 'reassign', to: 'unknown' }), 'IDENTITY_UNKNOWN');
  throwsCode(() => recover(ws, { to: 'new-child' }), 'INVALID');
  task(ws, 'task-a', 'child-a', { state: 'done' }, { 'expect-rev': 1 });
  throwsCode(() => recover(ws, { 'expect-rev': 2 }), 'INVALID_STATE');
  task(ws, 'main-task', 'main', { writes: [] });
  throwsCode(() => recover(ws, { task: 'main-task', from: 'main' }), 'INVALID');
});
test('mismatched ownership markers stop reassignment without changing the task or artifact', () => {
  const ws = workspace(); task(ws);
  const marker = path.join(ws, 'conversations/task-a/.session-id'); fs.writeFileSync(marker, 'someone-else');
  throwsCode(() => recover(ws, { action: 'reassign', to: 'new-child' }), 'OWNER_MISMATCH');
  assert.equal(read(taskFile(ws)).rev, 1); assert.equal(fs.readFileSync(marker, 'utf8'), 'someone-else');
  assert.equal(fs.existsSync(path.join(ws, '.workspace/recovery-pending.json')), false);
});
test('pending organization plans must be cancelled with copies retained before task recovery', () => {
  const ws = workspace(); task(ws); fs.writeFileSync(path.join(ws, 'notes.txt'), 'artifact');
  const plan = org(ws, 'propose', { session: 'main', file: input({ id: 'gather', task: 'task-a', files: [{ source: 'notes.txt', target: 'notes.txt' }], evidence: ['合成测试'] }) });
  const accepted = org(ws, 'accept', { session: 'child-a', plan: plan.id, digest: plan.digest, 'expect-rev': plan.rev });
  const copied = org(ws, 'copy', { session: 'child-a', plan: plan.id, 'expect-rev': accepted.rev });
  throwsCode(() => recover(ws, { action: 'reassign', to: 'new-child' }), 'PENDING_ORGANIZATION');
  org(ws, 'cancel', { session: 'main', plan: plan.id, 'expect-rev': copied.rev });
  recover(ws, { action: 'reassign', to: 'new-child' });
  assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'artifact');
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/notes.txt'), 'utf8'), 'artifact');
});
test('an interrupted transfer is visible, blocks writers and resumes without another revision', () => {
  const ws = workspace(); task(ws); const result = recover(ws, { action: 'reassign', to: 'new-child' });
  interrupted(ws, result); // marker is new, task is old: an interrupted two-file write
  assert.ok(run(ws, 'context', { session: 'main' }).alerts.items.some(a => a.type === 'recovery_pending'));
  assert.equal(run(ws, 'check').ok, false);
  throwsCode(() => task(ws, 'task-a', 'child-a', {}, { 'expect-rev': 1 }), 'RECOVERY_PENDING');
  throwsCode(() => run(ws, 'handoff', { session: 'main', to: 'another-main', 'expect-epoch': 1 }), 'RECOVERY_PENDING');
  throwsCode(() => run(ws, 'recover-task', { session: 'new-child', resume: 'pending' }), 'NOT_MAIN');
  assert.equal(run(ws, 'recover-task', { session: 'main', resume: 'pending' }).rev, 2);
  assert.equal(fs.existsSync(path.join(ws, '.workspace/recovery-pending.json')), false);
  assert.equal(read(taskFile(ws)).owner, 'new-child');
  assert.equal(run(ws, 'recover-task', { session: 'main', resume: result.recovery }).noChanges, true);
});
test('resume refuses unrelated task or marker changes and preserves the pending evidence', () => {
  const ws = workspace(); task(ws); const result = recover(ws, { action: 'reassign', to: 'new-child' });
  interrupted(ws, result);
  const marker = path.join(ws, 'conversations/task-a/.session-id'); fs.writeFileSync(marker, 'intruder');
  throwsCode(() => run(ws, 'recover-task', { session: 'main', resume: 'pending' }), 'RECOVERY_CHANGED');
  assert.equal(read(taskFile(ws)).rev, 1); assert.equal(fs.readFileSync(marker, 'utf8'), 'intruder');
  assert.equal(fs.existsSync(path.join(ws, '.workspace/recovery-pending.json')), true);
});
test('resume completes prepared or applied transactions even when the final audit was not written', () => {
  for (const stage of ['prepared', 'applied']) {
    const ws = workspace(); task(ws); const result = recover(ws, { action: 'reassign', to: 'new-child' });
    const op = interrupted(ws, result);
    fs.unlinkSync(path.join(ws, result.audit));
    if (stage === 'prepared') fs.writeFileSync(path.join(ws, 'conversations/task-a/.session-id'), op.marker);
    else fs.writeFileSync(taskFile(ws), JSON.stringify(op.after));
    assert.equal(run(ws, 'recover-task', { session: 'main', resume: 'pending' }).rev, 2);
    assert.equal(read(path.join(ws, result.audit)).after.owner, 'new-child');
    assert.equal(run(ws, 'owners').ok, true);
  }
});
test('resume does not overwrite an externally changed task snapshot', () => {
  const ws = workspace(); task(ws); const result = recover(ws);
  const op = interrupted(ws, result);
  fs.writeFileSync(taskFile(ws), JSON.stringify({ ...op.before, next: '外部已变更' }));
  throwsCode(() => run(ws, 'recover-task', { session: 'main', resume: 'pending' }), 'RECOVERY_CHANGED');
  assert.equal(read(taskFile(ws)).next, '外部已变更');
});
test('tampered recovery journals cannot broaden resource claims', () => {
  const ws = workspace(); task(ws); const result = recover(ws);
  interrupted(ws, result, op => { op.after.writes.push(path.join(ws, 'another-resource')); });
  throwsCode(() => run(ws, 'recover-task', { session: 'main', resume: 'pending' }), 'REGISTRY_DAMAGED');
  assert.equal(read(taskFile(ws)).rev, 1);
});
test('invalid recovery storage fails before any task or ownership mutation', () => {
  const ws = workspace(); task(ws); fs.writeFileSync(path.join(ws, '.workspace/recoveries'), 'not a directory');
  assert.throws(() => recover(ws, { action: 'reassign', to: 'new-child' }));
  assert.equal(read(taskFile(ws)).rev, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'conversations/task-a/.session-id'), 'utf8').trim(), 'child-a');
  const another = workspace(); task(another); const result = recover(another);
  const auditFile = path.join(another, result.audit);
  const { completedAt, completedBy, ...prepared } = read(auditFile);
  fs.writeFileSync(auditFile, JSON.stringify(prepared));
  throwsCode(() => run(another, 'recover-task', { session: 'main', resume: result.recovery }), 'REGISTRY_DAMAGED');
});
test('cancelling an orphan whose artifact was removed does not recreate or delete files', () => {
  const ws = workspace(); task(ws);
  const dir = path.join(ws, 'conversations/task-a'); fs.rmSync(dir, { recursive: true });
  assert.equal(recover(ws).state, 'cancelled'); assert.equal(fs.existsSync(dir), false);
});
test('successive confirmed transfers retain their audits and reject the former owner', () => {
  const ws = workspace(); task(ws);
  const first = recover(ws, { action: 'reassign', to: 'next-child' });
  throwsCode(() => recover(ws, { action: 'reassign', to: 'third-child', 'expect-rev': 2 }), 'OWNER_MISMATCH');
  const second = recover(ws, { action: 'reassign', to: 'third-child', from: 'next-child', 'expect-rev': 2 });
  assert.equal(read(taskFile(ws)).owner, 'third-child');
  assert.equal(read(path.join(ws, first.audit)).after.owner, 'next-child');
  assert.equal(read(path.join(ws, second.audit)).before.rev, 2);
});
