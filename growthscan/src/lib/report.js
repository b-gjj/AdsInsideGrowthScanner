// Deterministic report builder. PARENTS = GrowthScan master v1.3 checks (what customers see); SUBTESTS = runner checks (evidence layer).
// Coverage counts UNIQUE master IDs. Customer-facing sections (Top 10 / Top 3 / roadmap) hold only master-level findings that are
// (a) not provisional and (b) inside the Outside-In boundary. Supporting observations that map to no master check are listed separately.
import { CATALOG } from './catalog.js';
import { unscored } from './checks.js';
import { rollupMaster, masterCoverage } from './master.js';
import { boundaryViolations, CAN_ASSESS, CANNOT_ASSESS } from './boundary.js';
import { buildRoadmap } from './roadmap.js';

const CONF = { high: 1, medium: 0.75, low: 0.5 };
const sevOf = (s) => (s <= 1 ? 'critical' : s <= 2 ? 'high' : 'medium');
const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);

export function completeChecks(checks, harnessErrors = {}) {
  const have = new Set(checks.map((c) => c.id)); const out = [...checks];
  for (const [id, m] of Object.entries(CATALOG)) {
    if (have.has(id)) continue;
    if (m.class === 'connected') out.push(unscored(id, { code: 'NEEDS_AUTH', reason: 'Requires authenticated (Connected) access. Outside-In evidence cannot support any claim here.', evidence: [] }));
    else out.push(unscored(id, { code: 'HARNESS_FAILED', reason: harnessErrors[m.harness] ? `Harness did not complete: ${harnessErrors[m.harness]}` : 'Harness did not run or did not emit this check.', evidence: [] }));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildReport({ checks, run, discovery = {}, evidenceVerification = null }) {
  const sub = checks.filter((c) => c.class === 'outside-in'); const byId = Object.fromEntries(sub.map((c) => [c.id, c]));
  const master = rollupMaster(sub); const cov = masterCoverage(master);
  const mScored = master.filter((m) => m.status === 'scored');
  const byGroup = {}; for (const m of mScored) (byGroup[m.group] ||= []).push(m.score);
  const summary = {
    master: cov, meanScoreOfScoredMaster: mean(mScored.map((m) => m.score)), scale: '0–5 (rubric absolute-v0; not yet peer-calibrated)',
    byGroup: Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, { mean: mean(v), n: v.length }])),
    unscoredSupportedByReason: master.filter((m) => m.supported && m.status === 'unscored').reduce((a, m) => ((a[m.reasonCode] = (a[m.reasonCode] || 0) + 1), a), {}),
    runnerSubtests: { total: sub.length, scored: sub.filter((c) => c.status === 'scored').length, unscored: sub.filter((c) => c.status === 'unscored').length, note: 'Harness-level evidence checks. These are NOT master checks and are not used for customer coverage.' },
    note: 'Coverage is counted over unique master v1.3 checks. The mean covers scored master checks only; unscored and unimplemented checks are excluded, never counted as zero.',
  };

  // ── Master-level findings (hard boundary gate)
  const all = []; const suppressed = [];
  for (const m of mScored.filter((x) => x.score <= 3)) {
    const subs = m.subtests.filter((s) => s.status === 'scored').map((s) => byId[s.runnerId]).filter(Boolean).sort((a, b) => (m.subtests.find((s) => s.runnerId === a.id).score ?? 5) - (m.subtests.find((s) => s.runnerId === b.id).score ?? 5));
    const lead = subs[0]; const cm = CATALOG[lead.id];
    const f = { masterId: m.masterId, masterName: m.name, group: m.group, runnerIds: m.subtests.map((s) => s.runnerId), leadSubtest: lead.id, harness: lead.harness, theme: lead.theme,
      title: lead.detail?.findingTitle || cm.title, severity: sevOf(m.score), score: m.score, confidence: m.confidence, priority: Math.round(cm.impact * (5 - m.score) * (CONF[m.confidence] ?? 0.5) * 100) / 100,
      observed: m.observed, leadObserved: lead.observed, why: cm.why, recommendation: lead.detail?.recommendation || cm.rec, caveat: m.caveat, partial: m.partial, evidence: m.evidence, effort: cm.effort, impact: cm.impact, provisional: m.provisional, provisionalReason: m.provisionalReason };
    const v = boundaryViolations([f.title, f.observed, f.why, f.recommendation].join(' '));
    if (v.length) suppressed.push({ masterId: f.masterId, title: f.title, matched: v, action: 'removed from report; review the check text' }); else all.push(f);
  }
  all.sort((a, b) => b.priority - a.priority);
  const findings = all.filter((f) => !f.provisional);
  const rerunRequired = all.filter((f) => f.provisional).map((f) => ({ ...f, note: 'Not included in priorities or the roadmap until a re-run produces reproducible evidence.' }));
  const supporting = sub.filter((c) => c.masterStatus === 'not_in_master_v1_3' && c.status === 'scored' && c.score <= 3).map((c) => ({ runnerId: c.id, name: c.name, score: c.score, confidence: c.confidence, observed: c.observed, evidence: c.evidence, note: 'Supporting observation: no direct master v1.3 parent. Excluded from priorities, roadmap and coverage.', provisional: !!c.detail?.provisional }));
  const strengths = mScored.filter((m) => m.score >= 4.5 && !m.provisional).sort((a, b) => b.score - a.score).slice(0, 8).map((m) => ({ masterId: m.masterId, name: m.name, score: m.score, confidence: m.confidence, confirmed: m.confidence !== 'low', observed: m.observed, evidence: m.evidence }));
  const top10 = findings.slice(0, 10);
  const themes = {}; for (const f of findings) { (themes[f.theme] ||= { theme: f.theme, total: 0, items: [] }); themes[f.theme].total += f.priority; themes[f.theme].items.push(f); }
  const top3 = Object.values(themes).sort((a, b) => b.total - a.total).slice(0, 3).map((t, i) => ({ rank: i + 1, theme: t.theme, headline: t.items[0].title, action: t.items[0].recommendation, because: t.items[0].leadObserved || t.items[0].observed, masterIds: t.items.map((x) => x.masterId), priorityScore: Math.round(t.total * 100) / 100 }));
  const rm = buildRoadmap({ findings, rerunRequired, strengths: strengths.map((x) => ({ ...x })), coverage: cov, byId });
  const roadmap = rm.phases; suppressed.push(...rm.suppressed.map((x) => ({ ...x, action: 'roadmap item removed; review the playbook text' })));
  const followUps = [];
  if (sub.some((c) => c.id === 'TECH-07' && c.status === 'scored')) followUps.push({ for: 'TECH-07 (supporting)', action: 'Verify event accuracy, deduplication and server-side coverage for the detected tags', requires: 'GA4, Meta Events Manager and Google Ads access (Connected tier)' });
  if (mScored.some((m) => ['ACQ-05', 'ACQ-09'].includes(m.masterId))) followUps.push({ for: 'ACQ-05/09', action: 'Tie public creative and destinations to performance before deciding what to scale or retire', requires: 'Ad account access (Connected tier)' });
  if (rerunRequired.length) followUps.push({ for: rerunRequired.map((f) => f.masterId).join(', '), action: 'Re-run speed tests until two scans agree (and on a larger instance if variation persists)', requires: 'None' });
  followUps.push({ for: 'All', action: 'Re-run this scan after changes ship and compare scored checks run-over-run', requires: 'None' });

  // ── Client-ready gate
  const journey = sub.filter((c) => c.harness === 'h3' && c.status === 'scored'); const nSample = Math.max(0, ...journey.map((c) => c.detail?.sampleSize || 1));
  const supportedUnscored = master.filter((m) => m.supported && m.status === 'unscored');
  const blockers = []; const acknowledgeable = [];
  if (!evidenceVerification?.ok) blockers.push('Evidence integrity not verified');
  const avail = discovery.productsAvailableAuthoritative && Number.isFinite(discovery.productsAvailable) ? discovery.productsAvailable : null;
  const needSample = avail != null ? Math.max(1, Math.min(3, avail)) : 3;   // small catalogs are tested completely; unknown catalog size needs 3
  if (journey.length && nSample < needSample) blockers.push(`Conversion journey sampled ${nSample} product(s)${avail != null ? ` of ${avail} on the site` : ''}; at least ${needSample} ${avail != null ? '' : '(or an operator-selected set of 3–5) '}are needed before site-level conversion claims`);
  if (rerunRequired.length) blockers.push(`${rerunRequired.length} master finding(s) provisional (unreproducible lab data) — re-run required`);
  if (suppressed.length) blockers.push(`${suppressed.length} finding(s) suppressed by the boundary check — review`);
  if (supportedUnscored.length) blockers.push(`${supportedUnscored.length} supported master check(s) unscored: ${supportedUnscored.map((m) => `${m.masterId} (${m.reasonCode})`).join(', ')}`);
  const blocks = discovery.blocks || []; const blockVendors = [...new Set(blocks.map((b) => b.vendor))];
  if (blocks.length) blockers.push(`The target site served a bot-protection challenge (${blockVendors.join(', ')}) to the runner; site-based checks are unscored. Ask the site owner to allow the runner, or re-run from a network the site accepts`);
  const nComp = (run.options?.competitors || []).length;
  if (nComp < 3) blockers.push(`Competitor set incomplete (${nComp} supplied; 3–5 domains required for competitive claims)`);
  if (cov.unsupported) acknowledgeable.push(`Scope: this report covers ${cov.scored} of ${cov.total} master v1.3 checks (${cov.supported} supported by the runner; ${cov.unsupported} not implemented). A customer-facing report must state this limited scope.`);
  blockers.push('No human sign-off recorded');
  const clientReady = { ready: false, blockers, acknowledgeable, signoffRequired: true };
  // A scan is INCOMPLETE when bot protection blocked most of the supported checks: render a short honest report, not a thin full one.
  const blockedSupported = master.filter((m) => m.supported && m.status === 'unscored' && m.reasonCode === 'BLOCKED').length;
  const incomplete = blocks.length > 0 && cov.supported > 0 && blockedSupported >= cov.supported * 0.5;
  const seen = [...new Set(blocks.map((b) => b.seenAs).filter(Boolean))];
  const mode = incomplete ? 'incomplete' : 'standard';
  const incompleteInfo = incomplete ? { vendors: blockVendors, runnerSeenAs: seen, blockedChecks: blockedSupported, supported: cov.supported } : null;

  const failures = run.failures || [];
  return {
    status: 'draft', mode, incomplete: incompleteInfo, clientReady, masterVersion: 'v1.3', generatedAt: new Date().toISOString(), runId: run.id, target: { input: run.input, url: run.url, host: run.host },
    discovery: { pdpUrl: discovery.pdpUrl || null, pdpSource: discovery.pdpSource || null, brandKeyword: discovery.intel?.brand || null, journeySample: discovery.journeySample || null, targetBlocks: blocks, productsAvailable: discovery.productsAvailableAuthoritative ? discovery.productsAvailable : null },
    summary, master, top3, top10, findings, rerunRequired, supporting, strengths, roadmap, connectedFollowUps: followUps,
    notAssessable: checks.filter((c) => c.class === 'connected').map((c) => ({ harnessId: c.id, name: c.name })),
    boundary: { canAssess: CAN_ASSESS, cannotAssess: CANNOT_ASSESS },
    integrity: { evidence: evidenceVerification, suppressedFindings: suppressed, explicitFailures: failures.length, failuresByHarness: failures.reduce((a, f) => ((a[f.harness] = (a[f.harness] || 0) + 1), a), {}), evidenceItems: (run.evidence || []).length, rule: 'A check is scored only from positive evidence. Blocked, failed, timed-out or ambiguous evidence yields an unscored check with a reason — never a zero.' },
  };
}
