import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { execute } from './scripts/workspace.mjs';
import { decodeAll } from './zstd-frames.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-skill-smoke-'));
try {
  const run = (cmd, ...args) => execute([cmd, '--workspace', root, ...args]);
  run('init', '--session', 'smoke-main');
  const first = run('context', '--session', 'smoke-main');
  assert.equal(run('context', '--session', 'smoke-main', '--since', first.stamp).noChanges, true);
  assert.equal(run('check').complete, true);
  run('summary', '--session', 'smoke-main');
  assert.equal(run('check').ok, true);
  let decoding = 'unavailable';
  if (typeof zlib.zstdCompressSync === 'function') {
    const sample = path.join(root, 'sample.zstd');
    fs.writeFileSync(sample, Buffer.concat(['one\n', 'two\n', 'three\n'].map(t => zlib.zstdCompressSync(Buffer.from(t)))));
    assert.equal(decodeAll(sample).text, 'one\ntwo\nthree\n');
    decoding = 'passed';
  }
  if (process.argv[2]) decodeAll(path.resolve(process.argv[2]));
  console.log(JSON.stringify({ ok: true, coordination: 'passed', multiFrameDecode: decoding, ...(decoding === 'unavailable' ? { warning: 'Runtime lacks zstd; core collaboration works, log forensics unavailable' } : {}) }));
} catch (e) { console.error(JSON.stringify({ ok: false, message: e.message })); process.exitCode = 1; }
finally {
  const target = path.resolve(root), base = path.resolve(os.tmpdir());
  const rel = path.relative(base, target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(target).startsWith('workspace-skill-smoke-')) fs.rmSync(target, { recursive: true, force: true });
}
