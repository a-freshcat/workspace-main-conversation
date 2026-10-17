import { cli } from './scripts/workspace.mjs';
cli(['check', '--workspace', process.argv[2] || '.', ...process.argv.slice(3)]);
