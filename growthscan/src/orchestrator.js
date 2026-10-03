// Orchestrator: runs specialised harnesses in sequence (CPU-heavy Lighthouse must not compete with other browsers), records everything, builds the report.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Run } from './lib/evidence.js';
import { HARNESS_LABELS } from './lib/catalog.js';
import { completeChecks, buildReport } from './lib/report.js';
import { runH1 } from './harnesses/h1-technical.js';
import { runH2 } from './harnesses/h2-perf-a11y.js';
import { runH3 } from './harnesses/h3-journey.js';
import { runH4 } from './harnesses/h4-intel.js';
import { chromePath } from './lib/browser.js';
import { verifyEvidence } from './lib/verify.js';
import { egressLog } from './lib/egress.js';

export const HARNESSES = { h1: runH1, h2: runH2, h3: runH3, h4: runH4 };
const ver = (pkg) => { try { return JSON.parse(fs.readFileSync(new URL(`../node_modules/${pkg}/package.json`, import.meta.url))).version; } catch { return null; } };
export const versions = () => ({ app: '0.2.0', node: process.version, playwright: ver('playwright'), lighthouse: ver('lighthouse'), axeCore: ver('axe-core'), os: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memMB: Math.round(os.totalmem() / 1048576), chromium: path.basename(path.dirname(path.dirname(chromePath()))) });

export function createRun(dataDir, { id, input, url, host, options }) {
  const run = new Run(path.join(dataDir, 'runs', id), { id, input, url, host, options, versions: versions() });
  for (const [k, label] of Object.entries(HARNESS_LABELS)) run.harness(k, label);
  run.save();
  return run;
}

export async function executeRun(run, only = Object.keys(HARNESSES)) {
  const ctx = { run, dataDir: path.dirname(run.dir), url: run.state.url, host: run.state.host, options: run.state.options || {}, discovery: { blocks: [] } };
  run.state.status = 'running'; run.state.startedAt = new Date().toISOString(); run.save();
  const checks = []; const errors = {};
  for (const [name, fn] of Object.entries(HARNESSES)) {
    if (!only.includes(name)) { run.endHarness(name, 'skipped', { note: 'Not selected for this run' }); continue; }
    run.startHarness(name);
    try {
      const r = await fn(ctx); checks.push(...r.checks);
      const un = r.checks.filter((c) => c.status === 'unscored' && c.reasonCode !== 'NOT_APPLICABLE' && c.reasonCode !== 'NOT_CONFIGURED').length;
      const fails = run.state.failures.filter((f) => f.harness === name).length;
      run.endHarness(name, un || fails ? 'partial' : 'ok', { scored: r.checks.filter((c) => c.status === 'scored').length, unscored: r.checks.filter((c) => c.status === 'unscored').length, explicitFailures: fails });
    } catch (e) {
      errors[name] = e.message; run.failure(name, 'harness', e); run.endHarness(name, 'failed', { error: e.message });
    }
  }
  const all = completeChecks(checks, errors);
  fs.writeFileSync(path.join(run.dir, 'checks.json'), JSON.stringify(all, null, 2));
  const blockedEgress = egressLog().filter((b) => Date.parse(b.at) >= Date.parse(run.state.startedAt));
  if (blockedEgress.length) run.json('orchestrator', 'egress-blocked-requests', blockedEgress, { note: 'Requests the egress guard refused (non-public address / disallowed port).' });
  // Evidence integrity gate: every indexed file must exist and hash-match, and every cited evidence ID must be indexed.
  fs.writeFileSync(path.join(run.dir, 'discovery.json'), JSON.stringify(ctx.discovery, null, 2));
  const verification = verifyEvidence(run.dir, run.state, all);
  fs.writeFileSync(path.join(run.dir, 'evidence-verification.json'), JSON.stringify(verification, null, 2));
  if (!verification.ok) {
    run.failure('orchestrator', 'evidence-verification', { message: `${verification.problems.length} evidence problem(s): ${verification.problems.slice(0, 3).map((p) => p.id + ' ' + p.problem).join('; ')}`, kind: 'integrity' });
    run.state.status = 'failed_integrity'; run.state.finishedAt = new Date().toISOString(); run.save();
    return { checks: all, report: null, verification };
  }
  const report = buildReport({ checks: all, run: run.state, discovery: ctx.discovery, evidenceVerification: { ok: true, checked: verification.checked } });
  fs.writeFileSync(path.join(run.dir, 'report.json'), JSON.stringify(report, null, 2));
  const hs = Object.values(run.state.harnesses).filter((h) => h.status !== 'skipped');
  run.state.status = hs.every((h) => h.status === 'failed') ? 'failed' : hs.some((h) => h.status !== 'ok') ? 'complete_with_gaps' : 'complete';
  run.state.finishedAt = new Date().toISOString(); run.save();
  return { checks: all, report };
}
