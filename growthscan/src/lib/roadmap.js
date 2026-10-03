// 90-day roadmap. Phases are ordered by DEPENDENCY (fix → validate → extend), not by effort, so later columns are never empty by accident.
// Every item carries a `basis` so follow-through is never mistaken for a finding:
//   Confirmed finding · Requires validation · Validation of completed work · Requires Connected access · Conditional on results and approval · Scope extension
// Nothing here invents an opportunity: where the next step depends on data this scan cannot see, the item says so and names the review required.
import { boundaryViolations } from './boundary.js';

export const BASIS = {
  CONFIRMED: 'Confirmed finding', REVALIDATE: 'Requires validation', VALIDATION: 'Validation of completed work',
  CONNECTED: 'Requires Connected access', CONDITIONAL: 'Conditional on results and approval', SCOPE: 'Scope extension',
};
export const PHASES = [
  { key: 'd30', label: 'Days 1–30', purpose: 'Fix and establish', blurb: 'Implement approved fixes, assign owners, and establish baselines.' },
  { key: 'd60', label: 'Days 31–60', purpose: 'Validate and test', blurb: 'Confirm the fixes worked and investigate what public evidence cannot show.' },
  { key: 'd90', label: 'Days 61–90', purpose: 'Extend and optimize', blurb: 'Extend what worked, guard against regressions, and set the next priorities.' },
];
const item = (phase, masterId, initiative, stage, title, action, basis, evidence = []) => ({ phase, masterId, initiative, stage, title, action, basis, evidence });

const GROUP = (id) => id.split('-')[0];
const JOURNEY = new Set(['CVR-10', 'CVR-11', 'CVR-12', 'CVR-14', 'CVR-15', 'CVR-16', 'CVR-17']);

// Per-initiative staging: returns [fix, validate, extend] items. `d` = structured detail from the lead subtest, if any.
function stages(f, d) {
  const id = f.masterId; const T = f.title;
  if (id === 'LFC-12') {
    const hasRua = d?.hasRua; const enforced = d?.policy === 'reject';
    return [
      [BASIS.CONFIRMED, 'Inventory legitimate senders', hasRua
        ? 'Review the existing DMARC aggregate reports and list every service that sends mail as the domain (email platform, helpdesk, store notifications). Confirm each passes SPF or DKIM aligned with the domain.'
        : 'Add a DMARC reporting address (rua), then list every service that sends mail as the domain (email platform, helpdesk, store notifications) and confirm each passes SPF or DKIM aligned with the domain.'],
      [BASIS.VALIDATION, 'Resolve alignment gaps and verify DKIM', 'Review a month of aggregate reports, fix senders that fail alignment, and confirm DKIM is configured in each sending platform (DKIM selectors cannot be verified from outside). Re-run the DNS checks.'],
      [BASIS.CONDITIONAL, enforced ? 'Maintain enforcement' : 'Move toward enforcement', enforced ? 'Keep monitoring reports for new senders and alignment failures.' : 'If reports show only legitimate, aligned senders, move the policy from none to quarantine (starting at a partial percentage), then to reject, and keep monitoring reports.'],
    ];
  }
  if (id === 'CVR-19') return [
    [BASIS.CONFIRMED, T, f.recommendation],
    [BASIS.VALIDATION, 'Re-test and add expert review', 'Re-run the automated accessibility scan, then add a manual review (keyboard navigation, screen reader, zoom). Automated scans cover only part of accessibility.'],
    [BASIS.CONDITIONAL, 'Make accessibility part of release QA', 'Add automated accessibility checks to the release process so fixed issues do not return.'],
  ];
  if (id === 'CVR-01') return [
    [BASIS.REVALIDATE, 'Re-run speed tests until results are reproducible', 'Lab speed results were unstable. Re-run on a larger instance or at a quieter time until two scans agree before prioritizing speed work.'],
    [BASIS.CONDITIONAL, 'Act on the stable bottleneck', 'Once results are reproducible, address the largest confirmed bottleneck (for example the largest-contentful-paint element or third-party scripts) and add real-user field data (CrUX).'],
    [BASIS.CONDITIONAL, 'Hold the gain', 'Set a performance budget for the page templates and re-test after each release.'],
  ];
  if (JOURNEY.has(id)) return [
    [BASIS.CONFIRMED, T, f.recommendation],
    [BASIS.VALIDATION, 'Re-run the sampled journey', 'After the change ships, re-run the shopping journey on the same products (plus any best sellers not yet tested) and compare this check.'],
    [BASIS.CONDITIONAL, 'Extend across product templates', 'If the re-run confirms the change, apply it to the remaining product templates. Treat it as a test candidate once Connected funnel data is available.'],
  ];
  if (GROUP(id) === 'ACQ') return [
    [BASIS.CONFIRMED, T, f.recommendation],
    [BASIS.CONNECTED, 'Compare against ad-account results', 'Review the affected creative and destinations against results in the Connected ad accounts before deciding what to change.'],
    [BASIS.CONDITIONAL, 'Scale or retire based on results', 'Act on the Connected review: expand what performs, retire what does not.'],
  ];
  return [
    [BASIS.CONFIRMED, T, f.recommendation],
    [BASIS.VALIDATION, 'Re-run the affected checks', 'After the change ships, re-run the scan and confirm this check improved.'],
    [BASIS.CONDITIONAL, 'Add to the release checklist', 'Add this check to the release checklist so the improvement is maintained.'],
  ];
}

export function buildRoadmap({ findings, rerunRequired = [], strengths = [], coverage, byId = {} }) {
  const cols = Object.fromEntries(PHASES.map((p) => [p.key, []]));
  const suppressed = [];
  const push = (it) => { const v = boundaryViolations([it.title, it.action].join(' ')); if (v.length) suppressed.push({ masterId: it.masterId, title: it.title, matched: v }); else cols[it.phase].push(it); };

  // 1) Initiatives from confirmed findings (highest priority first), staged by dependency.
  for (const f of findings) {
    const lead = byId[f.leadSubtest]; const st = stages(f, lead?.detail);
    const plan = f.effort >= 4 ? [['d30', 'Scope and assign an owner', `Define the scope for “${f.title}”, name an owner, and agree what done looks like.`, BASIS.CONFIRMED], ['d60', st[0][1], st[0][2], st[0][0]], ['d90', st[1][1], st[1][2], st[1][0]]].map(([ph, t, a, b]) => [ph, t, a, b])
      : [['d30', st[0][1], st[0][2], st[0][0]], ['d60', st[1][1], st[1][2], st[1][0]], ['d90', st[2][1], st[2][2], st[2][0]]];
    plan.forEach(([ph, t, a, b], i) => push(item(ph, f.masterId, `${f.masterId} ${f.masterName}`, i + 1, t, a, b, i === 0 ? f.evidence : [])));
  }
  // 2) Provisional findings: the first step is getting a reproducible measurement, not acting on an unstable one.
  for (const f of rerunRequired) {
    const st = stages(f, byId[f.leadSubtest]?.detail);
    st.forEach(([b, t, a], i) => push(item(PHASES[i].key, f.masterId, `${f.masterId} ${f.masterName}`, i + 1, t, a, b, i === 0 ? f.evidence : [])));
  }
  // 3) Standing items: follow-through that does not depend on any specific finding. Never worded as a defect.
  push(item('d30', null, 'Baselines and owners', 1, 'Capture baselines and name owners', 'Record the current numbers for the areas above in Connected analytics (funnel, lifecycle, ads) and assign an owner to each priority. This report contains only public evidence, so it has no baselines.', BASIS.CONNECTED));
  push(item('d60', null, 'Re-scan', 2, 'Re-scan and compare', 'Re-run this scan once the first fixes ship. Compare scored checks run over run and confirm which findings closed.', BASIS.VALIDATION));
  push(item('d60', null, 'Connected review', 2, 'Connected review', 'Review funnel, lifecycle and ad-account data (Connected tier) to find the opportunities public evidence cannot show. The results of this review determine the next priorities.', BASIS.CONNECTED));
  if (coverage?.unsupported) push(item('d60', null, 'Assessment coverage', 2, `Extend the assessment (${coverage.unsupported} of ${coverage.total} master checks not yet assessed)`, 'Add the master checks this version does not yet cover. This extends the assessment; it does not imply a problem in those areas.', BASIS.SCOPE));
  const strong = strengths.filter((s) => s.confirmed).slice(0, 3).map((s) => s.name);
  if (strong.length) push(item('d90', null, 'Regression watch', 3, 'Protect what works', `Re-check the strong areas on a schedule to catch regressions: ${strong.join('; ')}.`, BASIS.CONDITIONAL));
  push(item('d90', null, 'Next backlog', 3, 'Next priorities determined after Connected review', 'Combine validated results with the Connected review into the next 90-day backlog. Each item needs a hypothesis, an owner, a data source and a success metric.', BASIS.CONDITIONAL));

  const phases = PHASES.map((p) => ({ ...p, items: cols[p.key] }));
  return { phases, suppressed };
}
