#!/usr/bin/env node
// Checks the data files before they are published. Exit code 1 = do not push.
//   node scripts/validate.mjs [--data-dir DIR]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, validImo } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OK_LICENCE = /^(CC BY(-SA)?( [\d.]+)?( [a-z]{2,})?|CC0( 1\.0)?|Public domain|PDM)$/i;
const CONF = ['high', 'medium', 'low'];
const FIELD_KEYS = ['flag', 'type', 'year_built', 'length_m', 'beam_m', 'teu', 'gross_tonnage', 'deadweight_t', 'builder', 'operator', 'owner', 'callsign', 'former_names', 'class'];
const KINDS = { previous_port: ['actual', 'reported'], next_port: ['scheduled', 'ais_destination', 'estimate'] };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validate(dataDir) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const isUrl = u => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

  const status = readJson(path.join(dataDir, 'status.json'), null);
  if (!status) err('status.json', 'missing or not valid JSON');
  else {
    if (!status.terminal) err('status.json', 'no terminal block');
    if (!status.berth || !['occupied', 'empty', 'unknown'].includes(status.berth.state)) err('status.json', 'bad berth.state');
    for (const v of status.berth?.vessels || []) if (!v.ata || v.atd) err('status.json', `${v.name} is listed at berth without ATA or with ATD`);
    for (const v of status.upcoming || []) if (v.ata) err('status.json', `${v.name} is listed as upcoming but has an ATA`);
  }

  const calls = readJson(path.join(dataDir, 'calls.json'), null);
  if (!calls || typeof calls.calls !== 'object') err('calls.json', 'missing or malformed');
  else for (const [id, c] of Object.entries(calls.calls)) {
    if (c.imo && !validImo(c.imo)) err(`calls ${id}`, `invalid IMO ${c.imo}`);
  }
  const voyagesPath = path.join(dataDir, 'voyages.json');
  const voyages = fs.existsSync(voyagesPath) ? readJson(voyagesPath, null) : {};
  if (!voyages || typeof voyages !== 'object' || Array.isArray(voyages)) err('voyages.json', 'not a JSON object keyed by call_id');
  else for (const [id, v] of Object.entries(voyages)) {
    if (calls?.calls && !calls.calls[id]) err(`voyages ${id}`, 'no such call_id in calls.json (copy call_id exactly from research_needed)');
    if (!v || typeof v !== 'object') { err(`voyages ${id}`, 'must be an object'); continue; }
    if (!ISO.test(v.researched_at || '')) err(`voyages ${id}`, 'researched_at must be an ISO timestamp');
    for (const leg of ['previous_port', 'next_port']) {
      const p = v[leg];
      if (p == null) continue;
      if (!p.name) err(`voyages ${id}`, `${leg}.name missing (use null for the whole leg when unknown)`);
      if (!KINDS[leg].includes(p.kind)) err(`voyages ${id}`, `${leg}.kind must be one of ${KINDS[leg].join(', ')}`);
      if (!p.source || !isUrl(p.source_url)) err(`voyages ${id}`, `${leg} needs source and source_url`);
      if (!CONF.includes(p.confidence)) err(`voyages ${id}`, `${leg}.confidence must be high/medium/low`);
      if (!ISO.test(p.retrieved_at || '')) err(`voyages ${id}`, `${leg}.retrieved_at must be an ISO timestamp`);
      for (const k of ['departed_at', 'eta']) if (p[k] != null && !ISO.test(p[k])) err(`voyages ${id}`, `${leg}.${k} is not an ISO timestamp`);
    }
  }

  const vdir = path.join(dataDir, 'vessels');
  const index = readJson(path.join(vdir, 'index.json'), {});
  for (const [name, imo] of Object.entries(index)) {
    if (name !== name.toUpperCase().replace(/\s+/g, ' ').trim()) err('vessels/index.json', `name key must be upper-case, single-spaced: "${name}"`);
    if (!validImo(imo)) err('vessels/index.json', `invalid IMO for ${name}: ${imo}`);
    else if (!fs.existsSync(path.join(vdir, `${imo}.json`))) err('vessels/index.json', `${name} -> ${imo} but vessels/${imo}.json does not exist`);
  }
  for (const f of fs.existsSync(vdir) ? fs.readdirSync(vdir) : []) {
    if (f === 'index.json') continue;
    const where = `vessels/${f}`;
    const p = readJson(path.join(vdir, f), null);
    if (!p) { err(where, 'not valid JSON'); continue; }
    if (!validImo(p.imo) || f !== `${p.imo}.json`) err(where, 'file name must be <valid IMO>.json and match the imo inside');
    if (!p.name) err(where, 'name missing');
    for (const [k, fld] of Object.entries(p.fields || {})) {
      if (!FIELD_KEYS.includes(k)) err(where, `unknown field "${k}" (allowed: ${FIELD_KEYS.join(', ')})`);
      if (fld == null || fld.value == null || fld.value === '') err(where, `fields.${k} has no value - delete the field instead of leaving it empty`);
      if (!fld?.source || !isUrl(fld?.source_url)) err(where, `fields.${k} needs source and source_url`);
      if (!CONF.includes(fld?.confidence)) err(where, `fields.${k}.confidence must be high/medium/low`);
      if (!ISO.test(fld?.retrieved_at || '')) err(where, `fields.${k}.retrieved_at must be an ISO timestamp`);
      if (['year_built', 'length_m', 'beam_m', 'teu', 'gross_tonnage', 'deadweight_t'].includes(k) && typeof fld?.value !== 'number') err(where, `fields.${k}.value must be a number`);
    }
    if (p.photo != null) {
      const ph = p.photo;
      if (!ph.file || !fs.existsSync(path.join(dataDir, '..', ph.file))) err(where, `photo.file does not exist: ${ph.file}`);
      if (!OK_LICENCE.test(ph.license || '')) err(where, `photo licence "${ph.license}" is not an allowed free licence`);
      if (!ph.author) err(where, 'photo.author missing (attribution is required)');
      if (!isUrl(ph.source_url)) err(where, 'photo.source_url missing');
    }
    for (const [i, fact] of (p.facts || []).entries()) {
      if (!fact.text || fact.text.length > 220) err(where, `facts[${i}] needs text of at most 220 characters`);
      if (!isUrl(fact.source_url)) err(where, `facts[${i}].source_url missing`);
      if (!CONF.includes(fact.confidence)) err(where, `facts[${i}].confidence must be high/medium/low`);
    }
    const r = p.research || {};
    if (!['auto', 'partial', 'complete'].includes(r.status)) err(where, 'research.status must be auto, partial or complete');
    if (r.status !== 'auto' && !ISO.test(r.researched_at || '')) err(where, 'research.researched_at must be set once researched');
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--data-dir');
  const dir = path.resolve(i > 0 ? process.argv[i + 1] : path.join(ROOT, 'docs', 'data'));
  const errors = validate(dir);
  if (errors.length) { console.error('DATA INVALID:\n- ' + errors.join('\n- ')); process.exit(1); }
  console.log('data OK');
}
