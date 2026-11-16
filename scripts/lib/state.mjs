// Pure state logic: merge a fresh sailing list into the stored calls, detect
// events, decide what needs research, and build the status file the site reads.
import { callId, phaseOf } from './terminal.mjs';
import { normName, toZagrebIso } from './util.mjs';

export const PROFILE_MAX_AGE_DAYS = 365;      // re-check a complete profile once a year
export const PARTIAL_RETRY_DAYS = 14;         // retry gaps (e.g. no photo found) every two weeks
export const OVERDUE_HOURS = 36;              // at berth this long past ETD without an ATD -> flag it
export const HISTORY_KEEP = 1000;

const TERMINAL_FIELDS = ['name', 'shipper', 'voyage_in', 'voyage_out', 'status', 'eta', 'etd', 'ata', 'atd'];

/**
 * Merge freshly parsed rows into the stored call map.
 * Terminal fields are overwritten (the terminal is the authority); anything
 * research or AIS added to a call (imo, ais, voyage) is preserved.
 */
export function mergeCalls(prevCalls, rows, nowIso) {
  const calls = {};
  const events = [];
  const seen = new Set();
  const firstRun = Object.keys(prevCalls || {}).length === 0;

  for (const row of rows) {
    const id = callId(row);
    if (seen.has(id)) continue; // the list occasionally repeats a row
    seen.add(id);
    const old = prevCalls[id];
    const call = { ...(old || {}), call_id: id };
    for (const k of TERMINAL_FIELDS) call[k] = row[k] ?? null;
    call.phase = phaseOf(call);
    call.first_seen = old?.first_seen || nowIso;
    call.last_seen = nowIso;
    call.listed = true;

    if (!old) {
      // On the very first run everything is "new"; only report what is at the berth.
      if (!firstRun || call.phase === 'at_berth') {
        events.push({ type: call.phase === 'at_berth' ? 'arrived' : 'listed', call_id: id, name: call.name, at: call.ata || call.eta, observed: nowIso, backfilled: firstRun || undefined });
      }
    } else {
      if (!old.ata && call.ata) events.push({ type: 'arrived', call_id: id, name: call.name, at: call.ata, observed: nowIso });
      if (phaseOf(old) !== 'departed' && call.phase === 'departed') events.push({ type: 'departed', call_id: id, name: call.name, at: call.atd, observed: nowIso });
      if (old.eta !== call.eta && call.phase === 'expected') events.push({ type: 'eta_changed', call_id: id, name: call.name, from: old.eta, to: call.eta, observed: nowIso });
      if (old.etd !== call.etd && call.phase === 'at_berth') events.push({ type: 'etd_changed', call_id: id, name: call.name, from: old.etd, to: call.etd, observed: nowIso });
      if (old.status !== call.status && phaseOf(old) === call.phase) events.push({ type: 'status_changed', call_id: id, name: call.name, from: old.status, to: call.status, observed: nowIso });
    }
    calls[id] = call;
  }

  // Calls the terminal no longer lists.
  for (const [id, old] of Object.entries(prevCalls || {})) {
    if (calls[id]) continue;
    const phase = phaseOf(old);
    if (phase === 'expected') {
      // A planned call that vanished was cancelled or re-numbered: drop it.
      events.push({ type: 'withdrawn', call_id: id, name: old.name, observed: nowIso });
      continue;
    }
    // Completed visits scroll out of the list window: keep them as history.
    // A ship that was at berth and vanished without an ATD is kept but marked unlisted,
    // so it is never shown as present on the strength of old data.
    if (phase === 'at_berth' && old.listed !== false) events.push({ type: 'vanished_at_berth', call_id: id, name: old.name, observed: nowIso });
    calls[id] = { ...old, phase, listed: false };
  }

  // Bound the history.
  const ids = Object.keys(calls);
  if (ids.length > HISTORY_KEEP) {
    const old = ids.filter(i => calls[i].phase === 'departed').sort((a, b) => String(calls[a].atd).localeCompare(String(calls[b].atd)));
    for (const i of old.slice(0, ids.length - HISTORY_KEEP)) delete calls[i];
  }
  return { calls, events };
}

const t = iso => (iso ? new Date(iso).getTime() : NaN);

export function selectBerth(calls, nowMs) {
  const list = Object.values(calls);
  const atBerth = list.filter(c => c.phase === 'at_berth' && c.listed !== false)
    .sort((a, b) => t(b.ata) - t(a.ata));
  for (const c of atBerth) c.overdue = !!(c.etd && nowMs - t(c.etd) > OVERDUE_HOURS * 3600000) || undefined;
  const expected = list.filter(c => c.phase === 'expected' && c.listed !== false)
    .sort((a, b) => t(a.eta) - t(b.eta));
  const departed = list.filter(c => c.phase === 'departed' && c.atd)
    .sort((a, b) => t(b.atd) - t(a.atd));
  return { atBerth, expected, departed };
}

/** Which vessels need Claude's research on this run (kept deliberately small). */
export function researchNeeds({ atBerth, expected }, profiles, nowMs) {
  const needs = [];
  const targets = [
    ...atBerth.map(c => [c, 'at_berth']),
    ...expected.slice(0, 2).map(c => [c, 'next_arrival']),
  ];
  const done = new Set();
  for (const [call, priority] of targets) {
    const key = call.imo || call.name;
    if (done.has(key)) continue;
    done.add(key);
    const p = call.imo ? profiles[call.imo] : null;
    const reasons = [];
    const st = p?.research?.status;
    const age = p?.research?.researched_at ? (nowMs - t(p.research.researched_at)) / 86400000 : Infinity;
    if (!call.imo) reasons.push('unidentified: no IMO known for this name');
    else if (!p) reasons.push('no profile');
    else if (st === 'auto' || !st) reasons.push('profile holds only automatic AIS data');
    else if (st === 'partial' && age > PARTIAL_RETRY_DAYS) reasons.push(`partial profile older than ${PARTIAL_RETRY_DAYS} days (missing: ${(p.research.missing || []).join(', ') || '?'})`);
    else if (age > PROFILE_MAX_AGE_DAYS) reasons.push('profile older than a year');
    // Previous port normally comes from Shiptrail automatically. Research is the fallback when a
    // berthed ship has none from either source and nobody has looked yet.
    if (priority === 'at_berth' && !call.trail?.previous_port && !call.voyage?.researched_at) reasons.push('voyage: previous port not available from Shiptrail; research previous/next port for this call');
    if (reasons.length) needs.push({ name: call.name, imo: call.imo || null, call_id: call.call_id, priority, reasons });
  }
  return needs;
}

/**
 * The voyage shown for a call. Per leg: a researched/hand-entered value (voyages.json) wins;
 * otherwise the previous port comes from Shiptrail's AIS port-call history.
 * The next port is never filled from AIS here: the page shows a crew-entered AIS destination
 * separately and labels it as such.
 */
export function effectiveVoyage(call) {
  const v = call.voyage ? { ...call.voyage } : {};
  const t = call.trail;
  // Source hierarchy for the previous port: Shiptrail's recorded port call first; research only
  // as a fallback, and not at all while Shiptrail shows her still lying in another port.
  if (t?.still_in_port && !t.previous_port && v.previous_port && !v.previous_port.departed_at) delete v.previous_port;
  if (t?.previous_port) {
    if (v.previous_port && v.previous_port.locode && v.previous_port.locode !== t.previous_port.locode) v.superseded_previous_port = v.previous_port;
    const p = t.previous_port;
    v.previous_port = {
      name: p.name, locode: p.locode, country: p.country || null,
      arrived_at: p.arrived_at ? toZagreb(p.arrived_at) : null,
      departed_at: p.departed_at ? toZagreb(p.departed_at) : null,
      kind: 'actual', source: 'Shiptrail (AIS port-call history)', source_url: t.source_url,
      retrieved_at: t.fetched_at, auto: true,
      // Two independent sources naming the same port raise the confidence.
      confidence: call.voyage?.previous_port?.locode === p.locode && !call.voyage.previous_port.auto ? 'high' : 'medium',
    };
  }
  return Object.keys(v).length ? v : undefined;
}
const toZagreb = iso => toZagrebIso(iso);

function publicCall(call, profiles) {
  const { first_seen, last_seen, listed, ...rest } = call;
  rest.voyage = effectiveVoyage(call);
  if (rest.trail) { const { recent_calls, particulars, ...slim } = rest.trail; rest.trail = { ...slim, recent_calls }; }
  const profile = call.imo ? profiles[call.imo] || null : null;
  return { ...rest, profile };
}

/** How AIS relates to the terminal's claim that a ship is at the berth. */
export function corroboration(call, nowMs) {
  // Best evidence first: a fresh AIS position (Shiptrail) measured against the quay itself.
  const tr = call.trail;
  const trAgeH = tr?.last_heard ? (nowMs - t(tr.last_heard)) / 3600000 : null;
  if (tr?.position && trAgeH != null && trAgeH <= 3) {
    if (tr.at_quay) return { level: 'ais_consistent', note: `AIS position ${Math.round(tr.quay_distance_km * 1000)} m from the Brajdica quay, ${tr.position.status || 'stationary'} (Shiptrail).` };
    if (tr.quay_distance_km > 5) return { level: 'ais_conflict', note: `AIS position is ${tr.quay_distance_km} km from the Brajdica quay (Shiptrail). The terminal remains the authority.` };
  }
  const a = call.ais;
  if (!a || !a.checked_at) return { level: 'terminal_only', note: 'No AIS check has been made for this call.' };
  if (!a.found) return { level: 'terminal_only', note: 'Not found in the AIS source. Missing AIS is not evidence of absence.' };
  const ageH = a.last_report ? (nowMs - t(a.last_report)) / 3600000 : null;
  if (ageH != null && ageH > 6) return { level: 'terminal_only', note: `AIS position is stale (${Math.round(ageH)} h old).` };
  if (a.berth_consistent) return { level: 'ais_consistent', note: 'AIS places the ship at a distance consistent with the Brajdica quay.' };
  if (a.distance_km != null && a.distance_km > 12 && ageH != null && ageH < 2) {
    return { level: 'ais_conflict', note: `AIS reported the ship ${a.distance_km} km from Rijeka. The terminal remains the authority.` };
  }
  return { level: 'terminal_only', note: 'AIS found the ship near Rijeka but could not place it at the quay.' };
}

export function buildStatus({ calls, profiles, terminal, ais, nowIso, events }) {
  const nowMs = t(nowIso);
  const sel = selectBerth(calls, nowMs);
  const vessels = sel.atBerth.map(c => ({ ...publicCall(c, profiles), corroboration: corroboration(c, nowMs) }));
  let state = vessels.length ? 'occupied' : 'empty';
  // Never claim knowledge of the berth before the terminal has been read at least once.
  if (!terminal.fetched_at) state = 'unknown';
  return {
    schema: 1,
    generated_at: nowIso,
    timezone: 'Europe/Zagreb',
    terminal,
    berth: { state, vessels },
    upcoming: sel.expected.slice(0, 8).map((c, i) => (i < 2 ? publicCall(c, profiles) : publicCall(c, {}))),
    recent_departures: sel.departed.slice(0, 5).map(c => publicCall(c, {})),
    ais,
    last_events: (events || []).slice(-10),
    stale_after_hours: 3, // used only when next_check_at is absent
  };
}

/** Find a known IMO for a vessel name using the curated name index. */
export function imoForName(name, index) {
  return (index && index[normName(name)]) || null;
}

export const HEARTBEAT_MIN = 55;     // publish at least this often even when nothing changed
export const STALE_GRACE_MIN = 100;  // page shows "unconfirmed" this long after a publish was due and missed

// Fields that change on every run without meaning anything changed at the berth.
const VOLATILE = new Set(['generated_at', 'fetched_at', 'last_attempt_at', 'checked_at', 'next_check_at', 'next_check_reason',
  'last_report', 'query_url', 'summary', 'vessels_listed', 'distance_km', 'nav', 'note', 'observed', 'nearest_port_label']);

/** A string that changes only when the published status changes in a way worth publishing. */
export function fingerprint(status) {
  const strip = v => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) o[k] = strip(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(strip(status));
}
