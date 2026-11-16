#!/usr/bin/env node
// Called by the GitHub Actions workflow after update.mjs.
// If the summary says a vessel needs research, start the Claude research task through
// its API trigger - at most once per distinct need, and again only after RETRY_HOURS.
//
//   node scripts/fire-research.mjs <summary.json>
//   env: CLAUDE_FIRE_URL, CLAUDE_FIRE_TOKEN   (repository secrets; without them this is a no-op)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, toZagrebIso } from './lib/util.mjs';

const RETRY_HOURS = 6;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(ROOT, 'docs', 'data', 'automation.json');

const summary = readJson(process.argv[2], null);
if (!summary) { console.error('fire-research: summary file missing'); process.exit(1); }
const needs = summary.research_needed || [];
if (!needs.length) { console.log('fire-research: nothing to research'); process.exit(0); }

const { CLAUDE_FIRE_URL: url, CLAUDE_FIRE_TOKEN: token } = process.env;
if (!url || !token) {
  console.log('fire-research: research is needed but CLAUDE_FIRE_URL / CLAUDE_FIRE_TOKEN are not set; the scheduled research task will pick it up');
  process.exit(0);
}
if (!/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(url)) {
  console.error('fire-research: CLAUDE_FIRE_URL does not look like a routine fire URL'); process.exit(0);
}

const key = needs.map(n => `${n.call_id}:${n.reasons.join('+')}`).sort().join(' | ');
const state = readJson(stateFile, {});
const ageH = state.last_fire_at ? (Date.now() - new Date(state.last_fire_at).getTime()) / 3600000 : Infinity;
if (state.last_fire_key === key && ageH < RETRY_HOURS) {
  console.log(`fire-research: already requested ${ageH.toFixed(1)} h ago for the same need; waiting`);
  process.exit(0);
}

const text = 'Research requested by the berth poller for: ' + needs.map(n => `${n.name} (${n.priority})`).join(', ');
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'experimental-cc-routine-2026-04-01',
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ text }),
}).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));

const now = toZagrebIso(Date.now());
if (res.ok) {
  writeJson(stateFile, { last_fire_at: now, last_fire_key: key, last_fire_ok: true });
  console.log('fire-research: research task started for ' + needs.map(n => n.name).join(', '));
  console.log('FIRED=1');
} else {
  // Record the failure time too, so a broken token is not hammered every 15 minutes.
  writeJson(stateFile, { last_fire_at: now, last_fire_key: key, last_fire_ok: false, last_error: `HTTP ${res.status}` });
  console.error(`fire-research: fire failed with HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log('FIRED=1');
}
