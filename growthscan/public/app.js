const $ = (s, r = document) => r.querySelector(s);
const scrub = (s) => String(s ?? '').replace(/(checkouts\/cn\/)[\w-]+/g, '$1…').replace(/product-form-template[-\w]*?__[-\w]*option/g, 'product option');
const esc = (s) => scrub(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '');
const dur = (a, b) => { if (!a) return ''; const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const DONE = ['complete', 'complete_with_gaps', 'failed', 'interrupted', 'failed_integrity'];
const statusChip = (s) => ({ complete: ['c-ok', 'Complete'], complete_with_gaps: ['c-warn', 'Complete, with gaps'], running: ['c-run', 'Running'], queued: ['c-idle', 'Queued'], failed: ['c-bad', 'Failed'], interrupted: ['c-bad', 'Interrupted'], failed_integrity: ['c-bad', 'Evidence check failed'], ok: ['c-ok', 'OK'], partial: ['c-warn', 'Partial'], pending: ['c-idle', 'Pending'], skipped: ['c-idle', 'Skipped'] }[s] || ['c-idle', s]);
const chip = (s) => { const [c, t] = statusChip(s); return `<span class="chip ${c}">${t}</span>`; };
const pips = (v) => `<span class="pips" role="img" aria-label="${v} out of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="pip ${v >= i ? 'on' : v >= i - 0.5 ? 'half' : ''}"></i>`).join('')}</span>`;
const BASIS_CLASS = { 'Confirmed finding': 'c-ok', 'Requires validation': 'c-bad', 'Validation of completed work': 'c-run', 'Requires Connected access': 'c-idle', 'Conditional on results and approval': 'c-idle', 'Scope extension': 'c-idle' };
const REASON_LABEL = { BLOCKED: 'Blocked', FETCH_FAILED: 'Fetch failed', TIMEOUT: 'Timed out', NOT_APPLICABLE: 'Not applicable', AMBIGUOUS_ABSENCE: 'Ambiguous', NOT_CONFIGURED: 'Not configured', NEEDS_AUTH: 'Needs Connected Access', HARNESS_FAILED: 'Harness failed', UNOBSERVABLE: 'Not observable', OBSERVATION_ONLY: 'Observation only', NOT_IMPLEMENTED: 'Not yet assessed' };
const HLABEL = { h1: 'Technical source & DNS', h2: 'Performance & accessibility', h3: 'Controlled browser journey', h4: 'Public Meta / Google intelligence', boundary: 'Not assessable Outside-In' };
let poll = null, current = null;

async function api(path, opts) { const r = await fetch(path, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`); return j; }
const reportBase = (run) => String(run.report?.target?.host || run.state.host || 'Website').replace(/^www\./i, '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9.-]/gi, '_').replace(/^./, (c) => c.toUpperCase());
const fileUrl = (run, p) => `/runs/${encodeURIComponent(run.state.id)}/files/${p}`;
const evLink = (run, id) => { const e = run.state.evidence.find((x) => x.id === id); return e ? `<a href="${fileUrl(run, e.path)}" target="_blank" rel="noopener" title="${esc(e.capturedAt)}">${esc(id)}</a>` : `<span class="mono muted">${esc(id)}</span>`; };
const evList = (run, ids) => `<div class="evl">${(ids || []).map((id) => evLink(run, id)).join('') || '<span class="mono muted">No linked evidence; review required.</span>'}</div>`;
const section = (n, t) => `<div class="section-head"><span class="eyebrow">${n}</span><h2>${t}</h2></div>`;
const evTypes = (run, ids) => [...new Set((ids || []).map((id) => run.state.evidence.find((e) => e.id === id)?.type).filter(Boolean))].join(', ') || 'not recorded';

// ── Review-sample step: choose which products the journey exercises (default: first 3 auto-selected)
let sampleFor = null, sampleMin = 3;
const pickedUrls = () => (sampleFor && !$('#sample').hidden ? [...document.querySelectorAll('#sample input[type=checkbox]:checked')].map((c) => c.value) : []);
function updateCount() {
  const n = pickedUrls().length; const el = $('#sample .count'); if (!el) return;
  el.className = 'count' + (n < sampleMin || n > 5 ? ' bad' : ''); el.textContent = `${n} selected — ${n < sampleMin ? `at least ${sampleMin} are needed before conversion findings can be site-level` : n > 5 ? 'maximum is 5' : `${n} add-to-cart event${n > 1 ? 's' : ''} will be registered on the site`}`;
  document.querySelectorAll('#sample input[type=checkbox]').forEach((c) => { c.disabled = !c.checked && n >= 5; });
}
$('#review').addEventListener('click', async () => {
  $('#err').textContent = ''; const url = $('#url').value.trim(); if (!url) { $('#err').textContent = 'Enter a website first, e.g. cedarcide.com'; return; }
  sampleMin = 3; const box = $('#sample'); box.hidden = false; box.innerHTML = '<span class="muted small">Looking for product pages…</span>'; $('#review').disabled = true;
  try {
    const d = await api('/api/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); sampleFor = d.host;
    sampleMin = d.min || 3;
    if (d.ok && d.complete && d.candidates.length <= 3) { sampleFor = null; box.innerHTML = `<b>${d.candidates.length === 1 ? 'This site has one product' : `Only ${d.candidates.length} products found`}.</b> <span class="muted small">${d.candidates.map((c) => esc(c.name)).join(', ')} — ${d.candidates.length === 1 ? 'it' : 'all of them'} will be tested automatically. Nothing to choose.</span>`; return; }
    if (!d.ok) { box.innerHTML = `<b>No products to choose from.</b> <span class="muted small">${esc(d.reason)}</span>`; sampleFor = null; return; }
    box.innerHTML = `<b>Choose the products to test</b> <span class="muted small">on ${esc(d.host)} — ${d.candidates.length}${d.complete ? '' : '+'} found; the first 3 are preselected; swap in best sellers, the highest-priced item, or a bundle/subscription.</span><ul>${d.candidates.map((c) => `<li><label><input type="checkbox" value="${esc(c.url)}" ${c.selected ? 'checked' : ''}><span><b>${esc(c.name)}</b> <span class="src">${esc(c.source)}</span><br><span class="small muted">${esc(c.url)}</span></span></label></li>`).join('')}</ul><div class="count"></div>`;
    box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', updateCount)); updateCount();
  } catch (er) { box.innerHTML = `<span class="err">${esc(er.message)}</span>`; sampleFor = null; } finally { $('#review').disabled = false; }
});
$('#url').addEventListener('input', () => { $('#sample').hidden = true; sampleFor = null; });

// ── scan form / run list
$('#f').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#err').textContent = ''; const url = $('#url').value.trim();
  if (!url) { $('#err').textContent = 'Enter a website, e.g. cedarcide.com'; return; }
  const n = pickedUrls().length; if (sampleFor && !$('#sample').hidden && (n < sampleMin || n > 5)) { $('#err').textContent = `Select between ${sampleMin} and 5 products, or clear the product choice to use the automatic selection.`; return; }
  $('#go').disabled = true;
  try {
    const r = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, options: { competitors: $('#o-comp').value, pdpUrl: pickedUrls().length ? pickedUrls().join(', ') : $('#o-pdp').value, metaPageId: $('#o-page').value, brand: $('#o-brand').value } }) });
    if (r.warning) sessionStorage.setItem('gs-warn', r.warning); else sessionStorage.removeItem('gs-warn');
    location.hash = `#/run/${r.id}`;
  } catch (er) { $('#err').textContent = er.message; } finally { $('#go').disabled = false; }
});

async function home() {
  clearInterval(poll); current = null; document.body.dataset.status = 'none';
  const runs = await api('/api/runs').catch(() => []);
  $('#main').innerHTML = `<h2>Recent runs</h2>` + (runs.length ? `<div class="runs">${runs.map((r) => `<a class="runitem" href="#/run/${esc(r.id)}"><span><b>${esc(r.host)}</b> <span class="muted small mono">${new Date(r.createdAt).toLocaleString()}</span></span><span>${r.masterScored != null ? `<span class="muted small">${r.masterScored}/${r.masterTotal} master checks</span> ` : ''}${chip(r.status)}</span></a>`).join('')}</div>` : `<p class="muted">No runs yet. Paste a public URL above and click Run GrowthScan.</p>`);
}

function ledger(state) {
  return `<div class="ledger">${Object.values(state.harnesses).map((h) => `
    <section class="hcard" aria-label="${esc(h.label)}"><header><b>${esc(h.label)}</b>${chip(h.status)}</header>
      ${h.steps.length ? `<ul class="steps">${h.steps.map((s) => `<li><i class="dot ${s.state}" aria-hidden="true"></i><span>${esc(s.label)} <span class="muted mono">${s.startedAt ? fmtTime(s.startedAt) : ''}${s.finishedAt ? ' · ' + dur(s.startedAt, s.finishedAt) : ''}</span></span>${s.note ? `<span class="note">${esc(String(s.note).length > 90 ? String(s.note).slice(0, 90) + '…' : s.note)}</span>` : ''}</li>`).join('')}</ul>` : `<div class="empty">${h.status === 'pending' ? 'Waiting for earlier harnesses to finish' : 'No steps recorded'}</div>`}
    </section>`).join('')}</div>`;
}

// ── report sections (design: ChatGPT-built layout; data: v1.3 master model)
function findingCards(run, list, provisional) {
  if (!list.length) return '<p class="muted">None.</p>';
  return `<div class="tw">${list.map((f, i) => `<details class="f sev-${f.severity}"><summary><span class="mono muted">${String(i + 1).padStart(2, '0')}</span><span><b>${esc(f.title)}</b><div class="finding-meta">${esc(f.masterId)} · ${esc(f.masterName)} · Confidence: ${esc(f.confidence)} · Evidence: ${esc(evTypes(run, f.evidence))}</div></span><span class="chip ${provisional ? 'c-bad' : f.severity === 'critical' ? 'c-bad' : 'c-warn'}">${provisional ? 'Requires validation' : esc(f.severity)}</span></summary>
    <div class="body"><div><b>Observed.</b> ${obs(f.observed)}</div><div><b>Why it matters.</b> ${esc(f.why)}</div><div><b>Recommended action.</b> ${esc(f.recommendation)}</div>
    ${provisional ? `<p class="callout">${esc(f.provisionalReason)}</p>` : ''}${f.partial ? `<div class="muted"><b>Partial.</b> ${esc(f.partial)}</div>` : ''}${f.caveat ? `<div class="muted"><b>Limits.</b> ${esc(f.caveat)}</div>` : ''}${evList(run, f.evidence)}</div></details>`).join('')}</div>`;
}

const obs = (t) => { const parts = String(t ?? '').split(/(?=\[[A-Z0-9]+-\d+\] )/).filter(Boolean); return parts.length > 1 ? parts.map((x) => `<span class="obs-line">${esc(x.trim())}</span>`).join('') : esc(t); };
const groupByReason = (list) => Object.values(list.reduce((m, c) => { (m[c.reasonCode] ||= { code: c.reasonCode, text: c.customerReason, items: [] }).items.push(c); return m; }, {}));

// A blocked scan gets its own short, honest report instead of a thin full one.
function incompletePanel(run) {
  const r = run.report, rd = run.readiness, m = r.summary.master, inc = r.incomplete; const approved = rd.status === 'approved';
  const assessed = r.master.filter((x) => x.status === 'scored'); const blocked = r.master.filter((x) => x.supported && x.reasonCode === 'BLOCKED'); const ambiguous = r.master.filter((x) => x.supported && x.status === 'unscored' && x.reasonCode !== 'BLOCKED'); const notImpl = r.master.filter((x) => !x.supported);
  const col = (list) => `<ul class="unk-list">${list.map((c) => `<li><span class="mono">${esc(c.masterId)}</span> ${esc(c.name)}</li>`).join('')}</ul>`;
  return `<header class="report-cover"><span class="eyebrow">GrowthScan report</span><h1>GrowthScan</h1><p class="byline">by Ads Inside / Good Joo Joo</p>
    <p class="mono">${esc(r.target.host)} | ${esc(new Date(r.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}</p>
    <p><span class="draft-mark ${approved ? 'approved-mark' : ''}">${approved ? 'Approved for customer' : 'Draft · not approved for customer'}</span></p>
    <div class="coverage incomplete">Scan incomplete — the site blocked automated access</div>
    <p class="small muted">${esc(inc.vendors.join(', '))} bot protection answered our scanner with a verification page instead of the website. Checks that need to load the site were not scored; a blocked check is never counted as a problem. ${assessed.length} of ${m.total} master checks could be assessed.</p></header>
  ${section('01', 'What happened')}<div class="frame"><p>When the scanner requested the site, ${esc(inc.vendors.join(' and '))} responded with a robot-verification page. Everything that depends on loading the site — page speed, accessibility, the shopping journey, structured data, indexing files — could therefore not be tested, and we have not guessed.</p><p class="small muted">Checks that do not depend on the site, such as email authentication and the public ad libraries, ran normally.</p></div>
  ${section('02', 'What we could assess')}${assessed.length ? `<div class="two">${assessed.map((x) => `<div class="card"><span class="chip ${x.score <= 3 ? 'c-warn' : 'c-ok'}">${esc(x.masterId)} · ${esc(x.name)}</span><p style="margin-top:12px">${obs(x.observed)}</p>${evList(run, x.evidence)}</div>`).join('')}</div>` : '<p class="muted">Nothing could be assessed without access to the site.</p>'}
  ${r.top10.length ? `<h3 style="margin-top:24px">Finding</h3>${findingCards(run, r.top10, false)}` : ''}
  ${section('03', 'What we could not assess')}
  <h3>Blocked by the site (${blocked.length})</h3><p class="section-note">These checks need the site to load. They were not scored.</p>${col(blocked)}
  ${ambiguous.length ? `<h3 style="margin-top:20px">No conclusion possible (${ambiguous.length})</h3><p class="section-note">Public ad libraries returned nothing that could be tied to this domain. That cannot distinguish “not advertising” from “advertising under a different name,” so nothing is concluded.</p>${col(ambiguous)}` : ''}
  <h3 style="margin-top:20px">Not yet assessed by this version (${notImpl.length})</h3>${col(notImpl)}
  ${section('04', 'How to complete the scan')}<div class="frame"><ol class="steps-list"><li><b>Ask the site owner to allow the scanner.</b> In the site’s bot-protection settings, allow-list the scanner’s address${inc.runnerSeenAs.length ? ` (the site saw it as <span class="mono">${esc(inc.runnerSeenAs.join(', '))}</span>)` : ''}.</li><li><b>Or run the scan from a network the site accepts</b>, such as an office or home connection.</li><li><b>Then re-run.</b> A complete scan replaces this report; nothing here carries over as a score.</li></ol></div>
  ${section('05', 'Next steps')}<ul class="next">${r.roadmap.flatMap((ph) => ph.items).filter((i) => i.basis === 'Confirmed finding' && i.stage === 1).map((i) => `<li><b>${esc(i.title)}</b> — ${esc(i.action)}</li>`).join('')}<li><b>Re-run the scan once access is allowed.</b> It will cover speed, accessibility, the shopping journey, structured data and indexing.</li><li><b>Capture baselines in Connected analytics</b> (funnel, lifecycle, ads) so later results can be measured.</li></ul>
  <footer class="footer"><img src="/assets/gjj-logo.png" alt="Good Joo Joo"><div><b>GrowthScan identifies the work.</b><p class="small muted">Ads Inside and Good Joo Joo can implement the approved priorities.<br>Built by the growth team at Good Joo Joo.</p></div></footer>`;
}

function summaryPanel(run) { return run.report.mode === 'incomplete' ? incompletePanel(run) : standardPanel(run); }

function standardPanel(run) {
  const r = run.report, rd = run.readiness, m = r.summary.master, js = r.discovery.journeySample;
  const unk = r.master.filter((x) => x.supported && x.status === 'unscored'); const notImpl = r.master.filter((x) => !x.supported);
  const approved = rd.status === 'approved';
  return `<header class="report-cover"><span class="eyebrow">GrowthScan report</span><h1>GrowthScan</h1><p class="byline">by Ads Inside / Good Joo Joo</p>
    <p><b>Evidence-led growth diagnostic</b><br>Outside-In assessment · Connected and Expert reviews not included</p>
    <p class="mono">${esc(r.target.host)} | ${esc(new Date(r.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}</p>
    <p><span class="draft-mark ${approved ? 'approved-mark' : ''}">${approved ? 'Approved for customer' : 'Draft · not approved for customer'}</span></p>
    <div class="coverage">Master checks assessed: ${m.scored} of ${m.total}</div>
    <p class="small muted">This version of GrowthScan supports ${m.supported} of the ${m.total} master checks; ${m.unsupported} are not yet assessed (listed in section 04). Missing, blocked or unobservable evidence is never counted as a failure. Connected and Expert dimensions require separate access or review.</p></header>
  ${r.discovery.targetBlocks?.length ? `<div class="callout" role="status"><b>The site blocked our automated tools.</b> It served a ${esc([...new Set(r.discovery.targetBlocks.map((b) => b.vendor))].join(', '))} bot-protection challenge instead of its pages, so every check that needs to load the site is marked <i>Unscored · Blocked</i> — not scored as a problem. Email-authentication and public advertising checks do not depend on the site and are unaffected. To assess the site itself, ask the site owner to allow the scanner, or re-run from a network the site accepts.</div>` : ''}
  ${section('01', 'What we observed')}<div class="frame"><p class="section-note">This report describes captured public evidence, within the Outside-In boundary. It does not establish advertising performance, tracking accuracy, or full-site conversion performance.</p><div class="two"><div><span class="eyebrow">Evidence captured</span><h3>${r.integrity.evidence?.ok ? `${r.integrity.evidence.checked} verified artifacts` : 'Evidence not verified'}</h3></div><div><span class="eyebrow">Collection gaps</span><h3>${r.integrity.explicitFailures} recorded failures</h3></div></div><a href="#evidence-appendix">View check appendix</a></div>
  ${js ? `<div class="sample"><b>Sampled journey: ${js.size}${js.available ? ' of ' + js.available : ''} product${(js.available || js.size) > 1 ? 's' : ''}, ${esc(js.device)}</b><p>${js.products.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.split('/').pop())}</a>`).join(' · ')}</p><p>${esc(js.scope)}; ${esc(js.selection)}. ${js.available && js.size >= js.available ? 'Every product on the site was tested.' : 'Conversion observations describe this sample, not the whole site. To test different products, re-run with “Choose products to test” under Advanced options.'}</p></div>` : ''}
  ${section('02', 'Confirmed strengths')}<div class="two">${r.strengths.map((x) => `<div class="card strength"><span class="chip ${x.confirmed ? 'c-ok' : 'c-idle'}">${x.confirmed ? 'Confirmed strength · Scored' : 'Observed · low confidence'}</span><h3 style="margin-top:12px">${esc(x.name)}</h3><p>${obs(x.observed)}</p><div class="finding-meta">${esc(x.masterId)} · Confidence: ${esc(x.confidence)} · Evidence: ${esc(evTypes(run, x.evidence))}</div>${evList(run, x.evidence)}</div>`).join('') || '<p class="muted">No checks met the strength threshold.</p>'}</div>
  ${section('03', 'Priority findings')}<p class="section-note">${r.top10.length === 1 ? 'Top confirmed finding' : `Top ${r.top10.length} confirmed findings`} in priority order. Expand each finding to review its evidence and limits.</p>${findingCards(run, r.top10, false)}
  ${r.rerunRequired.length ? `<h3 style="margin-top:28px">Requires validation</h3><p class="section-note">Provisional observations need a re-run. They are excluded from the Top 10, Top 3 and the roadmap.</p>${findingCards(run, r.rerunRequired, true)}` : ''}
  ${section('04', 'What remains unknown')}<p class="section-note">${unk.length} supported check${unk.length === 1 ? ' is' : 's are'} unscored and ${notImpl.length} are not yet assessed by this version. Blocked, missing and unobservable evidence supports no conclusion.</p>
  ${unk.length ? `<div class="two">${groupByReason(unk).map((g) => `<div class="card"><span class="chip c-idle">Unscored · ${esc(REASON_LABEL[g.code] || g.code)} · ${g.items.length}</span><p style="margin-top:12px">${esc(g.text)}</p><ul class="unk-list one">${g.items.map((c) => `<li><span class="mono">${esc(c.masterId)}</span> ${esc(c.name)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
  <h3 style="margin-top:24px">Not yet assessed in this version (${notImpl.length})</h3><ul class="unk-list">${notImpl.map((c) => `<li><span class="mono">${esc(c.masterId)}</span> ${esc(c.name)}</li>`).join('')}</ul>
  <h3 style="margin-top:24px">Connected-only follow-ups</h3><div class="two">${r.connectedFollowUps.filter((c) => c.requires !== 'None').map((c) => `<div class="card"><span class="chip c-idle">Needs Connected Access</span><p>${esc(c.action)}</p><p class="muted small">Requires: ${esc(c.requires)}</p></div>`).join('')}<div class="card"><span class="chip c-idle">Expert Review Required</span><p>Manual accessibility and contextual review remain outside this automated assessment.</p><a href="#report-boundary">Review assessment boundaries</a></div></div>
  ${section('05', 'Top 3 priorities')}<div class="prio">${r.top3.map((p) => `<div class="frame"><span class="priority-number">0${p.rank}</span><p class="eyebrow">${esc(p.theme)}</p><h3>${esc(p.headline)}</h3><p>${esc(p.action)}</p><p class="muted small">Why: ${esc(p.because)}</p>${evList(run, [...new Set(p.masterIds.flatMap((id) => r.findings.find((f) => f.masterId === id)?.evidence || []))])}</div>`).join('') || '<p class="muted">No confirmed priority available.</p>'}</div>
  ${section('06', '90-day roadmap')}<p class="section-note">Work is sequenced by dependency: fix, then validate, then extend. Only items marked <b>Confirmed finding</b> come from a defect observed in this report; the others are follow-through, validation or review steps, each labeled with its basis. Nothing here is committed until approved.</p><div class="road">${r.roadmap.map((ph) => `<div class="card"><span class="eyebrow">${esc(ph.label)}</span><h3>${esc(ph.purpose)}</h3><p class="small muted">${esc(ph.blurb)}</p>${ph.items.map((i) => `<div class="finding-row"><div class="finding-meta">${esc(i.initiative)}${i.masterId ? ` · stage ${i.stage} of 3` : ''}</div><h3>${esc(i.title)}</h3><p>${esc(i.action)}</p><span class="chip ${BASIS_CLASS[i.basis] || 'c-idle'}">${esc(i.basis)}</span>${i.evidence?.length ? evList(run, i.evidence) : ''}</div>`).join('') || '<p class="muted">Nothing scheduled.</p>'}</div>`).join('')}</div>
  <footer class="footer"><img src="/assets/gjj-logo.png" alt="Good Joo Joo"><div><b>GrowthScan identifies the work.</b><p class="small muted">Ads Inside and Good Joo Joo can implement the approved priorities.<br>Built by the growth team at Good Joo Joo.</p></div></footer>`;
}

function checksPanel(run) {
  const M = run.report.master; const sub = run.checks.filter((c) => c.class === 'outside-in'); const cn = run.checks.filter((c) => c.class === 'connected');
  const scored = M.filter((m) => m.status === 'scored'); const unsc = M.filter((m) => m.supported && m.status === 'unscored');
  return `<h2 style="margin-top:0">Check appendix: master checks scored (${scored.length})</h2>
  <div class="tw"><table><thead><tr><th>ID</th><th>Check</th><th>Score</th><th>Observed</th></tr></thead><tbody>${scored.map((m) => `<tr class="master-row"><td class="id">${m.masterId}</td><td><b>${esc(m.name)}</b><br><span class="muted small">${esc(m.group)} · confidence ${m.confidence}${m.provisional ? ' · provisional' : ''}</span></td><td>${pips(m.score)}<br><span class="mono">${m.score}</span></td><td>${obs(m.observed)}${m.partial ? `<br><span class="muted small">${esc(m.partial)}</span>` : ''}${m.caveat ? `<br><span class="muted small">Limits: ${esc(m.caveat)}</span>` : ''}<div class="sub">Subtests: ${m.subtests.map((s) => `${s.runnerId} ${s.status === 'scored' ? s.score : 'unscored'}`).join(' · ')} — ${esc(m.combineRule)}</div>${evList(run, m.evidence)}</td></tr>`).join('')}</tbody></table></div>
  <h2>Supported but unscored (${unsc.length})</h2>${unsc.length ? `<div class="two">${groupByReason(unsc).map((g) => `<div class="card"><span class="chip c-idle">${esc(REASON_LABEL[g.code] || g.code)} · ${g.items.length}</span><p style="margin-top:10px">${esc(g.text)}</p><ul class="unk-list one">${g.items.map((c) => `<li><span class="mono">${esc(c.masterId)}</span> ${esc(c.name)}</li>`).join('')}</ul></div>`).join('')}</div>` : '<p class="muted">None.</p>'}
  <div class="print-hide"><h2>Harness subtests (${sub.length}) — evidence layer, not master checks</h2>
  <div class="tw"><table><thead><tr><th>Harness ID</th><th>Subtest</th><th>Feeds</th><th>Result</th></tr></thead><tbody>${sub.map((c) => `<tr><td class="id">${c.id}</td><td>${esc(c.name)}<br><span class="muted small">${esc(HLABEL[c.harness])}</span></td><td class="small">${c.masterIds.length ? c.masterIds.join(', ') : '<span class="muted">supporting observation (no v1.3 parent)</span>'}</td><td>${c.status === 'scored' ? `${pips(c.score)} <span class="mono">${c.score}</span>` : `<span class="chip c-idle">${esc(REASON_LABEL[c.reasonCode] || c.reasonCode)}</span>`}</td></tr>`).join('')}</tbody></table></div></div>
  <h2>Not assessable Outside-In (${cn.length})</h2><div class="tw"><table><tbody>${cn.map((c) => `<tr><td class="id">${c.id}</td><td>${esc(c.name)}</td><td class="muted">Requires authenticated (Connected) access. No claim is made.</td></tr>`).join('')}</tbody></table></div>`;
}

function evidencePanel(run) {
  const byH = {}; for (const e of run.state.evidence) (byH[e.harness] ||= []).push(e);
  const shots = run.state.evidence.filter((e) => e.type === 'screenshot'); const f = run.state.failures;
  return `<h2 style="margin-top:0">Explicit failures (${f.length})</h2>
  ${f.length ? `<div class="tw"><table><thead><tr><th>Time</th><th>Harness</th><th>Step</th><th>Kind</th><th>Message</th></tr></thead><tbody>${f.map((x) => `<tr><td class="mono">${fmtTime(x.at)}</td><td>${esc(x.harness)}</td><td>${esc(x.step)}</td><td>${esc(x.kind)}</td><td class="small" style="overflow-wrap:anywhere">${esc(String(x.message).split('\n')[0].slice(0, 300))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No collection failures were recorded.</p>'}
  <p class="print-only small">${shots.length} screenshots and ${run.state.evidence.length} evidence files are stored with this report and available in the app (Evidence files tab).</p>
  <div class="print-hide"><h2 class="screenshot-heading">Screenshots (${shots.length})</h2>
  <div class="shots">${shots.map((e) => `<a href="${fileUrl(run, e.path)}" target="_blank" rel="noopener"><img loading="lazy" src="${fileUrl(run, e.path)}" alt="${esc(e.name)}"><span>${esc(e.harness)}/${esc(e.name)}<br>${fmtTime(e.capturedAt)}</span></a>`).join('')}</div>
  </div><div class="print-hide"><h2>All evidence (${run.state.evidence.length} files, hashed, timestamped${run.report.integrity.evidence?.ok ? ', verified' : ''})</h2>
  ${Object.entries(byH).map(([h, list]) => `<details class="adv" style="margin:6px 0"><summary>${esc(HLABEL[h] || h)} — ${list.length} files</summary><div class="tw" style="margin-top:6px"><table><tbody>${list.map((e) => `<tr><td><a href="${fileUrl(run, e.path)}" target="_blank" rel="noopener">${esc(e.name)}</a></td><td class="mono muted">${e.type}</td><td class="mono muted">${(e.bytes / 1024).toFixed(1)} KB</td><td class="mono muted">${fmtTime(e.capturedAt)}</td><td class="mono muted" title="${e.sha256}">${e.sha256.slice(0, 10)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}
  <p class="small"><a href="${fileUrl(run, 'report.json')}" target="_blank">report.json</a> · <a href="${fileUrl(run, 'checks.json')}" target="_blank">checks.json</a> · <a href="${fileUrl(run, 'run.json')}" target="_blank">run.json</a></p></div>`;
}

function boundaryPanel(run) {
  const b = run.report.boundary;
  return `<div class="two"><div class="card"><h3>Outside-In can assess</h3><ul>${b.canAssess.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div><div class="card"><h3>Outside-In cannot claim</h3><ul>${b.cannotAssess.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
  <p class="callout" style="margin-top:12px">${esc(run.report.integrity.rule)} Detected tags and visible creative are observations of public pages, not statements about account health.</p>`;
}

function reviewPanel(run) {
  const rd = run.readiness, r = run.report, h = rd.history;
  const opHints = r.master.filter((m) => m.supported && m.status === 'unscored');
  return `<h2 style="margin-top:0">Review gate <span class="muted small">(operator only — never printed)</span></h2>
  <div class="gate ${rd.status === 'approved' ? 'ok' : ''}"><b>${rd.status === 'approved' ? 'Approved for customer report.' : 'Draft — blockers before this can go to a customer:'}</b>
    ${rd.blockers.length ? `<ul>${rd.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}${rd.acknowledgeable.length ? `<p class="small" style="margin:8px 0 0"><b>Scope notice.</b> ${rd.acknowledgeable.map(esc).join(' ')}</p>` : ''}</div>
  ${r.discovery.targetBlocks?.length ? `<h3>Bot-protection details (operator)</h3><div class="gate"><p style="margin:0"><b>${esc([...new Set(r.discovery.targetBlocks.map((b) => b.vendor))].join(', '))}</b> blocked the runner at: ${esc([...new Set(r.discovery.targetBlocks.map((b) => b.harness + ' ' + b.step))].join('; '))}.${r.incomplete?.runnerSeenAs?.length ? ` The site saw the runner as <span class="mono">${esc(r.incomplete.runnerSeenAs.join(', '))}</span> — give this address to the site owner to allow-list.` : ' The vendor did not disclose the runner’s address; use the outbound IP of the machine running the scanner.'}</p></div>` : ''}
  ${opHints.length ? `<h3>Operator detail for unscored supported checks</h3><div class="tw"><table><tbody>${opHints.map((m) => `<tr><td class="id">${m.masterId}</td><td class="small">${esc(m.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${r.supporting.length ? `<h3>Supporting observations (no master v1.3 parent)</h3><div class="tw"><table><tbody>${r.supporting.map((x) => `<tr><td class="id">${x.runnerId}</td><td><b>${esc(x.name)}</b><br><span class="small muted">${esc(x.observed)}</span></td><td>${pips(x.score)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${r.integrity.suppressedFindings.length ? `<p class="callout"><b>${r.integrity.suppressedFindings.length} finding(s) suppressed by the Outside-In boundary check:</b> ${r.integrity.suppressedFindings.map((x) => esc(x.masterId + ' — ' + x.title)).join('; ')}</p>` : ''}
  <h2>Human sign-off</h2><p class="muted small">A sign-off applies only to this exact report; regenerating the report requires a new review. Customer-ready approval is refused while any hard blocker remains.</p>
  <div class="card"><form id="so" class="runner">
    <label class="f">Reviewer name<input type="text" id="so-name" autocomplete="name"></label>
    <label class="f">Disposition<select id="so-disp"><option value="needs_rerun">Needs re-run</option><option value="approved_with_changes">Approved with changes</option><option value="rejected">Rejected</option><option value="approved">Approved</option></select></label>
    <label class="f">Evidence disposition and notes<textarea id="so-notes" rows="3"></textarea></label>
    <label class="chk"><input type="checkbox" id="so-scope"><span>I acknowledge the limited master-check scope: ${esc(rd.acknowledgeable[0] || 'none')}</span></label>
    <label class="chk"><input type="checkbox" id="so-ready"><span>Approve this report for customers (requires the “Approved” disposition)</span></label>
    <div class="row"><button class="primary" type="submit">Record sign-off</button></div><div class="err" id="so-err" role="alert"></div></form></div>
  <h2>Record</h2>${h.length ? `<div class="tw"><table><thead><tr><th>When</th><th>Reviewer</th><th>Disposition</th><th>Customer-ready</th><th>Notes</th></tr></thead><tbody>${h.map((e) => `<tr><td class="mono">${new Date(e.at).toLocaleString()}</td><td>${esc(e.reviewer)}</td><td>${esc(e.disposition)}</td><td>${e.customerReady ? 'yes' : 'no'}</td><td class="small">${esc(e.notes)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No sign-off recorded.</p>'}`;
}

function render(run) {
  const st = run.state, done = DONE.includes(st.status), ready = run.report && run.checks && run.readiness;
  document.body.dataset.status = ready ? run.readiness.status : 'draft';
  document.title = ready ? `${reportBase(run)}_AdsInsideGrowthScan${run.readiness.status === 'approved' ? '' : '_DRAFT'}` : 'GrowthScan by Ads Inside';
  const warn = sessionStorage.getItem('gs-warn');
  const pdfName = ready ? `${reportBase(run)}_AdsInsideGrowthScan${run.readiness.status === 'approved' ? '' : '_DRAFT'}.pdf` : '';
  let html = `<div class="banner noprint" style="margin-top:22px"><div><h2 class="run-heading" style="margin:0">${esc(st.host)} ${chip(st.status)}</h2><div class="meta mono">${esc(st.id)} · started ${st.startedAt ? fmtTime(st.startedAt) : 'queued'}${st.startedAt ? ' · ' + dur(st.startedAt, st.finishedAt) : ''}${run.queuePosition ? ` · position ${run.queuePosition} in queue` : ''}</div></div><div><button class="ghost" onclick="location.hash=''">All runs</button> <button class="ghost" onclick="window.print()" ${ready ? '' : 'disabled'}>Print report</button> ${ready ? `<a class="ghost pdf-download" href="/api/runs/${encodeURIComponent(st.id)}/report.pdf" download="${esc(pdfName)}">Download PDF</a>` : ''}</div></div>`;
  if (warn) html += `<p class="warn-note noprint">${esc(warn)}</p>`;
  if (!done) html += `<p class="muted small noprint">Scans take several minutes (three Lighthouse passes, a sampled shopping journey and public ad intelligence). You can leave this page open or come back from All runs.</p>`;
  html += `<h2 class="run-heading noprint">Run status by harness</h2>${ledger(st)}`;
  if (ready) {
    html += `<div class="tabs" role="tablist">${['Decision report', 'Check appendix', 'Evidence files', 'Boundaries', 'Review & sign-off'].map((t, i) => `<button class="tab ${i === 4 ? 'tab-sign' : ''}" role="tab" aria-selected="${i === 0}" data-t="${i}">${t}</button>`).join('')}</div>
      <div class="panel" data-p="0">${summaryPanel(run)}</div><div class="panel" id="evidence-appendix" data-p="1" hidden>${checksPanel(run)}</div><div class="panel" data-p="2" hidden>${evidencePanel(run)}</div><div class="panel" id="report-boundary" data-p="3" hidden>${boundaryPanel(run)}</div><div class="panel noprint" data-p="4" hidden>${reviewPanel(run)}</div>`;
  } else if (done) html += `<p class="callout">This run ended without a report (${esc(st.status)}). ${st.status === 'failed_integrity' ? 'The evidence-integrity check failed, so no report was generated.' : ''} Failures are listed in <a href="${fileUrl(run, 'run.json')}">run.json</a>.</p>`;
  const keep = sessionStorage.getItem('gs-tab') || $('.tab[aria-selected=true]')?.dataset.t; sessionStorage.removeItem('gs-tab');
  $('#main').innerHTML = html;
  const show = (t) => { document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x.dataset.t === t)); document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.p !== t)); };
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.t)));
  if (keep && keep !== '0') show(keep);
  document.querySelectorAll('a[href="#evidence-appendix"],a[href="#report-boundary"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.getAttribute('href') === '#evidence-appendix' ? '1' : '3'); $(a.getAttribute('href'))?.scrollIntoView(); }));
  const f = $('#so');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault(); $('#so-err').textContent = '';
    try { await api(`/api/runs/${encodeURIComponent(st.id)}/signoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewer: $('#so-name').value, disposition: $('#so-disp').value, notes: $('#so-notes').value, acknowledgedScope: $('#so-scope').checked, customerReady: $('#so-ready').checked }) }); sessionStorage.setItem('gs-tab', '4'); $('#main').dataset.rendered = ''; showRun(st.id); }
    catch (er) { $('#so-err').textContent = er.message; }
  });
}
window.addEventListener('beforeprint', () => document.querySelectorAll('details').forEach((d) => { d.dataset.wasOpen = d.open; d.open = true; }));
window.addEventListener('afterprint', () => document.querySelectorAll('details').forEach((d) => { d.open = d.dataset.wasOpen === 'true'; }));

async function showRun(id) {
  clearInterval(poll); current = id;
  const tick = async () => {
    try { const run = await api(`/api/runs/${encodeURIComponent(id)}`); if (current !== id) return; const done = DONE.includes(run.state.status);
      if (!done || !run.report || $('#main').dataset.rendered !== run.state.status) { render(run); $('#main').dataset.rendered = run.state.status; } if (done) clearInterval(poll); }
    catch (e) { $('#main').innerHTML = `<p class="callout">${esc(e.message)}</p>`; clearInterval(poll); }
  };
  await tick(); poll = setInterval(tick, 2000);
}
function route() { const m = location.hash.match(/^#\/run\/([\w.-]+)$/); $('#main').dataset.rendered = ''; if (m) showRun(m[1]); else home(); }
window.addEventListener('hashchange', route); route();
