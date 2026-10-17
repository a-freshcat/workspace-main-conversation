import * as path from 'node:path';
import { options, sessions, readRecords, header, related, page, output } from './lib/transcripts.mjs';

output(() => {
  const opt = options(process.argv.slice(2));
  if (opt.help) return { help: 'list-sessions.mjs [--workspace PATH | --all] [--since ISO_TIME] [--limit 1..20] [--offset N] [--home DSH_HOME]' };
  const scope = opt.all ? null : opt.workspace || process.cwd();
  const found = sessions(opt.home), rows = [], issues = [...found.issues];
  for (const s of found.rows) {
    if (opt.since !== undefined && s.mtime < opt.since) continue;
    try {
      const scan = readRecords(s.file, { headerOnly: true }), meta = header(scan.records);
      if (!scan.complete) issues.push({ id: s.id, type: 'header_parse_incomplete', issues: scan.issues });
      if (!meta.cwd) { issues.push({ id: s.id, type: 'cwd_unknown' }); if (scope) continue; }
      if (scope && meta.cwd && !related(meta.cwd, scope)) continue;
      rows.push({ id: s.id, ...meta, logModifiedAt: s.modifiedAt, headerOnly: true });
    } catch (e) { issues.push({ id: s.id, type: e.code || 'READ_ERROR' }); }
  }
  rows.sort((a, b) => b.logModifiedAt.localeCompare(a.logModifiedAt) || a.id.localeCompare(b.id));
  return { complete: !issues.length, scope: scope ? path.resolve(scope) : 'all-sessions', coverage: 'header-metadata-only', sessions: page(rows, opt), issues: page(issues, opt) };
});
