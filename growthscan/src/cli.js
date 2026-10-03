// Developer convenience only. Operators use the web UI.  node src/cli.js cedarcide.com [h1,h2,h3,h4]
import path from 'node:path';
import { normalizeInput, assertPublicHost, registrableHost } from './lib/net.js';
import { createRun, executeRun } from './orchestrator.js';
const [, , input, only] = process.argv;
const u = normalizeInput(input); await assertPublicHost(u.hostname);
const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${registrableHost(u.hostname).replace(/\W+/g, '-')}`;
const dataDir = process.env.DATA_DIR || path.resolve('data');
const run = createRun(dataDir, { id, input, url: u.toString(), host: u.hostname, options: JSON.parse(process.env.GS_OPTIONS || '{}') });
const { report } = await executeRun(run, only ? only.split(',') : undefined);
if (!report) { console.error(`Run ${id}: evidence verification FAILED, no report generated.`); process.exit(2); }
console.log(`Run ${id}: ${run.state.status}. Master checks scored ${report.summary.master.scored}/${report.summary.master.total} (${report.summary.master.supported} supported).  ${run.dir}`);
