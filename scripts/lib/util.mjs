// Small shared helpers. No dependencies; Node 20+.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TZ = 'Europe/Zagreb';

/** Offset (minutes east of UTC) of Europe/Zagreb at the given UTC instant. */
export function zagrebOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const x of parts) p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Wall-clock time in Europe/Zagreb -> ISO 8601 string carrying the Zagreb offset. */
export function zagrebWallToIso(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = zagrebOffsetMinutes(guess - 60 * 60000);
  off = zagrebOffsetMinutes(guess - off * 60000);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Any instant -> ISO string expressed in Europe/Zagreb wall time. */
export function toZagrebIso(dateLike) {
  const ms = new Date(dateLike).getTime();
  const off = zagrebOffsetMinutes(ms);
  const d = new Date(ms + off * 60000);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** dd.mm.yyyy for the terminal's query parameters, in Zagreb local date. */
export function zagrebDmy(dateLike) {
  const iso = toZagrebIso(dateLike);
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

export function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** IMO numbers carry a check digit: sum(d[i] * (7 - i)) mod 10 == d[6]. */
export function validImo(imo) {
  const s = String(imo || '');
  if (!/^\d{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(s[i]) * (7 - i);
  return sum % 10 === Number(s[6]);
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Fetch a URL with curl (honours the HTTPS proxy settings of whatever machine
 * runs this: cloud session, CI runner or laptop). Rejects on non-200.
 */
export function fetchText(url, { timeoutSec = 40, retries = 2 } = {}) {
  const once = () => new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-L', '--compressed', '-m', String(timeoutSec), '-A', UA,
      '-w', '\n%{http_code}', url], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`fetch failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
      const i = stdout.lastIndexOf('\n');
      const code = stdout.slice(i + 1).trim();
      if (code !== '200') return reject(new Error(`HTTP ${code}`));
      resolve(stdout.slice(0, i));
    });
  });
  return (async () => {
    let last;
    for (let i = 0; i <= retries; i++) {
      try { return await once(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
    }
    throw last;
  })();
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
