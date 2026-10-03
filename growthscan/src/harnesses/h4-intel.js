// Harness 4 — Public Meta / Google intelligence (Outside-In only).
// Observes PUBLIC creative, offers, destinations and SERP presence. It never infers spend, targeting, ROAS, campaign structure or account performance.
import { createHash } from 'node:crypto';
import { launch, newContext, dismissOverlays } from '../lib/browser.js';
import { politeFetch, registrableHost } from '../lib/net.js';
import { scored, unscored, bucket } from '../lib/checks.js';

const H = 'h4';
const OFFER_RE = /\b(\d{1,2}\s?%\s*off|up to \d{1,2}\s?%|save \d{1,2}\s?%|buy \d+,?\s*get \d+|bogo|free shipping|free gift|bundle|subscribe (&|and) save|\$\s?\d+\s*off|money[- ]back|guarantee|sale ends|limited time|% off)\b/gi;
const CTA_RE = /^(shop now|learn more|sign up|order now|get offer|buy now|subscribe|book now|contact us|download|get quote|see more|watch more|apply now|send message|call now|install now|get directions|get started|shop the sale)$/i;

export const deriveBrand = (ctx) => {
  const t = ctx.discovery?.siteName || (ctx.discovery?.title || '').split(/[|\u2013\u2014:]| - /)[0].trim();
  return ctx.options?.brand || (t && t.length <= 32 ? t : registrableHost(ctx.host).split('.')[0]);
};
const pageType = (u) => { try { const x = new URL(u); const p = x.pathname; if (p === '/' || p === '') return 'home'; if (/\/products?\//.test(p)) return 'product'; if (/\/collections?\//.test(p)) return 'collection'; if (/\/(pages|blogs?|lp|landing)\//.test(p)) return 'landing/content'; return 'other'; } catch { return 'unknown'; } };

export function parseMetaCards(cards, domain) {
  return cards.map((c) => {
    const lines = c.text.split('\n').map((l) => l.replace(/\u200b/g, '').trim()).filter(Boolean);
    const di = lines.findIndex((l) => /^See (ad|summary) details$/i.test(l));
    const advertiser = di >= 0 ? lines[di + 1] : null;
    const si = lines.findIndex((l) => /^Sponsored$/i.test(l));
    let body = si >= 0 ? lines.slice(si + 1) : [];
    const last = body.at(-1); let cta = null; if (last && CTA_RE.test(last)) { cta = last; body = body.slice(0, -1); }
    const du = body.findIndex((l) => /^(HTTPS?:\/\/)?[A-Z0-9][A-Z0-9.\-]+\.[A-Z]{2,}(\/\S*)?$/.test(l)); let displayUrl = null; if (du >= 0) { displayUrl = body[du]; }
    const copy = body.filter((l, i) => i !== du && !/^\d+:\d\d( \/ \d+:\d\d)?$/.test(l)).join(' ').slice(0, 900);
    const dests = [...new Set(c.links.map((h) => { try { const u = new URL(h); if (u.hostname === 'l.facebook.com') return u.searchParams.get('u'); return null; } catch { return null; } }).filter(Boolean))];
    const attributable = dests.some((d) => { try { return registrableHost(new URL(d).hostname) === domain; } catch { return false; } });
    const offers = [...new Set((copy.match(OFFER_RE) || []).map((x) => x.toLowerCase()))];
    return {
      libraryId: c.id, status: /^Inactive$/m.test(c.text) ? 'inactive' : 'active', startedRunning: (c.text.match(/Started running on ([A-Za-z]{3} \d{1,2}, \d{4})/) || [])[1] || null,
      advertiser, partnership: /\bwith\b/i.test(advertiser || '') && /connected page|with /i.test(advertiser || ''), copy, copyHash: createHash('sha1').update(copy.toLowerCase().replace(/\W+/g, ' ')).digest('hex').slice(0, 10),
      cta, displayUrl, destinations: dests, destinationTypes: dests.map(pageType), offers, format: c.videos ? 'video' : c.imgs ? 'image' : 'unknown',
      reuseCount: Number((c.text.match(/(\d+) ads? use this creative/) || [])[1] || 1), attribution: attributable ? 'destination-domain' : 'keyword-only',
    };
  });
}

async function captureMeta(browser, run, { label, domain, keyword, pageId }) {
  const q = pageId ? `view_all_page_id=${encodeURIComponent(pageId)}&search_type=page` : `q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&${q}&media_type=all`;
  const name = `meta-${label}`; const res = { label, domain, keyword: pageId ? `page:${pageId}` : keyword, url, status: 'failed', ads: [] };
  const ctx = await newContext(browser, { mobile: false }); const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}); await page.waitForTimeout(3000); await dismissOverlays(page);
    let prev = -1;
    for (let i = 0; i < Number(process.env.GS_META_SCROLLS || 4); i++) {
      const n = await page.evaluate(() => (document.body.innerText.match(/Library ID:/g) || []).length);
      if (n === prev) break; prev = n; await page.mouse.wheel(0, 5000); await page.waitForTimeout(2500);
    }
    const text = await page.evaluate(() => document.body.innerText);
    res.shot = run.image(H, name, await page.screenshot({ fullPage: false }), { url });
    res.rawText = run.text(H, `${name}-page-text`, text, 'txt', { url });
    res.totalText = (text.match(/~?[\d,]+\+? results?/i) || [null])[0];
    if (/log in to continue|you must log in|temporarily blocked|something went wrong|try again later/i.test(text) && !/Library ID/.test(text)) { res.status = 'blocked'; res.note = 'Meta showed a login/error wall instead of results.'; }
    else if (!/Library ID/.test(text)) { res.status = /no ads match|0 results|didn.t find any/i.test(text) ? 'empty' : 'parse_failed'; res.note = res.status === 'empty' ? 'Meta reported no matching ads.' : 'No ad cards found and no explicit empty state; page layout may have changed.'; }
    else {
      const cards = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /Library ID:\s*\d+/.test(e.textContent || ''));
        return ids.map((n) => { let el = n; let best = n; while (el.parentElement) { const par = el.parentElement; if ((par.innerText.match(/Library ID:/g) || []).length > 1) break; best = par; el = par; }
          return { id: (n.textContent.match(/\d{8,}/) || [])[0], text: best.innerText.slice(0, 1500), links: [...best.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 8), imgs: best.querySelectorAll('img').length, videos: best.querySelectorAll('video').length }; });
      });
      const seen = new Set(); res.ads = parseMetaCards(cards, domain).filter((a) => a.libraryId && !seen.has(a.libraryId) && seen.add(a.libraryId));
      res.status = 'ok';
    }
  } catch (e) { run.failure(H, name, e, { url }); res.note = e.message; res.status = /Timeout/.test(e.message) ? 'timeout' : 'failed'; }
  await ctx.close();
  res.ev = run.json(H, `${name}-ads`, { ...res, shot: undefined, rawText: undefined, capturedVia: 'Meta Ad Library public web UI (no login), US, active ads', limits: 'Keyword search returns ads matching the text anywhere; only ads whose destination domain matches the target are attributed. Reach, spend, targeting and performance are not shown by the Library for non-political ads.' });
  return res;
}

async function captureGads(browser, run, { label, domain }) {
  const url = `https://adstransparency.google.com/?region=US&domain=${encodeURIComponent(domain)}`; const name = `gads-${label}`;
  const res = { label, domain, url, status: 'failed', advertisers: [], total: null };
  const ctx = await newContext(browser, { mobile: false }); const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}); await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    res.shot = run.image(H, name, await page.screenshot({ fullPage: false }), { url });
    const m = text.match(/~?([\d,]+)\+?\s+ads/i); res.total = m ? Number(m[1].replace(/,/g, '')) : null; res.totalText = m ? m[0] : null;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    res.advertisers = [...new Set(lines.map((l, i) => (lines[i + 1] === 'Verified' ? l : null)).filter(Boolean))];
    const frameText = [];
    for (const f of page.frames().filter((x) => x !== page.mainFrame()).slice(0, 25)) { try { const t = (await f.evaluate(() => document.body?.innerText || '', { timeout: 1000 })).trim(); if (t && t.length > 15) frameText.push(t.replace(/\s+/g, ' ').slice(0, 300)); } catch { /* cross-origin / detached */ } }
    res.creativeTexts = [...new Set(frameText)].slice(0, 12);
    if (/unusual traffic|captcha|verify you are/i.test(text)) { res.status = 'blocked'; res.note = 'Google verification page returned.'; }
    else if (m) res.status = 'ok';
    else if (/no ads|didn.t find|no results/i.test(text)) { res.status = 'empty'; res.note = 'No ads reported for this domain/region.'; }
    else { res.status = 'parse_failed'; res.note = 'Neither an ad count nor an explicit empty state was found.'; }
  } catch (e) { run.failure(H, name, e, { url }); res.note = e.message; res.status = /Timeout/.test(e.message) ? 'timeout' : 'failed'; }
  await ctx.close();
  res.ev = run.json(H, `${name}-summary`, { ...res, shot: undefined, capturedVia: 'Google Ads Transparency Center public web UI, US region, domain search', limits: 'Count is approximate (the page shows "~N"). Impressions, spend, targeting and performance are not shown. Creative text is read only where frames are accessible; the screenshot is the evidence of record.' });
  return res;
}

async function captureSerp(browser, run, { query, domain }) {
  const name = 'serp-' + query.replace(/\W+/g, '-').slice(0, 30); const res = { query, status: 'failed', source: null, organic: [], ads: [] };
  if (process.env.SERPAPI_KEY) {
    try {
      const r = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&gl=us&hl=en&google_domain=google.com&api_key=${process.env.SERPAPI_KEY}`, { signal: AbortSignal.timeout(30000) });
      const j = await r.json(); res.source = 'SerpAPI (Google)';
      res.ev = run.json(H, `${name}-serpapi`, { status: r.status, response: { organic_results: j.organic_results, ads: j.ads, shopping_results: j.shopping_results, search_information: j.search_information, error: j.error } });
      if (j.error) { res.status = 'failed'; res.note = j.error; }
      else { res.status = 'ok'; res.organic = (j.organic_results || []).map((o) => ({ pos: o.position, url: o.link, title: o.title })); res.ads = (j.ads || []).map((a) => ({ domain: a.displayed_link || a.link, title: a.title, desc: a.description })); }
      return res;
    } catch (e) { run.failure(H, name, e); res.note = 'SerpAPI request failed: ' + e.message; }
  }
  const ctx = await newContext(browser, { mobile: false }); const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText); res.source = 'Google web (browser)';
    res.shot = run.image(H, name, await page.screenshot({ fullPage: false }), { url: page.url() });
    if (/\/sorry\/|unusual traffic|not a robot|captcha/i.test(page.url() + text.slice(0, 600))) { res.status = 'blocked'; res.note = 'Google returned its "unusual traffic" verification page to the runner. This is not evidence about the brand\'s ranking.'; }
    else {
      const data = await page.evaluate(() => [...document.querySelectorAll('#search a[href^="http"] h3')].map((h, i) => ({ pos: i + 1, url: h.closest('a').href, title: h.innerText })));
      res.organic = data; res.status = data.length ? 'ok' : 'parse_failed'; if (!data.length) res.note = 'No organic results parsed (consent screen or layout change).';
    }
  } catch (e) { run.failure(H, name, e); res.note = e.message; res.status = 'failed'; }
  await ctx.close();
  res.ev = res.ev || run.json(H, `${name}-attempt`, { query, status: res.status, note: res.note, source: res.source });
  return res;
}

export async function runH4(ctx) {
  const { run, host } = ctx; const out = []; const ev = {};
  const domain = registrableHost(host); const brand = deriveBrand(ctx);
  const competitors = (ctx.options?.competitors || []).slice(0, 3);
  ev.plan = run.json(H, 'intel-plan', { domain, brandKeyword: brand, metaPageId: ctx.options?.metaPageId || null, competitors, note: 'Brand keyword derived from og:site_name/title unless overridden. Operator can set Meta Page ID and competitors under Advanced options.' });
  const browser = await launch();
  let meta, gads, serp = [];
  try {
    run.step(H, 'Meta Ad Library (brand)', 'running');
    meta = await captureMeta(browser, run, { label: 'brand', domain, keyword: brand, pageId: ctx.options?.metaPageId });
    run.step(H, 'Meta Ad Library (brand)', meta.status === 'ok' ? 'done' : 'failed', `${meta.status}${meta.ads.length ? ', ' + meta.ads.length + ' ads captured' : ''}`);
    run.step(H, 'Google Ads Transparency (brand)', 'running');
    gads = await captureGads(browser, run, { label: 'brand', domain });
    run.step(H, 'Google Ads Transparency (brand)', gads.status === 'ok' ? 'done' : 'failed', `${gads.status}${gads.totalText ? ', ' + gads.totalText : ''}`);
    run.step(H, 'Google SERP observation', 'running');
    const q1 = await captureSerp(browser, run, { query: brand, domain }); serp.push(q1);
    run.step(H, 'Google SERP observation', q1.status === 'ok' ? 'done' : 'failed', `${q1.status}${q1.note ? ': ' + q1.note.slice(0, 80) : ''}`);
    const comp = [];
    for (const c of competitors) {
      const cd = registrableHost(c.replace(/^https?:\/\//, '').split('/')[0]); const clabel = cd.split('.')[0];
      run.step(H, `Competitor capture: ${cd}`, 'running');
      const cm = await captureMeta(browser, run, { label: `comp-${clabel}`, domain: cd, keyword: clabel });
      const cg = await captureGads(browser, run, { label: `comp-${clabel}`, domain: cd });
      comp.push({ domain: cd, meta: cm, gads: cg });
      run.step(H, `Competitor capture: ${cd}`, 'done', `Meta ${cm.status}, Google ${cg.status}`);
    }
    // ── INTEL-01 / 02 (Meta)
    const evM = [meta.ev?.id, meta.shot?.id, meta.rawText?.id].filter(Boolean);
    if (meta.status === 'ok') {
      const attributed = meta.ads.filter((a) => a.attribution === 'destination-domain');
      const creatives = new Set(attributed.map((a) => a.copyHash)); const formats = [...new Set(attributed.map((a) => a.format))];
      const partner = attributed.filter((a) => a.partnership).length;
      if (attributed.length) {
        const n = attributed.length;
        out.push(scored('INTEL-01', { score: bucket(n, [[0, 0], [2, 2], [9, 3], [24, 4], [1e9, 5]]), confidence: 'medium', observed: `${n} active Meta ad(s) with destinations on ${domain} captured (Library reports ${meta.totalText || 'an unknown number of results'} for the keyword; ${meta.ads.length} cards captured, ${meta.ads.length - n} matched the keyword only and are excluded). ${creatives.size} distinct creative text(s); formats: ${formats.join(', ')}.${partner ? ` ${partner} are creator/partnership ads.` : ''}`, evidence: evM, caveat: 'Creative volume is not spend, reach or performance. Capture is capped at the first screens of results.', parents: { 'ACQ-05': formats.filter((f) => f !== 'unknown').length ? { score: formats.filter((f) => f !== 'unknown').length >= 2 ? 4 : 2.5, confidence: 'low', observed: `Formats seen across ${n} attributable active Meta ads: ${formats.join(', ')}. Carousel, collection, story and Reels placements are not distinguished by this capture.`, caveat: 'Image vs video only; four or more formats cannot be established, so the score is capped at 4. Active ads in the US only.' } : { unscored: true, code: 'UNOBSERVABLE', reason: 'Ad formats could not be determined from the captured cards.' } } }));
        // INTEL-02
        if (n >= 3) {
          const dests = attributed.flatMap((a) => a.destinations.filter((d) => { try { return registrableHost(new URL(d).hostname) === domain; } catch { return false; } }));
          const uniq = [...new Set(dests.map((d) => { try { const u = new URL(d); return u.origin + u.pathname; } catch { return d; } }))];
          const checked = []; for (const d of uniq.slice(0, 6)) { const r = await politeFetch(d, { method: 'HEAD', timeout: 15000 }); checked.push({ url: d, status: r.status, kind: r.kind }); }
          const homeShare = dests.filter((d) => pageType(d) === 'home').length / Math.max(1, dests.length); const types = [...new Set(dests.map(pageType))];
          const offerShare = attributed.filter((a) => a.offers.length).length / n; const ok = checked.filter((c) => c.status >= 200 && c.status < 400).length;
          ev.dests = run.json(H, 'meta-destination-check', { unique: uniq, checked, pageTypes: types, homeShare, offerShare });
          let s = 1; const notes = [];
          if (homeShare < 0.5) { s += 1; notes.push('most ads go to a specific page rather than the homepage'); } else notes.push(`${(homeShare * 100).toFixed(0)}% of ads point at the homepage`);
          if (uniq.length >= 3 || types.length >= 2) { s += 1; notes.push(`${uniq.length} distinct destinations across ${types.join('/')}`); } else notes.push('little destination variety');
          if (checked.length && ok === checked.length) { s += 1; notes.push('all sampled destinations resolve'); } else if (checked.length) notes.push(`${checked.length - ok}/${checked.length} sampled destinations did not resolve (HEAD)`);
          if (offerShare >= 0.3) { s += 1; notes.push(`${(offerShare * 100).toFixed(0)}% of ads state an explicit offer`); } else notes.push('few ads state an explicit offer in the copy');
          out.push(scored('INTEL-02', { score: Math.min(5, s), confidence: 'low', observed: `Across ${n} attributable ads: ${notes.join('; ')}.`, evidence: [...evM, ev.dests.id], caveat: 'Offer detection reads ad copy only (not on-image text). Message match to the landing-page content is not assessed. Rubric is a placeholder pending peer calibration.' }));
        } else out.push(unscored('INTEL-02', { code: 'AMBIGUOUS_ABSENCE', reason: `Only ${n} attributable ad(s) captured; at least 3 are needed to judge destination/offer alignment.`, evidence: evM }));
      } else {
        const why = `The Library returned ${meta.ads.length} keyword match(es) for "${brand}" but none link to ${domain}. This cannot distinguish "not advertising on Meta" from "advertising under a different Page name/domain". Provide the Meta Page ID under Advanced options to resolve.`;
        out.push(unscored('INTEL-01', { code: 'AMBIGUOUS_ABSENCE', reason: why, evidence: evM })); out.push(unscored('INTEL-02', { code: 'AMBIGUOUS_ABSENCE', reason: 'No attributable Meta ads to evaluate.', evidence: evM }));
      }
    } else {
      const code = meta.status === 'blocked' ? 'BLOCKED' : meta.status === 'timeout' ? 'TIMEOUT' : meta.status === 'empty' ? 'AMBIGUOUS_ABSENCE' : 'FETCH_FAILED';
      const reason = `Meta Ad Library capture ${meta.status}: ${meta.note || 'unknown'}. Not scored.`;
      out.push(unscored('INTEL-01', { code, reason, evidence: evM })); out.push(unscored('INTEL-02', { code, reason, evidence: evM }));
    }
    // ── INTEL-03 (Google Ads Transparency)
    const evG = [gads.ev?.id, gads.shot?.id].filter(Boolean);
    if (gads.status === 'ok' && gads.total) out.push(scored('INTEL-03', { score: bucket(gads.total, [[0, 0], [2, 2], [9, 3], [24, 4], [1e9, 5]]), confidence: 'low', observed: `Google Ads Transparency reports ${gads.totalText} for ${domain} in the US (advertiser account(s): ${gads.advertisers.join(', ') || 'not parsed'}).${gads.advertisers.length && !gads.advertisers.some((a) => a.toLowerCase().includes(brand.toLowerCase())) ? ' Note: the verified advertiser name differs from the brand name, so name-based searches would miss these ads.' : ''}${gads.creativeTexts?.length ? ' Sample creative text captured: "' + gads.creativeTexts[0].slice(0, 120) + '".' : ''}`, evidence: evG, caveat: 'Count is approximate and includes historical creatives; it is not spend, reach or performance. Unrelated advertisers can both display exactly "~200", which suggests the page caps the count — treat it as "at least" and do not compare volumes across advertisers (cap behaviour not independently verified). Format mix and dates require manual filtering in the Transparency Center.' }));
    else if (gads.status === 'ok' && gads.total === 0) out.push(unscored('INTEL-03', { code: 'AMBIGUOUS_ABSENCE', reason: `Google’s Ads Transparency Center reports 0 ads for ${domain} in the US. That cannot distinguish “not advertising on Google” from “advertising under a different domain or advertiser name”, so it is not scored.`, evidence: evG }));
    else out.push(unscored('INTEL-03', { code: gads.status === 'blocked' ? 'BLOCKED' : gads.status === 'empty' ? 'AMBIGUOUS_ABSENCE' : gads.status === 'timeout' ? 'TIMEOUT' : 'FETCH_FAILED', reason: `Google Ads Transparency capture ${gads.status}: ${gads.note || 'no ad count found'}. Not scored.`, evidence: evG }));
    // ── INTEL-04 (SERP)
    const s1 = serp[0]; const evS = [s1.ev?.id, s1.shot?.id].filter(Boolean);
    if (s1.status === 'ok' && s1.organic.length) {
      const rank = s1.organic.find((o) => { try { return registrableHost(new URL(o.url).hostname) === domain; } catch { return false; } })?.pos;
      const conquest = s1.ads.filter((a) => !String(a.domain || '').toLowerCase().includes(domain.split('.')[0]));
      let s = rank === 1 ? 5 : rank && rank <= 3 ? 4 : rank && rank <= 10 ? 3 : 1; if (conquest.length && s > 1) s -= 1;
      out.push(scored('INTEL-04', { score: s, confidence: 'medium', observed: `Google (${s1.source}) for "${brand}": ${domain} ${rank ? 'ranks #' + rank + ' organically' : 'does not appear in the parsed top results'}. ${conquest.length ? `Competitor/other ads shown on the brand query: ${conquest.map((a) => a.domain).slice(0, 4).join(', ')}.` : 'No other advertisers observed on the brand query.'}`, evidence: evS, caveat: 'Single query, single location/time, non-personalised. SERPs vary.' }));
    } else out.push(unscored('INTEL-04', { code: s1.status === 'blocked' ? 'BLOCKED' : 'FETCH_FAILED', reason: `${s1.note || 'SERP capture failed'}${process.env.SERPAPI_KEY ? '' : ' Set SERPAPI_KEY to use a licensed SERP API instead of scraping Google.'} Not scored — a blocked SERP is not a ranking problem.`, evidence: evS }));
    // ── INTEL-05 competitors
    if (!competitors.length) out.push(unscored('INTEL-05', { code: 'NOT_CONFIGURED', reason: 'No competitors supplied. Add up to 3 competitor domains under Advanced options to capture their public Meta/Google creative, offers and destinations.', evidence: [ev.plan.id] }));
    else {
      const table = comp.map((c) => { const at = c.meta.ads.filter((a) => a.attribution === 'destination-domain'); return { domain: c.domain, metaStatus: c.meta.status, metaAttributedAds: at.length, metaOffers: [...new Set(at.flatMap((a) => a.offers))].slice(0, 8), metaDestinations: [...new Set(at.flatMap((a) => a.destinationTypes))], metaSampleCopy: at.slice(0, 2).map((a) => a.copy.slice(0, 160)), googleStatus: c.gads.status, googleAds: c.gads.totalText, googleAdvertisers: c.gads.advertisers }; });
      ev.comp = run.json(H, 'competitor-capture-summary', { target: { domain, metaAttributedAds: meta.ads.filter((a) => a.attribution === 'destination-domain').length, googleAds: gads.totalText }, competitors: table });
      out.push(unscored('INTEL-05', { code: 'OBSERVATION_ONLY', reason: `Captured public creative for ${table.length} competitor(s): ${table.map((t) => `${t.domain} (Meta ${t.metaAttributedAds} attributable, Google ${t.googleAds || t.googleStatus})`).join('; ')}. Side-by-side offers and destinations are in the evidence; scoring needs a peer benchmark set.`, evidence: [ev.comp.id] }));
    }
  } catch (e) {
    run.failure(H, 'h4', e);
    for (const id of ['INTEL-01', 'INTEL-02', 'INTEL-03', 'INTEL-04', 'INTEL-05']) if (!out.some((c) => c.id === id)) out.push(unscored(id, { code: 'HARNESS_FAILED', reason: `Intel harness error: ${e.message}`, evidence: [] }));
  } finally { await browser.close().catch(() => {}); }
  ctx.discovery.intel = { brand, meta: meta && { status: meta.status, attributed: meta.ads?.filter((a) => a.attribution === 'destination-domain').length }, gads: gads && { status: gads.status, total: gads.total } };
  return { checks: out };
}
