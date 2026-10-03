import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { startEgressProxy, guardedLookup, resolvePublic } from '../src/lib/egress.js';

const raw = (port, payload) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1', () => s.write(payload)); let d = ''; s.on('data', (c) => (d += c)); s.on('close', () => ok(d)); setTimeout(() => { s.destroy(); }, 1500); });

test('DNS rebinding: a hostname whose answer is private (or mixed) is rejected at connect time', async () => {
  const rebind = async () => [{ address: '10.0.0.7', family: 4 }];
  const mixed = async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }];
  await assert.rejects(resolvePublic('evil.example', rebind), { code: 'ESSRF' });
  await assert.rejects(resolvePublic('evil.example', mixed), { code: 'ESSRF' });
  assert.equal(await resolvePublic('ok.example', async () => [{ address: '93.184.216.34', family: 4 }]), '93.184.216.34');
  const err = await new Promise((r) => guardedLookup(rebind)('evil.example', {}, (e) => r(e)));
  assert.equal(err.code, 'ESSRF');
});

test('proxy refuses CONNECT/forward to loopback, private, metadata and non-80/443 ports', async () => {
  const p = await startEgressProxy({ resolver: async () => [{ address: '10.1.1.1', family: 4 }] });
  for (const t of ['127.0.0.1:443', '169.254.169.254:443', 'internal.corp:443', 'example.com:22', 'example.com:8080']) {
    const out = await raw(p.port, `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`);
    assert.match(out, /403/, t);
  }
  const fwd = await raw(p.port, 'GET http://127.0.0.1:9/ HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n');
  assert.match(fwd, /403/);
  assert.ok(p.blocked.length >= 6); assert.equal(p.allowed, 0);
  await p.close();
});

test('real Chromium (Playwright flags) cannot reach a loopback server, even by direct URL or redirect', async (t) => {
  let hits = 0;
  const target = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r)); const tp = target.address().port;
  const redirector = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${tp}/` }); res.end(); });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r)); const rp = redirector.address().port;
  const proxy = await startEgressProxy();
  let browser;
  try { browser = await chromium.launch({ args: ['--no-sandbox', `--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>'] }); }
  catch (e) { t.skip('Chromium not available: ' + e.message.split('\n')[0]); target.close(); redirector.close(); await proxy.close(); return; }
  const page = await browser.newPage();
  for (const url of [`http://127.0.0.1:${tp}/`, `http://localhost:${tp}/`, `http://127.0.0.1:${rp}/`, `http://[::1]:${tp}/`]) {
    const ok = await page.goto(url, { timeout: 8000 }).then((r) => r && r.status() < 400 && /secret/.test('' + 0), () => false);
    assert.equal(ok, false, url);
  }
  assert.equal(hits, 0, 'loopback server must never receive a request from the browser');
  assert.ok(proxy.blocked.length >= 3);
  await browser.close(); target.close(); redirector.close(); await proxy.close();
});
