// Egress guard. Every byte the browsers (Playwright AND Lighthouse's Chrome) send goes through this local forward proxy.
// The proxy resolves DNS itself, rejects non-public addresses, and connects to the exact IP it validated — so a hostname
// that re-resolves to a private address after validation (DNS rebinding) cannot be reached. Redirects and subresources are covered
// because Chrome routes ALL traffic here, including loopback (via --proxy-bypass-list=<-loopback>).
// Deployment note: this is an application-level control. Also deny egress to RFC1918/link-local/metadata at the network layer where the host allows it.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateIp } from './net.js';

const ALLOWED_PORTS = new Set([80, 443]);

export async function resolvePublic(host, resolver = (h) => dns.lookup(h, { all: true })) {
  if (net.isIP(host)) { if (isPrivateIp(host)) throw Object.assign(new Error(`non-public address ${host}`), { code: 'ESSRF' }); return host; }
  const addrs = await resolver(host);
  if (!addrs?.length || addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error(`${host} resolves to a non-public address`), { code: 'ESSRF' });
  return addrs[0].address;
}

// Node-side fetch uses this as undici's connect.lookup so the connection uses the validated answer.
export function guardedLookup(resolver) {
  return (host, opts, cb) => {
    (resolver ? resolver(host) : dns.lookup(host, { all: true })).then((addrs) => {
      if (!addrs?.length || addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error(`${host} resolves to a non-public address`), { code: 'ESSRF' }));
      return opts?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    }, cb);
  };
}

export function startEgressProxy({ resolver } = {}) {
  const blocked = []; let count = 0;
  const deny = (what, why) => { blocked.push({ at: new Date().toISOString(), what: String(what).slice(0, 200), why }); };
  const server = http.createServer(async (req, res) => {          // plain-HTTP forward requests
    try {
      const u = new URL(req.url);
      const port = Number(u.port || 80); if (!ALLOWED_PORTS.has(port)) throw Object.assign(new Error('port not allowed'), { code: 'ESSRF' });
      const ip = await resolvePublic(u.hostname, resolver); count++;
      const up = http.request({ host: ip, port, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => res.destroy()); req.pipe(up);
    } catch (e) { deny(req.url, e.message); res.writeHead(403); res.end('blocked by egress policy'); }
  });
  server.on('connect', async (req, client, head) => {            // HTTPS tunnels
    try {
      const [host, p] = req.url.split(':'); const port = Number(p || 443);
      if (!ALLOWED_PORTS.has(port)) throw Object.assign(new Error('port not allowed'), { code: 'ESSRF' });
      const ip = await resolvePublic(host.replace(/^\[|\]$/g, ''), resolver); count++;
      const up = net.connect(port, ip, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(client); client.pipe(up); });
      up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
    } catch (e) { deny(req.url, e.message); client.write('HTTP/1.1 403 Forbidden\r\n\r\n'); client.destroy(); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, blocked, get allowed() { return count; }, close: () => new Promise((r) => server.close(r)) })));
}

let shared = null;
export async function egressArgs() {
  shared ??= await startEgressProxy();
  return { proxy: shared, args: [`--proxy-server=http://127.0.0.1:${shared.port}`, '--proxy-bypass-list=<-loopback>'] };
}
export const egressLog = () => shared?.blocked ?? [];
