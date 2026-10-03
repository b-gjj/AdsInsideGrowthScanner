// Harness 2 — Performance & accessibility: repeatable mobile Lighthouse (N runs, median) + axe-core on a mobile render.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { AxeBuilder } from '@axe-core/playwright';
import { launch, newContext, chromePath, dismissOverlays, probePage } from '../lib/browser.js';
import { detectChallenge } from '../lib/challenge.js';
import { egressArgs } from '../lib/egress.js';
import { scored, unscored, bucket } from '../lib/checks.js';

const H = 'h2';
const RUNS = Number(process.env.GS_LH_RUNS || 3);
// Most recent earlier completed scan of the same host (<=72h old) that has Lighthouse aggregates: used to test reproducibility ACROSS sessions.
function priorScan(ctx) {
  try {
    const slug = ctx.host.replace(/^www\./, '').replace(/\W+/g, '-'); const base = ctx.dataDir; const now = Date.parse(ctx.run.state.createdAt);
    for (const id of fs.readdirSync(base).sort().reverse()) {
      if (id === ctx.run.state.id || !id.includes(`-${slug}-`)) continue;
      const rj = path.join(base, id, 'run.json'); const aj = path.join(base, id, 'evidence/h2/lighthouse-aggregate.json'); if (!fs.existsSync(aj)) continue;
      const st = JSON.parse(fs.readFileSync(rj)); if (!['complete', 'complete_with_gaps'].includes(st.status) || now - Date.parse(st.createdAt) > 72 * 3600e3) continue;
      const a = JSON.parse(fs.readFileSync(aj)); const m = (v) => { const x = [...v].sort((p, q) => p - q); const k = Math.floor(x.length / 2); return x.length % 2 ? x[k] : (x[k - 1] + x[k]) / 2; };
      return { id, at: st.createdAt, perf: a.perf.median, lcp: m(a.lcp) };
    }
  } catch { /* no prior */ }
  return null;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function oneLighthouse(url) {
  const chrome = await chromeLauncher.launch({ chromePath: chromePath(), chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(await egressArgs()).args] });
  try {
    const res = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], formFactor: 'mobile', screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }, throttlingMethod: 'simulate' });
    return res.lhr;
  } finally { await chrome.kill(); }
}

function summarise(lhr) {
  const a = lhr.audits; const c = lhr.categories;
  const failing = (cat) => (c[cat]?.auditRefs || []).filter((r) => a[r.id]?.score !== null && a[r.id]?.score < 1 && r.weight > 0).map((r) => ({ id: r.id, title: a[r.id].title, score: a[r.id].score })).slice(0, 15);
  return {
    runtimeError: lhr.runtimeError || null, runWarnings: lhr.runWarnings || [], lighthouseVersion: lhr.lighthouseVersion, fetchTime: lhr.fetchTime, finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl,
    scores: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.score === null ? null : Math.round(v.score * 100)])),
    metrics: { fcp: a['first-contentful-paint']?.numericValue, lcp: a['largest-contentful-paint']?.numericValue, cls: a['cumulative-layout-shift']?.numericValue, tbt: a['total-blocking-time']?.numericValue, si: a['speed-index']?.numericValue, ttfb: a['server-response-time']?.numericValue, bytes: a['total-byte-weight']?.numericValue, lcpElement: a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet || null },
    failingAudits: { performance: failing('performance'), accessibility: failing('accessibility'), seo: failing('seo') },
    environment: lhr.environment?.networkUserAgent, benchmarkIndex: lhr.environment?.benchmarkIndex ?? null, config: { formFactor: lhr.configSettings?.formFactor, throttling: lhr.configSettings?.throttling, throttlingMethod: lhr.configSettings?.throttlingMethod },
  };
}

export async function runH2(ctx) {
  const { run, url } = ctx; const out = []; const ev = {};
  // ── Pre-flight: never measure or score a bot-protection challenge page (it would load fast and look like a great site).
  run.step(H, 'Pre-flight: does the site serve its real page?', 'running');
  const pre = await probePage(url).catch((e) => ({ loaded: false, error: e.message, blocked: false }));
  if (pre.blocked) {
    (ctx.discovery.blocks ||= []).push({ harness: H, step: 'pre-flight', url: pre.finalUrl, vendor: pre.challenge.vendor, signal: pre.challenge.signal, seenAs: pre.challenge.seenAs || null });
    const e = run.json(H, 'preflight-blocked', { url, finalUrl: pre.finalUrl, status: pre.status, title: pre.title, challenge: pre.challenge, note: 'Lighthouse and axe were not run: they would have measured the challenge page, not the site.' });
    run.failure(H, 'preflight', { message: `Bot-protection challenge (${pre.challenge.vendor}): ${pre.challenge.signal}`, kind: 'blocked' }, { url });
    run.step(H, 'Pre-flight: does the site serve its real page?', 'failed', `blocked by ${pre.challenge.vendor} challenge`);
    for (const id of ['PERF-01', 'PERF-02', 'PERF-03', 'PERF-04', 'PERF-05', 'PERF-06', 'A11Y-01', 'A11Y-02', 'SEO-01']) out.push(unscored(id, { code: 'BLOCKED', reason: `The site answered with a ${pre.challenge.vendor} bot-protection challenge, so there is no real page to test. Not scored.`, evidence: [e.id] }));
    return { checks: out };
  }
  run.step(H, 'Pre-flight: does the site serve its real page?', 'done', pre.loaded ? `HTTP ${pre.status}` : 'load issue; continuing');
  // ── Lighthouse × N
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    run.step(H, `Lighthouse mobile run ${i}/${RUNS}`, 'running');
    try {
      const lhr = await oneLighthouse(url);
      { const fin = lhr.finalDisplayedUrl || lhr.finalUrl || ''; const ch = detectChallenge({ url: fin }); if (ch) throw Object.assign(new Error(`Lighthouse ended on a ${ch.vendor} challenge page (${fin})`), { kind: 'blocked' }); }
      run.text(H, `lighthouse-run-${i}-full`, JSON.stringify(lhr), 'json', { note: 'full LHR' });
      const s = summarise(lhr); const rec = run.json(H, `lighthouse-run-${i}`, s);
      if (s.runtimeError) { run.failure(H, `lighthouse-${i}`, { message: `${s.runtimeError.code}: ${s.runtimeError.message}`, kind: 'lighthouse_runtime' }); run.step(H, `Lighthouse mobile run ${i}/${RUNS}`, 'failed', s.runtimeError.code); }
      else { runs.push({ ...s, evId: rec.id }); run.step(H, `Lighthouse mobile run ${i}/${RUNS}`, 'done', `perf ${s.scores.performance}`); }
    } catch (e) { run.failure(H, `lighthouse-${i}`, e, { url }); run.step(H, `Lighthouse mobile run ${i}/${RUNS}`, 'failed', e.message); }
  }
  const lhIds = runs.map((r) => r.evId);
  const agg = (f) => runs.map(f).filter((v) => typeof v === 'number');
  if (runs.length) {
    const perf = agg((r) => r.scores.performance); const spread = Math.max(...perf) - Math.min(...perf);
    const bench = runs.map((r) => r.benchmarkIndex).filter((v) => typeof v === 'number');
    const lcpVals = agg((r) => r.metrics.lcp); const lcpCv = lcpVals.length > 1 ? (Math.max(...lcpVals) - Math.min(...lcpVals)) / median(lcpVals) : 0;
    const slowHost = bench.length > 0 && Math.min(...bench) < 1000;
    const noisy = spread > 10 || lcpCv > 0.3;
    let conf = runs.length >= 3 && !noisy && !slowHost ? 'high' : runs.length >= 2 ? 'medium' : 'low';
    if (slowHost || noisy) conf = 'low';
    ev.lhAggBody = { runsRequested: RUNS, runsValid: runs.length, perf: { values: perf, median: median(perf), spread }, lcp: lcpVals, lcpVariation: Number(lcpCv.toFixed(2)), cls: agg((r) => r.metrics.cls), tbt: agg((r) => r.metrics.tbt), runner: { benchmarkIndex: bench, cpus: os.cpus().length, memMB: Math.round(os.totalmem() / 1048576), slowHostFlag: slowHost }, confidenceReason: { slowHost, noisy }, method: 'Lighthouse default mobile emulation, simulated throttling, cold cache each run, median reported.' };
    const note = `${runs.length}/${RUNS} valid runs; performance spread ${spread} pts; LCP run-to-run variation ${(lcpCv * 100).toFixed(0)}%.${noisy ? ' High variance — treat as indicative.' : ''}${slowHost ? ` Runner CPU benchmark index ${Math.min(...bench).toFixed(0)} is below 1000, so lab timings are likely inflated.` : ''}`;
    const reasons = []; if (lcpCv > 0.3) reasons.push(`LCP varied ${(lcpCv * 100).toFixed(0)}% between runs (limit 30%): ${lcpVals.map((v) => (v / 1000).toFixed(1)).join(', ')} s`); if (spread > 10) reasons.push(`performance score spread was ${spread} points (limit 10)`); if (slowHost) reasons.push(`runner CPU benchmark index ${Math.min(...bench).toFixed(0)} was below 1000`);
    const mP = median(perf), mL = median(agg((r) => r.metrics.lcp)), mC = median(agg((r) => r.metrics.cls)), mT = median(agg((r) => r.metrics.tbt)), mB = median(agg((r) => r.metrics.bytes));
    const prior = priorScan(ctx); let crossRun = { prior: null };
    if (prior) {
      const dPerf = Math.abs(mP - prior.perf); const dLcp = Math.abs(mL - prior.lcp) / Math.max(mL, prior.lcp, 1);
      crossRun = { prior, perfDelta: dPerf, lcpRelDelta: Number(dLcp.toFixed(2)), reproducible: dPerf <= 10 && dLcp <= 0.3 };
      if (!crossRun.reproducible) reasons.push(`this scan differs from the previous scan ${prior.id} (performance ${prior.perf} vs ${mP}; LCP ${(prior.lcp / 1000).toFixed(1)} vs ${(mL / 1000).toFixed(1)} s) — not reproducible across sessions`);
    } else if (conf === 'high') conf = 'medium';
    ev.lhAgg = run.json(H, 'lighthouse-aggregate', { ...ev.lhAggBody, crossRun });
    const detail = { crossRun, provisional: reasons.length > 0, provisionalReason: reasons.length ? `Lab data was unstable: ${reasons.join('; ')}. Re-run before quoting this finding.` : null, slowHost, lcpVariation: Number(lcpCv.toFixed(2)), perfSpread: spread, benchmarkIndex: bench };
    const cav = 'Lab data from the runner location with simulated throttling; not real-user data.' + (slowHost ? ' Runner CPU was slow during at least one run; re-run on a larger instance before quoting these timings.' : '') + (crossRun.prior ? ` Compared with earlier scan ${crossRun.prior.id}: performance ${crossRun.prior.perf} vs ${mP}.` : ' Single session: no earlier scan of this site was available to confirm reproducibility, so confidence is capped at medium.');
    out.push(scored('PERF-01', { score: bucket(mP, [[24, 0], [49, 1], [64, 2], [79, 3], [89, 4], [100, 5]]), confidence: conf, observed: `Median mobile Lighthouse performance: ${mP}/100. ${note}`, evidence: [...lhIds, ev.lhAgg.id], caveat: cav , detail }));
    if (Number.isFinite(mL)) out.push(scored('PERF-02', { score: bucket(mL, [[2500, 5], [3200, 4], [4000, 3], [5500, 2], [8000, 1], [1e12, 0]]), confidence: conf, observed: `Median LCP ${(mL / 1000).toFixed(1)} s (runs: ${agg((r) => r.metrics.lcp).map((v) => (v / 1000).toFixed(1)).join(', ')} s). LCP element: ${runs[0].metrics.lcpElement ? runs[0].metrics.lcpElement.slice(0, 120) : 'n/a'}.`, evidence: [...lhIds], caveat: cav , detail })); else out.push(unscored('PERF-02', { code: 'FETCH_FAILED', reason: 'LCP not reported by Lighthouse.', evidence: lhIds }));
    if (Number.isFinite(mC)) out.push(scored('PERF-03', { score: bucket(mC, [[0.1, 5], [0.15, 4], [0.25, 3], [0.4, 2], [0.6, 1], [1e9, 0]]), confidence: conf, observed: `Median CLS ${mC.toFixed(3)}.`, evidence: lhIds, caveat: cav , detail })); else out.push(unscored('PERF-03', { code: 'FETCH_FAILED', reason: 'CLS not reported.', evidence: lhIds }));
    if (Number.isFinite(mT)) out.push(scored('PERF-04', { score: bucket(mT, [[200, 5], [300, 4], [600, 3], [900, 2], [1500, 1], [1e9, 0]]), confidence: conf, observed: `Median Total Blocking Time ${Math.round(mT)} ms.`, evidence: lhIds, caveat: 'TBT is a lab proxy; INP (real-user responsiveness) is not measured here.' , detail })); else out.push(unscored('PERF-04', { code: 'FETCH_FAILED', reason: 'TBT not reported.', evidence: lhIds }));
    if (Number.isFinite(mB)) out.push(scored('PERF-05', { score: bucket(mB / 1e6, [[1.6, 5], [2.5, 4], [3.5, 3], [5, 2], [7, 1], [1e9, 0]]), confidence: conf, observed: `Median transfer size ${(mB / 1e6).toFixed(2)} MB on mobile load.`, evidence: lhIds, caveat: cav , detail })); else out.push(unscored('PERF-05', { code: 'FETCH_FAILED', reason: 'Byte weight not reported.', evidence: lhIds }));
    const a11y = agg((r) => r.scores.accessibility); const seo = agg((r) => r.scores.seo);
    if (a11y.length) out.push(scored('A11Y-01', { score: bucket(median(a11y), [[49, 0], [69, 1], [79, 2], [89, 3], [96, 4], [100, 5]]), confidence: conf, observed: `Median Lighthouse accessibility score ${median(a11y)}/100. Failing audits: ${runs[0].failingAudits.accessibility.map((a) => a.title).join('; ') || 'none'}.`, evidence: lhIds, caveat: 'Automated checks cover only part of WCAG.' })); else out.push(unscored('A11Y-01', { code: 'FETCH_FAILED', reason: 'No accessibility score.', evidence: lhIds }));
    if (seo.length) out.push(scored('SEO-01', { score: bucket(median(seo), [[59, 0], [74, 1], [84, 2], [92, 3], [99, 4], [100, 5]]), confidence: conf, observed: `Median Lighthouse SEO score ${median(seo)}/100. Failing audits: ${runs[0].failingAudits.seo.map((a) => a.title).join('; ') || 'none'}.`, evidence: lhIds })); else out.push(unscored('SEO-01', { code: 'FETCH_FAILED', reason: 'No SEO score.', evidence: lhIds }));
  } else for (const id of ['PERF-01', 'PERF-02', 'PERF-03', 'PERF-04', 'PERF-05', 'A11Y-01', 'SEO-01']) out.push(unscored(id, { code: 'FETCH_FAILED', reason: `All ${RUNS} Lighthouse runs failed (see failures). Not scored as zero.`, evidence: [] }));

  // ── CrUX field data (optional)
  if (process.env.CRUX_API_KEY) {
    run.step(H, 'CrUX field data', 'running');
    try {
      const origin = new URL(url).origin;
      const r = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${process.env.CRUX_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin, formFactor: 'PHONE' }), signal: AbortSignal.timeout(15000) });
      const j = await r.json(); ev.crux = run.json(H, 'crux-response', { status: r.status, body: j });
      const m = j?.record?.metrics;
      if (r.status === 404 || !m) { out.push(unscored('PERF-06', { code: 'UNOBSERVABLE', reason: 'CrUX has no field data for this origin (insufficient traffic or not eligible).', evidence: [ev.crux.id] })); run.step(H, 'CrUX field data', 'done', 'no data'); }
      else {
        const p75 = (k) => Number(m[k]?.percentiles?.p75);
        const lcp = p75('largest_contentful_paint'), inp = p75('interaction_to_next_paint'), cls = p75('cumulative_layout_shift');
        const pass = [lcp <= 2500, inp <= 200, cls <= 0.1].filter(Boolean).length;
        out.push(scored('PERF-06', { score: [1, 2, 3.5, 5][pass], confidence: 'high', observed: `CrUX p75 (phone, origin): LCP ${(lcp / 1000).toFixed(1)} s, INP ${Number.isFinite(inp) ? inp + ' ms' : 'n/a'}, CLS ${cls}. ${pass}/3 pass thresholds.`, evidence: [ev.crux.id] })); run.step(H, 'CrUX field data', 'done');
      }
    } catch (e) { run.failure(H, 'crux', e); run.step(H, 'CrUX field data', 'failed', e.message); out.push(unscored('PERF-06', { code: 'FETCH_FAILED', reason: 'CrUX request failed: ' + e.message, evidence: [] })); }
  } else { run.step(H, 'CrUX field data', 'skipped', 'CRUX_API_KEY not set'); out.push(unscored('PERF-06', { code: 'NOT_CONFIGURED', reason: 'Set CRUX_API_KEY to include real-user Core Web Vitals (free Google API key).', evidence: [] })); }

  // ── axe-core
  run.step(H, 'axe-core accessibility scan (mobile render)', 'running');
  try {
    const browser = await launch();
    try {
      const bctx = await newContext(browser, { mobile: true });
      const page = await bctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await dismissOverlays(page);
      ev.shot = run.image(H, 'axe-page-mobile', await page.screenshot({ fullPage: false }), { viewport: 'Pixel 7' });
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const viol = res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.length, samples: v.nodes.slice(0, 3).map((n) => ({ target: n.target, html: n.html.slice(0, 200) })) }));
      ev.axe = run.json(H, 'axe-results', { axeVersion: res.testEngine?.version, url: page.url(), timestamp: res.timestamp, violations: viol, passes: res.passes.length, incomplete: res.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length })), inapplicable: res.inapplicable.length });
      const sc = viol.filter((v) => ['serious', 'critical'].includes(v.impact)); const nodes = sc.reduce((a, v) => a + v.nodes, 0);
      out.push(scored('A11Y-02', { score: bucket(sc.length, [[0, 5], [2, 4], [4, 3], [6, 2], [9, 1], [1e9, 0]]), confidence: 'medium', observed: `${sc.length} serious/critical axe rule(s) failing across ${nodes} element(s)${sc.length ? ': ' + sc.map((v) => `${v.id} (${v.nodes})`).join(', ') : ''}. ${viol.length - sc.length} moderate/minor rule(s) also failing.`, evidence: [ev.axe.id, ev.shot.id], caveat: 'axe-core finds only automatable issues; keyboard, screen-reader and cognitive checks need manual review. Scan taken after dismissing overlays.' }));
      run.step(H, 'axe-core accessibility scan (mobile render)', 'done', `${viol.length} violating rules`);
    } finally { await browser.close(); }
  } catch (e) { run.failure(H, 'axe', e, { url }); run.step(H, 'axe-core accessibility scan (mobile render)', 'failed', e.message); out.push(unscored('A11Y-02', { code: 'FETCH_FAILED', reason: 'axe scan failed: ' + e.message, evidence: [] })); }

  return { checks: out };
}
