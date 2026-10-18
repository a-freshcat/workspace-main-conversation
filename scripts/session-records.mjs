import * as fs from 'node:fs';
import * as path from 'node:path';

// Presence of a local log is evidence about storage, never about a live process.
// Read directory names and file types only; no transcript text or decompression.
export function sessionRecords(home, owners, { maxEntries = 10000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid session scan limit');
  const wanted = new Set(owners), found = new Set(), issues = [];
  let visited = 0, limited = false;
  const issue = (type, code) => { if (issues.length < 20) issues.push({ type, ...(code ? { code } : {}) }); };
  const root = path.join(path.resolve(home), 'sessions');
  function directory(dir, visit) {
    let handle, before;
    try {
      before = fs.lstatSync(dir);
      if (!before.isDirectory() || before.isSymbolicLink()) { issue('session_directory_unavailable'); return; }
      handle = fs.opendirSync(dir);
      let entry;
      while (!limited && found.size < wanted.size && (entry = handle.readSync())) {
        if (++visited > maxEntries) { limited = true; issue('session_scan_limit'); break; }
        visit(entry);
      }
      const after = fs.lstatSync(dir);
      if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) issue('session_directory_changed');
    } catch (e) { issue('session_directory_unreadable', e.code); }
    finally { if (handle) { try { handle.closeSync(); } catch (e) { issue('session_directory_unreadable', e.code); } } }
  }
  if (wanted.size) directory(root, workspace => {
    if (workspace.isSymbolicLink()) { issue('linked_session_workspace'); return; }
    if (!workspace.isDirectory()) return;
    const dir = path.join(root, workspace.name);
    directory(dir, entry => {
      if (!wanted.has(entry.name)) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { issue('session_record_unavailable'); return; }
      try {
        const log = fs.lstatSync(path.join(dir, entry.name, 'session.v4.jsonl.zstd'));
        if (log.isFile() && !log.isSymbolicLink()) found.add(entry.name);
        else issue('session_log_not_regular');
      } catch (e) { if (e.code !== 'ENOENT') issue('session_log_unreadable', e.code); }
    });
  });
  const complete = issues.length === 0;
  return {
    scope: 'dsh-record-presence', complete, liveness: 'unknown', checkedOwners: wanted.size,
    owners: [...wanted].sort().map(owner => ({ owner, status: found.has(owner) ? 'record_present' : complete ? 'record_missing' : 'unverified' })),
    issues,
  };
}
