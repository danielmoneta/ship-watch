#!/usr/bin/env node
// Builds the SIMULATED status files in docs/demo/ from the current live status.
// View them at  index.html?demo=empty | stale | two | unidentified | photo
// The page shows a "Simulation - not live data" ribbon for all of them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = readJson(path.join(ROOT, 'docs/data/status.json'), null);
if (!live || !live.berth.vessels.length || live.upcoming.length < 2) {
  console.error('needs a live status with one ship alongside and two upcoming'); process.exit(1);
}
const clone = o => JSON.parse(JSON.stringify(o));
const base = () => ({ ...clone(live), simulated: true, demo_now: live.generated_at });
const out = (name, s, note) => { s.simulated_note = note; writeJson(path.join(ROOT, 'docs/demo', name + '.json'), s); };

// Berth empty: the current ship has sailed, next arrival is featured as "expected".
let s = base();
const gone = s.berth.vessels[0];
s.berth = { state: 'empty', vessels: [] };
s.recent_departures.unshift({ ...gone, phase: 'departed', status: 'DEPARTED', atd: live.generated_at, profile: null });
out('empty', s, 'empty berth');

// Stale: the terminal has not been reachable for 7 hours.
s = base();
s.terminal.ok = false; s.terminal.error = 'HTTP 503'; s.terminal.last_attempt_at = live.generated_at;
s.next_check_at = live.terminal.fetched_at;
s.demo_now = new Date(new Date(live.terminal.fetched_at).getTime() + 7 * 3600000).toISOString().replace('.000Z', 'Z');
out('stale', s, 'terminal unreachable for 7 hours');

// Two ships alongside.
s = base();
const second = s.upcoming.shift();
s.berth.vessels.push({ ...second, phase: 'at_berth', status: 'UNDER OPS', ata: live.generated_at, corroboration: { level: 'terminal_only', note: 'Simulated.' } });
out('two', s, 'two ships alongside');

// A ship the system has not identified or researched yet.
s = base();
s.berth.vessels = [{ ...s.berth.vessels[0], name: 'EXAMPLE TRADER', call_id: 'EXAMPLE TRADER|001', imo: null, shipper: 'SOC', voyage_in: '001', profile: null, voyage: undefined,
  ais: { source: 'Wingo Marine', source_url: 'https://wingo-marine.com/port/rijeka-2263', checked_at: live.generated_at, found: false },
  corroboration: { level: 'terminal_only', note: 'Not found in the AIS source. Missing AIS is not evidence of absence.' } }];
out('unidentified', s, 'newly arrived ship, research pending');

// Photo layout, using a real freely licensed photograph of a ship that does not call here.
s = base();
const now = live.generated_at;
const f = (value) => ({ value, source: 'Demo', source_url: 'https://en.wikipedia.org/wiki/MSC_Oscar', retrieved_at: now, confidence: 'medium' });
s.berth.vessels = [{ ...s.berth.vessels[0], name: 'MSC OSCAR', call_id: 'MSC OSCAR|DEMO', imo: '9703291', voyage_in: 'DEMO',
  voyage: { researched_at: now,
    previous_port: { name: 'Gioia Tauro', departed_at: '2026-11-14T18:00:00+01:00', kind: 'actual', source: 'Demo', source_url: 'https://example.org/', retrieved_at: now, confidence: 'medium' },
    next_port: { name: 'Koper', eta: '2026-11-17T16:00:00+01:00', kind: 'scheduled', source: 'Demo', source_url: 'https://example.org/', retrieved_at: now, confidence: 'medium' } },
  ais: null, corroboration: { level: 'terminal_only', note: 'Simulated.' },
  profile: { imo: '9703291', name: 'MSC OSCAR', mmsi: null,
    fields: { type: f('Container ship'), flag: f('Panama'), year_built: f(2014), length_m: f(395.4), beam_m: f(59), teu: f(19224), gross_tonnage: f(192237) },
    photo: { file: 'demo/msc-oscar.jpg', title: 'MSC Oscar (ship, 2014) 002.jpg', author: 'kees torn', license: 'CC BY-SA 2.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/2.0', source_name: 'Wikimedia Commons',
      source_url: 'https://commons.wikimedia.org/wiki/File:MSC_Oscar_(ship,_2014)_002.jpg' },
    facts: [{ text: 'When delivered in January 2015 she was the largest container ship in the world.', source: 'Wikipedia', source_url: 'https://en.wikipedia.org/wiki/MSC_Oscar', confidence: 'medium' }],
    research: { status: 'complete', researched_at: now, missing: [], notes: 'Demo data.' } } }];
out('photo', s, 'photo layout demo - this ship is not at Brajdica');
console.log('demos written');
