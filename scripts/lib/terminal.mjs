// Parser for the Adriatic Gate Container Terminal (AGCT) public sailing list.
// https://webusercorner.ictsi.hr/?language=EN
import { decodeEntities, normName, zagrebWallToIso, zagrebDmy } from './util.mjs';

export const TERMINAL_URL = 'https://webusercorner.ictsi.hr/?language=EN';

/** URL covering a window wide enough to keep a long-staying ship and recent history in view. */
export function terminalUrl(now = Date.now(), daysBack = 10, daysAhead = 21) {
  const from = zagrebDmy(now - daysBack * 86400000);
  const to = zagrebDmy(now + daysAhead * 86400000);
  return `${TERMINAL_URL}&from=${from}&to=${to}`;
}

/** "16.11.2026. 6:30:00" (Europe/Zagreb wall time) -> ISO with offset; "" -> null. */
export function parseTerminalDateTime(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return zagrebWallToIso(+y, +mo, +d, +h, +mi, +se);
}

const HEADER_KEYS = {
  'vessel': 'name', 'shipper': 'shipper',
  'arrival voyage': 'voyage_in', 'departure voyage': 'voyage_out',
  'eta': 'eta', 'etd': 'etd', 'ata': 'ata', 'atd': 'atd',
  'status': 'status', 'truck gate open': 'gate_open',
};
const REQUIRED = ['name', 'eta', 'etd', 'ata', 'atd', 'status'];

/**
 * Parse the sailing-list HTML. Columns are located by header text, so a
 * reordered table still parses. Throws if the page does not look like the
 * sailing list - the caller must then keep the previous state.
 */
export function parseSailingList(html) {
  if (typeof html !== 'string' || html.length < 200) throw new Error('terminal page empty or truncated');
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
    [...m[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => ({
      th: c[1].toLowerCase() === 'h',
      text: decodeEntities(c[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    })));
  const headerRow = rows.find(r => r.length && r.every(c => c.th) && r.some(c => /^vessel$/i.test(c.text)));
  if (!headerRow) throw new Error('sailing list header row not found (page layout changed or error page)');
  const cols = headerRow.map(c => HEADER_KEYS[c.text.toLowerCase()] || null);
  for (const k of REQUIRED) if (!cols.includes(k)) throw new Error(`sailing list column missing: ${k}`);

  const out = [];
  for (const r of rows) {
    if (r === headerRow || !r.length || r.some(c => c.th) || r.length < REQUIRED.length) continue;
    const raw = {};
    cols.forEach((k, i) => { if (k) raw[k] = r[i] ? r[i].text : ''; });
    const name = normName(raw.name);
    if (!name) continue;
    const call = {
      name,
      shipper: raw.shipper || null,
      voyage_in: raw.voyage_in || null,
      voyage_out: raw.voyage_out || null,
      status: normName(raw.status) || null,
      eta: parseTerminalDateTime(raw.eta),
      etd: parseTerminalDateTime(raw.etd),
      ata: parseTerminalDateTime(raw.ata),
      atd: parseTerminalDateTime(raw.atd),
    };
    // A non-empty cell we could not read as a date is a parsing problem, not "no data".
    for (const k of ['eta', 'etd', 'ata', 'atd']) {
      if (raw[k] && !call[k]) throw new Error(`unreadable ${k.toUpperCase()} "${raw[k]}" for ${name}`);
    }
    out.push(call);
  }
  return out;
}

/** Where a call stands, derived from the terminal's own fields. */
export function phaseOf(call) {
  if (call.atd || call.status === 'DEPARTED') return 'departed';
  if (call.ata) return 'at_berth';
  return 'expected';
}

export function callId(call) {
  return `${normName(call.name)}|${call.voyage_in || '-'}`;
}
