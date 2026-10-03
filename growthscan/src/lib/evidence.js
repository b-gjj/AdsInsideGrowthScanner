// Per-run evidence store. Every artifact is timestamped, hashed and indexed; failures are explicit records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Run {
  constructor(dir, meta) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    this.state = {
      id: meta.id, input: meta.input, url: meta.url, host: meta.host, options: meta.options || {},
      status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      harnesses: {}, evidence: [], failures: [], versions: meta.versions || {},
    };
    this.save();
  }
  save() { fs.writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(this.state, null, 2)); }

  harness(name, label) {
    this.state.harnesses[name] ??= { name, label, status: 'pending', startedAt: null, finishedAt: null, steps: [], summary: null };
    return this.state.harnesses[name];
  }
  startHarness(name) { const h = this.harness(name); h.status = 'running'; h.startedAt = new Date().toISOString(); this.save(); }
  endHarness(name, status, summary) { const h = this.harness(name); h.status = status; h.finishedAt = new Date().toISOString(); h.summary = summary ?? h.summary; this.save(); }
  // state: running | done | failed | skipped
  step(harness, label, state = 'running', note) {
    const h = this.harness(harness);
    let s = h.steps.find((x) => x.label === label);
    if (!s) { s = { label, state, startedAt: new Date().toISOString(), finishedAt: null, note: null }; h.steps.push(s); }
    s.state = state; if (note) s.note = note;
    if (state !== 'running') s.finishedAt = new Date().toISOString();
    this.save();
  }

  _rec(harness, name, rel, type, bytes, sha, meta) {
    const rec = { id: `${harness}/${name}`, harness, name, type, path: rel, bytes, sha256: sha, capturedAt: new Date().toISOString(), ...meta };
    const i = this.state.evidence.findIndex((e) => e.id === rec.id);
    if (i >= 0) this.state.evidence[i] = rec; else this.state.evidence.push(rec);
    this.save();
    return rec;
  }
  _write(harness, name, ext, data, type, meta) {
    const dir = path.join(this.dir, 'evidence', harness);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${name}.${ext}`;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');   // size and hash are computed over the exact bytes written
    fs.writeFileSync(path.join(dir, file), buf);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    return this._rec(harness, name, `evidence/${harness}/${file}`, type, buf.length, sha, meta);
  }
  json(harness, name, obj, meta = {}) { return this._write(harness, name, 'json', JSON.stringify(obj, null, 2), 'json', meta); }
  text(harness, name, text, ext = 'txt', meta = {}) { return this._write(harness, name, ext, String(text ?? ''), ext, meta); }
  image(harness, name, buf, meta = {}) { return this._write(harness, name, 'png', buf, 'screenshot', meta); }

  failure(harness, step, err, extra = {}) {
    const f = { harness, step, at: new Date().toISOString(), message: String(err?.message || err), kind: err?.kind || extra.kind || 'error', ...extra };
    this.state.failures.push(f);
    this.save();
    return f;
  }
}
