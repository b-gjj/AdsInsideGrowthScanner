// Bot-protection / challenge detection. A challenge page is NEVER evidence about the site: it must make every dependent check `unscored (blocked)`.
// This must hold even when the HTTP status is 2xx (e.g. SiteGround answers a challenge with 202 and a tiny meta-refresh page).
const URL_RE = /\/\.well-known\/sgcaptcha|\/cdn-cgi\/challenge(?!-platform\/scripts)|captcha-delivery\.com|\/_Incapsula_Resource|px-captcha|\/akam\/|perimeterx/i;
const BODY_RE = /sgcaptcha|Robot Challenge Screen|Just a moment\.\.\.|Attention Required! \| Cloudflare|Checking your browser before accessing|Checking the site connection security|px-captcha|captcha-delivery|Pardon Our Interruption|Request unsuccessful\. Incapsula|Access Denied[\s\S]{0,200}Reference #\d/i;
const TITLE_RE = /Robot Challenge|Just a moment|Attention Required|Access Denied|Pardon Our Interruption|Are you a robot|Security Check|Verify you are human/i;

export function vendorOf({ headers = {}, url = '', body = '' }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (h['sg-captcha'] || /sgcaptcha/i.test(url + body)) return 'SiteGround';
  if (h['cf-mitigated'] || /cdn-cgi\/challenge|Just a moment|Attention Required! \| Cloudflare/i.test(url + body)) return 'Cloudflare';
  if (h['x-datadome'] || /datadome|captcha-delivery/i.test(url + body)) return 'DataDome';
  if (/px-captcha|perimeterx/i.test(url + body)) return 'PerimeterX';
  if (/Incapsula/i.test(body)) return 'Imperva';
  if (/akam/i.test(url + (h.server || ''))) return 'Akamai';
  return 'unknown bot protection';
}

/** @returns null when the response looks like real content, else { vendor, signal } */
export function detectChallenge({ status = 200, headers = {}, url = '', title = '', body = '' } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const head = String(body).slice(0, 8000);
  let signal = null;
  if (h['sg-captcha'] === 'challenge') signal = 'response header sg-captcha: challenge';
  else if (h['cf-mitigated']) signal = `response header cf-mitigated: ${h['cf-mitigated']}`;
  else if (URL_RE.test(url)) signal = 'URL is a challenge endpoint';
  else if (TITLE_RE.test(title)) signal = `page title "${title.slice(0, 50)}"`;
  else if (BODY_RE.test(head)) signal = 'challenge text in page';
  else if (status === 202 && String(body).length < 1200 && /http-equiv=["']?refresh/i.test(head)) signal = 'HTTP 202 with a bare meta-refresh page';
  if (!signal) return null;
  const ip = (url + ' ' + head).match(/[?&;]y=ip[rc]:([0-9a-f.:]+?):\d{6,}/i);   // SiteGround echoes the visitor address in its challenge redirect
  return { vendor: vendorOf({ headers, url, body: head }), signal, ...(ip ? { seenAs: ip[1] } : {}) };
}
