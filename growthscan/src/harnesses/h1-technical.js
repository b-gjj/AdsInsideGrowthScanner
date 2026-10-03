// Harness 1 — Technical source / DNS (deterministic; no LLM).
import dns from 'node:dns/promises';
import * as cheerio from 'cheerio';
import { politeFetch, UA_DESKTOP } from '../lib/net.js';
import { launch, newContext } from '../lib/browser.js';
import { parseRobots, isAllowed, groupFor } from '../lib/robots.js';
import { detectTags } from '../lib/tags.js';
import { scored, unscored, bucket } from '../lib/checks.js';
import { detectChallenge } from '../lib/challenge.js';

const H = 'h1';
const fetchSummary = (r) => ({ ok: r.ok, kind: r.kind, status: r.status, finalUrl: r.finalUrl, chain: r.chain, ms: r.ms, error: r.error || null, retryAfter: r.retryAfter || null, headers: r.headers, bytes: r.bodyLen ?? null, diagnosticSample: r.diagnosticSample || null });
const why = (r) => (r.kind === 'blocked' ? 'BLOCKED' : r.kind === 'timeout' ? 'TIMEOUT' : 'FETCH_FAILED');

export function visibleTextFromHtml(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,template,svg,iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

export function extractJsonLd(html) {
  const $ = cheerio.load(html); const blocks = []; const errors = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try { blocks.push(JSON.parse(raw)); } catch (e) { errors.push(e.message); }
  });
  const nodes = [];
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === 'object') { if (n['@graph']) walk(n['@graph']); if (n['@type']) nodes.push(n); } };
  blocks.forEach(walk);
  const types = [...new Set(nodes.flatMap((n) => [].concat(n['@type'])))];
  return { nodes, types, errors, blockCount: blocks.length };
}

async function txt(name) {
  try { return { ok: true, records: (await dns.resolveTxt(name)).map((c) => c.join('')) }; }
  catch (e) {
    if (['ENODATA', 'ENOTFOUND'].includes(e.code)) return { ok: true, records: [], absent: true, code: e.code };
    return { ok: false, records: [], code: e.code || e.message };
  }
}

async function spfLookups(record, depth = 0, seen = new Set(), counter = { n: 0, errors: [] }) {
  if (depth > 6 || counter.n > 30) return counter;
  for (const tok of record.split(/\s+/).slice(1)) {
    const t = tok.replace(/^[+\-~?]/, '');
    if (/^(include:|redirect=|exists:)/i.test(t)) {
      counter.n++;
      const target = t.split(/[:=]/)[1];
      if (/^(include:|redirect=)/i.test(t) && target && !seen.has(target)) {
        seen.add(target);
        const r = await txt(target);
        if (!r.ok) { counter.errors.push(`${target}: ${r.code}`); continue; }
        const rec = r.records.find((x) => /^v=spf1/i.test(x));
        if (rec) await spfLookups(rec, depth + 1, seen, counter);
      }
    } else if (/^(a|mx|ptr)(:|\/|$)/i.test(t)) counter.n++;
  }
  return counter;
}

const parents = (host) => { const l = host.split('.'); const out = []; for (let i = 0; i <= l.length - 2; i++) out.push(l.slice(i).join('.')); return out; };

export async function runH1(ctx) {
  const { run, url, host } = ctx;
  const out = []; const ev = {};
  const origin = new URL(url).origin;

  // 1 — Static fetch of the entry URL + http→https test
  run.step(H, 'HTTP status, redirects, headers', 'running');
  const home = await politeFetch(url, { ua: UA_DESKTOP });
  const noteBlock = (step, ch, u) => { (ctx.discovery.blocks ||= []).push({ harness: H, step, url: u, vendor: ch?.vendor || 'unknown bot protection', signal: ch?.signal || 'blocked', seenAs: ch?.seenAs || null }); };
  if (home.kind === 'blocked') noteBlock('static fetch', home.challenge, url);
  ev.homeFetch = run.json(H, 'home-fetch', fetchSummary(home), { url });
  if (home.ok) ev.homeHtml = run.text(H, 'home-static', home.body, 'html', { url: home.finalUrl });
  else run.failure(H, 'home-static', { message: `${home.kind}: ${home.error}`, kind: home.kind }, { url });
  const httpVariant = await politeFetch('http://' + host + '/', { ua: UA_DESKTOP, method: 'GET', maxRedirects: 4 });
  ev.httpFetch = run.json(H, 'http-variant-fetch', fetchSummary(httpVariant), { url: 'http://' + host + '/' });
  run.step(H, 'HTTP status, redirects, headers', home.ok ? 'done' : 'failed', home.ok ? `HTTP ${home.status}` : `${home.kind} ${home.status ?? ''}`);
  const finalOrigin = home.finalUrl ? new URL(home.finalUrl).origin : origin;

  if (!home.ok) {
    out.push(unscored('TECH-01', { code: why(home), reason: `Entry URL returned ${home.kind}${home.status ? ' HTTP ' + home.status : ''}: ${home.error}. Availability cannot be assessed from a blocked/failed response — this is not scored as a failure of the site.`, evidence: [ev.homeFetch.id] }));
  } else {
    const hops = home.chain.length - 1;
    const httpsFinal = home.finalUrl.startsWith('https://');
    const httpUpgrade = httpVariant.chain?.some((c) => c.location?.startsWith('https://')) ?? false;
    let s = 5; const notes = [];
    if (!httpsFinal) { s -= 3; notes.push('final URL is not HTTPS'); }
    if (hops > 1) { s -= Math.min(2, hops - 1); notes.push(`${hops} redirect hops`); }
    if (httpVariant.kind === 'ok' || httpVariant.kind === 'http_error') { if (!httpUpgrade) { s -= 1; notes.push('http:// does not redirect to https://'); } }
    if (home.ms > 3000) { s -= 1; notes.push(`slow response (${home.ms} ms)`); }
    out.push(scored('TECH-01', { score: Math.max(0, s), confidence: 'high', observed: `HTTP ${home.status} at ${home.finalUrl} after ${hops} redirect hop(s), ${home.ms} ms. ${notes.length ? 'Issues: ' + notes.join('; ') + '.' : 'No issues observed.'}`, evidence: [ev.homeFetch.id, ev.httpFetch.id], caveat: 'Response time measured from the runner location, single request.' }));
  }

  // 2 — Rendered load (tags, schema, parity)
  run.step(H, 'Rendered page load (tags, schema, parity)', 'running');
  let rendered = null; let renderedBlocked = null; const requests = [];
  try {
    const browser = await launch();
    try {
      const bctx = await newContext(browser, { mobile: false, log: (e) => run.failure(H, 'guard', { message: JSON.stringify(e), kind: 'guard' }) });
      const page = await bctx.newPage();
      page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
      const resp = await page.goto(home.finalUrl || url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const html = await page.content();
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const dom = await page.evaluate(() => ({
        title: document.title, h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).slice(0, 5),
        anchors: document.querySelectorAll('a[href]').length, productLinks: [...document.querySelectorAll('a[href*="/product"]')].map((a) => a.href),
        forms: document.forms.length, images: document.images.length, canonical: [...document.querySelectorAll('link[rel="canonical"]')].map((l) => l.href),
        ogSite: document.querySelector('meta[property="og:site_name"]')?.content || null, desc: document.querySelector('meta[name="description"]')?.content || null,
      }));
      rendered = { status: resp?.status(), html, bodyText, dom };
      ev.renderedHtml = run.text(H, 'home-rendered', html, 'html', { url: page.url() });
      ev.requests = run.json(H, 'home-network-requests', requests, { count: requests.length });
      ev.shot = run.image(H, 'home-desktop', await page.screenshot({ fullPage: false }), { viewport: '1366x900' });
      const ch = detectChallenge({ status: resp?.status(), url: page.url(), title: dom.title, body: html });
      if (ch) { renderedBlocked = ch; rendered = null; noteBlock('rendered load', ch, page.url()); run.failure(H, 'rendered-load', { message: `Bot-protection challenge (${ch.vendor}): ${ch.signal}`, kind: 'blocked' }, { url: page.url() }); }
      else { ctx.discovery.siteName = dom.ogSite || null; ctx.discovery.title = dom.title; ctx.discovery.homeLinks = dom.productLinks; }
    } finally { await browser.close(); }
    run.step(H, 'Rendered page load (tags, schema, parity)', renderedBlocked ? 'failed' : 'done', renderedBlocked ? `blocked by ${renderedBlocked.vendor} challenge` : `${requests.length} requests observed`);
  } catch (e) {
    run.failure(H, 'rendered-load', e, { url }); run.step(H, 'Rendered page load (tags, schema, parity)', 'failed', e.message);
  }

  // 3 — Canonical
  const staticHtml = home.ok ? home.body : null;
  const canon = (html) => { if (!html) return null; const $ = cheerio.load(html); return $('link[rel="canonical"]').map((_, e) => $(e).attr('href')).get(); };
  const cs = canon(staticHtml); const cr = rendered ? canon(rendered.html) : null;
  const normU = (u) => { try { const x = new URL(u, home.finalUrl || url); return x.origin + x.pathname.replace(/\/$/, ''); } catch { return u; } };
  const evC = [ev.homeHtml?.id, ev.renderedHtml?.id].filter(Boolean);
  if (cs === null && cr === null) out.push(unscored('TECH-02', { code: why(home), reason: 'Neither static nor rendered HTML could be collected.', evidence: [ev.homeFetch.id] }));
  else {
    const all = [...new Set([...(cs || []), ...(cr || [])])];
    let s; let obs;
    if (cs?.length > 1 && new Set(cs.map(normU)).size > 1) { s = 1; obs = `Multiple conflicting canonicals in static HTML: ${cs.join(', ')}.`; }
    else if (cs?.length) { const self = normU(cs[0]) === normU(home.finalUrl || url); s = self ? 5 : 3; obs = `Static HTML canonical: ${cs[0]} (${self ? 'matches the page URL' : 'differs from the fetched URL ' + (home.finalUrl || url)}).`; }
    else if (cr?.length) { s = 3; obs = `No canonical in static HTML; one appears only after JavaScript runs (${cr[0]}).`; }
    else if (cs !== null && cr !== null) { s = 1; obs = 'No canonical tag in static or rendered HTML (both observed successfully).'; }
    else { out.push(unscored('TECH-02', { code: 'FETCH_FAILED', reason: 'Only one of static/rendered HTML was collected, and it had no canonical; cannot rule out the other.', evidence: evC })); s = null; }
    if (s !== null) out.push(scored('TECH-02', { score: s, confidence: 'high', observed: obs, evidence: evC.length ? evC : [ev.homeFetch.id], detail: { static: cs, rendered: cr, all } }));
  }

  // 4 — robots.txt
  run.step(H, 'robots.txt & AI-crawler policy', 'running');
  const robots = await politeFetch(finalOrigin + '/robots.txt', { ua: UA_DESKTOP });
  ev.robots = run.json(H, 'robots-fetch', fetchSummary(robots));
  let parsed = null;
  if (robots.ok) { ev.robotsTxt = run.text(H, 'robots', robots.body, 'txt'); parsed = parseRobots(robots.body); }
  run.step(H, 'robots.txt & AI-crawler policy', robots.ok || robots.status === 404 ? 'done' : 'failed', `${robots.kind} ${robots.status ?? ''}`);
  if (robots.ok) {
    const ge = groupFor(parsed, 'Googlebot');
    const blocksAll = !isAllowed(parsed, 'Googlebot', '/');
    const blocksProducts = !isAllowed(parsed, 'Googlebot', '/products/test');
    const hasSitemap = parsed.sitemaps.length > 0;
    const blocksCart = !isAllowed(parsed, 'Googlebot', '/cart') || !isAllowed(parsed, 'Googlebot', '/checkout');
    let s = 5; const n = [];
    if (blocksAll) { s = 0; n.push('Googlebot is disallowed from the entire site'); }
    else {
      if (blocksProducts) { s -= 2; n.push('product paths appear disallowed'); }
      if (!hasSitemap) { s -= 1; n.push('no Sitemap: directive'); }
      if (!blocksCart) { s -= 0.5; n.push('cart/checkout not disallowed'); }
    }
    out.push(scored('TECH-03', { score: Math.max(0, s), confidence: 'high', observed: `robots.txt returned HTTP ${robots.status} with ${parsed.groups.length} user-agent group(s) and ${parsed.sitemaps.length} sitemap directive(s). ${n.length ? 'Issues: ' + n.join('; ') + '.' : 'No blocking issues observed.'}`, evidence: [ev.robots.id, ev.robotsTxt.id] }));
    // AI crawlers
    const bots = { search: ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot', 'ChatGPT-User', 'Claude-User'], training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended'] };
    const status = {};
    for (const b of [...bots.search, ...bots.training]) status[b] = isAllowed(parsed, b, '/') ? 'allowed' : 'disallowed';
    const sBlocked = bots.search.filter((b) => status[b] === 'disallowed'); const tBlocked = bots.training.filter((b) => status[b] === 'disallowed');
    ev.ai = run.json(H, 'ai-crawler-policy', { status, note: 'Derived from robots.txt rules only. WAF/CDN rules may differ and are not tested here.' });
    out.push(scored('TECH-04', { score: sBlocked.length ? (sBlocked.length >= 3 ? 1 : 2) : tBlocked.length ? 4 : 5, confidence: 'medium', observed: sBlocked.length ? `robots.txt disallows answer/search crawlers: ${sBlocked.join(', ')}.` : tBlocked.length ? `Answer/search crawlers allowed; training crawlers disallowed (${tBlocked.join(', ')}) — typically a business choice.` : 'No AI/answer-engine crawlers are disallowed in robots.txt.', evidence: [ev.robots.id, ev.ai.id], caveat: 'robots.txt expresses policy only; it does not prove a WAF/CDN actually lets these bots through.' }));
  } else if (robots.status === 404) {
    out.push(scored('TECH-03', { score: 2, confidence: 'high', observed: 'robots.txt returned HTTP 404: crawling is unrestricted, but there is no sitemap pointer and no cart/checkout/parameter rules.', evidence: [ev.robots.id] }));
    out.push(unscored('TECH-04', { code: 'AMBIGUOUS_ABSENCE', reason: 'No robots.txt exists, so no per-bot policy is expressed; WAF behaviour is not observable here.', evidence: [ev.robots.id] }));
  } else {
    const c = why(robots);
    out.push(unscored('TECH-03', { code: c, reason: `robots.txt fetch returned ${robots.kind} ${robots.status ?? ''}: ${robots.error}. Not scored (a blocked fetch is not a missing file).`, evidence: [ev.robots.id] }));
    out.push(unscored('TECH-04', { code: c, reason: 'robots.txt could not be fetched.', evidence: [ev.robots.id] }));
  }

  // 5 — Sitemap
  run.step(H, 'Sitemap discovery & sampling', 'running');
  const smCandidates = [...new Set([...(parsed?.sitemaps || []), finalOrigin + '/sitemap.xml'])].slice(0, 4);
  const smResults = []; let urls = []; const smEvidence = [];
  for (const sm of smCandidates) {
    const r = await politeFetch(sm, { ua: UA_DESKTOP, maxBytes: 3_000_000 });
    const rec = { url: sm, ...fetchSummary(r) }; smResults.push(rec);
    if (!r.ok) continue;
    const $ = cheerio.load(r.body, { xmlMode: true });
    const isIndex = $('sitemapindex').length > 0;
    rec.type = isIndex ? 'index' : 'urlset';
    if (isIndex) {
      const children = $('sitemap > loc').map((_, e) => $(e).text().trim()).get();
      rec.children = children.slice(0, 40);
      for (const child of children.slice(0, 6)) {
        const cr = await politeFetch(child, { ua: UA_DESKTOP, maxBytes: 3_000_000 });
        rec.childResults = rec.childResults || []; rec.childResults.push({ url: child, status: cr.status, kind: cr.kind });
        if (cr.ok) { const c$ = cheerio.load(cr.body, { xmlMode: true }); urls.push(...c$('url').map((_, e) => ({ loc: c$(e).find('loc').first().text().trim(), lastmod: c$(e).find('lastmod').first().text().trim() || null })).get()); }
      }
    } else urls.push(...$('url').map((_, e) => ({ loc: $(e).find('loc').first().text().trim(), lastmod: $(e).find('lastmod').first().text().trim() || null })).get());
    if (urls.length) break;
  }
  ev.sitemap = run.json(H, 'sitemap-discovery', { candidates: smResults, urlCount: urls.length, sampleUrls: urls.slice(0, 20) });
  const step = Math.max(1, Math.floor(urls.length / 5)); const picks = []; for (let i = 0; i < urls.length && picks.length < 5; i += step) picks.push(urls[i]);
  const sampleResults = [];
  for (const p of picks) { const r = await politeFetch(p.loc, { ua: UA_DESKTOP, method: 'HEAD', timeout: 15000 }); sampleResults.push({ url: p.loc, status: r.status, kind: r.kind, finalUrl: r.finalUrl }); }
  if (picks.length) ev.smSample = run.json(H, 'sitemap-url-sample', sampleResults);
  const productish = urls.map((u) => u.loc).filter((l) => /\/products?\//i.test(l));
  ctx.discovery.pdpCandidates = productish.slice(0, 5); ctx.discovery.allProductUrls = productish; ctx.discovery.sitemapUrlCount = urls.length;
  run.step(H, 'Sitemap discovery & sampling', 'done', `${urls.length} URLs`);
  const smOk = smResults.some((r) => r.ok);
  const smAny404 = smResults.length && smResults.every((r) => r.status === 404);
  const smBlocked = smResults.some((r) => r.kind === 'blocked');
  if (urls.length) {
    const good = sampleResults.filter((r) => r.status >= 200 && r.status < 300).length; const lm = urls.filter((u) => u.lastmod).length / urls.length;
    const declared = parsed?.sitemaps?.length > 0;
    let s = 5; const n = [];
    if (!declared) { s -= 1; n.push('not declared in robots.txt'); }
    if (sampleResults.length && good < sampleResults.length) { s -= Math.min(3, sampleResults.length - good); n.push(`${sampleResults.length - good}/${sampleResults.length} sampled URLs did not return 2xx`); }
    if (lm < 0.5) { s -= 1; n.push('lastmod missing on most URLs'); }
    out.push(scored('TECH-05', { score: Math.max(0, s), confidence: 'high', observed: `Sitemap parsed: ${urls.length} URLs found (${productish.length} product-like). ${good}/${sampleResults.length} sampled URLs returned 2xx. ${n.length ? 'Issues: ' + n.join('; ') + '.' : 'No issues observed.'}`, evidence: [ev.sitemap.id, ...(ev.smSample ? [ev.smSample.id] : [])], caveat: 'Sampled via HEAD requests; some servers answer HEAD differently from GET.' }));
  } else if (smAny404 && !smBlocked) out.push(scored('TECH-05', { score: 0, confidence: 'high', observed: 'No sitemap declared in robots.txt and /sitemap.xml returned HTTP 404.', evidence: [ev.sitemap.id] }));
  else out.push(unscored('TECH-05', { code: smBlocked ? 'BLOCKED' : smOk ? 'FETCH_FAILED' : 'FETCH_FAILED', reason: smOk ? 'Sitemap fetched but no URLs could be parsed.' : 'Sitemap requests failed or were blocked; absence cannot be concluded.', evidence: [ev.sitemap.id] }));

  // 6 — Schema (home static+rendered, PDP static)
  run.step(H, 'Structured data', 'running');
  const sHome = staticHtml ? extractJsonLd(staticHtml) : null; const rHome = rendered ? extractJsonLd(rendered.html) : null;
  const cleanPdp = (u) => { try { const x = new URL(u, home.finalUrl || url); const m = x.pathname.match(/\/products?\/[^/]+/); return m ? x.origin + m[0] : null; } catch { return null; } };
  const homePdps = [...new Set((ctx.discovery.homeLinks || []).map(cleanPdp).filter(Boolean))];
  ctx.discovery.homePdps = homePdps;
  { const all = new Set([...homePdps, ...(ctx.discovery.allProductUrls || []).map(cleanPdp)].filter(Boolean)); ctx.discovery.productsAvailable = all.size; ctx.discovery.productsAvailableAuthoritative = (ctx.discovery.sitemapUrlCount || 0) > 0; }
  // Order of preference: operator override → first product linked from the home page → first product in sitemap
  let pdpUrl = ctx.options?.pdpUrl || homePdps[0] || ctx.discovery.pdpCandidates[0] || null;
  ctx.discovery.pdpSource = ctx.options?.pdpUrl ? 'operator-supplied' : homePdps[0] ? 'linked from home page' : ctx.discovery.pdpCandidates[0] ? 'sitemap' : null;
  let sPdp = null; let pdpFetch = null;
  if (pdpUrl) { pdpFetch = await politeFetch(pdpUrl, { ua: UA_DESKTOP }); if (pdpFetch.ok) sPdp = extractJsonLd(pdpFetch.body); }
  // Product schema is evaluated on up to 3 product pages (operator-selected, else linked from home, else sitemap), not one.
  const pdpSet = [...new Set([...(ctx.options?.pdpUrls || []).map(cleanPdp), ...homePdps, ...ctx.discovery.pdpCandidates.map(cleanPdp)].filter(Boolean))].slice(0, Math.max(3, Math.min(5, (ctx.options?.pdpUrls || []).length)));
  const pdpResults = [];
  for (const u of pdpSet) { const r = u === pdpUrl && pdpFetch ? pdpFetch : await politeFetch(u, { ua: UA_DESKTOP }); const j = r.ok ? (u === pdpUrl && sPdp ? sPdp : extractJsonLd(r.body)) : null; pdpResults.push({ url: u, status: r.status, kind: r.kind, j }); }
  ctx.discovery.pdpUrl = pdpUrl;
  ev.schema = run.json(H, 'schema-extraction', { home: { static: sHome && { types: sHome.types, errors: sHome.errors, blocks: sHome.blockCount }, rendered: rHome && { types: rHome.types, errors: rHome.errors, blocks: rHome.blockCount }, nodes: (rHome || sHome)?.nodes?.slice(0, 20) }, pdpSet: pdpResults.map((r) => ({ url: r.url, status: r.status, kind: r.kind, types: r.j?.types || null })), pdp: pdpFetch && { url: pdpUrl, source: ctx.discovery.pdpSource, status: pdpFetch.status, kind: pdpFetch.kind, types: sPdp?.types, errors: sPdp?.errors, productNode: sPdp?.nodes.find((n) => [].concat(n['@type']).includes('Product')) } });
  run.step(H, 'Structured data', 'done');
  if (!sHome && !rHome) out.push(unscored('TECH-06', { code: why(home), reason: 'No HTML collected for the home page.', evidence: [ev.homeFetch.id] }));
  else {
    const hTypes = new Set([...(sHome?.types || []), ...(rHome?.types || [])]);
    const staticTypes = new Set(sHome?.types || []);
    // ── AIV-02 Organization structured data (home page)
    const hasOrg = ['Organization', 'Corporation', 'LocalBusiness', 'OnlineStore', 'Store'].some((t) => hTypes.has(t)); const orgStatic = ['Organization', 'Corporation', 'LocalBusiness', 'OnlineStore', 'Store'].some((t) => staticTypes.has(t));
    const hasSite = hTypes.has('WebSite'); const orgNode = (rHome || sHome).nodes.find((n) => [].concat(n['@type']).some((t) => ['Organization', 'Corporation', 'LocalBusiness', 'OnlineStore', 'Store'].includes(t)));
    const orgFields = orgNode ? ['name', 'url', 'logo', 'sameAs'].filter((f) => orgNode[f]) : [];
    let orgScore = 1; let orgObs;
    if (hasOrg) { orgScore = 3 + (orgFields.length >= 3 ? 1 : 0) + (hasSite ? 0.5 : 0) + (orgStatic ? 0.5 : -0.5); orgObs = `Organization JSON-LD ${orgStatic ? 'in static HTML' : 'only after JavaScript'} on the home page with fields: ${orgFields.join(', ') || 'none of name/url/logo/sameAs'}; WebSite schema ${hasSite ? 'present' : 'absent'}.`; }
    else orgObs = `No Organization JSON-LD on the home page (static or rendered); types found: ${[...hTypes].join(', ') || 'none'}.`;
    // ── AIV-03 Product structured data (sampled product pages)
    const prodRes = pdpResults.filter((r) => r.j).map((r) => {
      const prod = r.j.nodes.find((x) => [].concat(x['@type']).includes('Product'));
      if (!prod) return { url: r.url, found: false, score: 1, types: r.j.types };
      const offer = [].concat(prod.offers || [])[0] || {};
      const need = [['name', prod.name], ['image', prod.image], ['offers.price', offer.price ?? offer.lowPrice], ['offers.priceCurrency', offer.priceCurrency], ['offers.availability', offer.availability]];
      const missing = need.filter(([, v]) => v === undefined || v === '').map(([k]) => k);
      return { url: r.url, found: true, missing, aggregateRating: !!prod.aggregateRating, score: Math.min(5, 3 + (missing.length === 0 ? 1.5 : missing.length <= 2 ? 0.5 : 0) + (prod.aggregateRating ? 0.5 : 0)) };
    });
    const slugOf = (u) => u.split('/').pop();
    let prodParent;
    if (prodRes.length) {
      const sc = prodRes.map((x) => x.score).sort((a, b) => a - b); const med = sc.length % 2 ? sc[(sc.length - 1) / 2] : (sc[sc.length / 2 - 1] + sc[sc.length / 2]) / 2;
      prodParent = { score: med, confidence: prodRes.length >= 3 ? 'medium' : 'low', observed: `Product JSON-LD checked on ${prodRes.length} product page(s) in static HTML: ${prodRes.map((x) => `${slugOf(x.url)} ${x.found ? 'Product' + (x.missing.length ? ' (missing ' + x.missing.join(', ') + ')' : ' with core fields') + (x.aggregateRating ? ' + aggregateRating' : '') : 'no Product schema'}`).join('; ')}.`, caveat: 'Structural check of static-HTML JSON-LD fields only; not a Rich Results eligibility test. Sample of product pages, not a census.' };
    } else prodParent = { unscored: true, code: 'FETCH_FAILED', reason: pdpSet.length ? 'None of the sampled product pages could be fetched.' : 'No product page was discovered.' };
    const orgParent = { score: Math.max(0, Math.min(5, orgScore)), confidence: 'high', observed: orgObs, caveat: 'Home page only; Microdata/RDFa not parsed.' };
    const parts = [orgParent.score, ...(prodParent.unscored ? [] : [prodParent.score])];
    out.push(scored('TECH-06', { score: Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 2) / 2, confidence: prodParent.unscored ? 'low' : prodParent.confidence, observed: `Organization: ${orgObs} Product: ${prodParent.unscored ? prodParent.reason : prodParent.observed}`, evidence: [ev.schema.id], caveat: 'Subtest only; the master checks AIV-02 (Organization) and AIV-03 (Product) carry their own results. Breadcrumb schema is not scored here.', parents: { 'AIV-02': orgParent, 'AIV-03': prodParent }, detail: { breadcrumbObservedOnPdp: pdpResults.some((r) => r.j?.types.includes('BreadcrumbList')) } }));
  }

  // 7 — Tags
  if (rendered) {
    const tags = detectTags({ html: rendered.html, requests });
    ev.tags = run.json(H, 'public-tag-detection', { ...tags, note: 'Detection only. Presence of a tag or request does not establish correct configuration, event accuracy, deduplication or consent behaviour. Consent banners may delay or suppress tags for an uncontrolled visitor.' });
    const has = (cat) => tags.found.filter((f) => f.category === cat);
    const core = has('analytics').filter((a) => !/deprecated/.test(a.name));
    if (!tags.found.filter((f) => !['commerce'].includes(f.category)).length) out.push(unscored('TECH-07', { code: 'AMBIGUOUS_ABSENCE', reason: 'No marketing/analytics tags were detected. That could mean none are installed, or that they load only after consent / server-side — not distinguishable Outside-In.', evidence: [ev.tags.id, ev.requests.id] }));
    else {
      let s = 0; const n = [];
      if (core.length) s += 1.5; else n.push('no analytics tag detected');
      if (has('advertising').length) s += 1.5; else n.push('no ad-platform tag detected');
      if (has('email_sms').length) s += 1; else n.push('no email/SMS platform detected');
      if (has('consent').length) s += 0.5; else n.push('no consent/CMP detected');
      const dup = tags.ids.ga4.length > 1 || tags.ids.metaPixel.length > 1;
      if (!dup) s += 0.5; else n.push(`multiple IDs (GA4: ${tags.ids.ga4.length}, Meta pixel: ${tags.ids.metaPixel.length}) — may be intentional`);
      if (has('attribution').length) s += 0.5;
      out.push(scored('TECH-07', { score: Math.min(5, s), confidence: 'low', observed: `Detected: ${tags.found.map((f) => f.name).join(', ')}. ${n.length ? 'Gaps/notes: ' + n.join('; ') + '.' : ''}`, evidence: [ev.tags.id, ev.requests.id], caveat: 'Tags detected on one uncontrolled page load. This does not establish that tags fire correctly, deduplicate, or are consent-compliant.', detail: tags }));
    }
  } else out.push(unscored('TECH-07', { code: renderedBlocked ? 'BLOCKED' : 'FETCH_FAILED', reason: renderedBlocked ? `The site answered with a ${renderedBlocked.vendor} bot-protection challenge instead of the page, so tags could not be observed.` : 'Rendered page load failed; tags could not be observed.', evidence: renderedBlocked ? [ev.renderedHtml?.id, ev.shot?.id].filter(Boolean) : [] }));

  // 8–10 — DNS email auth
  run.step(H, 'DNS: SPF / DMARC / DKIM', 'running');
  let spfRec = null; let spfName = null; const dnsLog = [];
  let spfUnknown = false;
  for (const d of parents(host)) { const r = await txt(d); dnsLog.push({ name: d, ...r }); if (!r.ok) { spfUnknown = true; break; } const rec = r.records.filter((x) => /^v=spf1/i.test(x)); if (rec.length) { spfRec = rec; spfName = d; break; } }
  let dmarcRec = null; let dmarcName = null; let dmarcUnknown = false;
  for (const d of parents(host)) { const r = await txt('_dmarc.' + d); dnsLog.push({ name: '_dmarc.' + d, ...r }); if (!r.ok) { dmarcUnknown = true; break; } const rec = r.records.filter((x) => /^v=DMARC1/i.test(x)); if (rec.length) { dmarcRec = rec; dmarcName = d; break; } }
  const selectors = ['google', 'selector1', 'selector2', 'k1', 'k2', 's1', 's2', 'default', 'mail', 'dkim', 'klaviyo', 'kl', 'mandrill', 'sendgrid', 'smtp', 'shopify', 'mxvault', 'zendesk1'];
  const dkimFound = []; const base = parents(host)[Math.max(0, parents(host).length - 1)];
  await Promise.all(selectors.map(async (sel) => { const r = await txt(`${sel}._domainkey.${base}`); if (r.ok && r.records.some((x) => /v=DKIM1|p=/.test(x))) dkimFound.push(sel); }));
  dkimFound.sort();
  const spfLk = spfRec ? await spfLookups(spfRec[0]) : null;
  ev.dns = run.json(H, 'dns-email-auth', { host, queried: dnsLog, spf: spfRec && { name: spfName, records: spfRec, lookups: spfLk }, dmarc: dmarcRec && { name: dmarcName, records: dmarcRec }, dkim: { baseDomain: base, selectorsProbed: selectors, found: dkimFound } });
  run.step(H, 'DNS: SPF / DMARC / DKIM', 'done');
  if (spfUnknown) out.push(unscored('TECH-08', { code: 'FETCH_FAILED', reason: 'DNS TXT lookup errored (timeout/SERVFAIL); absence of SPF cannot be concluded.', evidence: [ev.dns.id] }));
  else if (!spfRec) out.push(scored('TECH-08', { score: 0, confidence: 'high', observed: `DNS returned no SPF (v=spf1) TXT record for ${parents(host).join(' / ')}.`, evidence: [ev.dns.id] }));
  else {
    let s = 5; const n = [];
    if (spfRec.length > 1) { s = 1; n.push('multiple SPF records (invalid)'); }
    const all = spfRec[0].match(/\s([+\-~?]?)all\b/); if (!all) { s -= 1.5; n.push('no "all" mechanism'); } else if (all[1] === '+' || all[1] === '?') { s -= 3; n.push('permissive all'); } else if (all[1] === '~' || all[1] === '') { s -= 0.5; }
    if (spfLk.n > 10) { s -= 2; n.push(`${spfLk.n} DNS lookups (limit 10)`); } else if (spfLk.n >= 9) { s -= 0.5; n.push(`${spfLk.n} DNS lookups, near the limit of 10`); }
    out.push(scored('TECH-08', { score: Math.max(0, s), confidence: spfLk.errors.length ? 'medium' : 'high', observed: `SPF at ${spfName}: ${spfRec[0].slice(0, 160)}. Approx. ${spfLk.n} DNS lookups. ${n.length ? 'Issues: ' + n.join('; ') + '.' : 'No issues observed.'}`, evidence: [ev.dns.id], caveat: 'Lookup count is an approximation from recursive include/redirect resolution.' }));
  }
  if (dmarcUnknown) out.push(unscored('TECH-09', { code: 'FETCH_FAILED', reason: 'DNS TXT lookup errored; DMARC absence cannot be concluded.', evidence: [ev.dns.id] }));
  else if (!dmarcRec) out.push(scored('TECH-09', { score: 0, confidence: 'high', observed: 'DNS returned no DMARC record at _dmarc for the host or its parent domains.', evidence: [ev.dns.id] }));
  else {
    const rec = dmarcRec[0]; const p = (rec.match(/\bp=(\w+)/i) || [])[1]?.toLowerCase(); const pct = Number((rec.match(/\bpct=(\d+)/i) || [])[1] ?? 100); const rua = /\brua=/i.test(rec);
    let s = p === 'reject' ? 5 : p === 'quarantine' ? 4 : 2; if (pct < 100) s -= 0.5; if (!rua) s -= 0.5;
    out.push(scored('TECH-09', { detail: { policy: p || null, pct, hasRua: rua }, score: Math.max(0, s), confidence: 'high', observed: `DMARC at _dmarc.${dmarcName}: ${rec.slice(0, 160)} (policy ${p || 'unknown'}, pct ${pct}, reporting ${rua ? 'on' : 'off'}).`, evidence: [ev.dns.id] }));
  }
  if (dkimFound.length) out.push(scored('TECH-10', { score: 4, confidence: 'low', observed: `DKIM key found at selector(s): ${dkimFound.join(', ')}.`, evidence: [ev.dns.id], caveat: 'Presence of a key does not verify that live mail is signed or aligned.' }));
  else out.push(unscored('TECH-10', { code: 'AMBIGUOUS_ABSENCE', reason: `None of ${selectors.length} common selectors resolved. DKIM selectors are arbitrary, so this is not evidence of absence.`, evidence: [ev.dns.id] }));

  // 11 — Parity
  if (home.ok && rendered) {
    const st = visibleTextFromHtml(home.body); const rt = rendered.bodyText.replace(/\s+/g, ' ').trim();
    const ratio = rt.length ? Math.min(1, st.length / rt.length) : null;
    const $s = cheerio.load(home.body); const staticProd = $s('a[href*="/product"]').length;
    ev.parity = run.json(H, 'static-vs-rendered-parity', { staticTextChars: st.length, renderedTextChars: rt.length, ratio, staticProductLinks: staticProd, renderedProductLinks: rendered.dom.productLinks.length, staticH1: $s('h1').length, renderedH1: rendered.dom.h1.length, staticForms: $s('form').length, renderedForms: rendered.dom.forms, method: 'Static: Node fetch HTML → visible text via DOM parse (script/style/template removed). Rendered: Chromium document.body.innerText after load + 2.5s.' });
    if (ratio === null || rt.length < 200) out.push(unscored('TECH-11', { code: 'FETCH_FAILED', reason: 'Rendered page produced too little text to compare.', evidence: [ev.parity.id] }));
    else {
      let s = bucket(ratio, [[0.15, 0], [0.3, 1], [0.5, 2], [0.7, 3], [0.85, 4], [1, 5]]);
      if (staticProd === 0 && rendered.dom.productLinks.length > 3) s = Math.max(0, s - 1);
      out.push(scored('TECH-11', { score: s, confidence: 'medium', observed: `Static HTML contains ${(ratio * 100).toFixed(0)}% of the visible text present after rendering (${st.length.toLocaleString()} vs ${rt.length.toLocaleString()} characters). Product links: ${staticProd} static vs ${rendered.dom.productLinks.length} rendered.`, evidence: [ev.parity.id, ev.homeHtml.id, ev.renderedHtml.id], caveat: 'Measured on the home page only. Rendered text can include banners/widgets that inflate the gap; compare with the stored HTML before drawing conclusions.' }));
    }
  } else out.push(unscored('TECH-11', { code: renderedBlocked ? 'BLOCKED' : home.ok ? 'FETCH_FAILED' : why(home), reason: 'Both a successful static fetch and a rendered load are required.', evidence: [ev.homeFetch.id] }));

  return { checks: out };
}
