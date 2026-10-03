// Network helpers: SSRF guard, URL normalisation, polite fetch with explicit outcome kinds.
import dns from 'node:dns/promises';
import net from 'node:net';
import { fetch as ufetch, Agent } from 'undici';
import { guardedLookup } from './egress.js';
import { detectChallenge } from './challenge.js';

const agent = new Agent({ connect: { lookup: guardedLookup() } });

export const UA_BROWSER =
  process.env.GS_USER_AGENT ||
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 GrowthScan/0.2 (+https://goodjoojoo.com)';
export const UA_DESKTOP =
  process.env.GS_USER_AGENT_DESKTOP ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 GrowthScan/0.2 (+https://goodjoojoo.com)';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') ||
      (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
  }
  return true;
}

export async function assertPublicHost(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal'))
    throw Object.assign(new Error(`Host not allowed: ${hostname}`), { kind: 'ssrf_blocked' });
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw Object.assign(new Error(`Private IP not allowed: ${hostname}`), { kind: 'ssrf_blocked' });
    return;
  }
  let addrs = [];
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch (e) { throw Object.assign(new Error(`DNS lookup failed for ${hostname}: ${e.code || e.message}`), { kind: 'dns_error', code: e.code }); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw Object.assign(new Error(`${hostname} resolves to a non-public address`), { kind: 'ssrf_blocked' });
}

// Accepts "cedarcide.com", "www.cedarcide.com/x", "https://…". Public http(s) only.
export function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Enter a website URL, e.g. cedarcide.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error(`"${raw}" is not a valid URL`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are supported');
  if (!u.hostname.includes('.') && !net.isIP(u.hostname)) throw new Error('Enter a full domain, e.g. cedarcide.com');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Only standard ports (80/443) are allowed');
  u.username = ''; u.password = ''; u.hash = '';
  return u;
}

export function registrableHost(host) {
  return host.replace(/^www\./i, '').toLowerCase();
}

const lastHit = new Map();
export async function pace(host, gapMs = Number(process.env.GS_PACE_MS || 500)) {
  const now = Date.now();
  const wait = Math.max(0, (lastHit.get(host) || 0) + gapMs - now);
  lastHit.set(host, now + wait);
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const CHALLENGE_RE = /just a moment|attention required|checking your browser|captcha|cf-chl|access denied|bot detection|px-captcha|perimeterx|datadome/i;

/**
 * Fetch with manual redirects. Only a 2xx is ever `ok` content.
 * kind: ok | http_error | blocked | timeout | network_error | ssrf_blocked | dns_error
 * A 404 is a real, positive observation (kind=http_error,status=404); a 429/challenge is `blocked` and must never be scored.
 */
export async function politeFetch(url, { timeout = 20000, headers = {}, maxRedirects = 8, maxBytes = 4_000_000, ua = UA_DESKTOP, method = 'GET' } = {}) {
  const started = Date.now();
  const chain = [];
  let cur = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = new URL(cur);
      await assertPublicHost(u.hostname);
      await pace(u.hostname);
      const res = await ufetch(cur, {
        dispatcher: agent, method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...headers },
      });
      const hdrs = Object.fromEntries(res.headers.entries());
      const loc = res.headers.get('location');
      chain.push({ url: cur, status: res.status, location: loc || null });
      if (res.status >= 300 && res.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        if (hop === maxRedirects) return { ok: false, kind: 'http_error', status: res.status, finalUrl: cur, chain, headers: hdrs, error: 'Too many redirects', ms: Date.now() - started };
        continue;
      }
      let body = '';
      if (method !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer());
        body = buf.subarray(0, maxBytes).toString('utf8');
      }
      const bodyLen = body.length;
      const challenged = (res.status === 403 || res.status === 503 || res.status === 429) &&
        (hdrs['cf-mitigated'] || CHALLENGE_RE.test(body.slice(0, 6000)) || res.status === 429);
      if (res.status >= 200 && res.status < 300) {
        const ch = detectChallenge({ status: res.status, headers: hdrs, url: cur, body });
        if (ch) return { ok: false, kind: 'blocked', status: res.status, finalUrl: cur, chain, headers: hdrs, challenge: ch, diagnosticSample: body.slice(0, 300), bodyLen, error: `Bot-protection challenge (${ch.vendor}): ${ch.signal}`, ms: Date.now() - started };
        return { ok: true, kind: 'ok', status: res.status, finalUrl: cur, chain, headers: hdrs, body, bodyLen, ms: Date.now() - started };
      }
      const blocked = res.status === 429 || challenged || res.status === 401;
      return {
        ok: false, kind: blocked ? 'blocked' : 'http_error', status: res.status, finalUrl: cur, chain, headers: hdrs,
        // body of a non-2xx is kept only as a short diagnostic sample, never as page content
        diagnosticSample: body.slice(0, 300), bodyLen, retryAfter: hdrs['retry-after'] || null,
        error: `HTTP ${res.status}`, ms: Date.now() - started,
      };
    }
  } catch (e) {
    const kind = e.kind || (e.cause?.code === 'ESSRF' || e.code === 'ESSRF' ? 'ssrf_blocked' : e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network_error');
    return { ok: false, kind, status: null, finalUrl: cur, chain, headers: {}, error: e.message, ms: Date.now() - started };
  }
}
