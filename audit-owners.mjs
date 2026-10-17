import { execute } from './scripts/workspace.mjs';
try {
  const result = execute(['owners', '--workspace', process.argv[2] || '.', ...process.argv.slice(3)]);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok === false ? 1 : 0;
} catch (e) { console.error(JSON.stringify({ error: e.code || 'ERROR', message: e.message })); process.exitCode = 2; }
