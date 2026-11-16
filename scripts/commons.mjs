#!/usr/bin/env node
// Wikimedia Commons helper for vessel photographs.
//
//   node scripts/commons.mjs search 9469560              files in Commons' IMO category (preferred)
//   node scripts/commons.mjs search "MSC Teresa"         exact-phrase search by name
//   node scripts/commons.mjs fetch "File:Name.jpg" 9469560   download a 1600px copy to docs/data/photos/<imo>.jpg
//                                                            and print the "photo" block for the profile
//
// Only licences that allow public display with attribution are accepted.
// Wikimedia throttles shared cloud addresses hard, so every call waits out Retry-After.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toZagrebIso } from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ShipPlacardBot/1.0 (hobby wall display; low volume)';
export const OK_LICENCE = /^(CC BY(-SA)? [\d.]+( [a-z]{2,})?|CC0( 1\.0)?|Public domain|PDM|CC BY(-SA)?)$/i;

function curl(argv) {
  return new Promise((resolve, reject) => execFile('curl', argv, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
    (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));
}

async function get(url, binaryTo) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const hdr = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cm-')), 'h');
    const argv = ['-sS', '-L', '-m', '60', '-A', UA, '-D', hdr, '-w', '\n%{http_code}', url];
    let body, code;
    if (binaryTo) {
      code = String(await curl(['-sS', '-L', '-m', '90', '-A', UA, '-D', hdr, '-o', binaryTo, '-w', '%{http_code}', url])).trim();
    } else {
      const out = String(await curl(argv));
      const i = out.lastIndexOf('\n');
      body = out.slice(0, i); code = out.slice(i + 1).trim();
    }
    if (code === '200') return body;
    const h = fs.existsSync(hdr) ? fs.readFileSync(hdr, 'utf8') : '';
    const ra = Number((h.match(/retry-after:\s*(\d+)/i) || [])[1] || 20);
    if (code !== '429' && code !== '503') throw new Error(`HTTP ${code} from Wikimedia`);
    process.stderr.write(`Wikimedia asked us to wait ${ra}s (attempt ${attempt + 1})\n`);
    await new Promise(r => setTimeout(r, (ra + 3) * 1000));
  }
  throw new Error('Wikimedia kept rate-limiting; try again on a later run');
}

const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function describe(page) {
  const ii = (page.imageinfo || [])[0] || {};
  const em = ii.extmetadata || {};
  const licence = strip(em.LicenseShortName?.value);
  return {
    title: page.title, width: ii.width, height: ii.height,
    licence, licence_ok: OK_LICENCE.test(licence),
    licence_url: em.LicenseUrl?.value || null,
    author: strip(em.Artist?.value) || null,
    date: strip(em.DateTimeOriginal?.value) || null,
    description: strip(em.ImageDescription?.value).slice(0, 200) || null,
    page_url: ii.descriptionurl, thumb_url: ii.thumburl || ii.url, mime: ii.mime,
  };
}

const PROPS = 'prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=1600';

/**
 * query = a 7-digit IMO number  -> every file under Commons' "Category:IMO <n>" tree
 *                                  (the reliable way: also finds photos filed under former names)
 * query = a ship name           -> exact-phrase search; check each hit really shows this ship
 */
export async function search(query) {
  const q = /^\d{7}$/.test(query) ? `deepcategory:"IMO ${query}"` : `"${query.replace(/"/g, '')}"`;
  const url = `${API}?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent(q)}&${PROPS}`;
  const j = JSON.parse(await get(url));
  return Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index).map(describe)
    .filter(f => /^image\/(jpeg|png)$/.test(f.mime || ''));
}

export async function fetchPhoto(title, imo) {
  const url = `${API}?action=query&format=json&titles=${encodeURIComponent(title)}&${PROPS}`;
  const j = JSON.parse(await get(url));
  const page = Object.values(j.query?.pages || {})[0];
  if (!page || !page.imageinfo) throw new Error(`no such file on Commons: ${title}`);
  const f = describe(page);
  if (!f.licence_ok) throw new Error(`licence "${f.licence}" is not on the allowed list; choose another image`);
  const ext = f.mime === 'image/png' ? 'png' : 'jpg';
  const rel = `data/photos/${imo}.${ext}`;
  const dest = path.join(ROOT, 'docs', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise(r => setTimeout(r, 2000));
  await get(f.thumb_url, dest);
  if (fs.statSync(dest).size < 20000) throw new Error('downloaded image is implausibly small');
  return {
    file: rel, title: f.title.replace(/^File:/, ''), author: f.author || 'Unknown author',
    license: f.licence, license_url: f.licence_url, source_name: 'Wikimedia Commons', source_url: f.page_url,
    taken: f.date, width: f.width, height: f.height, retrieved_at: toZagrebIso(Date.now()),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  const job = cmd === 'search' ? search(a) : cmd === 'fetch' && a && /^\d{7}$/.test(b || '') ? fetchPhoto(a, b) : null;
  if (!job) { console.error('usage: commons.mjs search "<name>" | fetch "File:<title>" <imo>'); process.exit(2); }
  job.then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
