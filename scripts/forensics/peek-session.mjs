import { options, sessions, readRecords, toolsFrom, related, page, output } from './lib/transcripts.mjs';

output(() => {
  const opt = options(process.argv.slice(2), true);
  if (opt.help) return { help: 'peek-session.mjs SESSION [--workspace PATH] [--path TARGET] [--since ISO_TIME] [--limit 1..20] [--offset N] [--include-args] [--home DSH_HOME]' };
  if (!opt.session) throw Object.assign(new Error('SESSION is required; choose an id from list-sessions'), { code: 'ARGUMENT' });
  const found = sessions(opt.home);
  let matches = found.rows.filter(r => r.id === opt.session);
  if (!matches.length) matches = found.rows.filter(r => r.id.includes(opt.session));
  if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Ambiguous session id; provide an exact id' : 'Session not found'), { code: matches.length ? 'AMBIGUOUS_SESSION' : 'NOT_FOUND' });
  const target = matches[0], scan = readRecords(target.file), result = toolsFrom(scan.records, opt);
  const issues = [...found.issues, ...scan.issues];
  if (opt.workspace && result.cwd && !related(result.cwd, opt.workspace)) throw Object.assign(new Error('Session cwd is outside the requested workspace'), { code: 'WORKSPACE_MISMATCH' });
  if (opt.workspace && !result.cwd) issues.push({ type: 'cwd_unknown' });
  if (result.unrecognisedToolEvents) issues.push({ type: 'unrecognised_tool_events', count: result.unrecognisedToolEvents });
  return { complete: !issues.length, id: target.id, cwd: result.cwd || null, title: result.title, logModifiedAt: target.modifiedAt, frames: scan.frames, coverage: 'recognised-arguments-and-literal-text;effects-not-proven', tools: page(result.calls, opt), issues: page(issues, opt) };
});
