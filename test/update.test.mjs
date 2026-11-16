// Run with: npm test   (node --test)
// Fixtures in test/fixtures/*-2026-11-16.html are real pages saved on 16 Nov 2026.
// Everything built with mutate() below is a SIMULATION derived from those pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSailingList, parseTerminalDateTime, phaseOf, callId } from '../scripts/lib/terminal.mjs';
import { parseWingoPort, parseWingoShip, resolveDestination } from '../scripts/lib/wingo.mjs';
import { zagrebWallToIso, toZagrebIso, validImo } from '../scripts/lib/util.mjs';
import { run } from '../scripts/update.mjs';
import { summarizeShip } from '../scripts/lib/shiptrail.mjs';
import { effectiveVoyage } from '../scripts/lib/state.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TERMINAL = fs.readFileSync(path.join(FX, 'terminal-2026-11-16.html'), 'utf8');
const WINGO_PORT = path.join(FX, 'wingo-port-2026-11-16.html');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bw-')); }
function writeTmp(dir, name, text) { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; }
function json(dir, f) { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }

/** Rewrite one vessel's row in the saved terminal page: cells = {ATA: '...', ATD: '...', Status: '...'} */
function mutate(html, vessel, cells) {
  const order = ['Vessel', 'Shipper', 'In', 'Out', 'ETA', 'ETD', 'ATA', 'ATD', 'Status', 'Gate'];
  let hit = false;
  const out = html.replace(/<tr class=(?:even|odd)>[\s\S]*?<\/tr>/g, row => {
    const tds = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1].trim());
    if (tds[0] !== vessel || hit) return row;
    hit = true;
    for (const [k, v] of Object.entries(cells)) tds[order.indexOf(k)] = v;
    return '<tr class=even>' + tds.map(t => `<td>\n${t}\n</td>`).join('') + '</tr>';
  });
  assert.ok(hit, `fixture has no row for ${vessel}`);
  return out;
}

async function step(dir, html, now, extra = []) {
  const f = writeTmp(dir, 'terminal.html', html);
  return run(['--data-dir', path.join(dir, 'data'), '--terminal-file', f, '--now', now, ...extra]);
}

// ---------------------------------------------------------------- time zone
test('terminal times are read as Europe/Zagreb wall time (winter and summer)', () => {
  assert.equal(parseTerminalDateTime('16.11.2026. 6:30:00'), '2026-11-16T06:30:00+01:00');
  assert.equal(parseTerminalDateTime('1.7.2026. 14:05:00'), '2026-07-01T14:05:00+02:00');
  assert.equal(parseTerminalDateTime('9.11.2026.'), '2026-11-09T00:00:00+01:00');
  assert.equal(parseTerminalDateTime(''), null);
  assert.equal(parseTerminalDateTime('soon'), null);
  assert.equal(zagrebWallToIso(2026, 3, 29, 3, 30), '2026-03-29T03:30:00+02:00'); // after spring-forward
  assert.equal(toZagrebIso('2026-11-16T09:30:00Z'), '2026-11-16T10:30:00+01:00');
});

// ------------------------------------------------------- 1. terminal parsing
test('LIVE FIXTURE: the saved terminal page parses into the expected calls', () => {
  const rows = parseSailingList(TERMINAL);
  assert.equal(rows.length, 19);
  const teresa = rows.find(r => r.name === 'MSC TERESA');
  assert.deepEqual(teresa, {
    name: 'MSC TERESA', shipper: 'MSC', voyage_in: 'QX644E', voyage_out: 'QX644E', status: 'UNDER OPS',
    eta: '2026-11-16T06:30:00+01:00', etd: '2026-11-17T06:30:00+01:00', ata: '2026-11-16T10:30:00+01:00', atd: null,
  });
  // Double space in the source ("CMA CGM  ALTAMIRA") is normalised.
  assert.ok(rows.some(r => r.name === 'CMA CGM ALTAMIRA'));
  // The same ship calling twice gives two distinct calls.
  const med = rows.filter(r => r.name === 'SC MEDFORD');
  assert.equal(med.length, 2);
  assert.notEqual(callId(med[0]), callId(med[1]));
  assert.equal(phaseOf(med[1]), 'departed');
  assert.equal(med[1].atd, '2026-11-16T08:00:00+01:00');
});

test('a page that is not the sailing list is rejected, not treated as an empty berth', () => {
  assert.throws(() => parseSailingList('<html><body><h1>Service Unavailable</h1></body></html>' + ' '.repeat(300)), /header row not found/);
  assert.throws(() => parseSailingList(''), /empty or truncated/);
  assert.throws(() => parseSailingList(mutate(TERMINAL, 'MSC TERESA', { ATA: 'garbage' })), /unreadable ATA/);
});

// ------------------------------------------- 2. current vessel selection
test('LIVE FIXTURE: MSC TERESA is selected as the vessel at the berth; expected ships are not', async () => {
  const dir = tmp();
  const s = await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX]);
  assert.equal(s.berth_state, 'occupied');
  assert.deepEqual(s.at_berth.map(v => v.name), ['MSC TERESA']);
  assert.equal(s.next_expected[0].name, 'MSC EAGLE III');
  const status = json(dir, 'data/status.json');
  assert.equal(status.berth.vessels.length, 1);
  assert.ok(status.upcoming.every(c => c.phase === 'expected' && !c.ata));
  assert.equal(status.recent_departures[0].name, 'SC MEDFORD');
  // History was backfilled from the list: 12 completed visits + 1 current.
  const calls = Object.values(json(dir, 'data/calls.json').calls);
  assert.equal(calls.filter(c => c.phase === 'departed').length, 12);
});

// --------------------------------------- 3. arrivals and departures (SIMULATED)
test('SIMULATION: departure -> empty berth -> arrival are detected in sequence', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);

  // MSC TERESA sails.
  const departed = mutate(TERMINAL, 'MSC TERESA', { ATD: '17.11.2026. 7:10:00', Status: 'DEPARTED' });
  let s = await step(dir, departed, '2026-11-17T07:00:00Z', ['--no-ais']);
  assert.deepEqual(s.events.map(e => [e.type, e.name]), [['departed', 'MSC TERESA']]);
  assert.equal(s.berth_state, 'empty');
  let status = json(dir, 'data/status.json');
  assert.equal(status.berth.vessels.length, 0);
  assert.equal(status.upcoming[0].name, 'MSC EAGLE III');
  assert.equal(status.upcoming[0].ata, null, 'the next ship must not be presented as arrived');

  // Nothing changes on the next run: no events.
  s = await step(dir, departed, '2026-11-17T08:00:00Z', ['--no-ais']);
  assert.equal(s.events.length, 0);

  // MSC EAGLE III arrives.
  const arrived = mutate(departed, 'MSC EAGLE III', { ATA: '17.11.2026. 15:20:00', Status: 'UNDER OPS' });
  s = await step(dir, arrived, '2026-11-17T15:00:00Z', ['--no-ais']);
  assert.deepEqual(s.events.map(e => [e.type, e.name, e.at]), [['arrived', 'MSC EAGLE III', '2026-11-17T15:20:00+01:00']]);
  assert.deepEqual(s.at_berth.map(v => v.name), ['MSC EAGLE III']);
  // The completed visit is kept in history with both times.
  const t = json(dir, 'data/calls.json').calls['MSC TERESA|QX644E'];
  assert.equal(t.ata, '2026-11-16T10:30:00+01:00');
  assert.equal(t.atd, '2026-11-17T07:10:00+01:00');
  const log = json(dir, 'data/log.json');
  assert.equal(log.runs.length, 4);
  assert.ok(log.events.some(e => e.type === 'departed') && log.events.some(e => e.type === 'arrived'));
});

test('SIMULATION: two ships alongside at once are both reported', async () => {
  const dir = tmp();
  const two = mutate(TERMINAL, 'MSC EAGLE III', { ATA: '16.11.2026. 15:00:00', Status: 'UNDER OPS' });
  const s = await step(dir, two, '2026-11-16T15:30:00Z', ['--no-ais']);
  assert.deepEqual(s.at_berth.map(v => v.name), ['MSC EAGLE III', 'MSC TERESA']); // most recent arrival first
});

test('SIMULATION: ETA changes and withdrawn calls are logged; history is kept when rows scroll off', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);
  let html = mutate(TERMINAL, 'MSC AUDREY', { ETA: '18.11.2026. 14:30:00' });
  // Remove UNITY ONE (expected) and CMA CGM SAO PAULO (departed, scrolled out of the window).
  html = html.replace(/<tr class=(?:even|odd)>\s*<td>\s*UNITY ONE[\s\S]*?<\/tr>/, '').replace(/<tr class=(?:even|odd)>\s*<td>\s*CMA CGM SAO PAULO[\s\S]*?<\/tr>/, '');
  const s = await step(dir, html, '2026-11-16T16:00:00Z', ['--no-ais']);
  assert.deepEqual(s.events.map(e => e.type).sort(), ['eta_changed', 'withdrawn']);
  const calls = json(dir, 'data/calls.json').calls;
  assert.equal(calls['UNITY ONE|13'], undefined);
  assert.equal(calls['CMA CGM SAO PAULO|0BEOSE1MA'].phase, 'departed');
});

// ------------------------------------ terminal outage keeps the last record
test('SIMULATION: terminal outage keeps the last verified vessel and records the failure', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);
  const s = await step(dir, '<html><body>502 Bad Gateway</body></html>' + ' '.repeat(300), '2026-11-16T19:30:00Z', ['--no-ais']);
  assert.equal(s.terminal_ok, false);
  assert.match(s.errors[0], /terminal:/);
  const status = json(dir, 'data/status.json');
  assert.equal(status.terminal.ok, false);
  assert.equal(status.terminal.fetched_at, '2026-11-16T16:00:00+01:00', 'last successful read is preserved');
  assert.equal(status.terminal.last_attempt_at, '2026-11-16T20:30:00+01:00');
  assert.equal(status.berth.vessels[0].name, 'MSC TERESA', 'last verified vessel is preserved');
  assert.equal(status.generated_at, '2026-11-16T20:30:00+01:00');
  assert.equal(json(dir, 'data/log.json').runs.at(-1).terminal_ok, false);
  // (The page itself turns this into "occupancy unconfirmed" once fetched_at is older than stale_after_hours.)
  assert.ok(status.next_check_at && status.stale_grace_minutes === 100);
});

test('an empty table is treated as a failed read, never as "berth empty"', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);
  const empty = TERMINAL.replace(/<tr class=(?:even|odd)>[\s\S]*?<\/tr>/g, '');
  const s = await step(dir, empty, '2026-11-16T16:00:00Z', ['--no-ais']);
  assert.equal(s.terminal_ok, false);
  assert.equal(s.berth_state, 'occupied');
});

// ----------------------------------------------- 4/5. AIS identification
test('LIVE FIXTURE: Wingo pages identify MSC TERESA and place her consistently with the berth', () => {
  const port = parseWingoPort(fs.readFileSync(WINGO_PORT, 'utf8'));
  const t = port.vessels.find(v => v.name === 'MSC TERESA');
  assert.equal(t.mmsi, '357891000');
  assert.equal(t.distance_km, 4.3);
  assert.equal(t.destination_raw, 'ITTRS');
  const far = port.vessels.find(v => v.name === 'GREEN POLE');
  assert.equal(far.distance_km, 1065, 'a ship merely *bound for* Rijeka is 1,065 km away');
  const ship = parseWingoShip(fs.readFileSync(path.join(FX, '357891000.html'), 'utf8'));
  assert.equal(ship.imo, '9469560');
  assert.equal(ship.mmsi, '357891000');
  assert.equal(ship.last_report, '2026-11-16T13:56:00.000Z');
  assert.equal(ship.length_m, 366);
  assert.equal(ship.beam_m, 51);
  assert.equal(ship.flag, 'Panama');
  assert.equal(ship.callsign, '3FZP9');
});

test('LIVE FIXTURE: AIS corroborates the berthed ship and never promotes a Rijeka-bound ship to "at berth"', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX]);
  const status = json(dir, 'data/status.json');
  const v = status.berth.vessels[0];
  assert.equal(v.imo, '9469560');
  assert.equal(v.ais.berth_consistent, true);
  assert.equal(v.corroboration.level, 'ais_consistent');
  assert.equal(v.ais.destination.name, 'Trieste, Italy');
  assert.equal(v.ais.destination_kind, 'ais_destination');
  // MSC EAGLE III reports destination HRRJK and is 18 km out: still only "expected".
  const eagle = status.upcoming[0];
  assert.equal(eagle.name, 'MSC EAGLE III');
  assert.equal(eagle.phase, 'expected');
  assert.equal(eagle.ais.destination.locode, 'HRRJK');
  assert.equal(eagle.ais.berth_consistent, false);
  // GRANDE MEDITERRANEO etc. report Rijeka as destination but are not terminal calls: absent everywhere.
  assert.ok(!JSON.stringify(status).includes('GRANDE MEDITERRANEO'));
  // An automatic profile was cached under the IMO, flagged as needing research.
  const p = json(dir, 'data/vessels/9469560.json');
  assert.equal(p.research.status, 'auto');
  assert.equal(json(dir, 'data/vessels/index.json')['MSC TERESA'], '9469560');
});

test('SIMULATION: AIS outage or a ship missing from AIS does not change berth occupancy', async () => {
  const dir = tmp();
  let s = await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--wingo-file', 'none']);
  assert.equal(s.berth_state, 'occupied');
  assert.match(s.errors.join(';'), /wingo: simulated outage/);
  let status = json(dir, 'data/status.json');
  assert.equal(status.ais.wingo.ok, false);
  assert.equal(status.berth.vessels[0].corroboration.level, 'terminal_only');

  // AIS page that lists other ships but not ours ("zero matching vessels").
  const without = fs.readFileSync(WINGO_PORT, 'utf8').replace(/<a class="vcard"[^>]*href="\/ship\/msc-teresa-357891000">[\s\S]*?<\/a>/, '');
  const f = writeTmp(dir, 'wingo.html', without);
  s = await step(dir, TERMINAL, '2026-11-16T16:00:00Z', ['--wingo-file', f]);
  status = json(dir, 'data/status.json');
  assert.equal(status.berth.state, 'occupied');
  assert.equal(status.berth.vessels[0].ais.found, false);
  assert.match(status.berth.vessels[0].corroboration.note, /not evidence of absence/);
});

test('SIMULATION: stale AIS is reported as stale and a far-away AIS fix is flagged, terminal still wins', async () => {
  const dir = tmp();
  // 20 hours after the AIS report in the fixture.
  await step(dir, TERMINAL, '2026-11-17T10:00:00Z', ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX]);
  let v = json(dir, 'data/status.json').berth.vessels[0];
  assert.equal(v.corroboration.level, 'terminal_only');
  assert.match(v.corroboration.note, /stale/);

  const farPort = fs.readFileSync(WINGO_PORT, 'utf8').replace('4.3 km away', '85 km away · 17.2 kn');
  const f = writeTmp(dir, 'far.html', farPort);
  await step(dir, TERMINAL, '2026-11-16T14:30:00Z', ['--wingo-file', f, '--wingo-ship-dir', FX]);
  const status = json(dir, 'data/status.json');
  v = status.berth.vessels[0];
  assert.equal(v.corroboration.level, 'ais_conflict');
  assert.equal(status.berth.state, 'occupied');
});

test('destination codes: crew-entered text is resolved only when unambiguous', () => {
  assert.deepEqual(resolveDestination('ITTRS'), { locode: 'ITTRS', name: 'Trieste, Italy' });
  assert.deepEqual(resolveDestination('HR RJK'), { locode: 'HRRJK', name: 'Rijeka, Croatia' });
  assert.deepEqual(resolveDestination('GRPIR= → HRRJK'), { locode: 'HRRJK', name: 'Rijeka, Croatia' });
  assert.deepEqual(resolveDestination('RIJEKA'), { locode: 'HRRJK', name: 'Rijeka, Croatia' });
  assert.equal(resolveDestination('CLASS B'), null);
  assert.equal(resolveDestination('FOR ORDERS'), null);
});

test('IMO check digit', () => {
  assert.ok(validImo('9469560'));
  assert.ok(validImo('9302449'));
  assert.ok(!validImo('9469561'));
  assert.ok(!validImo('123'));
});

// --------------------------------- 6. research queue, missing photo / voyage
test('research is requested once, then not again while the cached profile is fresh', async () => {
  const dir = tmp();
  const a = ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX];
  let s = await step(dir, TERMINAL, '2026-11-16T15:00:00Z', a);
  assert.deepEqual(s.research_needed.map(n => [n.name, n.priority]), [
    ['MSC TERESA', 'at_berth'], ['MSC EAGLE III', 'next_arrival'], ['MSC AUDREY', 'next_arrival'],
  ]);


  // Simulate the research step: a partial profile (no photo, no TEU) and a voyage with unknown previous port.
  const data = path.join(dir, 'data');
  const p = json(dir, 'data/vessels/9469560.json');
  p.research = { status: 'partial', researched_at: '2026-11-16T16:10:00+01:00', missing: ['photo', 'teu'], notes: 'test' };
  fs.writeFileSync(path.join(data, 'vessels/9469560.json'), JSON.stringify(p));
  fs.writeFileSync(path.join(data, 'voyages.json'), JSON.stringify({ 'MSC TERESA|QX644E': { researched_at: '2026-11-16T16:10:00+01:00', previous_port: null, next_port: null } }));

  s = await step(dir, TERMINAL, '2026-11-16T16:00:00Z', a);
  assert.ok(!s.research_needed.some(n => n.name === 'MSC TERESA'), 'no repeat research an hour later');
  const status = json(dir, 'data/status.json');
  assert.equal(status.berth.vessels[0].profile.photo, null, 'missing photo is carried as null, not invented');
  assert.equal(status.berth.vessels[0].voyage.previous_port, null);

  // Two weeks later the gaps are retried.
  s = await step(dir, TERMINAL, '2026-12-02T16:00:00Z', a);
  assert.ok(s.research_needed.some(n => n.name === 'MSC TERESA' && /partial profile/.test(n.reasons[0])));

  // --rebuild regenerates status.json without touching the network or the run log.
  const runs = json(dir, 'data/log.json').runs.length;
  const r = await run(['--data-dir', data, '--rebuild', '--now', '2026-12-02T16:05:00Z']);
  assert.equal(r.mode, 'rebuild');
  assert.equal(json(dir, 'data/log.json').runs.length, runs);
});

// ------------------------------------------- publish only when it matters
test('SIMULATION: unchanged runs are not published until the hourly heartbeat; changes publish at once', async () => {
  const dir = tmp();
  let s = await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);
  assert.equal(s.publish, true);
  s = await step(dir, TERMINAL, '2026-11-16T15:15:00Z', ['--no-ais']);
  assert.equal(s.publish, false); assert.equal(s.publish_reason, 'no change');
  // (the workflow discards an unpublished run, so restore what "was published")
  s = await step(dir, mutate(TERMINAL, 'MSC TERESA', { ATD: '16.11.2026. 16:20:00', Status: 'DEPARTED' }), '2026-11-16T15:30:00Z', ['--no-ais']);
  assert.equal(s.publish, true); assert.equal(s.publish_reason, 'status changed');
});

test('heartbeat: an unchanged status is republished once the published file is 55 minutes old', async () => {
  const dir = tmp();
  await step(dir, TERMINAL, '2026-11-16T15:00:00Z', ['--no-ais']);
  const published = fs.readFileSync(path.join(dir, 'data/status.json'), 'utf8');
  let s = await step(dir, TERMINAL, '2026-11-16T15:30:00Z', ['--no-ais']);
  assert.equal(s.publish, false);
  fs.writeFileSync(path.join(dir, 'data/status.json'), published); // unpublished run discarded
  s = await step(dir, TERMINAL, '2026-11-16T15:56:00Z', ['--no-ais']);
  assert.equal(s.publish, true); assert.equal(s.publish_reason, 'heartbeat');
  assert.equal(json(dir, 'data/status.json').next_check_at, '2026-11-16T17:56:00+01:00');
});

// ------------------------------------------------ Shiptrail (voyage history)
test('LIVE FIXTURE: Shiptrail get_ship gives MSC TERESA\'s previous port (Haifa) and a position at the quay', () => {
  const ship = JSON.parse(fs.readFileSync(path.join(FX, '357891000.json'), 'utf8'));
  const s = summarizeShip(ship, { nowIso: '2026-11-16T19:40:00+01:00', before: new Date('2026-11-16T10:30:00+01:00').getTime() });
  assert.equal(s.imo, '9469560');
  assert.equal(s.previous_port.locode, 'ILHFA');
  assert.equal(s.previous_port.departed_at, '2026-11-12T12:18:52.222Z');
  assert.equal(s.at_quay, true);
  assert.ok(s.quay_distance_km < 0.3);
  // Kostrena / Rijeka entries belong to this visit and are never the previous port.
  assert.notEqual(s.previous_port.locode, 'HRKOS');
});

test('SIMULATION: a ship still lying in another port has no previous port yet; a moving ship is not "at quay"', () => {
  const ship = JSON.parse(fs.readFileSync(path.join(FX, '357891000.json'), 'utf8'));
  const inHaifa = { ...ship, recentCalls: [{ ...ship.recentCalls[1], departed: undefined }, ...ship.recentCalls.slice(2)] };
  let s = summarizeShip(inHaifa, { nowIso: 'x' });
  assert.equal(s.previous_port, null);
  assert.equal(s.still_in_port.locode, 'ILHFA');
  s = summarizeShip({ ...ship, position: { ...ship.position, speedKn: 6 } }, { nowIso: 'x' });
  assert.equal(s.at_quay, false);
  s = summarizeShip({ ...ship, position: { lat: 45.2869, lon: 14.4084, speedKn: 0, status: 'At anchor' } }, { nowIso: 'x' });
  assert.equal(s.at_quay, false, 'at anchor off Rijeka is not at the berth');
});

test('LIVE FIXTURE: updater takes the previous port from Shiptrail, matched by MMSI and IMO', async () => {
  const dir = tmp();
  const a = ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX, '--shiptrail-dir', FX];
  const s = await step(dir, TERMINAL, '2026-11-16T18:45:00Z', a);
  assert.ok(!s.research_needed.some(n => n.name === 'MSC TERESA' && n.reasons.some(r => /voyage/.test(r))), 'no voyage research needed');
  const st = json(dir, 'data/status.json');
  const v = st.berth.vessels[0];
  assert.equal(v.voyage.previous_port.name, 'Haifa');
  assert.equal(v.voyage.previous_port.kind, 'actual');
  assert.equal(v.voyage.previous_port.departed_at, '2026-11-12T13:18:52+01:00');
  assert.match(v.voyage.previous_port.source_url, /shiptrail\.io\/vessel\/357891000/);
  assert.equal(v.voyage.next_port, undefined, 'AIS destination is never promoted to a verified next port');
  assert.equal(v.corroboration.level, 'ais_consistent');
  assert.match(v.corroboration.note, /m from the Brajdica quay/);
  assert.equal(st.ais.shiptrail.ok, true);
  // MSC EAGLE III: at anchor 5 km out with destination Rijeka - still only expected.
  const e = st.upcoming[0];
  assert.equal(e.phase, 'expected');
  assert.equal(e.trail.at_quay, false);
  assert.equal(e.voyage.previous_port.name, 'Trieste');
});

test('SIMULATION: Shiptrail outage or an IMO mismatch leaves the previous port unknown and occupancy untouched', async () => {
  const dir = tmp();
  let s = await step(dir, TERMINAL, '2026-11-16T18:45:00Z', ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX, '--shiptrail-dir', 'none']);
  assert.match(s.errors.join(';'), /shiptrail: simulated outage/);
  let st = json(dir, 'data/status.json');
  assert.equal(st.berth.state, 'occupied');
  assert.equal(st.berth.vessels[0].voyage, undefined);
  assert.ok(s.research_needed.some(n => n.name === 'MSC TERESA' && n.reasons.some(r => /voyage/.test(r))), 'falls back to research');

  // A record for the right MMSI but a different hull is rejected.
  const wrong = path.join(dir, 'trail'); fs.mkdirSync(wrong);
  const ship = JSON.parse(fs.readFileSync(path.join(FX, '357891000.json'), 'utf8'));
  fs.writeFileSync(path.join(wrong, '357891000.json'), JSON.stringify({ ...ship, imo: 9302449 }));
  fs.copyFileSync(path.join(FX, '636024014.json'), path.join(wrong, '636024014.json'));
  const dir2 = tmp();
  await step(dir2, TERMINAL, '2026-11-16T18:45:00Z', ['--wingo-file', WINGO_PORT, '--wingo-ship-dir', FX, '--shiptrail-dir', wrong]);
  st = json(dir2, 'data/status.json');
  assert.equal(st.berth.vessels[0].voyage, undefined);
  assert.match(st.berth.vessels[0].trail.identity_warning, /expected 9469560/);
});

test('previous port: Shiptrail first, but a later researched actual call wins; agreement raises confidence', () => {
  const trail = { source_url: 'https://shiptrail.io/vessel/x', fetched_at: '2026-11-16T19:00:00+01:00',
    previous_port: { name: 'Varna', locode: 'BGVAR', departed_at: '2026-11-04T14:22:37Z' } };
  const leg = (name, locode, departed_at, kind = 'actual') => ({ name, locode, departed_at, kind, source: 'VesselFinder', source_url: 'https://www.vesselfinder.com/', confidence: 'medium' });
  // Later researched call at another port: research wins, with a note.
  let v = effectiveVoyage({ trail, voyage: { previous_port: leg('Derince', 'TRDRC', '2026-11-12T14:16:00+01:00') } });
  assert.equal(v.previous_port.name, 'Derince'); assert.match(v.previous_port.note, /Varna/);
  // Earlier researched call: Shiptrail wins.
  v = effectiveVoyage({ trail, voyage: { previous_port: leg('Piraeus', 'GRPIR', '2026-11-01T10:00:00+02:00') } });
  assert.equal(v.previous_port.name, 'Varna'); assert.equal(v.previous_port.confidence, 'medium');
  // Same port from both: high confidence, Shiptrail's precise time.
  v = effectiveVoyage({ trail, voyage: { previous_port: leg('Varna', 'BGVAR', null) } });
  assert.equal(v.previous_port.confidence, 'high'); assert.equal(v.previous_port.departed_at, '2026-11-04T15:22:37+01:00');
  // Nothing from either source: unknown, not guessed.
  assert.equal(effectiveVoyage({}), undefined);
  // Still lying in another port: a researched leg without a departure time is dropped.
  v = effectiveVoyage({ trail: { still_in_port: { name: 'Trieste' }, previous_port: null }, voyage: { researched_at: 'x', previous_port: leg('Trieste', 'ITTRS', null) } });
  assert.equal(v.previous_port, undefined);
});
