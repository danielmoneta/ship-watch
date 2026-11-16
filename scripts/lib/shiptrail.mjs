// Shiptrail (shiptrail.io) - AIS-derived positions and port-call history.
// It publishes a free, unauthenticated MCP server. MCP over HTTP is plain JSON-RPC, so the
// updater calls it directly with curl: no MCP client and no AI are needed, which is why it
// works from GitHub Actions as well as from a Claude session.
//
// Verified 16 Nov 2026: tool `get_ship` (by MMSI) returns `recentCalls` (port, arrived, departed),
// `position` (lat/lon/status) and `voyage` (crew-entered destination + ETA). `search_ships` finds a
// ship by IMO, MMSI or name. Shiptrail asks callers to keep an answer for a minute and to credit it.
import { execFile } from 'node:child_process';
import { normName, validImo } from './util.mjs';

export const SHIPTRAIL_MCP = 'https://shiptrail.io/mcp';
// Brajdica quay (approximate midpoint). A moored ship within QUAY_RADIUS_KM of it is at the terminal.
export const QUAY = { lat: 45.3200, lon: 14.4545 };
export const QUAY_RADIUS_KM = 0.8;
// Port areas Shiptrail may report for a ship that is at, or waiting for, Brajdica.
// Calls at these are part of *this* visit and can never be the "previous port".
export const LOCAL_PORTS = new Set(['HRRJK', 'HRKOS', 'HRBAK', 'HROMI', 'HRKRA', 'HROPA', 'HRURJ']);

export function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function post(body, timeoutSec = 30) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-m', String(timeoutSec), '-X', 'POST', SHIPTRAIL_MCP,
      '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream',
      '-A', 'BrajdicaWatch/1.0 (ship wall display)', '-w', '\n%{http_code}', '-d', JSON.stringify(body)],
    { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`shiptrail: ${String(stderr || err.message).trim().split('\n')[0]}`));
      const i = stdout.lastIndexOf('\n');
      const code = stdout.slice(i + 1).trim();
      if (code !== '200') return reject(new Error(`shiptrail: HTTP ${code}`));
      resolve(stdout.slice(0, i));
    });
  });
}

/** Call one MCP tool and return its structured result. Throws on transport, protocol or tool errors. */
export async function callTool(name, args) {
  const raw = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  // The server answers with JSON; tolerate an SSE-framed answer too.
  const text = raw.trim().startsWith('{') ? raw : (raw.split('\n').filter(l => l.startsWith('data: ')).pop() || '').slice(6);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('shiptrail: unreadable response'); }
  if (j.error) throw new Error(`shiptrail: ${j.error.message || 'protocol error'}`);
  const r = j.result || {};
  if (r.isError) throw new Error(`shiptrail: ${(r.content?.[0]?.text || 'tool error').slice(0, 160)}`);
  if (r.structuredContent) return r.structuredContent;
  const t = (r.content || []).map(c => c.text).find(x => x && x.trim().startsWith('{'));
  if (!t) throw new Error('shiptrail: no structured content');
  return JSON.parse(t);
}

export const getShip = mmsi => callTool('get_ship', { mmsi: Number(mmsi) });

/** Find a ship's MMSI from its IMO number (exact match only). */
export async function mmsiForImo(imo) {
  const r = await callTool('search_ships', { query: String(imo), limit: 5 });
  const hit = (r.ships || []).find(s => String(s.imo) === String(imo));
  return hit ? String(hit.mmsi) : null;
}

/**
 * Reduce a get_ship record to what Brajdica Watch keeps.
 * `before` (ms) = the ship's arrival here, if known: the previous port must have been left before it.
 */
export function summarizeShip(ship, { nowIso, before = Infinity } = {}) {
  const out = {
    source: 'Shiptrail', source_url: ship.url || `https://shiptrail.io/`, fetched_at: nowIso,
    mmsi: ship.mmsi != null ? String(ship.mmsi) : null,
    imo: ship.imo != null && validImo(String(ship.imo)) ? String(ship.imo) : null,
    name: normName(ship.name),
    last_heard: ship.lastHeard || null,
    position: null, quay_distance_km: null, at_quay: false,
    destination_raw: ship.voyage?.destination || null,
    bound_for: ship.voyage?.boundFor ? { locode: ship.voyage.boundFor.locode, name: ship.voyage.boundFor.name, country: ship.voyage.boundFor.country } : null,
    destination_eta: ship.voyage?.eta || null,
    previous_port: null,
    recent_calls: [],
    particulars: ship.particulars || null,
  };
  const p = ship.position;
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
    out.position = { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), at: p.at || null, status: p.status || null, speed_kn: p.speedKn ?? null };
    out.quay_distance_km = +distanceKm(QUAY, p).toFixed(2);
    out.at_quay = out.quay_distance_km <= QUAY_RADIUS_KM && (p.speedKn == null || p.speedKn < 0.5);
  }
  const calls = (ship.recentCalls || []).filter(c => c?.port?.locode);
  out.recent_calls = calls.slice(0, 6).map(c => ({ locode: c.port.locode, name: c.port.name, country: c.port.country, arrived_at: c.arrived || null, departed_at: c.departed || null }));
  // Previous port = the most recent *completed* call somewhere other than the Rijeka area.
  // If her latest call elsewhere is still open she has not sailed for Rijeka yet: no previous port yet.
  const last = calls.find(c => !LOCAL_PORTS.has(c.port.locode.toUpperCase()));
  const prev = last && last.departed && new Date(last.departed).getTime() < before ? last : null;
  out.still_in_port = last && !last.departed ? { locode: last.port.locode, name: last.port.name } : null;
  if (prev) {
    out.previous_port = { locode: prev.port.locode, name: prev.port.name, country: prev.port.country, arrived_at: prev.arrived || null, departed_at: prev.departed, url: prev.port.url || null };
  }
  return out;
}
