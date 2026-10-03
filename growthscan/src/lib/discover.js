// Candidate product discovery for the "Review sample" step. Static fetches only (home page links, then product sitemaps); no browser, no cart actions.
import * as cheerio from 'cheerio';
import { politeFetch, UA_DESKTOP } from './net.js';
import { parseRobots } from './robots.js';

export const productRoot = (href, base) => { try { const x = new URL(href, base); const m = x.pathname.match(/\/products?\/[^/?#]+/); return m ? x.origin + m[0] : null; } catch { return null; } };
export const humanize = (u) => decodeURIComponent(u.split('/').pop() || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function homeProductLinks(html, base) {
  const $ = cheerio.load(html); const out = [];
  $('a[href]').each((_, a) => { const r = productRoot($(a).attr('href'), base); if (r) out.push(r); });
  return [...new Set(out)];
}
export function sitemapProductUrls(xml, base) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return [...new Set($('url > loc').map((_, e) => productRoot($(e).text().trim(), base)).get().filter(Boolean))];
}

export async function discoverProducts(origin, { max = 24, defaultCount = 3 } = {}) {
  const cands = []; const seen = new Set(); const add = (u, source) => { if (u && !seen.has(u) && cands.length < max) { seen.add(u); cands.push({ url: u, name: humanize(u), source }); } };
  const home = await politeFetch(origin + '/', { ua: UA_DESKTOP });
  if (!home.ok) return { ok: false, reason: `Home page returned ${home.kind}${home.status ? ' ' + home.status : ''}; product discovery needs a readable home page.`, candidates: [] };
  for (const u of homeProductLinks(home.body, home.finalUrl)) add(u, 'linked from home page');
  let smNote = null;
  try {
    const robots = await politeFetch(origin + '/robots.txt', { ua: UA_DESKTOP });
    const maps = [...new Set([...(robots.ok ? parseRobots(robots.body).sitemaps : []), origin + '/sitemap.xml'])].slice(0, 3);
    for (const sm of maps) {
      const r = await politeFetch(sm, { ua: UA_DESKTOP, maxBytes: 3_000_000 }); if (!r.ok) continue;
      const $ = cheerio.load(r.body, { xmlMode: true }); const kids = $('sitemap > loc').map((_, e) => $(e).text().trim()).get();
      const targets = kids.length ? kids.filter((k) => /product/i.test(k)).slice(0, 3) : [sm];
      for (const t of targets) { const rr = t === sm ? r : await politeFetch(t, { ua: UA_DESKTOP, maxBytes: 3_000_000 }); if (rr.ok) for (const u of sitemapProductUrls(rr.body, origin)) add(u, 'sitemap'); }
      if (cands.length >= max) break;
    }
  } catch (e) { smNote = `Sitemap lookup failed: ${e.message}`; }
  const ok = cands.length > 0;
  return { ok, min: Math.min(3, cands.length), complete: cands.length < max, reason: ok ? null : 'No product pages were found. If this is not a standard product-page site, paste product URLs in Advanced options.', note: smNote, candidates: cands.map((c, i) => ({ ...c, selected: i < defaultCount })) };
}
