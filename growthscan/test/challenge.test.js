import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChallenge } from '../src/lib/challenge.js';
import { completeChecks, buildReport } from '../src/lib/report.js';

// Exact response captured from drgabriellelyon.com on 2026-10-03 (HTTP 202; the runner previously treated 2xx as real content)
const SG_BODY = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F&y=ipr:35.225.242.17:1791003935.245"></meta></head></html>';

test('SiteGround 202 challenge is detected by header, by body alone, and by the challenge URL', () => {
  assert.deepEqual(detectChallenge({ status: 202, headers: { 'sg-captcha': 'challenge' }, url: 'https://x.com/', body: SG_BODY }), { vendor: 'SiteGround', signal: 'response header sg-captcha: challenge', seenAs: '35.225.242.17' });
  assert.equal(detectChallenge({ status: 202, headers: {}, url: 'https://x.com/', body: SG_BODY })?.vendor, 'SiteGround');
  assert.equal(detectChallenge({ url: 'https://x.com/.well-known/sgcaptcha/?r=%2F' })?.vendor, 'SiteGround');
  assert.equal(detectChallenge({ status: 200, title: 'Robot Challenge Screen', body: 'x' })?.vendor !== undefined, true);
});
test('other vendors: Cloudflare managed challenge, DataDome', () => {
  assert.equal(detectChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' })?.vendor, 'Cloudflare');
  assert.equal(detectChallenge({ status: 200, title: 'Just a moment...', body: '<title>Just a moment...</title>' })?.vendor, 'Cloudflare');
  assert.equal(detectChallenge({ status: 200, body: '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>' })?.vendor, 'DataDome');
});
test('normal pages are never flagged: a large page, a small honest page, and a normal 202 without a refresh', () => {
  assert.equal(detectChallenge({ status: 200, title: 'Cedarcide | Pest Control', url: 'https://cedarcide.com/', body: '<html><body>' + 'content '.repeat(800) + '</body></html>' }), null);
  assert.equal(detectChallenge({ status: 200, url: 'https://x.com/', title: 'Hello', body: '<html><head><title>Hello</title></head><body>Small site</body></html>' }), null);
  assert.equal(detectChallenge({ status: 202, url: 'https://x.com/api', body: '{"queued":true}' }), null);
  assert.equal(detectChallenge({ status: 200, url: 'https://x.com/cdn-cgi/challenge-platform/scripts/jsd/main.js' }), null);   // the Cloudflare script tag on a normal page is not a challenge
});
test('report: a blocked target is a hard blocker, is disclosed in the report data, and checks stay unscored (never zero)', () => {
  const checks = completeChecks([]);                                      // nothing could be measured
  const blocks = [{ harness: 'h1', step: 'static fetch', url: 'https://x.com/', vendor: 'SiteGround', signal: 'response header sg-captcha: challenge' }];
  const r = buildReport({ checks, run: { id: 'x', failures: [], evidence: [], options: {} }, discovery: { blocks }, evidenceVerification: { ok: true } });
  assert.equal(r.discovery.targetBlocks.length, 1); assert.ok(r.clientReady.blockers.some((b) => /bot-protection challenge \(SiteGround\)/.test(b)));
  assert.equal(r.summary.master.scored, 0); assert.ok(checks.filter((c) => c.status === 'scored').length === 0);
});

test('SiteGround challenge discloses the address the site saw; other vendors do not invent one', () => {
  assert.equal(detectChallenge({ status: 202, headers: { 'sg-captcha': 'challenge' }, url: 'https://x.com/', body: SG_BODY }).seenAs, '35.225.242.17');
  assert.equal(detectChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' }).seenAs, undefined);
});
test('report mode: INCOMPLETE when bot protection blocked at least half of the supported checks; STANDARD otherwise', async () => {
  const { scored, unscored, PARENT_MAP } = await import('../src/lib/checks.js');
  const allBlocked = Object.entries(PARENT_MAP).filter(([, v]) => Array.isArray(v)).map(([id]) => unscored(id, { code: 'BLOCKED', reason: 'challenge', evidence: [] }));
  const blocks = [{ harness: 'h1', step: 'static fetch', vendor: 'SiteGround', signal: 's', seenAs: '1.2.3.4' }];
  const base = { run: { id: 'x', failures: [], evidence: [], options: {} }, evidenceVerification: { ok: true } };
  const none = buildReport({ ...base, checks: completeChecks(allBlocked), discovery: { blocks } });              // every site-based check blocked → incomplete
  assert.equal(none.mode, 'incomplete'); assert.deepEqual(none.incomplete.runnerSeenAs, ['1.2.3.4']);
  const good = ['TECH-02', 'TECH-03', 'TECH-04', 'TECH-05', 'TECH-08', 'TECH-09', 'PERF-01', 'A11Y-01', 'JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06'].map((i) => scored(i, { score: 4, confidence: 'high', observed: 'ok', evidence: ['h/e'] }));
  assert.equal(buildReport({ ...base, checks: completeChecks(good), discovery: { blocks } }).mode, 'standard');   // blocked on one page but most checks still ran
  assert.equal(buildReport({ ...base, checks: completeChecks(allBlocked), discovery: {} }).mode, 'standard');       // no bot protection recorded → standard
  assert.equal(buildReport({ ...base, checks: completeChecks([]), discovery: { blocks } }).mode, 'standard');     // unscored for other reasons (harness failure) is not a bot block
});
