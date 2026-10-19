import { cli } from './scripts/workspace.mjs';
cli(['owners', '--workspace', process.argv[2] || '.', ...process.argv.slice(3)]);
