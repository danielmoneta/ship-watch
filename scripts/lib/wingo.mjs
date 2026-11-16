// Parsers for Wingo Marine's public AIS pages (secondary, corroborating source only).
import { decodeEntities, normName, stripTags, validImo } from './util.mjs';

export const WINGO_PORT_URL = 'https://wingo-marine.com/port/rijeka-2263';
export const WINGO_BASE = 'https://wingo-marine.com';

// Wingo measures "x km away" from its Rijeka reference point (45.3167 N, 14.4000 E).
// Brajdica's quay (45.3205 N, 14.4540 E) lies about 4.3 km east of that point,
// so a ship reported 3.8-4.8 km away is *consistent with* lying at Brajdica.
// It is corroboration, never proof: other spots share that distance ring.
export const BERTH_RING_KM = [3.8, 4.8];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Port page -> { vessels: [{name, mmsi, href, flag, type, destination_raw, distance_km, nav}], summary } */
export function parseWingoPort(html) {
  if (typeof html !== 'string' || !/vcard/.test(html)) throw new Error('wingo port page has no vessel cards');
  const vessels = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a class="vcard"[^>]*href="(\/ship\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1];
    const body = m[2];
    const pick = cls => {
      const x = body.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</span>`));
      return x ? decodeEntities(x[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
    };
    const name = normName(pick('vcard__name'));
    if (!name) continue;
    const mmsi = (href.match(/-(\d{9})$/) || [])[1] || null;
    const key = name + '|' + mmsi;
    const flag = (body.match(/class="flag" title="([^"]+)"/) || [])[1] || null;
    const extra = pick('vcard__extra') || '';
    const dist = extra.match(/([\d.,]+)\s*km away/);
    const dest = pick('vcard__dest');
    const rec = {
      name, mmsi, href, flag,
      destination_raw: dest ? dest.replace(/^→\s*/, '').trim() : null,
      distance_km: dist ? Number(dist[1].replace(/,/g, '')) : null,
      nav: (extra.match(/·\s*(.+)$/) || [])[1] || null,
    };
    if (seen.has(key)) {
      // A ship can appear in both "nearby" and "expected arrivals"; keep the record with a distance.
      const i = vessels.findIndex(v => v.name + '|' + v.mmsi === key);
      if (vessels[i].distance_km == null && rec.distance_km != null) vessels[i] = rec;
      continue;
    }
    seen.add(key);
    vessels.push(rec);
  }
  const text = stripTags(html);
  const summary = (text.match(/(\d+) vessels reported within 15 km in the last 24 hours/) || [])[0] || null;
  return { vessels, summary };
}

/** Ship page -> identifiers, AIS particulars and last-report time. */
export function parseWingoShip(html) {
  const text = stripTags(html);
  const out = {};
  const t = text.match(/IMO (\d{7}), MMSI (\d{9})/);
  if (t) { if (validImo(t[1])) out.imo = t[1]; out.mmsi = t[2]; }
  // "Last report 16 Nov 2026, 13:56 UTC" / "... received on 16 Nov 2026 at 13:56 UTC ..."
  const seen = text.match(/Last report (\d{1,2}) (\w{3}) (\d{4}), (\d{1,2}):(\d{2}) UTC/)
    || text.match(/received on (\d{1,2}) (\w{3}) (\d{4}) at (\d{1,2}):(\d{2}) UTC/)
    || html.match(/Last seen[^"<]*? on (\d{1,2}) (\w{3}) (\d{4}) at (\d{1,2}):(\d{2}) UTC/);
  if (seen) {
    const mo = MONTHS[seen[2].toLowerCase()];
    if (mo != null) out.last_report = new Date(Date.UTC(+seen[3], mo, +seen[1], +seen[4], +seen[5])).toISOString();
  }
  const np = text.match(/placed it in the port of ([^,.]+)/);
  if (np) out.nearest_port = np[1].trim();
  const num = re => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  out.length_m = num(/Length ([\d.,]+) m\b/);
  out.beam_m = num(/Beam ([\d.,]+) m\b/);
  out.draught_m = num(/Draught ([\d.,]+) m\b/);
  const cs = text.match(/Call sign ([A-Z0-9]{3,8})\b/); if (cs) out.callsign = cs[1];
  const fl = text.match(/registered in ([A-Z][A-Za-z .'-]+?)\./); if (fl) out.flag = fl[1].trim();
  const dest = text.match(/reported its destination as ([^.]+)\./) || text.match(/The crew reported ([^.]+?) as the destination\./);
  if (dest) out.destination_raw = dest[1].trim();
  return out;
}

// Common ports on Adriatic / Mediterranean container loops. Used only to turn a
// crew-entered AIS destination code into a readable name; unknown codes are shown raw.
export const LOCODES = {
  HRRJK: 'Rijeka, Croatia', HRPLE: 'Ploče, Croatia', HRSPU: 'Split, Croatia', HRBAK: 'Bakar, Croatia',
  ITTRS: 'Trieste, Italy', ITVCE: 'Venice, Italy', ITRAN: 'Ravenna, Italy', ITAOI: 'Ancona, Italy',
  ITBRI: 'Bari, Italy', ITGIT: 'Gioia Tauro, Italy', ITGOA: 'Genoa, Italy', ITSPE: 'La Spezia, Italy',
  ITNAP: 'Naples, Italy', ITSAL: 'Salerno, Italy', ITLIV: 'Livorno, Italy', ITTAR: 'Taranto, Italy',
  SIKOP: 'Koper, Slovenia', MEBAR: 'Bar, Montenegro', ALDRZ: 'Durrës, Albania',
  GRPIR: 'Piraeus, Greece', GRSKG: 'Thessaloniki, Greece', MTMAR: 'Marsaxlokk, Malta', MTMLA: 'Valletta, Malta',
  EGPSD: 'Port Said, Egypt', EGALY: 'Alexandria, Egypt', EGDAM: 'Damietta, Egypt',
  TRIST: 'Istanbul, Türkiye', TRMER: 'Mersin, Türkiye', TRIZM: 'İzmir, Türkiye', TRALI: 'Aliağa, Türkiye',
  TRGEM: 'Gemlik, Türkiye', TRTEK: 'Tekirdağ, Türkiye', TRAMB: 'Ambarlı, Türkiye',
  ILHFA: 'Haifa, Israel', ILASH: 'Ashdod, Israel', LBBEY: 'Beirut, Lebanon', CYLMS: 'Limassol, Cyprus',
  ESVLC: 'Valencia, Spain', ESBCN: 'Barcelona, Spain', ESALG: 'Algeciras, Spain', MAPTM: 'Tanger Med, Morocco',
  FRFOS: 'Fos-sur-Mer, France', FRMRS: 'Marseille, France', PTSIE: 'Sines, Portugal',
  SGSIN: 'Singapore', CNSHA: 'Shanghai, China', CNNGB: 'Ningbo, China', LKCMB: 'Colombo, Sri Lanka',
  SAJED: 'Jeddah, Saudi Arabia', AEJEA: 'Jebel Ali, UAE', OMSLL: 'Salalah, Oman',
};

/** Crew-typed AIS destination -> { locode, name } when it is a recognisable single port, else null. */
export function resolveDestination(raw) {
  if (!raw) return null;
  // Crews often write "FROM > TO" or "A => B"; the last element is where the ship is going.
  const last = String(raw).toUpperCase().split(/=?>|→/).pop().trim();
  const code = last.replace(/[^A-Z]/g, '');
  if (code.length === 5 && LOCODES[code]) return { locode: code, name: LOCODES[code] };
  const byName = Object.entries(LOCODES).find(([, n]) => n.split(',')[0].toUpperCase() === last);
  if (byName) return { locode: byName[0], name: byName[1] };
  return null;
}
