#!/usr/bin/env node
// Brajdica Watch updater.
//
//   node scripts/update.mjs            fetch terminal + AIS, update docs/data, print a JSON summary
//   node scripts/update.mjs --rebuild  no network: rebuild status.json from stored calls + profiles
//
// Test / simulation flags:
//   --data-dir DIR        use another data directory
//   --terminal-file F     read the sailing list from a file instead of the network
//   --wingo-file F        read the Wingo port page from a file ("none" = simulate an outage)
//   --wingo-ship-dir DIR  read Wingo ship pages from DIR/<mmsi>.html
//   --no-ais              skip AIS entirely
//   --now ISO             pretend it is this instant
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText, readJson, writeJson, toZagrebIso, normName, validImo } from './lib/util.mjs';
import { parseSailingList, terminalUrl, TERMINAL_URL } from './lib/terminal.mjs';
import { parseWingoPort, parseWingoShip, resolveDestination, WINGO_PORT_URL, WINGO_BASE, BERTH_RING_KM } from './lib/wingo.mjs';
import { mergeCalls, selectBerth, researchNeeds, buildStatus, fingerprint, HEARTBEAT_MIN, STALE_GRACE_MIN } from './lib/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AISCATCHER_URL = 'https://www.aiscatcher.org/place/6398/brajdica-container-terminal';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (['rebuild', 'no-ais'].includes(k)) o[k] = true; else o[k] = argv[++i];
  }
  return o;
}

function loadProfiles(dir) {
  const out = {};
  const vdir = path.join(dir, 'vessels');
  if (!fs.existsSync(vdir)) return out;
  for (const f of fs.readdirSync(vdir)) {
    if (!/^\d{7}\.json$/.test(f)) continue;
    const p = readJson(path.join(vdir, f), null);
    if (p && p.imo) out[p.imo] = p;
  }
  return out;
}

function field(value, source, source_url, retrieved_at, confidence) {
  return { value, source, source_url, retrieved_at, confidence };
}

/** Minimal profile from AIS broadcast data, created so the display has something before research runs. */
function autoProfile(name, ship, url, nowIso) {
  const f = {};
  if (ship.flag) f.flag = field(ship.flag, 'Wingo Marine (AIS)', url, nowIso, 'medium');
  if (ship.length_m) f.length_m = field(ship.length_m, 'Wingo Marine (AIS broadcast dimensions)', url, nowIso, 'medium');
  if (ship.beam_m) f.beam_m = field(ship.beam_m, 'Wingo Marine (AIS broadcast dimensions)', url, nowIso, 'medium');
  if (ship.callsign) f.callsign = field(ship.callsign, 'Wingo Marine (AIS)', url, nowIso, 'medium');
  return {
    imo: ship.imo, name, aliases: [], mmsi: ship.mmsi || null,
    fields: f, photo: null, facts: [],
    research: { status: 'auto', researched_at: null, missing: [], notes: 'Created automatically from AIS data; awaiting research.' },
  };
}

export async function run(argv = process.argv.slice(2)) {
  const opt = args(argv);
  const dataDir = path.resolve(opt['data-dir'] || path.join(ROOT, 'docs', 'data'));
  const now = opt.now ? new Date(opt.now) : new Date();
  const nowIso = toZagrebIso(now);
  const nowMs = now.getTime();
  const errors = [];

  const store = readJson(path.join(dataDir, 'calls.json'), { calls: {} });
  const index = readJson(path.join(dataDir, 'vessels', 'index.json'), {});
  const prevStatus = readJson(path.join(dataDir, 'status.json'), null);
  const log = readJson(path.join(dataDir, 'log.json'), { runs: [], events: [] });
  let profiles = loadProfiles(dataDir);

  let calls = store.calls || {};
  // Researched voyages live in their own file (written only by the research task) and are
  // merged in here. Older data kept them inside calls.json: move those across once.
  const voyagesFile = path.join(dataDir, 'voyages.json');
  const voyages = readJson(voyagesFile, {});
  let voyagesMoved = false;
  for (const [id, c] of Object.entries(calls)) {
    if (c.voyage && !voyages[id]) { voyages[id] = c.voyage; voyagesMoved = true; }
  }
  if (voyagesMoved) writeJson(voyagesFile, voyages);
  const applyVoyages = () => { for (const [id, c] of Object.entries(calls)) { if (voyages[id]) c.voyage = voyages[id]; else delete c.voyage; } };
  let events = [];
  let terminal = prevStatus?.terminal || { url: TERMINAL_URL, ok: false, fetched_at: null, last_attempt_at: null, rows: 0, error: null };
  let ais = prevStatus?.ais || {};

  // ---- 1. Official terminal list (primary authority) ---------------------
  if (!opt.rebuild) {
    const url = terminalUrl(nowMs);
    try {
      const html = opt['terminal-file'] ? fs.readFileSync(opt['terminal-file'], 'utf8') : await fetchText(url);
      const rows = parseSailingList(html);
      // An empty table is implausible for a working terminal with a 31-day window;
      // treat it as a failed read rather than wiping the schedule.
      if (rows.length === 0) throw new Error('sailing list parsed but contained no vessels');
      const merged = mergeCalls(calls, rows, nowIso);
      calls = merged.calls;
      events = merged.events;
      terminal = { url: TERMINAL_URL, query_url: url, ok: true, fetched_at: nowIso, last_attempt_at: nowIso, rows: rows.length, error: null };
    } catch (e) {
      errors.push(`terminal: ${e.message}`);
      terminal = { ...terminal, ok: false, last_attempt_at: nowIso, error: e.message };
    }
  }

  for (const c of Object.values(calls)) {
    if (!c.imo && index[normName(c.name)]) c.imo = index[normName(c.name)];
  }
  applyVoyages();

  // ---- 2. AIS corroboration (secondary; never overrides the terminal) ----
  const sel0 = selectBerth(calls, nowMs);
  const targets = [...sel0.atBerth, ...sel0.expected.slice(0, 2)];
  if (!opt.rebuild && !opt['no-ais']) {
    const w = { name: 'Wingo Marine', url: WINGO_PORT_URL, ok: false, fetched_at: ais.wingo?.fetched_at || null, last_attempt_at: nowIso, error: null, summary: ais.wingo?.summary || null };
    try {
      if (opt['wingo-file'] === 'none') throw new Error('simulated outage');
      const html = opt['wingo-file'] ? fs.readFileSync(opt['wingo-file'], 'utf8') : await fetchText(WINGO_PORT_URL, { retries: 1 });
      const port = parseWingoPort(html);
      w.ok = true; w.fetched_at = nowIso; w.summary = port.summary; w.vessels_listed = port.vessels.length;
      for (const call of targets) {
        const hit = port.vessels.find(v => v.name === normName(call.name));
        if (!hit) {
          call.ais = { source: 'Wingo Marine', source_url: WINGO_PORT_URL, checked_at: nowIso, found: false };
          continue;
        }
        const rec = {
          source: 'Wingo Marine', source_url: WINGO_BASE + hit.href, checked_at: nowIso, found: true,
          mmsi: hit.mmsi, distance_km: hit.distance_km, nav: hit.nav,
          destination_raw: hit.destination_raw, destination: resolveDestination(hit.destination_raw),
          destination_kind: 'ais_destination',
          berth_consistent: hit.distance_km != null && hit.distance_km >= BERTH_RING_KM[0] && hit.distance_km <= BERTH_RING_KM[1],
          last_report: null,
        };
        // Ship page: needed for the last-report time of a berthed ship, or to identify an unknown one.
        if (call.phase === 'at_berth' || !call.imo) {
          try {
            const shipFile = opt['wingo-ship-dir'] ? path.join(opt['wingo-ship-dir'], `${hit.mmsi}.html`) : null;
            const shtml = shipFile ? fs.readFileSync(shipFile, 'utf8') : (opt['wingo-file'] ? null : await fetchText(WINGO_BASE + hit.href, { retries: 0 }));
            if (shtml) {
              const ship = parseWingoShip(shtml);
              rec.last_report = ship.last_report || null;
              rec.nearest_port_label = ship.nearest_port || null;
              if (ship.imo && validImo(ship.imo)) {
                rec.imo = ship.imo;
                if (!call.imo) {
                  call.imo = ship.imo;
                  index[normName(call.name)] = ship.imo;
                }
                if (call.imo === ship.imo && !profiles[ship.imo]) {
                  profiles[ship.imo] = autoProfile(call.name, ship, WINGO_BASE + hit.href, nowIso);
                  writeJson(path.join(dataDir, 'vessels', `${ship.imo}.json`), profiles[ship.imo]);
                }
                if (call.imo !== ship.imo) rec.identity_warning = `AIS source reports IMO ${ship.imo} for this name but the cached IMO is ${call.imo}`;
              }
            }
          } catch (e) {
            errors.push(`wingo ship page (${call.name}): ${e.message}`);
          }
        }
        call.ais = rec;
      }
    } catch (e) {
      w.error = e.message;
      errors.push(`wingo: ${e.message}`);
      // Calls keep their previous AIS record, whose checked_at shows its age.
    }
    ais.wingo = w;

    // AIS-catcher: recorded for transparency. Its public page has no receiver
    // coverage of Brajdica, so "0 vessels" there says nothing about the berth.
    if (!opt['terminal-file']) {
      const a = { name: 'AIS-catcher', url: AISCATCHER_URL, ok: false, fetched_at: ais.aiscatcher?.fetched_at || null, last_attempt_at: nowIso, error: null };
      try {
        const html = await fetchText(AISCATCHER_URL, { retries: 0, timeoutSec: 25 });
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const stations = text.match(/(\d+)\s*receiving stations/);
        a.ok = true; a.fetched_at = nowIso;
        a.receiving_stations = stations ? Number(stations[1]) : null;
        a.vessels_inside = /No vessels recorded inside/.test(text) ? 0 : null;
        a.usable = !!(a.receiving_stations && a.receiving_stations > 0);
        a.note = a.usable ? 'Has receiver coverage.' : 'No receiver coverage of the terminal: a zero count here is not evidence that the berth is empty.';
      } catch (e) {
        a.error = e.message;
        errors.push(`aiscatcher: ${e.message}`);
      }
      ais.aiscatcher = a;
    }
  }

  // ---- 3. Decide research, build outputs ---------------------------------
  profiles = loadProfiles(dataDir);
  const sel = selectBerth(calls, nowMs);
  const needs = researchNeeds(sel, profiles, nowMs);

  log.events = [...(log.events || []), ...events].slice(-500);
  const status = buildStatus({ calls, profiles, terminal, ais, nowIso, events: log.events });
  status.research_pending = needs.map(n => ({ name: n.name, imo: n.imo, priority: n.priority }));
  status.research_needed = needs;
  // The published file is refreshed at least every HEARTBEAT_MIN minutes; the page treats
  // a file that is STALE_GRACE_MIN minutes past that as unconfirmed.
  status.next_check_at = toZagrebIso(nowMs + 60 * 60000);
  status.stale_grace_minutes = STALE_GRACE_MIN;

  // Publish only when something changed, or as an hourly heartbeat.
  const prevAgeMin = prevStatus?.generated_at ? (nowMs - new Date(prevStatus.generated_at).getTime()) / 60000 : Infinity;
  const changed = !prevStatus || fingerprint(prevStatus) !== fingerprint(status);
  const publish = !!opt.rebuild || changed || prevAgeMin >= HEARTBEAT_MIN;

  const summary = {
    ran_at: nowIso,
    mode: opt.rebuild ? 'rebuild' : 'update',
    terminal_ok: terminal.ok,
    terminal_fetched_at: terminal.fetched_at,
    berth_state: status.berth.state,
    at_berth: sel.atBerth.map(c => ({ name: c.name, imo: c.imo || null, ata: c.ata, etd: c.etd, status: c.status, ais: status.berth.vessels.find(v => v.call_id === c.call_id)?.corroboration.level })),
    next_expected: sel.expected.slice(0, 3).map(c => ({ name: c.name, imo: c.imo || null, eta: c.eta })),
    events,
    research_needed: needs,
    publish,
    publish_reason: changed ? 'status changed' : (publish ? 'heartbeat' : 'no change'),
    errors,
  };

  // voyage is stored in voyages.json only
  const callsOut = Object.fromEntries(Object.entries(calls).map(([id, c]) => { const { voyage, ...rest } = c; return [id, rest]; }));
  writeJson(path.join(dataDir, 'calls.json'), { calls: callsOut });
  writeJson(path.join(dataDir, 'vessels', 'index.json'), Object.fromEntries(Object.entries(index).sort()));
  writeJson(path.join(dataDir, 'status.json'), status);
  if (!opt.rebuild) {
    log.runs = [...(log.runs || []), {
      at: nowIso, terminal_ok: terminal.ok, rows: terminal.ok ? terminal.rows : null,
      berth: sel.atBerth.map(c => c.name), events: events.length,
      research_needed: needs.map(n => n.name), errors,
    }].slice(-500);
  }
  writeJson(path.join(dataDir, 'log.json'), log);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(s => { console.log(JSON.stringify(s, null, 2)); })
    .catch(e => { console.error(e); process.exit(1); });
}
