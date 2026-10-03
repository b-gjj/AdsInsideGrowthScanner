import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadmap, BASIS, PHASES } from '../src/lib/roadmap.js';
import { boundaryViolations } from '../src/lib/boundary.js';
import { scored, unscored } from '../src/lib/checks.js';
import { completeChecks, buildReport } from '../src/lib/report.js';

const F = (o = {}) => ({ masterId: 'CVR-10', masterName: 'PDP trust signals', title: 'Delivery timing not visible on the product page', recommendation: 'Make delivery timing visible.', leadSubtest: 'JRN-04', effort: 1, evidence: ['h3/x'], ...o });
const items = (rm) => rm.phases.flatMap((p) => p.items);
const S = (id, score, extra = {}) => scored(id, { score, confidence: 'high', observed: `${id} obs`, evidence: ['h/e'], ...extra });

test('a single quick-fix finding still produces content in all three phases, each labeled by basis', () => {
  const rm = buildRoadmap({ findings: [F()], coverage: { unsupported: 17, total: 35 } });
  assert.deepEqual(rm.phases.map((p) => p.key), ['d30', 'd60', 'd90']);
  for (const p of rm.phases) assert.ok(p.items.length > 0, p.label);
  for (const it of items(rm)) assert.ok(Object.values(BASIS).includes(it.basis), it.title);
  const cvr = items(rm).filter((i) => i.masterId === 'CVR-10'); assert.deepEqual(cvr.map((i) => i.stage), [1, 2, 3]); assert.deepEqual(cvr.map((i) => i.phase), ['d30', 'd60', 'd90']);
});

test('with NO findings the later columns are filled only by follow-through, never by invented defects', () => {
  const rm = buildRoadmap({ findings: [], coverage: { unsupported: 17, total: 35 }, strengths: [{ name: 'Indexability', confirmed: true }] });
  assert.equal(items(rm).some((i) => i.basis === BASIS.CONFIRMED), false);
  assert.ok(items(rm).some((i) => /Next priorities determined after Connected review/.test(i.title)));
  assert.ok(rm.phases.every((p) => p.items.length > 0));
});

test('only items tied to a finding carry evidence; Confirmed-finding items always do', () => {
  const rm = buildRoadmap({ findings: [F()], coverage: { unsupported: 1, total: 35 } });
  for (const it of items(rm)) if (it.basis === BASIS.CONFIRMED) assert.ok(it.evidence.length > 0); else assert.equal(it.evidence.length, 0);
});

test('DMARC sequence follows the evidence: existing rua → review reports first; no rua → add reporting first; enforced → maintain', () => {
  const f = F({ masterId: 'LFC-12', masterName: 'SPF/DKIM/DMARC', leadSubtest: 'TECH-09', title: 'DMARC missing or not enforced' });
  const run = (detail) => items(buildRoadmap({ findings: [f], byId: { 'TECH-09': { detail } }, coverage: { unsupported: 0, total: 35 } })).filter((i) => i.masterId === 'LFC-12');
  assert.match(run({ policy: 'none', hasRua: true })[0].action, /Review the existing DMARC aggregate reports/);
  assert.match(run({ policy: 'none', hasRua: false })[0].action, /Add a DMARC reporting address/);
  assert.match(run({ policy: 'none', hasRua: true })[2].action, /none to quarantine/); assert.match(run({ policy: 'reject', hasRua: true })[2].title, /Maintain enforcement/);
  assert.equal(run({ policy: 'none', hasRua: true })[2].basis, BASIS.CONDITIONAL);       // enforcement is conditional on what the reports show
});

test('large-effort findings start with scoping, implement in month two and validate in month three', () => {
  const its = items(buildRoadmap({ findings: [F({ effort: 4 })], coverage: { unsupported: 0, total: 35 } })).filter((i) => i.masterId === 'CVR-10');
  assert.deepEqual(its.map((i) => i.phase), ['d30', 'd60', 'd90']); assert.match(its[0].title, /Scope and assign an owner/); assert.equal(its[1].basis, BASIS.CONFIRMED); assert.equal(its[2].basis, BASIS.VALIDATION);
});

test('provisional speed finding: first step is a reproducible measurement, and nothing is asserted as confirmed', () => {
  const its = items(buildRoadmap({ findings: [], rerunRequired: [F({ masterId: 'CVR-01', masterName: 'Mobile page speed', leadSubtest: 'PERF-02', evidence: ['h2/x'] })], coverage: { unsupported: 0, total: 35 } })).filter((i) => i.masterId === 'CVR-01');
  assert.equal(its[0].basis, BASIS.REVALIDATE); assert.match(its[0].title, /reproducible/); assert.equal(its.some((i) => i.basis === BASIS.CONFIRMED), false);
});

test('every roadmap text the playbooks can produce passes the Outside-In boundary lint', () => {
  const masters = ['LFC-12', 'CVR-19', 'CVR-01', 'CVR-10', 'CVR-11', 'CVR-12', 'CVR-14', 'CVR-15', 'CVR-16', 'CVR-17', 'ACQ-05', 'ACQ-09', 'AIV-02', 'AIV-03', 'AIV-13', 'AIV-14', 'AIV-15', 'AIV-16'];
  for (const effort of [1, 4]) for (const prov of [false, true]) {
    const fs = masters.map((m) => F({ masterId: m, masterName: m, effort, title: 'A finding', recommendation: 'Fix it.' }));
    const rm = buildRoadmap({ findings: prov ? [] : fs, rerunRequired: prov ? fs : [], strengths: [{ name: 'Indexability', confirmed: true }], coverage: { unsupported: 17, total: 35 } });
    assert.equal(rm.suppressed.length, 0, JSON.stringify(rm.suppressed));
    for (const it of items(rm)) assert.deepEqual(boundaryViolations(it.title + ' ' + it.action), [], it.title);
  }
});

test('report integrates the staged roadmap: provisional findings only appear as re-validation steps, never as confirmed work', () => {
  const checks = completeChecks([S('TECH-08', 4), S('TECH-09', 2, { detail: { policy: 'none', pct: 100, hasRua: true } }), S('PERF-02', 1, { confidence: 'low', detail: { provisional: true, provisionalReason: 'unstable' } })]);
  const r = buildReport({ checks, run: { id: 'x', failures: [], evidence: [], options: {} }, evidenceVerification: { ok: true } });
  const all = r.roadmap.flatMap((p) => p.items);
  assert.ok(all.some((i) => i.masterId === 'LFC-12' && i.basis === BASIS.CONFIRMED));
  assert.equal(all.filter((i) => i.masterId === 'CVR-01').some((i) => i.basis === BASIS.CONFIRMED), false);
  assert.ok(r.roadmap.every((p) => p.items.length > 0));
});
