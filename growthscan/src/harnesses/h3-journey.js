// Harness 3 — Controlled browser journey (mobile): PDP → variants → add-to-cart → cart → checkout ENTRY observation.
// SAFETY: never fills or submits checkout/payment fields, never submits an order. Payment-like POSTs are aborted at the network layer
// (lib/browser.js PAYMENT_BLOCK_RE) as defence in depth, and every action taken is written to journey-action-log.json.
import { launch, newContext, dismissOverlays, dismissDialogs } from '../lib/browser.js';
import { scored, unscored } from '../lib/checks.js';
import { assertPublicHost } from '../lib/net.js';
import { detectChallenge } from '../lib/challenge.js';

const H = 'h3';
const CHALLENGE = /captcha|verify you are (a )?human|just a moment|access denied|unusual traffic|are you a robot/i;
const RE = {
  shipping: /free shipping|ships? (free|within|in \d)|shipping (is )?free|free (standard )?delivery|flat[- ]rate shipping|shipping (cost|rates?|policy)|\bships\b/i,
  delivery: /arrives?|delivery (by|in|estimate)|get it by|estimated delivery|ships in \d|ready to ship|business days/i,
  returns: /returns?|refund|money[- ]back|satisfaction guarantee|guarantee|warranty/i,
  reviews: /\b\d[\d,]*\s*(\+\s*)?(verified\s+)?(customer\s+)?(reviews?|ratings?)\b|\(\s*\d[\d,]*\s*\)/i,
  secure: /secure (checkout|payment)|ssl|safe (checkout|payment)|trusted/i,
  threshold: /(free shipping|ships? free).{0,40}\$\s?\d+|\$\s?\d+.{0,40}(free shipping)|(away from|until|spend).{0,40}free shipping/i,
  calcAtCheckout: /shipping.{0,30}(calculated|determined).{0,20}checkout|taxes.{0,40}calculated at checkout/i,
  upsell: /you may also like|frequently bought|add to your order|recommended|complete the set|customers also|pair with/i,
  trust: /secure|guarantee|money[- ]back|satisfaction/i,
  express: /shop ?pay|apple ?pay|google ?pay|gpay|paypal|amazon ?pay|venmo|klarna|afterpay/gi,
  signin: /sign in|log ?in|create (an )?account/i,
};

export async function runJourneyOnce(ctx) {
  const { run, url, host } = ctx; const out = []; const ev = {};
  const origin = new URL(url).origin;
  const actions = []; const guard = [];
  const act = (type, detail) => actions.push({ at: new Date().toISOString(), type, ...detail });
  const mk = (id, code, reason, evidence = []) => out.push(unscored(id, { code, reason, evidence }));
  const allIds = ['JRN-01', 'JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06', 'JRN-07', 'JRN-08'];
  const rest = (from, code, reason, evidence) => allIds.filter((i) => i >= from && !out.some((c) => c.id === i)).forEach((i) => mk(i, code, reason, evidence));

  const browser = await launch();
  try {
    const bctx = await newContext(browser, { mobile: true, log: (e) => { guard.push({ at: new Date().toISOString(), ...e }); } });
    const page = await bctx.newPage();
    const addResponses = []; const reqs = [];
    page.on('response', (r) => { const u = r.url(); if (/\/cart\/add(\.js)?|\/cart\.js|\/cart\/change/.test(u)) addResponses.push({ url: u, status: r.status(), method: r.request().method() }); });
    page.on('request', (r) => reqs.push({ m: r.method(), u: r.url().slice(0, 160) }));
    const snap = async (name, full = false) => { try { return run.image(H, name, await page.screenshot({ fullPage: full, timeout: 15000 }), { url: page.url(), viewport: 'Pixel 7 (412x915)', fullPage: full }); } catch (e) { run.failure(H, 'screenshot:' + name, e); return null; } };
    const settle = async () => { await page.waitForLoadState('domcontentloaded').catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(1200); };

    // ── Discover PDP
    run.step(H, 'Find a product page', 'running'); let homeBlocked = null;
    let pdpUrl = ctx.options?.pdpUrl || ctx.discovery.pdpUrl || null; let source = ctx.options?.pdpUrl && !ctx.options?.pdpAuto ? 'operator-supplied' : ctx.discovery.pdpSource || null;
    if (!pdpUrl) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await settle();
        { const ch = detectChallenge({ url: page.url(), title: await page.title().catch(() => ''), body: await page.content().catch(() => '') }); if (ch) { homeBlocked = ch; (ctx.discovery.blocks ||= []).push({ harness: H, step: 'home page', url: page.url(), vendor: ch.vendor, signal: ch.signal }); } }
        const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/product"]')].map((a) => a.href));
        const m = links.map((l) => { try { const x = new URL(l); const p = x.pathname.match(/\/products?\/[^/]+/); return p ? x.origin + p[0] : null; } catch { return null; } }).filter(Boolean);
        pdpUrl = m[0] || null; source = pdpUrl ? 'linked from home page' : null;
      } catch (e) { run.failure(H, 'discover-pdp', e); }
    }
    if (!pdpUrl && homeBlocked) {
      run.step(H, 'Find a product page', 'failed', `blocked by ${homeBlocked.vendor} challenge`);
      ev.shotB = await snap('home-blocked');
      allIds.forEach((i) => mk(i, 'BLOCKED', `The site answered with a ${homeBlocked.vendor} bot-protection challenge, so no product page could be reached. Not scored, and not treated as a site without a shop.`, ev.shotB ? [ev.shotB.id] : []));
      return { checks: out };
    }
    if (!pdpUrl) {
      run.step(H, 'Find a product page', 'failed', 'none found');
      ev.disc = run.json(H, 'funnel-observation', { funnelTypeObserved: 'UNDETERMINED', note: 'No product-page links found on the home page or in the sitemap. Funnel type (CART/APPT/QUOTE/LEAD/HYBRID) must be set by the operator; cart-based checks are not applicable until then.' });
      allIds.forEach((i) => mk(i, 'NOT_APPLICABLE', 'No product page could be discovered, so this is not treated as a cart-based funnel. Set the Funnel Type or paste a product URL under Advanced options.', [ev.disc.id]));
      return { checks: out };
    }
    run.step(H, 'Find a product page', 'done', `${pdpUrl} (${source})`);

    // ── PDP
    run.step(H, 'Load product page (mobile)', 'running');
    act('goto', { url: pdpUrl }); await assertPublicHost(new URL(pdpUrl).hostname);
    let resp = null;
    try { resp = await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { run.failure(H, 'pdp-goto', e, { url: pdpUrl }); }
    await settle(); const closed = await dismissOverlays(page); if (closed.length) act('dismiss-overlays', { selectors: closed });
    const pdpText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const pdpAll = await page.evaluate(() => document.body?.textContent || '').catch(() => '');
    ev.pdpShot = await snap('pdp-above-fold'); ev.pdpFull = await snap('pdp-full', true);
    if (!resp || resp.status() >= 400 || CHALLENGE.test(pdpText.slice(0, 1500))) {
      const blocked = resp && ([401, 403, 429].includes(resp.status()) || CHALLENGE.test(pdpText.slice(0, 1500)));
      run.step(H, 'Load product page (mobile)', 'failed', `HTTP ${resp?.status() ?? 'no response'}`);
      const code = blocked ? 'BLOCKED' : 'FETCH_FAILED';
      allIds.forEach((i) => mk(i, code, `Product page ${pdpUrl} returned ${resp ? 'HTTP ' + resp.status() : 'no response'}${blocked ? ' / challenge page' : ''}. Not scored as a site failure.`, ev.pdpShot ? [ev.pdpShot.id] : []));
      return { checks: out };
    }
    const vh = page.viewportSize().height;
    const pdp = await page.evaluate((vh) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY), h: Math.round(r.height), inFirstViewport: r.top >= 0 && r.bottom <= vh }; };
      const sticky = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
      const title = document.querySelector('h1')?.innerText?.trim() || null;
      // price
      let price = null;
      for (const el of document.querySelectorAll('[itemprop=price],[class*="price" i],[data-price]')) {
        const t = (el.innerText || el.getAttribute('content') || '').trim();
        if (/[$€£]\s?\d/.test(t) && t.length < 60 && vis(el) && !/ship|over|save|off\b/i.test(t)) { price = { text: t.replace(/\s+/g, ' '), ...rect(el) }; break; }
      }
      // add to cart
      const btns = [...document.querySelectorAll('button, input[type=submit], [role=button], a.button')];
      const atcEl = btns.find((b) => vis(b) && /add to (cart|bag|basket)|add to order|^add$|buy now|subscribe/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim()) && !/buy now/i.test(b.innerText || '')) || btns.find((b) => vis(b) && /buy now/i.test(b.innerText || ''));
      const atc = atcEl ? { text: (atcEl.innerText || atcEl.value || '').trim().slice(0, 40), disabled: atcEl.disabled || atcEl.getAttribute('aria-disabled') === 'true', sticky: sticky(atcEl), ...rect(atcEl) } : null;
      // ratings
      let rating = null;
      for (const el of document.querySelectorAll('[class*="rating" i],[class*="review" i],[class*="star" i],[aria-label*="star" i],[class*="okendo"],[class*="yotpo"],[class*="jdgm"]')) { if (vis(el) && el.getBoundingClientRect().top < 4000) { rating = { text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60), ...rect(el) }; break; } }
      // variants
      const groups = [];
      document.querySelectorAll('select').forEach((s) => { if (/quantity|qty/i.test(s.name + s.id) || s.options.length < 2 || !vis(s)) return; groups.push({ kind: 'select', name: s.name || s.id, options: [...s.options].map((o) => o.text.trim()).slice(0, 12), selected: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text.trim() : null, hasPlaceholder: /select|choose/i.test(s.options[0]?.text || '') });
      });
      const radios = {}; document.querySelectorAll('input[type=radio]').forEach((r) => { if (/payment|shipping|delivery|subscription_?type|purchase/i.test(r.name)) return; (radios[r.name] ||= []).push(r); });
      Object.entries(radios).forEach(([n, arr]) => { if (arr.length > 1) groups.push({ kind: 'radio', name: n, options: arr.map((r) => (r.labels?.[0]?.innerText || r.value || '').trim()).slice(0, 12), selected: arr.find((r) => r.checked)?.value ?? null }); });
      const form = document.querySelector('form[action*="/cart/add"]');
      return { title, price, atc, rating, variantGroups: groups.filter((g) => !(g.options.length === 1 && /default title/i.test(g.options[0]))), shopifyForm: !!form, docTitle: document.title, viewportHeight: innerHeight };
    }, vh);
    ev.pdpFacts = run.json(H, 'pdp-facts', { url: pdpUrl, source, finalUrl: page.url(), httpStatus: resp.status(), ...pdp });
    run.step(H, 'Load product page (mobile)', 'done', pdp.title || pdp.docTitle);

    // JRN-01
    if (pdp.title && pdp.price) out.push(scored('JRN-01', { score: source === 'operator-supplied' || source === 'linked from home page' ? 5 : 4, confidence: 'high', observed: `Product page ${page.url()} loaded (HTTP ${resp.status()}) with a title ("${pdp.title.slice(0, 60)}") and a visible price (${pdp.price.text}). Source: ${source}.`, evidence: [ev.pdpFacts.id, ev.pdpShot?.id].filter(Boolean) }));
    else out.push(scored('JRN-01', { score: 3, confidence: 'medium', observed: `Product page loaded (HTTP ${resp.status()}) but ${!pdp.title ? 'no H1 title' : 'no visible price'} was detected by the heuristic.`, evidence: [ev.pdpFacts.id], caveat: 'Price/title detection is heuristic; check the screenshot.' }));

    // Funnel / ATC existence
    if (!pdp.atc) {
      ev.disc = run.json(H, 'funnel-observation', { funnelTypeObserved: 'UNDETERMINED', note: 'Product-like page has no detectable add-to-cart button. Could be a lead/quote/appointment funnel or an unusual theme.', pdp: pdp.docTitle });
      ['JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JRN-06', 'JRN-07', 'JRN-08'].forEach((i) => mk(i, 'NOT_APPLICABLE', 'No add-to-cart control detected on the product page, so cart-journey checks are not applicable until the Funnel Type is confirmed.', [ev.disc.id]));
      return { checks: out };
    }

    // JRN-02 variants
    run.step(H, 'Variants & add-to-cart', 'running');
    let variantInteraction = null;
    const vg = pdp.variantGroups;
    if (vg.length) {
      try {
        const g = vg[0]; const before = pdp.price?.text; let clicked = false;
        if (g.kind === 'select') { act('select-variant', { group: g.name }); await page.locator(`select[name="${g.name}"], select#${g.name}`).first().selectOption({ index: Math.min(1, g.options.length - 1) }, { timeout: 3000 }); clicked = true; }
        else { const radios = page.locator(`input[type=radio][name="${g.name}"]`); act('select-variant', { group: g.name }); await radios.nth(1).evaluate((el) => (el.labels?.[0] || el).click()); clicked = true; }
        await page.waitForTimeout(1000);
        const after = await page.evaluate(() => { const el = [...document.querySelectorAll('[itemprop=price],[class*="price" i],[data-price]')].find((e) => /[$€£]\s?\d/.test(e.innerText || '') && !/ship|over|save|off\b/i.test(e.innerText)); const b = [...document.querySelectorAll('button')].find((x) => /add to (cart|bag)|sold out|unavailable/i.test(x.innerText)); return { price: el?.innerText?.trim().replace(/\s+/g, ' ') || null, atcText: b?.innerText?.trim() || null, atcDisabled: b?.disabled || false }; });
        variantInteraction = { clicked, priceBefore: before, priceAfter: after.price, priceChanged: !!after.price && after.price !== before, atcAfter: after.atcText, atcDisabled: after.atcDisabled };
      } catch (e) { run.failure(H, 'variant-interaction', e); variantInteraction = { error: e.message }; }
      ev.variants = run.json(H, 'variant-observation', { groups: vg, interaction: variantInteraction });
      const g = vg[0]; let s = 2; const n = [];
      if (g.selected && !g.hasPlaceholder) { s += 1; n.push('a default option is pre-selected'); } else n.push('no default selected');
      if (g.options.every((o) => o)) { s += 1; n.push('option labels present'); }
      if (variantInteraction && !variantInteraction.error) { if (variantInteraction.priceChanged) { s += 1; n.push('price updated on selection'); } else n.push('price did not visibly change on selection (may be same-price variants)'); if (variantInteraction.atcDisabled) { s -= 1; n.push('add-to-cart disabled after selecting an option'); } }
      out.push(scored('JRN-02', { score: Math.max(0, Math.min(5, s)), confidence: 'medium', observed: `${vg.length} option group(s): ${vg.map((x) => `${/\d{6,}|__/.test(x.name || '') ? 'product option' : x.name} [${x.options.slice(0, 4).join(' / ')}${x.options.length > 4 ? ' …' : ''}]`).join('; ')}. ${n.join('; ')}.`, evidence: [ev.variants.id, ev.pdpShot?.id].filter(Boolean), caveat: 'Tested by selecting the second option of the first group only.' }));
    } else out.push(unscored('JRN-02', { code: 'NOT_APPLICABLE', reason: 'No option selectors detected (single-variant product, or a variant UI the heuristic cannot see). Not scored.', evidence: [ev.pdpFacts.id] }));

    // JRN-03 above the fold
    {
      const a = pdp.atc; const p = pdp.price; const r = pdp.rating; let s = 0; const n = [];
      if (a.inFirstViewport || a.sticky) { s += 2; n.push(`add-to-cart ${a.sticky && !a.inFirstViewport ? 'is a sticky bar' : 'is'} in the first viewport`); } else n.push(`add-to-cart sits ${a.top}px down (viewport ${vh}px)`);
      if (p?.inFirstViewport) { s += 1.5; n.push('price visible'); } else n.push(p ? `price at ${p.top}px, below the fold` : 'price not found');
      if (r?.inFirstViewport) { s += 1; n.push('review/rating visible'); } else n.push(r ? `reviews at ${r.top}px, below the fold` : 'no review/rating element found');
      const firstView = pdpText.slice(0, 1200); if (RE.shipping.test(firstView) || RE.returns.test(firstView)) { s += 0.5; n.push('shipping/returns/guarantee copy near top of page'); }
      out.push(scored('JRN-03', { score: Math.min(5, s), confidence: 'medium', observed: `Mobile viewport ${vh}px tall: ${n.join('; ')}.`, evidence: [ev.pdpFacts.id, ev.pdpShot?.id].filter(Boolean), caveat: 'Positions measured after dismissing overlays on a single device profile (Pixel 7). Element detection is heuristic; verify against the screenshot.' , parents: { 'CVR-12': (() => { const near = a.inFirstViewport || a.sticky; const sc = near ? 5 : a.top <= vh * 1.5 ? 3.5 : 2; return { score: sc, confidence: 'medium', observed: `Add-to-cart ("${a.text}") ${a.sticky ? 'is a sticky bar' : a.inFirstViewport ? 'is in the first mobile viewport' : `sits ${a.top}px down a ${vh}px viewport`}${a.disabled ? ' and is disabled until an option is chosen' : ''}.`, caveat: 'Position on one product at one device profile (Pixel 7).' }; })() } }));
    }

    // JRN-04 reassurance on the product page (visible without interaction)
    {
      const found = {}; const vis = {};
      for (const k of ['shipping', 'delivery', 'returns', 'reviews', 'secure']) { found[k] = RE[k].test(pdpAll); vis[k] = RE[k].test(pdpText); }
      const snippets = {}; for (const k of Object.keys(found)) { const m = pdpText.match(RE[k]); if (m) snippets[k] = pdpText.slice(Math.max(0, m.index - 40), m.index + 80).replace(/\s+/g, ' '); }
      ev.trust = run.json(H, 'pdp-trust-shipping', { foundInDom: found, visibleWithoutInteraction: vis, snippets });
      const LBL = { shipping: 'shipping cost/threshold', delivery: 'delivery timing', returns: 'returns/guarantee', reviews: 'review count', secure: 'secure-payment wording' };
      const present = Object.keys(vis).filter((k) => vis[k]); const missing = Object.keys(vis).filter((k) => !vis[k]);
      const collapsed = missing.filter((k) => found[k]);
      const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
      const list = (a) => (a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ', and ' + a.at(-1));
      out.push(scored('JRN-04', { score: present.length, confidence: 'medium', observed: `Visible on this product page without interaction: ${present.map((k) => LBL[k]).join(', ') || 'none of the five reassurance elements'}. Not detected as visible: ${missing.map((k) => LBL[k]).join(', ') || 'none'}${collapsed.length ? ` (${collapsed.map((k) => LBL[k]).join(', ')} appear only in collapsed content)` : ''}.`, evidence: [ev.trust.id, ev.pdpFull?.id].filter(Boolean), caveat: 'Text pattern matching on the rendered page; collapsed accordions and image-based badges are not read. Proximity to the add-to-cart button is not measured.', detail: { present, missing, findingTitle: missing.length ? `${cap(list(missing.map((k) => LBL[k])))} not visible on the product page` : undefined, recommendation: missing.length ? `Make ${list(missing.map((k) => LBL[k]))} visible on the product page without needing to expand anything.` : undefined } }));
    }

    // ── Add to cart
    act('click-add-to-cart', { text: pdp.atc.text });
    let atcOutcome = { clicked: false, popupsClosed: [], popupInterfered: false };
    try {
      const preClosed = await dismissDialogs(page); if (preClosed.length) { atcOutcome.popupInterfered = true; atcOutcome.popupsClosed.push(...preClosed); act('close-dialog', { labels: preClosed, note: 'closed without typing or submitting' }); }
      const btn = page.locator('button, input[type=submit], [role=button]').filter({ hasText: new RegExp(pdp.atc.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
      const urlBefore = page.url();
      await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      try { await btn.click({ timeout: 4000 }); }
      catch (clickErr) {
        if (!/intercepts pointer events/.test(clickErr.message)) throw clickErr;
        atcOutcome.popupInterfered = true;
        const closedNow = await dismissDialogs(page); atcOutcome.popupsClosed.push(...closedNow); act('close-dialog', { labels: closedNow, note: 'a dialog intercepted the add-to-cart click; closed without typing or submitting' });
        ev.popupShot = await snap('popup-after-dismiss');
        await btn.click({ timeout: 5000 });
      }
      atcOutcome.clicked = true;
      await page.waitForTimeout(3500);
      const ui = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        // Geometry-based: any fixed/absolute/sticky layer covering a large part of the viewport that mentions cart/checkout. Selector lists miss custom themes.
        const covers = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height >= 0.4 * innerWidth * innerHeight; };
        const layered = [...document.querySelectorAll('div,aside,section,dialog,form')].filter((e) => { if (!vis(e)) return false; const p = getComputedStyle(e).position; return (p === 'fixed' || p === 'absolute' || p === 'sticky') && covers(e) && /check ?out/i.test(e.innerText || '') && /cart|bag|subtotal/i.test(e.innerText || ''); });
        const drawer = layered.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || [...document.querySelectorAll('[class*="cart-drawer" i],[id*="cart-drawer" i],[class*="minicart" i],[class*="mini-cart" i],dialog[open]')].find((e) => vis(e) && /cart|bag|added|checkout/i.test(e.innerText || ''));
        const toast = [...document.querySelectorAll('[class*="toast" i],[class*="notification" i],[role=alert],[role=status]')].find((e) => vis(e) && /added|cart/i.test(e.innerText || ''));
        const count = [...document.querySelectorAll('[class*="cart-count" i],[class*="cart-bubble" i],[class*="cartcount" i],[id*="cart-icon-bubble"]')].map((e) => (e.innerText || '').trim()).filter(Boolean);
        return { drawer: drawer ? { text: drawer.innerText.slice(0, 1800) } : null, toast: toast ? { text: toast.innerText.slice(0, 120) } : null, countBadges: count.slice(0, 3) };
      });
      const cartJs = await page.evaluate(async () => { try { const r = await fetch('/cart.js', { headers: { accept: 'application/json' } }); if (!r.ok) return { status: r.status }; const j = await r.json(); return { status: r.status, item_count: j.item_count, total_price: j.total_price, currency: j.currency, items: (j.items || []).map((i) => ({ title: i.product_title, qty: i.quantity, price: i.price })) }; } catch (e) { return { error: String(e) }; } });
      atcOutcome = { clicked: true, urlBefore, urlAfter: page.url(), redirectedToCart: /\/cart\b/.test(page.url()) && page.url() !== urlBefore, ui, cartJs, addRequests: addResponses.filter((r) => /add/.test(r.url)) };
    } catch (e) { run.failure(H, 'add-to-cart', e); atcOutcome.error = e.message; }
    ev.atcShot = await snap('after-add-to-cart'); ev.atc = run.json(H, 'add-to-cart-observation', atcOutcome);
    const confirmed = (atcOutcome.cartJs?.item_count > 0) || atcOutcome.addRequests?.some((r) => r.status >= 200 && r.status < 300) || atcOutcome.ui?.countBadges?.some((b) => /[1-9]/.test(b));
    const feedback = !!(atcOutcome.ui?.drawer || atcOutcome.ui?.toast || atcOutcome.redirectedToCart);
    run.step(H, 'Variants & add-to-cart', 'done', confirmed ? 'item added' : 'could not confirm');
    const popupNote = atcOutcome.popupInterfered ? ` A modal popup (${atcOutcome.popupsClosed.join(', ')}) was covering the product page / intercepting the tap on add-to-cart and had to be closed first — a shopper would hit the same obstruction.` : '';
    if (confirmed && feedback) out.push(scored('JRN-05', { score: atcOutcome.popupInterfered ? 4 : 5, confidence: 'high', observed: `Add-to-cart succeeded (${atcOutcome.cartJs?.item_count ?? '?'} item(s) in cart) with ${atcOutcome.redirectedToCart ? 'a redirect to the cart page' : atcOutcome.ui.drawer ? 'a cart drawer' : 'a confirmation toast'}.${popupNote}`, evidence: [ev.atc.id, ev.atcShot?.id, ev.popupShot?.id].filter(Boolean) }));
    else if (confirmed) out.push(scored('JRN-05', { score: atcOutcome.popupInterfered ? 2 : 3, confidence: 'medium', observed: `Add-to-cart succeeded (${atcOutcome.cartJs?.item_count ?? 'cart request 2xx'}), but no drawer, toast or redirect was detected — shoppers may not notice it worked.${popupNote}`, evidence: [ev.atc.id, ev.atcShot?.id].filter(Boolean), caveat: 'Feedback detection is heuristic; confirm in the screenshot.' }));
    else out.push(unscored('JRN-05', { code: 'AMBIGUOUS_ABSENCE', reason: atcOutcome.error ? `Click failed: ${atcOutcome.error}` : 'Clicked add-to-cart but could not confirm an item was added (possible variant requirement, bot protection or non-Shopify cart). Not scored as a defect.', evidence: [ev.atc.id] }));

    // ── Cart
    run.step(H, 'Cart observation', 'running');
    let cart = null;
    if (!confirmed) { run.step(H, 'Cart observation', 'skipped', 'no item in cart'); rest('JRN-06', 'AMBIGUOUS_ABSENCE', 'Add-to-cart could not be confirmed, so the cart and checkout entry were not observed.', [ev.atc.id]); return { checks: out }; }
    act('goto', { url: origin + '/cart' });
    try { await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }); await settle(); await dismissOverlays(page); } catch (e) { run.failure(H, 'cart-goto', e); }
    ev.cartShot = await snap('cart'); ev.cartFull = await snap('cart-full', true);
    const cartText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const cartHtml = await page.content().catch(() => '');
    const cf = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const qty = [...document.querySelectorAll('input[name*="quantity" i],input[name*="updates" i],[class*="quantity" i] input,button[aria-label*="quantity" i]')].filter(vis).length;
      const discount = [...document.querySelectorAll('input')].filter(vis).some((i) => /discount|promo|coupon|gift/i.test((i.name || '') + (i.placeholder || '') + (i.getAttribute('aria-label') || '')));
      const lines = document.querySelectorAll('[class*="cart-item" i],[class*="cart__row" i],tr.cart__row,[class*="line-item" i]').length;
      const co = [...document.querySelectorAll('button,input[type=submit],a')].filter(vis).find((b) => /check ?out/i.test((b.innerText || b.value || b.name || '').trim()));
      const progress = [...document.querySelectorAll('[class*="progress" i],[role=progressbar]')].filter(vis).length;
      return { qtyControls: qty, discountField: discount, lineItems: lines, progressBars: progress, checkoutBtn: co ? { text: (co.innerText || co.value || '').trim().slice(0, 30), top: Math.round(co.getBoundingClientRect().top + scrollY), inFirstViewport: co.getBoundingClientRect().bottom <= innerHeight } : null };
    });
    const expressSet = new Set([...(cartText + ' ' + cartHtml).matchAll(RE.express)].map((m) => m[0].toLowerCase().replace(/\s/g, '')));
    const drawerText = atcOutcome.ui?.drawer?.text || '';
    const both = cartText + '\n' + drawerText;
    cart = { ...cf, express: [...expressSet], shippingThreshold: RE.threshold.test(both) || /unlocked.{0,20}free shipping|free shipping/i.test(drawerText), shippingAtCheckoutOnly: RE.calcAtCheckout.test(cartText), upsell: RE.upsell.test(both), upsellWhere: [RE.upsell.test(drawerText) && 'cart drawer', RE.upsell.test(cartText) && 'cart page'].filter(Boolean), trust: RE.trust.test(both), url: page.url(), drawerObserved: !!drawerText, textSample: cartText.slice(0, 1200), drawerTextSample: drawerText.slice(0, 600) };
    ev.cart = run.json(H, 'cart-observation', cart);
    cart.itemsInCart = atcOutcome.cartJs?.item_count ?? null; run.json(H, 'cart-observation', cart); run.step(H, 'Cart observation', 'done', `${cart.itemsInCart ?? '?'} item(s) in cart (per /cart.js)`);
    {
      let s = 0; const n = [];
      if (cf.qtyControls) { s += 1; n.push('quantity controls'); } else n.push('no quantity controls found');
      if (cart.shippingThreshold || cf.progressBars) { s += 1; n.push('shipping-threshold messaging'); } else n.push('no free-shipping threshold/progress');
      if (cart.express.length) { s += 1; n.push('express pay (' + cart.express.slice(0, 3).join(', ') + ')'); } else n.push('no express pay detected');
      if (cart.upsell) { s += 1; n.push('cross-sell/upsell in ' + cart.upsellWhere.join(' and ')); } else n.push('no cross-sell');
      if (cf.checkoutBtn?.inFirstViewport) { s += 0.75; n.push('checkout button in first viewport'); } else n.push(cf.checkoutBtn ? 'checkout button below the fold' : 'checkout button not found');
      if (cart.trust) s += 0.25; if (cf.discountField) s += 0; 
      out.push(scored('JRN-06', { score: Math.min(5, s), confidence: 'medium', observed: `Cart (${page.url()}): ${n.join('; ')}.${cf.discountField ? ' Discount-code field is visible on the cart (can prompt coupon hunting).' : ''}`, evidence: [ev.cart.id, ev.cartShot?.id].filter(Boolean), caveat: 'Heuristic element detection on one cart state (1 item). Cart drawers on other pages are not observed.' }));
    }
    // JRN-07 shipping clarity
    {
      const pdpShip = RE.threshold.test(pdpText) || /free shipping/i.test(pdpText); const cartShip = cart.shippingThreshold || /free shipping/i.test(cartText);
      const s = pdpShip && cartShip ? 5 : pdpShip || cartShip ? 4 : cart.shippingAtCheckoutOnly ? 2 : 1;
      out.push(scored('JRN-07', { score: s, confidence: 'medium', observed: `Shipping cost/threshold messaging: product page ${pdpShip ? 'yes' : 'no'}, cart ${cartShip ? 'yes' : 'no'}${cart.shippingAtCheckoutOnly ? '; cart says shipping is calculated at checkout' : ''}.`, evidence: [ev.trust.id, ev.cart.id], caveat: 'Text matching only; shipping information in images or in a header announcement bar may be counted or missed.' , parents: (() => {
        const both = cartText + '\n' + (atcOutcome.ui?.drawer?.text || '');
        const thrStated = RE.threshold.test(pdpText) || RE.threshold.test(both) || /free shipping on orders/i.test(pdpText); const prog = cart.shippingThreshold || cf.progressBars > 0 || /unlocked|away from free shipping/i.test(both);
        const s15 = thrStated && prog ? 5 : thrStated || prog ? 3.5 : /free shipping/i.test(pdpText + both) ? 2.5 : 1;
        const pre = pdpShip || cartShip; const s17 = pre ? 4 : cart.shippingAtCheckoutOnly ? 2 : 2.5;
        return {
          'CVR-15': { score: s15, confidence: 'low', observed: `Free-shipping threshold ${thrStated ? 'is stated' : 'is not stated'} on the product page/cart${prog ? ' and the cart shows progress toward it' : ''}${!thrStated && /free shipping/i.test(pdpText + both) ? '; free shipping is mentioned without a threshold' : ''}.`, caveat: 'Presence of threshold messaging only; whether the threshold level is commercially right (vs AOV) needs Connected data.' },
          'CVR-17': { score: s17, confidence: 'low', observed: `Before checkout, shipping cost or free-shipping status is ${pre ? 'shown' : 'not shown'}${cart.shippingAtCheckoutOnly ? '; the cart says shipping is calculated at checkout' : ''}. Taxes and the final total cannot be observed without entering an address, which this harness never does.`, caveat: 'Pre-checkout disclosure only.' } };
      })() }));
    }

    // ── Checkout ENTRY (observation only)
    run.step(H, 'Checkout entry observation (no order)', 'running');
    if (!cf.checkoutBtn) { run.step(H, 'Checkout entry observation (no order)', 'skipped', 'no checkout button'); mk('JRN-08', 'AMBIGUOUS_ABSENCE', 'No checkout button was detected on the cart page, so the checkout entry could not be observed.', [ev.cart.id]); }
    else {
      act('click-checkout-entry', { note: 'navigation only; no fields are filled and no payment request is allowed' });
      let co = { reached: false };
      try {
        const b = page.locator('button, input[type=submit], a').filter({ hasText: /check ?out/i }).first();
        await Promise.all([page.waitForURL(/checkout|checkouts/i, { timeout: 20000 }).catch(() => {}), b.click({ timeout: 5000 }).catch(async () => { await page.locator('[name=checkout]').first().click({ timeout: 3000 }); })]);
        await settle();
        const text = await page.evaluate(() => document.body?.innerText || ''); const html = await page.content();
        const fields = await page.evaluate(() => [...document.querySelectorAll('input,select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && e.type !== 'hidden'; }).map((e) => ({ type: e.type || e.tagName.toLowerCase(), name: e.name || e.id || null, label: (e.labels?.[0]?.innerText || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 40) })).slice(0, 40));
        const onCheckout = /checkout/i.test(page.url());
        const emailField = fields.some((f) => /email/i.test(f.type + f.name + f.label));
        const forcedLogin = !emailField && RE.signin.test(text.slice(0, 800));
        co = { reached: onCheckout, entryShowsTotal: /\b(subtotal|total)\b/i.test(text) && /[$€£]\s?\d/.test(text), url: page.url(), host: new URL(page.url()).host, title: await page.title(), challenged: CHALLENGE.test(text.slice(0, 1500)), guestEmailFieldVisible: emailField, forcedLogin, express: [...new Set([...(text + html).matchAll(RE.express)].map((m) => m[0].toLowerCase().replace(/\s/g, '')))], fieldsObserved: fields, textSample: text.slice(0, 900), policy: 'OBSERVATION ONLY — no fields filled, nothing submitted.' };
        ev.coShot = await snap('checkout-entry');
      } catch (e) { run.failure(H, 'checkout-entry', e); co.error = e.message; }
      ev.co = run.json(H, 'checkout-entry-observation', co);
      run.step(H, 'Checkout entry observation (no order)', co.reached ? 'done' : 'failed', co.reached ? `reached ${co.host}/checkouts/… (session token not shown)` : co.error || 'did not reach checkout');
      if (co.challenged) mk('JRN-08', 'BLOCKED', 'Checkout presented a bot/verification challenge; checkout entry cannot be assessed.', [ev.co.id]);
      else if (!co.reached) mk('JRN-08', 'AMBIGUOUS_ABSENCE', `Clicking checkout did not reach a checkout page (final URL ${co.url || page.url()}). Cause not determinable.`, [ev.co.id]);
      else {
        let s = 3; const n = ['reached checkout']; if (co.guestEmailFieldVisible && !co.forcedLogin) { s += 1; n.push('guest/email-first entry'); } if (co.forcedLogin) { s -= 1; n.push('account/login prompt before guest entry'); } if (co.express.length) { s += 1; n.push('express pay: ' + co.express.slice(0, 3).join(', ')); } else n.push('no express pay detected');
        out.push(scored('JRN-08', { score: Math.max(0, Math.min(5, s)), confidence: 'medium', observed: `Checkout entry at ${co.host}: ${n.join('; ')}. Nothing was entered or submitted.`, evidence: [ev.co.id, ev.coShot?.id].filter(Boolean), caveat: 'Entry screen only. Shipping rates, payment methods, order review and error handling are not observed.' , parents: (() => { const w = [...new Set([...(cart.express || []), ...(co.express || [])])]; const s16 = w.length >= 3 ? 5 : w.length === 2 ? 4 : w.length === 1 ? 3 : 1;
        return { 'CVR-16': { score: s16, confidence: 'medium', observed: `Express/wallet options detected on the cart and checkout entry: ${w.join(', ') || 'none'} (${w.length}).`, caveat: 'Detected by text/markup on the cart and checkout entry only; wallet availability can vary by device and region.' },
          'CVR-17': { score: co.entryShowsTotal ? 4 : 3, confidence: 'low', observed: `Checkout entry ${co.entryShowsTotal ? 'shows an order summary with a total' : 'did not show an order summary with a total before address entry'}.`, caveat: 'Totals after shipping address and tax are not observed.' } }; })() }));
      }
      await page.goto('about:blank').catch(() => {});
    }
  } catch (e) {
    run.failure(H, 'journey', e);
    rest('JRN-01', 'HARNESS_FAILED', `Journey harness error: ${e.message}`, []);
  } finally {
    ev.log = run.json(H, 'journey-action-log', { policy: 'No form field on any checkout/payment page is filled. POST requests matching payment/order patterns are aborted at the network layer. Browser context is discarded after the run, so the test cart is not persisted.', actions, blockedRequests: guard, note: 'The add-to-cart click is a real action on the target site and may register as an add-to-cart event in its analytics.' });
    await browser.close().catch(() => {});
  }
  allIds.filter((i) => !out.some((c) => c.id === i)).forEach((i) => mk(i, 'HARNESS_FAILED', 'Not evaluated.', []));
  return { checks: out };
}


// ── Sampled journey: run the full journey on several products and aggregate, so a single PDP is never presented as "the" journey.
const median = (a) => { const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const slug = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean).pop() || u; } catch { return u; } };
const clean = (u) => { try { const x = new URL(u); const m = x.pathname.match(/\/products?\/[^/]+/); return m ? x.origin + m[0] : null; } catch { return null; } };
function prefixed(run, pfx, tag) {
  return { state: run.state, dir: run.dir, save: () => run.save(), json: (h, n, o, m) => run.json(h, pfx + n, o, m), text: (h, n, t, e, m) => run.text(h, pfx + n, t, e, m), image: (h, n, b, m) => run.image(h, pfx + n, b, m),
    failure: (h, st, e, x) => run.failure(h, `[${tag}] ${st}`, e, x), step: (h, l, st, n) => run.step(h, `[${tag}] ${l}`, st, n) };
}
export async function runH3(ctx) {
  const N = Number(process.env.GS_JOURNEY_PDPS || 3);
  const operator = [...new Set([...(ctx.options?.pdpUrls || []), ...(ctx.options?.pdpUrl ? [ctx.options.pdpUrl] : [])].map((u) => clean(u) || u))];
  const auto = [...new Set([...(ctx.discovery.homePdps || []), ...(ctx.discovery.pdpCandidates || []).map(clean).filter(Boolean)])];
  const picks = operator.length ? operator.slice(0, 5) : auto.slice(0, N);
  const source = operator.length ? 'operator-selected' : 'auto-selected (linked from home page, then sitemap)';
  if (!picks.length) return runJourneyOnce(ctx);
  const per = [];
  for (let i = 0; i < picks.length; i++) {
    const tag = `p${i + 1}`; const pctx = { ...ctx, run: prefixed(ctx.run, `${tag}-`, tag), options: { ...ctx.options, pdpUrl: picks[i], pdpUrls: undefined, pdpAuto: !operator.length }, discovery: { ...ctx.discovery, pdpUrl: picks[i], pdpSource: operator.length ? 'operator-supplied' : 'linked from home page' } };
    per.push({ tag, url: picks[i], checks: (await runJourneyOnce(pctx)).checks });
  }
  const sample = { size: per.length, available: ctx.discovery.productsAvailableAuthoritative ? ctx.discovery.productsAvailable : null, device: 'Pixel 7 mobile emulation', scope: 'product page → variant → add-to-cart → cart → checkout entry (no order)', selection: source, products: per.map((p) => ({ tag: p.tag, url: p.url })) };
  ctx.discovery.journeySample = sample;
  const sumEv = ctx.run.json(H, 'journey-sample-summary', { sample, perProduct: per.map((p) => ({ tag: p.tag, url: p.url, results: p.checks.map((c) => ({ id: c.id, status: c.status, score: c.score, reasonCode: c.reasonCode || null })) })) });
  const ids = [...new Set(per.flatMap((p) => p.checks.map((c) => c.id)))].sort(); const out = [];
  for (const id of ids) {
    const rs = per.map((p) => ({ ...p, c: p.checks.find((c) => c.id === id) })).filter((r) => r.c); const ok = rs.filter((r) => r.c.status === 'scored');
    if (!ok.length) { const f = rs[0].c; out.push(unscored(id, { code: f.reasonCode, reason: `Sampled journey (${per.length} product(s)): ${f.reason}`, evidence: [...new Set([sumEv.id, ...rs.flatMap((r) => r.c.evidence || [])])] })); continue; }
    const scores = ok.map((r) => r.c.score); const med = Math.round(median(scores) * 2) / 2; const range = Math.max(...scores) - Math.min(...scores);
    const conf = ok.length >= 3 && range < 2 ? 'medium' : 'low';
    const label = `Sampled journey (${per.length} product${per.length > 1 ? 's' : ''}, ${sample.device}, up to checkout entry; ${source})`;
    const parents = {};
    for (const mid of [...new Set(ok.flatMap((r) => Object.keys(r.c.parents || {})))]) {
      const items = ok.map((r) => ({ r, p: r.c.parents?.[mid] })).filter((x) => x.p && !x.p.unscored);
      if (!items.length) { parents[mid] = { unscored: true, code: 'AMBIGUOUS_ABSENCE', reason: `No sampled product produced a result for ${mid}.` }; continue; }
      const sc = items.map((x) => x.p.score); const pm = Math.round(median(sc) * 2) / 2; const rg = Math.max(...sc) - Math.min(...sc);
      parents[mid] = { score: pm, confidence: items.length >= 3 && rg < 2 && items.every((x) => x.p.confidence !== 'low') ? 'medium' : 'low', observed: `Median ${pm}/5 across ${items.length} sampled products (${items.map((x) => `${slug(x.r.url)} ${x.p.score}`).join('; ')}). ${rg >= 2 ? 'Products differ materially. ' : ''}Example: ${items[0].p.observed}`, caveat: `${items[0].p.caveat || ''} Sample of ${per.length} products.`.trim() };
    }
    out.push(scored(id, { parents: Object.keys(parents).length ? parents : null, score: med, confidence: conf, observed: `Median ${med}/5 across ${ok.length} sampled product(s) (${ok.map((r) => `${slug(r.url)} ${r.c.score}`).join('; ')}).${range >= 2 ? ' Products differ materially, so no single score represents the site.' : ''}${ok.length < rs.length ? ` ${rs.length - ok.length} product(s) unscored for this check.` : ''} Example (${slug(ok[0].url)}): ${ok[0].c.observed}`, evidence: [...new Set([sumEv.id, ...ok.flatMap((r) => r.c.evidence)])], caveat: `${ok[0].c.caveat || ''} Sample of ${per.length}; not a census of products, variants, devices or traffic sources.`.trim(), detail: { sampleSize: per.length, scoredProducts: ok.length, range, perProduct: ok.map((r) => ({ url: r.url, score: r.c.score, observed: r.c.observed, detail: r.c.detail })), findingTitle: ok.map((r) => r.c.detail?.findingTitle).find(Boolean), recommendation: ok.map((r) => r.c.detail?.recommendation).find(Boolean) } }));
  }
  return { checks: out };
}
