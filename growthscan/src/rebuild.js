// Re-verify evidence and rebuild report.json from a stored run (e.g. after report-logic changes). node src/rebuild.js <runDir>
import fs from 'node:fs'; import path from 'node:path';
import { verifyEvidence } from './lib/verify.js'; import { buildReport } from './lib/report.js';
const dir = path.resolve(process.argv[2]); const state = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))); const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks.json')));
// Migration for runs scanned before a detail field existed: backfill DMARC policy detail from the stored (hash-verified) DNS evidence. Derived data only; evidence files are never modified.
try {
  const t9 = checks.find((c) => c.id === 'TECH-09' && c.status === 'scored' && !c.detail);
  if (t9) { const dns = JSON.parse(fs.readFileSync(path.join(dir, 'evidence/h1/dns-email-auth.json'))); const rec = dns.dmarc?.records?.[0] || ''; t9.detail = { policy: (rec.match(/\bp=(\w+)/i) || [])[1]?.toLowerCase() || null, pct: Number((rec.match(/\bpct=(\d+)/i) || [])[1] ?? 100), hasRua: /\brua=/i.test(rec), backfilledFromEvidence: true }; fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(checks, null, 2)); }
} catch { /* no DNS evidence: leave as is */ }
const v = verifyEvidence(dir, state, checks); fs.writeFileSync(path.join(dir, 'evidence-verification.json'), JSON.stringify(v, null, 2));
if (!v.ok) { console.error('Evidence verification FAILED:', JSON.stringify(v.problems.slice(0, 10), null, 1)); process.exit(2); }
const disc = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'discovery.json'))); } catch { return {}; } })();
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(buildReport({ checks, run: state, discovery: disc, evidenceVerification: { ok: true, checked: v.checked } }), null, 2)); console.log('rebuilt; evidence verified:', v.checked);
