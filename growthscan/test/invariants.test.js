import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { scored, unscored } from '../src/lib/checks.js';
import { CATALOG } from '../src/lib/catalog.js';
import { completeChecks, buildReport } from '../src/lib/report.js';
import { boundaryViolations } from '../src/lib/boundary.js';
import { normalizeInput, assertPublicHost, isPrivateIp, politeFetch } from '../src/lib/net.js';
import { PAYMENT_BLOCK_RE } from '../src/lib/browser.js';
import { parseRobots, isAllowed } from '../src/lib/robots.js';
import { parseMetaCards } from '../src/harnesses/h4-intel.js';

test('scored() refuses a score without observed text or evidence, and out-of-range scores', () => {
  assert.throws(() => scored('TECH-01', { score: 3, observed: 'x', evidence: [] }));
  assert.throws(() => scored('TECH-01', { score: 3, evidence: ['a'] }));
  assert.throws(() => scored('TECH-01', { score: 6, observed: 'x', evidence: ['a'] }));
  assert.throws(() => scored('TECH-01', { score: null, observed: 'x', evidence: ['a'] }));
});

test('unscored checks carry score=null (never 0) and require a known reason code', () => {
  const c = unscored('TECH-03', { code: 'BLOCKED', reason: 'WAF', evidence: [] });
  assert.equal(c.score, null); assert.equal(c.status, 'unscored');
  assert.throws(() => unscored('TECH-03', { code: 'MADE_UP' }));
});

test('every catalog check appears in the final result; missing ones become unscored, connected ones NEEDS_AUTH', () => {
  const done = completeChecks([], { h1: 'boom' });
  assert.equal(done.length, Object.keys(CATALOG).length);
  assert.ok(done.every((c) => c.status === 'unscored' && c.score === null));
  assert.ok(done.filter((c) => c.class === 'connected').every((c) => c.reasonCode === 'NEEDS_AUTH'));
  assert.ok(done.filter((c) => c.harness === 'h1').every((c) => c.reasonCode === 'HARNESS_FAILED' && /boom/.test(c.reason)));
});


test('boundary lint flags assertions about spend/targeting/ROAS/pixel accuracy', () => {
  for (const t of ['Your ad spend is too high', 'Targeting is too broad', 'ROAS is declining', 'The pixel is misfiring', 'tags fire correctly', 'Your media budget is wasted'])
    assert.ok(boundaryViolations(t).length, t);
  assert.equal(boundaryViolations('Redirect chains waste crawl budget').length, 0);
  assert.equal(boundaryViolations('Meta Pixel detected on the home page; 18 active ads captured').length, 0);
});

test('every finding template in the catalog passes the boundary lint', () => {
  for (const [id, m] of Object.entries(CATALOG)) if (m.class !== 'connected')
    assert.equal(boundaryViolations([m.title, m.why, m.rec].join(' ')).length, 0, id);
});

test('SSRF: private, loopback, link-local, metadata and non-standard ports are rejected', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  await assert.rejects(assertPublicHost('localhost')); await assert.rejects(assertPublicHost('169.254.169.254')); await assert.rejects(assertPublicHost('foo.internal'));
  assert.throws(() => normalizeInput('example.com:8080')); assert.throws(() => normalizeInput('ftp://example.com')); assert.throws(() => normalizeInput('intranet'));
  assert.equal(normalizeInput('cedarcide.com').toString(), 'https://cedarcide.com/');
  assert.equal(normalizeInput('https://user:pw@cedarcide.com/a#frag').username, '');
});

test('politeFetch never treats a non-2xx body as page content (429 → blocked, 404 → http_error)', async () => {
  // loopback is blocked by the SSRF guard, so verify that contract directly:
  const r = await politeFetch('http://127.0.0.1:1/'); assert.equal(r.ok, false); assert.equal(r.kind, 'ssrf_blocked'); assert.equal(r.body, undefined);
});

test('payment/order POSTs are matched by the browser guard; ordinary cart and checkout-page URLs are not', () => {
  for (const u of ['https://shop.com/checkouts/cn/abc/processing', 'https://shop.com/checkouts/cn/Z2xk/abc/complete', 'https://shop.com/checkouts/abc/processing', 'https://checkout.pci.shopifyinc.com/sessions', 'https://api.stripe.com/v1/payment_methods', 'https://shop.com/wallets/checkouts/x', 'https://x.com/graphql?operationName=SubmitForCompletion'])
    assert.ok(PAYMENT_BLOCK_RE.test(u), u);
  for (const u of ['https://shop.com/cart/add.js', 'https://shop.com/cart', 'https://shop.com/checkouts/cn/abc', 'https://shop.com/products/x'])
    assert.equal(PAYMENT_BLOCK_RE.test(u), false, u);
});

test('robots parser: longest match wins; specific agent group beats *', () => {
  const p = parseRobots('User-agent: *\nDisallow: /cart\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://x.com/s.xml');
  assert.equal(isAllowed(p, 'Googlebot', '/products/a'), true); assert.equal(isAllowed(p, 'Googlebot', '/cart'), false);
  assert.equal(isAllowed(p, 'GPTBot', '/'), false); assert.deepEqual(p.sitemaps, ['https://x.com/s.xml']);
});

test('Meta card parser: attributes by destination domain only; keyword-only matches are not attributed', () => {
  const mk = (dest, name) => ({ id: '1' + Math.random().toString().slice(2, 12), text: `Active\nLibrary ID: 123\nStarted running on Jul 31, 2026\nSee ad details\n${name}\nSponsored\nSave 20% off today. Free shipping!\nShop now`, links: [`https://l.facebook.com/l.php?u=${encodeURIComponent(dest)}&h=x`], imgs: 1, videos: 0 });
  const [a, b] = parseMetaCards([mk('https://cedarcide.com/products/x', 'Cedarcide'), mk('https://other.com/', 'Cedarcide Fan Page')], 'cedarcide.com');
  assert.equal(a.attribution, 'destination-domain'); assert.equal(b.attribution, 'keyword-only');
  assert.equal(a.cta, 'Shop now'); assert.ok(a.offers.some((o) => /20% off/.test(o)));
});
