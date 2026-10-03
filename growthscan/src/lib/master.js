// Parent/subtest model. Runner checks are SUBTESTS; GrowthScan master v1.3 checks are the PARENTS customers see.
// Coverage is computed from unique master IDs, never from runner checks. Master checks without an implementation stay unscored (NOT_IMPLEMENTED).
import fs from 'node:fs';
import { PARENT_MAP } from './checks.js';

export const MASTER = JSON.parse(fs.readFileSync(new URL('../../config/master-v1.3.json', import.meta.url))).checks;
// Customer-safe wording. Operator hints (env vars, option names) stay in `reason`, which only the operator-only review tab shows.
export const CUSTOMER_REASON = {
  BLOCKED: 'The source blocked or rate-limited automated collection, so no conclusion is drawn.',
  FETCH_FAILED: 'The evidence could not be collected during this scan, so no conclusion is drawn.',
  TIMEOUT: 'Collection timed out, so no conclusion is drawn.',
  NOT_APPLICABLE: 'Not applicable to this site.',
  AMBIGUOUS_ABSENCE: 'Absence could not be distinguished from evidence that is not visible from outside, so no conclusion is drawn.',
  NOT_CONFIGURED: 'This check needs a data source that was not enabled for this scan.',
  NEEDS_AUTH: 'Requires authenticated (Connected) access.',
  HARNESS_FAILED: 'This part of the scan did not complete, so no conclusion is drawn.',
  UNOBSERVABLE: 'Not observable from public evidence.',
  NOT_IMPLEMENTED: 'Not yet assessed by this version of GrowthScan.',
};
const CONF_RANK = { high: 3, medium: 2, low: 1 }; const RANK_CONF = { 3: 'high', 2: 'medium', 1: 'low' };
const supportersOf = (mid) => Object.entries(PARENT_MAP).filter(([, v]) => Array.isArray(v) && v.includes(mid)).map(([k]) => k);
export const SUPPORTED_MASTER_IDS = [...new Set(Object.values(PARENT_MAP).filter(Array.isArray).flat())].sort();
const mean = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;

// What each supporting subtest contributes to ONE parent: its own parent-specific result if it emitted one, else its check-level result.
function contribution(c, mid) {
  if (c.status !== 'scored') return { runnerId: c.id, status: 'unscored', reasonCode: c.reasonCode, reason: c.reason, evidence: c.evidence || [] };
  const p = c.parents?.[mid];
  if (p?.unscored) return { runnerId: c.id, status: 'unscored', reasonCode: p.code || 'FETCH_FAILED', reason: p.reason, evidence: c.evidence };
  return { runnerId: c.id, status: 'scored', score: p ? p.score : c.score, observed: p ? p.observed : c.observed, confidence: p?.confidence || c.confidence, caveat: p?.caveat ?? c.caveat, evidence: c.evidence, provisional: !!c.detail?.provisional, provisionalReason: c.detail?.provisionalReason || null, basis: p ? 'parent-specific threshold' : 'subtest score' };
}

export function rollupMaster(checks) {
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  return MASTER.map((m) => {
    const sup = supportersOf(m.id);
    const base = { masterId: m.id, name: m.name, group: m.group, supportedBy: sup, supported: sup.length > 0 };
    if (!sup.length) return { ...base, status: 'unscored', reasonCode: 'NOT_IMPLEMENTED', reason: 'Not implemented by the current runner; no evidence is collected for this master check.', customerReason: CUSTOMER_REASON.NOT_IMPLEMENTED, subtests: [], evidence: [] };
    const subs = sup.map((id) => byId[id]).filter(Boolean).map((c) => contribution(c, m.id));
    const ok = subs.filter((s) => s.status === 'scored'); const bad = subs.filter((s) => s.status === 'unscored');
    const subtests = subs.map((s) => ({ runnerId: s.runnerId, status: s.status, score: s.score ?? null, reasonCode: s.reasonCode || null, basis: s.basis || null }));
    const evidence = [...new Set(subs.flatMap((s) => s.evidence || []))];
    const unscoredResult = (reasonCode, reason) => ({ ...base, status: 'unscored', reasonCode, reason, customerReason: CUSTOMER_REASON[reasonCode] || CUSTOMER_REASON.FETCH_FAILED, subtests, evidence });
    if (!ok.length) return unscoredResult(bad[0]?.reasonCode || 'HARNESS_FAILED', `No contributing subtest could be scored. ${bad.map((b) => `${b.runnerId}: ${b.reason}`).join(' | ')}`);
    let score; let rule; let lfcConf = null;
    if (m.combine === 'lfc12') {                       // SPF and DMARC are both required; DKIM is probed and only informs
      const spf = ok.find((s) => s.runnerId === 'TECH-08'); const dmarc = ok.find((s) => s.runnerId === 'TECH-09');
      if (!spf || !dmarc) return unscoredResult('FETCH_FAILED', `SPF and DMARC must both be observed to score LFC-12. ${bad.map((b) => `${b.runnerId}: ${b.reason}`).join(' | ')}`);
      score = Math.min(spf.score, dmarc.score); rule = 'lowest of SPF and DMARC (email authentication is only as strong as its weakest control); DKIM cannot be verified without a selector and is reported but neither required nor used for the score or confidence';
      lfcConf = RANK_CONF[Math.min(CONF_RANK[spf.confidence] || 1, CONF_RANK[dmarc.confidence] || 1)];
    } else if (m.combine === 'min') { score = Math.min(...ok.map((s) => s.score)); rule = 'lowest contributing subtest (a surprise cost at any step is a surprise)'; }
    else if (m.combine === 'mean') { score = mean(ok.map((s) => s.score)); rule = 'mean of scored subtests'; }
    else if (m.combine === 'min-basics') { score = Math.min(...ok.map((s) => s.score)); rule = 'lowest contributing subtest (a serious defect is not offset by a good composite score)'; }
    else { score = ok[0].score; rule = 'single supporting subtest'; }
    const conf = lfcConf || RANK_CONF[Math.min(...ok.map((s) => CONF_RANK[s.confidence] || 1))];
    const provisional = ok.some((s) => s.provisional);
    return {
      ...base, status: 'scored', score, confidence: conf, combineRule: rule,
      observed: ok.map((s) => (ok.length > 1 ? `[${s.runnerId}] ` : '') + s.observed).join(' '),
      caveat: [...new Set(ok.map((s) => s.caveat).filter(Boolean))].join(' ') || null,
      partial: bad.length ? `${bad.length} supporting subtest(s) unscored: ${bad.map((b) => `${b.runnerId} (${b.reasonCode})`).join(', ')}` : null,
      provisional, provisionalReason: provisional ? ok.filter((s) => s.provisional).map((s) => s.provisionalReason).filter(Boolean)[0] || 'A contributing subtest is provisional.' : null,
      subtests, evidence,
    };
  });
}

export function masterCoverage(master) {
  const total = master.length; const supported = master.filter((m) => m.supported).length; const scored = master.filter((m) => m.status === 'scored').length;
  return { total, supported, unsupported: total - supported, scored, unscored: total - scored, coverageOfAllPct: Math.round((scored / total) * 100), coverageOfSupportedPct: supported ? Math.round((scored / supported) * 100) : 0 };
}
