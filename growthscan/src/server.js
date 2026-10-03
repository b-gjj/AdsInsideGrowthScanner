// Hosted internal web app. One URL in → queued run → evidence-backed report out.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeInput, assertPublicHost, registrableHost } from './lib/net.js';
import { createRun, executeRun } from './orchestrator.js';
import { discoverProducts } from './lib/discover.js';
import { chromium } from 'playwright';
import { loadSignoff, addSignoff, effectiveReadiness, reportSha } from './lib/signoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const PORT = Number(process.env.PORT || 8080);
const PASSWORD = process.env.APP_PASSWORD || '';
const USER = process.env.APP_USER || 'goodjoojoo';
if (!PASSWORD && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('Refusing to start without auth. Set APP_PASSWORD (and optionally APP_USER), or ALLOW_NO_AUTH=1 for local development only.');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA_DIR, 'runs'), { recursive: true });

// ── Recover: any run left "running"/"queued" by a restart is marked interrupted (an explicit state, not silently lost)
for (const id of fs.readdirSync(path.join(DATA_DIR, 'runs'))) {
  const f = path.join(DATA_DIR, 'runs', id, 'run.json');
  try { const r = JSON.parse(fs.readFileSync(f)); if (['running', 'queued'].includes(r.status)) { r.status = 'interrupted'; r.finishedAt = new Date().toISOString(); r.failures.push({ harness: 'orchestrator', step: 'restart', at: r.finishedAt, message: 'Server restarted while this run was in progress. Re-run to get a complete result.', kind: 'interrupted' }); fs.writeFileSync(f, JSON.stringify(r, null, 2)); } } catch { /* not a run dir */ }
}

// ── Queue: one run at a time (Lighthouse timings are only comparable if nothing else is competing for CPU)
const queue = []; let active = null; const live = new Map();
async function pump() {
  if (active || !queue.length) return;
  active = queue.shift(); const run = live.get(active);
  try { await executeRun(run); } catch (e) { run.failure('orchestrator', 'executeRun', e); run.state.status = 'failed'; run.state.finishedAt = new Date().toISOString(); run.save(); }
  live.delete(active); active = null; setImmediate(pump);
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  const h = req.headers.authorization || '';
  const [u, ...p] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
  const given = Buffer.from(p.join(':')); const want = Buffer.from(PASSWORD);
  const ok = u === USER && given.length === want.length && crypto.timingSafeEqual(given, want);
  if (ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="GrowthScan"').status(401).send('Authentication required');
});
app.use(express.json({ limit: '50kb' }));

const readRun = (id) => { if (!/^[\w.-]+$/.test(id)) return null; const d = path.join(DATA_DIR, 'runs', id); try { const state = JSON.parse(fs.readFileSync(path.join(d, 'run.json'))); let report = null; try { report = JSON.parse(fs.readFileSync(path.join(d, 'report.json'))); } catch { /* not ready */ } let checks = null; try { checks = JSON.parse(fs.readFileSync(path.join(d, 'checks.json'))); } catch { /* not ready */ } return { state, report, checks }; } catch { return null; } };

// Review-sample step: list candidate product pages (static fetch only) so the operator can choose which products the journey will exercise.
app.post('/api/discover', async (req, res) => {
  try { const u = normalizeInput(req.body?.url); await assertPublicHost(u.hostname); res.json({ host: u.hostname, ...(await discoverProducts(u.origin)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/runs', async (req, res) => {
  try {
    const u = normalizeInput(req.body?.url);
    await assertPublicHost(u.hostname);
    if (queue.length >= 5) return res.status(429).json({ error: 'Queue is full (5 runs waiting). Try again in a few minutes.' });
    const o = req.body?.options || {};
    const clean = (s) => String(s || '').trim();
    const options = {
      competitors: clean(o.competitors).split(/[\s,]+/).filter(Boolean).slice(0, 3).map((c) => registrableHost(normalizeInput(c).hostname)),
      brand: clean(o.brand).slice(0, 60) || undefined, metaPageId: /^\d{5,20}$/.test(clean(o.metaPageId)) ? clean(o.metaPageId) : undefined,
      pdpUrls: clean(o.pdpUrl).split(/[\s,]+/).filter(Boolean).slice(0, 5).map((x) => normalizeInput(x).toString()),
    };
    if (options.pdpUrls.some((x) => registrableHost(new URL(x).hostname) !== registrableHost(u.hostname))) return res.status(400).json({ error: 'Product page URLs must be on the same site as the URL being scanned.' });
    const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${registrableHost(u.hostname).replace(/\W+/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
    const run = createRun(DATA_DIR, { id, input: String(req.body.url).trim(), url: u.toString(), host: u.hostname, options });
    live.set(id, run); queue.push(id); pump();
    const recent = fs.readdirSync(path.join(DATA_DIR, 'runs')).filter((d) => d !== id && d.includes('-' + registrableHost(u.hostname).replace(/\W+/g, '-') + '-')).map((d) => readRun(d)?.state).filter((s) => s && Date.now() - Date.parse(s.createdAt) < 15 * 60 * 1000);
    res.status(202).json({ id, queuePosition: queue.indexOf(id) + 1 || 0, warning: recent.length ? 'This site was scanned within the last 15 minutes. Repeated scans can trigger rate limits or bot protection on the target and make results less reliable.' : undefined });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/runs', (_req, res) => {
  const ids = fs.readdirSync(path.join(DATA_DIR, 'runs')).sort().reverse().slice(0, 40);
  res.json(ids.map((id) => readRun(id)).filter(Boolean).map(({ state, report }) => ({ id: state.id, host: state.host, status: state.status, createdAt: state.createdAt, finishedAt: state.finishedAt, masterScored: report?.summary.master.scored ?? null, masterTotal: report?.summary.master.total ?? null, mean: report?.summary.meanScoreOfScoredMaster ?? null })));
});
const readiness = (id, r) => (r.report ? effectiveReadiness(r.report, reportSha(path.join(DATA_DIR, 'runs', id)), loadSignoff(path.join(DATA_DIR, 'runs', id))) : null);
app.get('/api/runs/:id', (req, res) => { const r = readRun(req.params.id); if (!r) return res.status(404).json({ error: 'Run not found' }); res.json({ ...r, readiness: readiness(req.params.id, r), queuePosition: queue.indexOf(req.params.id) + 1 || 0 }); });
app.post('/api/runs/:id/signoff', (req, res) => {
  const r = readRun(req.params.id); if (!r?.report) return res.status(404).json({ error: 'Run or report not found' });
  try { addSignoff(path.join(DATA_DIR, 'runs', req.params.id), r.report, req.body || {}, USER); res.status(201).json({ readiness: readiness(req.params.id, r) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── PDF: the same page the operator sees, printed by the runner's own Chromium (Letter, DRAFT watermark + filename until approved).
// This browser is deliberately NOT routed through the egress proxy: it only ever loads this app on loopback.
let pdfChain = Promise.resolve();
app.get('/api/runs/:id/report.pdf', (req, res) => {
  const r = readRun(req.params.id); if (!r?.report) return res.status(404).json({ error: 'No report for this run' });
  const rd = readiness(req.params.id, r); const base = String(r.report.target.host).replace(/^www\./, '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9.-]/gi, '_'); const name = `${base.charAt(0).toUpperCase() + base.slice(1)}_AdsInsideGrowthScan${rd.status === 'approved' ? '' : '_DRAFT'}.pdf`;
  pdfChain = pdfChain.catch(() => {}).then(async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, ...(PASSWORD ? { httpCredentials: { username: USER, password: PASSWORD } } : {}) });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/#/run/${encodeURIComponent(req.params.id)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('.report-cover', { timeout: 30000 }); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500);
      await page.emulateMedia({ media: 'print' });
      const footer = `<div style="font:8px sans-serif;color:#6D7075;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>${String(r.report.target.host).replace(/[<>&]/g, '')} · GrowthScan by Ads Inside${rd.status === 'approved' ? '' : ' · DRAFT — not approved for customer'}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
      const pdf = await page.pdf({ format: 'Letter', printBackground: true, displayHeaderFooter: true, headerTemplate: rd.status === 'approved' ? '<span></span>' : '<div style="font:700 7.5px sans-serif;color:#a02626;width:100%;text-align:center;letter-spacing:.14em;text-transform:uppercase;padding:3mm 14mm 0">Draft — not approved for customer · internal review copy</div>', footerTemplate: footer, margin: { top: '17mm', bottom: '17mm', left: '14mm', right: '14mm' } });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` }).send(pdf);
    } catch (e) { res.status(500).json({ error: 'PDF generation failed: ' + e.message }); }
    finally { await browser.close().catch(() => {}); }
  });
});

// Evidence files. Target-site HTML is untrusted: serve as plain text under a locked-down CSP so it can never execute in this origin.
app.use('/runs/:id/files', (req, res, next) => {
  if (!/^[\w.-]+$/.test(req.params.id)) return res.sendStatus(400);
  res.set({ 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  express.static(path.join(DATA_DIR, 'runs', req.params.id), { dotfiles: 'deny', index: false, setHeaders: (r, f) => { if (/\.(html?|xml)$/i.test(f)) r.type('text/plain; charset=utf-8'); } })(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.listen(PORT, () => console.log(`GrowthScan runner listening on :${PORT} (data: ${DATA_DIR}, auth: ${PASSWORD ? 'on' : 'OFF'})`));
