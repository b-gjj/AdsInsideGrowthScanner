import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Run } from '../src/lib/evidence.js';
import { verifyEvidence } from '../src/lib/verify.js';
import { scored, unscored } from '../src/lib/checks.js';
import { completeChecks, buildReport } from '../src/lib/report.js';
import { CATALOG } from '../src/lib/catalog.js';

const mkRun = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-')); const run = new Run(dir, { id: 't', input: 'x.com', url: 'https://x.com/', host: 'x.com' }); return { dir, run }; };

test('evidence gate: missing file, tampered file, and cited-but-unindexed evidence all fail verification', () => {
  const { dir, run } = mkRun();
  const a = run.json('h1', 'a', { x: 1 }); const b = run.text('h1', 'b', 'hello');
  assert.equal(verifyEvidence(dir, run.state, []).ok, true);
  fs.writeFileSync(path.join(dir, b.path), 'tampered!');
  let v = verifyEvidence(dir, run.state, []); assert.ok(v.problems.some((p) => p.id === b.id && p.problem !== 'missing_file'));
  fs.unlinkSync(path.join(dir, a.path));
  v = verifyEvidence(dir, run.state, [{ id: 'TECH-01', evidence: ['h9/ghost'] }]);
  assert.ok(v.problems.some((p) => p.problem === 'missing_file')); assert.ok(v.problems.some((p) => p.problem === 'cited_but_not_indexed')); assert.equal(v.ok, false);
});

test('evidence index records UTF-8 byte length (non-ASCII content must verify)', () => {
  const { dir, run } = mkRun(); run.text('h4', 'ad', 'Don’t miss 🌿 40% off — “bug-free”'); run.json('h4', 'j', { s: 'café ✓' });
  assert.equal(verifyEvidence(dir, run.state, []).ok, true);
});





