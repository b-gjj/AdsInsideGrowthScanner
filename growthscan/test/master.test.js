import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scored, unscored, PARENT_MAP } from '../src/lib/checks.js';
import { MASTER, SUPPORTED_MASTER_IDS, rollupMaster, masterCoverage } from '../src/lib/master.js';
import { completeChecks, buildReport } from '../src/lib/report.js';
import { CATALOG } from '../src/lib/catalog.js';
import { addSignoff, effectiveReadiness, reportSha, loadSignoff } from '../src/lib/signoff.js';

const run = (o = {}) => ({ id: 'x', failures: [], evidence: [], options: { competitors: ['a.com', 'b.com', 'c.com'], ...o } });
const S = (id, score, extra = {}) => scored(id, { score, confidence: 'high', observed: `${id} observed`, evidence: ['h/e'], ...extra });
const U = (id, code = 'BLOCKED') => unscored(id, { code, reason: 'x', evidence: [] });
const fullPass = () => completeChecks([...['TECH-02', 'TECH-03', 'TECH-04', 'TECH-05', 'TECH-08', 'TECH-09', 'JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06', 'PERF-01', 'A11Y-01', 'INTEL-02'].map((i) => S(i, 5)),
  S('TECH-06', 4, { parents: { 'AIV-02': { score: 5, observed: 'org', confidence: 'high' }, 'AIV-03': { score: 3, observed: 'prod', confidence: 'medium' } } }),
  S('JRN-07', 4, { parents: { 'CVR-15': { score: 5, observed: 'thr', confidence: 'low' }, 'CVR-17': { score: 4, observed: 'pre', confidence: 'low' } } }),
  S('JRN-08', 5, { parents: { 'CVR-16': { score: 4, observed: 'wallets', confidence: 'medium' }, 'CVR-17': { score: 3, observed: 'entry', confidence: 'low' } } }),
  S('INTEL-01', 4, { parents: { 'ACQ-05': { score: 2.5, observed: 'formats', confidence: 'low' } } })]);

test('master v1.3 registry: 35 checks, 18 supported, 17 unsupported exactly as specified', () => {
  assert.equal(MASTER.length, 35); assert.equal(SUPPORTED_MASTER_IDS.length, 18);
  const unsupported = MASTER.map((m) => m.id).filter((i) => !SUPPORTED_MASTER_IDS.includes(i)).sort();
  assert.deepEqual(unsupported, ['ACQ-10', 'AIV-01', 'AIV-04', 'AIV-05', 'AIV-06', 'AIV-08', 'AIV-10', 'AIV-11', 'AIV-12', 'AIV-17', 'AIV-18', 'AIV-19', 'CVR-03', 'CVR-05', 'CVR-08', 'CVR-09', 'CVR-18']);
});

test('parent map follows the agreed mapping; non-master runner checks are explicitly marked and never map to a master ID', () => {
  assert.deepEqual(PARENT_MAP['TECH-06'], ['AIV-02', 'AIV-03']); assert.deepEqual(PARENT_MAP['JRN-07'], ['CVR-15', 'CVR-17']); assert.deepEqual(PARENT_MAP['JRN-08'], ['CVR-16', 'CVR-17']);
  for (const id of ['TECH-01', 'TECH-07', 'TECH-11', 'JRN-01', 'INTEL-03', 'INTEL-04', 'INTEL-05', 'SEO-01']) assert.equal(PARENT_MAP[id], 'not_in_master_v1_3', id);
  for (const id of Object.keys(CATALOG)) if (CATALOG[id].class !== 'connected') assert.ok(id in PARENT_MAP, `${id} missing from map`);
  assert.ok(!SUPPORTED_MASTER_IDS.includes('AIV-04'));       // breadcrumb stays unscored until it has its own check
});

test('coverage is counted over UNIQUE master IDs, not runner checks (33 runner checks → ≤18 master checks)', () => {
  const checks = fullPass(); const r = buildReport({ checks, run: run(), evidenceVerification: { ok: true } });
  const sub = checks.filter((c) => c.class === 'outside-in').length;
  assert.ok(sub >= 33); assert.equal(r.summary.master.total, 35); assert.equal(r.summary.master.supported, 18);
  assert.ok(r.summary.master.scored <= 18, 'unique masters');
  assert.equal(r.master.filter((m) => !m.supported).every((m) => m.status === 'unscored' && m.reasonCode === 'NOT_IMPLEMENTED'), true);
  assert.equal(r.summary.runnerSubtests.total, sub);
});

test('non-master subtests (TECH-01, TECH-07, JRN-01…) can never raise master coverage or appear in customer priorities', () => {
  const only = completeChecks([S('TECH-01', 5), S('TECH-07', 5), S('TECH-11', 5), S('JRN-01', 5), S('INTEL-03', 5), S('SEO-01', 1)]);
  const r = buildReport({ checks: only, run: run(), evidenceVerification: { ok: true } });
  assert.equal(r.summary.master.scored, 0); assert.equal(r.top10.length, 0); assert.equal(r.roadmap.flatMap((p) => p.items).some((i) => i.basis === 'Confirmed finding'), false);
  assert.deepEqual(r.supporting.map((x) => x.runnerId), ['SEO-01']);        // low score → listed as supporting observation only
});

test('CVR-17 combines two subtests with separate thresholds (lowest wins); CVR-15 and CVR-16 each have their own statement', () => {
  const m = Object.fromEntries(rollupMaster(fullPass().filter((c) => c.class === 'outside-in')).map((x) => [x.masterId, x]));
  assert.equal(m['CVR-17'].score, 3); assert.match(m['CVR-17'].observed, /\[JRN-07\] pre/); assert.match(m['CVR-17'].observed, /\[JRN-08\] entry/);
  assert.equal(m['CVR-15'].score, 5); assert.equal(m['CVR-16'].score, 4); assert.notEqual(m['CVR-15'].observed, m['CVR-17'].observed);
  assert.equal(m['AIV-02'].score, 5); assert.equal(m['AIV-03'].score, 3);   // TECH-06 splits into Organization and Product
  assert.equal(m['ACQ-05'].score, 2.5);                                      // INTEL-01 count ≠ format coverage: its own parent threshold applies
});

test('LFC-12 requires SPF and DMARC; DKIM-unscored does not block it; a missing DMARC result leaves it unscored (never zero)', () => {
  let m = rollupMaster([S('TECH-08', 4), S('TECH-09', 2), U('TECH-10', 'AMBIGUOUS_ABSENCE')]).find((x) => x.masterId === 'LFC-12');
  assert.equal(m.status, 'scored'); assert.equal(m.score, 2); assert.match(m.partial, /TECH-10/);   // weakest of SPF/DMARC: p=none must not be averaged away
  m = rollupMaster([S('TECH-08', 4), U('TECH-09', 'FETCH_FAILED')]).find((x) => x.masterId === 'LFC-12');
  assert.equal(m.status, 'unscored'); assert.equal(m.score, undefined);
});

test('provisional subtests make their master provisional: excluded from Top 10 / Top 3 / roadmap, listed under re-run required', () => {
  const checks = completeChecks([S('PERF-01', 1, { confidence: 'low', detail: { provisional: true, provisionalReason: 'this scan differs from the previous scan r1 — not reproducible across sessions' } }), S('TECH-08', 4), S('TECH-09', 2)]);
  const r = buildReport({ checks, run: run(), evidenceVerification: { ok: true } });
  const where = (id) => JSON.stringify([r.top10, r.top3, r.findings]).includes(`"${id}"`);
  assert.equal(r.roadmap.flatMap((p) => p.items).filter((i) => i.masterId === 'CVR-01').some((i) => i.basis === 'Confirmed finding'), false);   // roadmap may re-validate it, never treat it as confirmed work
  assert.equal(where('CVR-01'), false); assert.equal(where('LFC-12'), true);
  assert.equal(r.rerunRequired[0].masterId, 'CVR-01'); assert.match(r.rerunRequired[0].provisionalReason, /not reproducible/);
});

test('boundary lint is a hard gate at master level', () => {
  const orig = CATALOG['TECH-09'].why; CATALOG['TECH-09'].why = 'Your ad spend is being wasted';
  try {
    const r = buildReport({ checks: completeChecks([S('TECH-08', 4), S('TECH-09', 1)]), run: run(), evidenceVerification: { ok: true } });
    assert.equal(r.findings.length, 0); assert.equal(r.integrity.suppressedFindings.length, 1); assert.ok(r.clientReady.blockers.some((b) => /suppressed/.test(b)));
  } finally { CATALOG['TECH-09'].why = orig; }
});

test('gate: hard blockers, acknowledgeable scope notice, and sign-off requirement are all explicit', () => {
  const r = buildReport({ checks: completeChecks([S('JRN-01', 5), S('JRN-02', 5, { detail: { sampleSize: 1 } })]), run: { id: 'x', failures: [], evidence: [], options: {} } });
  assert.equal(r.status, 'draft');
  for (const re of [/Evidence integrity/, /sampled 1 product/, /supported master check/, /Competitor set incomplete/, /sign-off/]) assert.ok(r.clientReady.blockers.some((b) => re.test(b)), String(re));
  assert.match(r.clientReady.acknowledgeable[0], /0 of 35|of 35 master/);
});

// ── sign-off
function signedRun(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-'));
  const report = buildReport({ checks: opts.checks || fullPass(), run: run(opts.run), evidenceVerification: { ok: true } });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report)); return { dir, report };
}
const ok = { reviewer: 'Brandon', disposition: 'approved', customerReady: true, acknowledgedScope: true, notes: 'ok' };

test('sign-off cannot approve for customers while hard blockers remain; it records reviewer, date, disposition, notes', () => {
  const { dir, report } = signedRun({ run: { competitors: [] } });                 // competitor set incomplete → hard blocker
  assert.throws(() => addSignoff(dir, report, ok, 'u'), /blockers remain/);
  const e = addSignoff(dir, report, { ...ok, customerReady: false, disposition: 'needs_rerun', notes: 'competitors missing' }, 'u');
  assert.equal(e.reviewer, 'Brandon'); assert.ok(e.at); assert.equal(e.customerReady, false);
  assert.equal(effectiveReadiness(report, reportSha(dir), loadSignoff(dir)).ready, false);
  assert.throws(() => addSignoff(dir, report, { reviewer: '', disposition: 'approved' }, 'u')); assert.throws(() => addSignoff(dir, report, { reviewer: 'B', disposition: 'looks-good' }, 'u'));
});

test('sign-off requires scope acknowledgement, binds to the exact report bytes, and goes stale if the report changes', () => {
  const det = { sampleSize: 3 };
  const clean = completeChecks([...['TECH-02', 'TECH-03', 'TECH-04', 'TECH-05', 'TECH-08', 'TECH-09', 'PERF-01', 'A11Y-01', 'INTEL-02'].map((i) => S(i, 5)), ...['JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06'].map((i) => S(i, 5, { detail: det })),
    S('TECH-06', 4, { parents: { 'AIV-02': { score: 5, observed: 'o', confidence: 'high' }, 'AIV-03': { score: 4, observed: 'p', confidence: 'high' } } }),
    S('JRN-07', 4, { detail: det, parents: { 'CVR-15': { score: 5, observed: 't', confidence: 'low' }, 'CVR-17': { score: 4, observed: 'p', confidence: 'low' } } }),
    S('JRN-08', 5, { detail: det, parents: { 'CVR-16': { score: 4, observed: 'w', confidence: 'medium' }, 'CVR-17': { score: 4, observed: 'e', confidence: 'low' } } }),
    S('INTEL-01', 4, { parents: { 'ACQ-05': { score: 4, observed: 'f', confidence: 'low' } } })]);
  const { dir, report } = signedRun({ checks: clean });
  assert.deepEqual(report.clientReady.blockers, ['No human sign-off recorded']);          // nothing else may block this fixture
  assert.equal(effectiveReadiness(report, reportSha(dir), loadSignoff(dir)).ready, false);
  assert.throws(() => addSignoff(dir, report, { ...ok, acknowledgedScope: false }, 'u'), /acknowledging/);
  addSignoff(dir, report, ok, 'u');
  assert.equal(effectiveReadiness(report, reportSha(dir), loadSignoff(dir)).ready, true);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ ...report, generatedAt: 'changed' }));
  const eff = effectiveReadiness(report, reportSha(dir), loadSignoff(dir)); assert.equal(eff.ready, false); assert.ok(eff.blockers.some((b) => /earlier version/.test(b)));
});

test('weakest-link parents: a DMARC p=none and a serious axe failure cannot be hidden by strong sibling subtests', () => {
  const r = buildReport({ checks: completeChecks([S('TECH-08', 5), S('TECH-09', 2), S('TECH-10', 4, { confidence: 'low' }), S('A11Y-01', 5), S('A11Y-02', 2)]), run: run(), evidenceVerification: { ok: true } });
  const ids = r.findings.map((f) => f.masterId); assert.ok(ids.includes('LFC-12')); assert.ok(ids.includes('CVR-19'));
  assert.equal(r.master.find((m) => m.masterId === 'LFC-12').confidence, 'high');   // DKIM (low) neither drives score nor confidence
});

// ── sample-size gate: min(3, products available); unknown catalog size still needs 3
const jr = (n) => completeChecks(['JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06'].map((i) => S(i, 5, { detail: { sampleSize: n } })));
const sampleBlockers = (n, discovery) => buildReport({ checks: jr(n), run: run(), discovery, evidenceVerification: { ok: true } }).clientReady.blockers.filter((b) => /Conversion journey sampled/.test(b));

test('one-product site: testing its single product is complete, not a blocker', () => {
  assert.deepEqual(sampleBlockers(1, { productsAvailable: 1, productsAvailableAuthoritative: true }), []);
});
test('two-product site: testing both is complete; testing one is a blocker that names the site size', () => {
  assert.deepEqual(sampleBlockers(2, { productsAvailable: 2, productsAvailableAuthoritative: true }), []);
  const b = sampleBlockers(1, { productsAvailable: 2, productsAvailableAuthoritative: true }); assert.equal(b.length, 1); assert.match(b[0], /1 product\(s\) of 2/);
});
test('large catalog still needs 3; unknown catalog size (sitemap unreadable) also needs 3 rather than trusting a partial count', () => {
  assert.equal(sampleBlockers(2, { productsAvailable: 24, productsAvailableAuthoritative: true }).length, 1);
  assert.deepEqual(sampleBlockers(3, { productsAvailable: 24, productsAvailableAuthoritative: true }), []);
  assert.equal(sampleBlockers(2, { productsAvailable: 2, productsAvailableAuthoritative: false }).length, 1);   // count came from home links only → not authoritative
  assert.equal(sampleBlockers(1, {}).length, 1);
});
