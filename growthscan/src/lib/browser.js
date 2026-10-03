// Shared Playwright helpers: launch, mobile context, safety guards (SSRF + never-submit-an-order).
import { chromium, devices } from 'playwright';
import { assertPublicHost, UA_BROWSER, UA_DESKTOP } from './net.js';
import { egressArgs } from './egress.js';

export const chromePath = () => chromium.executablePath();
export const launch = async () => chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', ...(await egressArgs()).args] });

// Requests that could place or pay for an order are aborted at the network layer, regardless of what the harness does.
export const PAYMENT_BLOCK_RE = new RegExp([
  String.raw`/checkouts?/(?:[^/?]+/)+(processing|complete|payments?)\b`,
  String.raw`/wallets/checkouts`, String.raw`/payments?/(create|confirm|authorize|capture)`,
  String.raw`/orders?/(create|place|submit)`, String.raw`checkout\.pci\.shopifyinc\.com`, String.raw`deposit\.(us\.)?shopifycs\.com`,
  String.raw`api\.stripe\.com/v1/(payment_methods|payment_intents|tokens|sources|setup_intents)`,
  String.raw`paypal\.com/.*/(authorize|capture|approve)`, String.raw`braintree-api\.com`, String.raw`/graphql.*SubmitForCompletion`,
].join('|'), 'i');

export async function newContext(browser, { mobile = true, log } = {}) {
  const base = mobile ? devices['Pixel 7'] : { viewport: { width: 1366, height: 900 } };
  const ctx = await browser.newContext({ ...base, userAgent: mobile ? UA_BROWSER : UA_DESKTOP, locale: 'en-US', timezoneId: 'America/Chicago', ignoreHTTPSErrors: false });
  const hostOk = new Map();
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    try {
      if (req.method() !== 'GET' && req.method() !== 'HEAD' && PAYMENT_BLOCK_RE.test(url)) {
        log?.({ type: 'blocked_payment_request', method: req.method(), url: url.slice(0, 200) });
        return route.abort('blockedbyclient');
      }
      if (req.isNavigationRequest() && /^https?:/.test(url)) {
        const h = new URL(url).hostname;
        if (!hostOk.has(h)) hostOk.set(h, assertPublicHost(h).then(() => true, () => false));
        if (!(await hostOk.get(h))) { log?.({ type: 'blocked_ssrf', url: url.slice(0, 200) }); return route.abort('blockedbyclient'); }
      }
    } catch { /* fall through */ }
    return route.continue();
  });
  return ctx;
}

export async function dismissOverlays(page) {
  // Best-effort, non-destructive: close newsletter/cookie dialogs so they don't occlude measurements.
  const sels = ['button:has-text("Accept all")', 'button:has-text("Accept")', 'button:has-text("Got it")', 'button[aria-label="Close"]', 'button[aria-label="Close dialog"]', '[data-testid="popup-close"]', '.needsclick[aria-label*="lose"]'];
  const clicked = [];
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: 300 })) { await el.click({ timeout: 800 }); clicked.push(s); await page.waitForTimeout(250); }
    } catch { /* ignore */ }
  }
  return clicked;
}

// Closes modal dialogs (newsletter/SMS popups) WITHOUT typing in or submitting them. Returns descriptions of what was closed.
export async function dismissDialogs(page) {
  const closed = [];
  for (let i = 0; i < 3; i++) {
    const info = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const dlg = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].find(vis);
      if (!dlg) return null;
      const label = (dlg.getAttribute('aria-label') || dlg.innerText || '').trim().slice(0, 60);
      const btn = [...dlg.querySelectorAll('button,[role=button],a,[class*=close i]')].find((b) => vis(b) && (/^(×|x|✕|✖|close|no thanks|not now|dismiss|maybe later)$/i.test((b.innerText || '').trim()) || /close|dismiss/i.test(b.getAttribute('aria-label') || '')));
      if (btn) { btn.setAttribute('data-gs-close', '1'); }
      return { label, hasClose: !!btn };
    }).catch(() => null);
    if (!info) break;
    try {
      if (info.hasClose) await page.locator('[data-gs-close="1"]').first().click({ timeout: 1500 }); else await page.keyboard.press('Escape');
      closed.push(info.label || 'dialog');
      await page.waitForTimeout(500);
    } catch { await page.keyboard.press('Escape').catch(() => {}); break; }
  }
  return closed;
}

import { detectChallenge as _detect } from './challenge.js';
/** Load a page once and report whether bot protection answered instead of the site. Used to avoid measuring/scoring a challenge page. */
export async function probePage(url, { mobile = true } = {}) {
  const browser = await launch();
  try {
    const ctx = await newContext(browser, { mobile }); const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => ({ error: e.message }));
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(2500);
    if (resp?.error) return { loaded: false, error: resp.error, blocked: false };
    const html = await page.content().catch(() => ''); const title = await page.title().catch(() => '');
    const ch = _detect({ status: resp.status(), headers: await resp.allHeaders().catch(() => ({})), url: page.url(), title, body: html });
    return { loaded: true, status: resp.status(), finalUrl: page.url(), title, blocked: !!ch, challenge: ch };
  } finally { await browser.close().catch(() => {}); }
}
