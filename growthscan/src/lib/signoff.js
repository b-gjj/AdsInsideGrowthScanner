// Human sign-off record. Stored beside the run (signoff.json), bound to the exact report.json bytes it approved.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DISPOSITIONS = ['approved', 'approved_with_changes', 'needs_rerun', 'rejected'];
export const reportSha = (runDir) => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(runDir, 'report.json'))).digest('hex'); } catch { return null; } };
export const loadSignoff = (runDir) => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'signoff.json'))); } catch { return { history: [] }; } };

export function effectiveReadiness(report, sha, so) {
  const latest = (so.history || []).filter((h) => h.reportSha256 === sha).at(-1) || null;   // a sign-off only counts for the exact report it reviewed
  const cr = report.clientReady; const hard = cr.blockers.filter((b) => !/^No human sign-off/.test(b));
  const stale = (so.history || []).length > 0 && !latest;
  const blockers = [...hard];
  if (!latest) blockers.push(stale ? 'Sign-off is for an earlier version of this report — review again' : 'No human sign-off recorded');
  else if (latest.disposition !== 'approved' || !latest.customerReady) blockers.push(`Latest sign-off disposition is "${latest.disposition}"${latest.customerReady ? '' : ' without customer-ready approval'}`);
  if (latest && cr.acknowledgeable.length && !latest.acknowledgedScope) blockers.push('Sign-off does not acknowledge the limited master-check scope');
  const ready = blockers.length === 0;
  return { ready, status: ready ? 'approved' : 'draft', blockers, acknowledgeable: cr.acknowledgeable, latest, history: so.history || [] };
}

export function addSignoff(runDir, report, input, authUser) {
  const err = (m, code = 400) => Object.assign(new Error(m), { status: code });
  const reviewer = String(input.reviewer || '').trim(); if (reviewer.length < 2) throw err('Reviewer name is required.');
  if (!DISPOSITIONS.includes(input.disposition)) throw err(`Disposition must be one of: ${DISPOSITIONS.join(', ')}.`);
  const sha = reportSha(runDir); if (!sha) throw err('This run has no report to sign off.', 409);
  const customerReady = input.customerReady === true && input.disposition === 'approved';
  if (input.customerReady === true && input.disposition !== 'approved') throw err('Customer-ready approval requires the disposition "approved".');
  const hard = report.clientReady.blockers.filter((b) => !/^No human sign-off/.test(b));
  if (customerReady && hard.length) throw err(`Cannot approve for customers while blockers remain: ${hard.join(' | ')}`, 409);
  if (customerReady && report.clientReady.acknowledgeable.length && input.acknowledgedScope !== true) throw err('Approval requires acknowledging the limited master-check scope.', 409);
  const so = loadSignoff(runDir);
  const entry = { at: new Date().toISOString(), reviewer, authUser: authUser || null, disposition: input.disposition, notes: String(input.notes || '').slice(0, 2000), customerReady, acknowledgedScope: input.acknowledgedScope === true, reportSha256: sha, blockersAtSigning: report.clientReady.blockers };
  so.history.push(entry); fs.writeFileSync(path.join(runDir, 'signoff.json'), JSON.stringify(so, null, 2));
  return entry;
}
