// Check result constructors. The invariant: a check is EITHER scored (0–5, from positive evidence) OR unscored (with a reason).
// Missing, blocked, timed-out, or ambiguous evidence can only ever produce `unscored`.
import fs from 'node:fs';
import { CATALOG } from './catalog.js';

const MAP = JSON.parse(fs.readFileSync(new URL('../../config/master-map.json', import.meta.url)));   // no fallback: a missing mapping must fail loudly, never silently produce an unmapped report
export const PARENT_MAP = MAP;
export const masterIdsFor = (id) => (Array.isArray(MAP[id]) ? MAP[id] : []);
export const masterStatusFor = (id) => (Array.isArray(MAP[id]) ? 'mapped' : MAP[id] === 'not_in_master_v1_3' ? 'not_in_master_v1_3' : 'unmapped');

export const REASON = {
  BLOCKED: 'Target blocked or rate-limited the collector',
  FETCH_FAILED: 'Evidence could not be fetched',
  TIMEOUT: 'Collection timed out',
  NOT_APPLICABLE: 'Not applicable to this site',
  AMBIGUOUS_ABSENCE: 'Absence is ambiguous (could be not present, or not visible Outside-In)',
  NOT_CONFIGURED: 'Optional data source not configured',
  NEEDS_AUTH: 'Requires authenticated (Connected) access',
  HARNESS_FAILED: 'Harness failed before this check could be evaluated',
  UNOBSERVABLE: 'Not observable from public evidence',
  NOT_IMPLEMENTED: 'Master check not implemented by the current runner',
  OBSERVATION_ONLY: 'Evidence captured; no scoring rubric yet (peer-relative scoring needs a benchmark set)',
};

const base = (id, extra) => {
  const meta = CATALOG[id];
  if (!meta) throw new Error(`Check ${id} is not in the catalog`);
  return { id, harnessId: id, masterIds: masterIdsFor(id), masterStatus: masterStatusFor(id), harness: meta.harness, name: meta.name, class: meta.class || 'outside-in', theme: meta.theme, ...extra };
};

export function scored(id, { score, confidence = 'medium', observed, evidence = [], caveat = null, detail = null, parents = null }) {
  if (typeof score !== 'number' || Number.isNaN(score) || score < 0 || score > 5) throw new Error(`Bad score for ${id}: ${score}`);
  if (!observed) throw new Error(`Scored check ${id} needs an observed statement`);
  if (!evidence.length) throw new Error(`Scored check ${id} must cite evidence`);
  if (parents) for (const [m, p] of Object.entries(parents)) if (!p.unscored && (typeof p.score !== 'number' || p.score < 0 || p.score > 5 || !p.observed)) throw new Error(`Bad parent result ${m} for ${id}`);
  return base(id, { status: 'scored', score, confidence, observed, evidence, caveat, detail, parents });
}

export function unscored(id, { code, reason, evidence = [], detail = null }) {
  if (!REASON[code]) throw new Error(`Unknown reason code ${code}`);
  return base(id, { status: 'unscored', score: null, reasonCode: code, reason: reason || REASON[code], evidence, detail });
}

export const bucket = (v, steps) => { for (const [limit, s] of steps) if (v <= limit) return s; return steps.at(-1)[1]; };
