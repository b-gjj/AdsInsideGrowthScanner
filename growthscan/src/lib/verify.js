// Evidence integrity gate. A report is never generated from an evidence set that doesn't verify.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function verifyEvidence(runDir, state, checks = []) {
  const problems = []; const ids = new Set();
  for (const e of state.evidence) {
    ids.add(e.id);
    const f = path.join(runDir, e.path);
    if (!fs.existsSync(f)) { problems.push({ id: e.id, problem: 'missing_file', path: e.path }); continue; }
    const buf = fs.readFileSync(f);
    if (buf.length !== e.bytes) problems.push({ id: e.id, problem: 'size_mismatch', expected: e.bytes, actual: buf.length });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== e.sha256) problems.push({ id: e.id, problem: 'hash_mismatch', expected: e.sha256.slice(0, 12), actual: sha.slice(0, 12) });
  }
  for (const c of checks) for (const id of c.evidence || []) if (!ids.has(id)) problems.push({ id, problem: 'cited_but_not_indexed', citedBy: c.id });
  return { ok: problems.length === 0, checked: state.evidence.length, problems };
}
