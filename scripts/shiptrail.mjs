#!/usr/bin/env node
// Shiptrail lookups from the command line (used by the research task and for checking by hand).
//   node scripts/shiptrail.mjs ship <MMSI or IMO>     full record: position, voyage, recentCalls, particulars
//   node scripts/shiptrail.mjs search "<name|IMO|MMSI>"
//   node scripts/shiptrail.mjs port <LOCODE>          arrivals / departures board
import { callTool, getShip, mmsiForImo } from './lib/shiptrail.mjs';

const [cmd, arg] = process.argv.slice(2);
try {
  let r;
  if (cmd === 'ship' && /^\d{9}$/.test(arg || '')) r = await getShip(arg);
  else if (cmd === 'ship' && /^\d{7}$/.test(arg || '')) {
    const mmsi = await mmsiForImo(arg);
    if (!mmsi) throw new Error(`no ship with IMO ${arg} on Shiptrail`);
    r = await getShip(mmsi);
  } else if (cmd === 'search' && arg) r = await callTool('search_ships', { query: arg, limit: 10 });
  else if (cmd === 'port' && arg) r = await callTool('get_port', { locode: arg, limit: 40 });
  else { console.error('usage: shiptrail.mjs ship <MMSI|IMO> | search "<query>" | port <LOCODE>'); process.exit(2); }
  console.log(JSON.stringify(r, null, 2));
} catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
