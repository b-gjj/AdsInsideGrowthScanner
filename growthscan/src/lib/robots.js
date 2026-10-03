export function parseRobots(text) {
  const groups = []; const sitemaps = []; let cur = null; let lastWasUA = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!cur || !lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasUA = true; continue; }
    lastWasUA = false;
    if (k === 'sitemap') sitemaps.push(v);
    else if ((k === 'disallow' || k === 'allow') && cur) cur.rules.push({ type: k, path: v });
  }
  return { groups, sitemaps };
}
function toRe(p) { return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')); }
export function groupFor(parsed, agent) {
  const a = agent.toLowerCase();
  const exact = parsed.groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  return exact || parsed.groups.find((g) => g.agents.includes('*')) || null;
}
export function isAllowed(parsed, agent, path) {
  const g = groupFor(parsed, agent); if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    if (r.path === '') continue;
    if (toRe(r.path).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow'))) best = r;
  }
  return !best || best.type === 'allow';
}
