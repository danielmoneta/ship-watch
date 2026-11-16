/* Brajdica Watch - display logic.
   Plain ES5 on purpose: e-ink readers and old wall tablets ship old browsers.
   Reads data/status.json (written by scripts/update.mjs) and re-reads it on a timer.

   URL options:
     ?mode=eink | ?mode=colour   choose the theme (remembered on the device)
     ?photo=1                    e-ink mode only: show the photograph in greyscale
     ?demo=NAME                  load demo/NAME.json (simulated data, clearly labelled)
*/
(function () {
  'use strict';

  var POLL_MS = { colour: 5 * 60 * 1000, eink: 10 * 60 * 1000 };
  var ROTATE_MS = 40 * 1000; // colour mode: alternate between ships when two are alongside
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var app = document.getElementById('app');
  var params = parseQuery(location.search);
  var mode = pickMode();
  var data = null;
  var lastSignature = '';
  var rotateIndex = 0;
  var sourcesOpen = false;
  var lastError = null;

  document.body.className = mode + (params.photo === '1' ? ' withphoto' : '') + ' loading';

  // ---------- helpers ----------
  function parseQuery(q) {
    var o = {}, parts = (q || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var kv = parts[i].split('=');
      o[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    }
    return o;
  }
  function store(k, v) {
    try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; }
  }
  function pickMode() {
    var m = params.mode;
    if (m === 'e-ink' || m === 'bw') m = 'eink';
    if (m === 'color') m = 'colour';
    if (m === 'eink' || m === 'colour') { store('bw-mode', m); return m; }
    var saved = store('bw-mode');
    return saved === 'eink' ? 'eink' : 'colour';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* Timestamps are stored as ISO strings that already carry the Europe/Zagreb
     offset, so we read the wall-clock digits straight from the string. That
     shows Rijeka time on any device, whatever its own time zone. */
  function parts(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso || '');
    if (!m) return null;
    var off = 0;
    if (m[7] && m[7] !== 'Z') off = (m[7].charAt(0) === '-' ? -1 : 1) * (parseInt(m[7].substr(1, 2), 10) * 60 + parseInt(m[7].substr(4, 2), 10));
    var wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], dow: new Date(wall).getUTCDay(), ms: wall - off * 60000 };
  }
  function fmtTime(iso) { var p = parts(iso); return p ? pad(p.h) + ':' + pad(p.mi) : ''; }
  function fmtDay(iso, long) {
    var p = parts(iso); if (!p) return '';
    return (long ? DAYS[p.dow] : DAYS[p.dow].substr(0, 3)) + ' ' + p.d + ' ' + MONTHS[p.mo - 1];
  }
  function fmtDayTime(iso) { return iso ? fmtDay(iso) + ', ' + fmtTime(iso) : ''; }
  function nowMs() { return data && data.demo_now ? parts(data.demo_now).ms : new Date().getTime(); }
  function ago(iso) {
    var p = parts(iso); if (!p) return '';
    var min = Math.round((nowMs() - p.ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' h ' + (min % 60 ? (min % 60) + ' min ' : '') + 'ago';
    return Math.floor(h / 24) + ' days ago';
  }
  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fv(profile, key) {
    var f = profile && profile.fields && profile.fields[key];
    return f && f.value != null && f.value !== '' ? f.value : null;
  }
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); })
      .replace(/\b(Msc|Cma|Cgm|Sc|Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii|Xiii)\b/g, function (w) { return w.toUpperCase(); });
  }

  // ---------- data ----------
  function load(cb) {
    var url = params.demo ? 'demo/' + encodeURIComponent(params.demo) + '.json' : 'data/status.json';
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url + '?t=' + new Date().getTime(), true); // cache-buster: Pages caches for 10 min
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(null, JSON.parse(xhr.responseText)); } catch (e) { cb('Status file unreadable'); }
      } else { cb('Could not reach the status file (HTTP ' + xhr.status + ')'); }
    };
    try { xhr.send(null); } catch (e) { cb('Network error'); }
  }

  function refresh() {
    load(function (err, d) {
      lastError = err || null;
      if (!err) data = d;
      render(false);
    });
  }

  // ---------- view model ----------
  function staleInfo() {
    var t = data.terminal || {};
    var p = parts(t.fetched_at);
    if (!p) return { stale: true, never: true };
    var hours = (nowMs() - p.ms) / 3600000;
    // Checks are timed around arrivals and departures, so "stale" means a planned check
    // was missed by more than the grace period - not simply that the data is a few hours old.
    var due = parts(data.next_check_at);
    if (due) return { stale: nowMs() > due.ms + (data.stale_grace_minutes || 100) * 60000, hours: hours };
    return { stale: hours > (data.stale_after_hours || 3), hours: hours };
  }

  function nextPortOf(call) {
    var v = call.voyage && call.voyage.next_port;
    if (v && v.name) return { name: v.name, when: v.eta ? 'ETA ' + fmtDayTime(v.eta) : '', kind: v.kind || 'scheduled' };
    var a = call.ais;
    if (a && a.found && a.destination_raw) {
      var isHere = a.destination && a.destination.locode === 'HRRJK';
      if (!isHere) return { name: a.destination ? a.destination.name.split(',')[0] : a.destination_raw, when: '', kind: 'ais_destination' };
    }
    return null;
  }
  function prevPortOf(call) {
    var v = call.voyage && call.voyage.previous_port;
    if (v && v.name) return { name: v.name, when: v.departed_at ? 'Left ' + fmtDayTime(v.departed_at) : '', kind: v.kind || 'actual' };
    return null;
  }
  var KIND = {
    actual: 'Actual port call', reported: 'Reported', scheduled: 'Scheduled',
    ais_destination: 'AIS destination · crew-entered', estimate: 'Estimate'
  };

  // ---------- rendering ----------
  function silhouette() {
    // A generic container-ship profile, used when no freely licensed photograph is on file.
    var boxes = '', x, y, cols = 22, rows;
    for (x = 0; x < cols; x++) {
      if (x === 15 || x === 16) continue; // gap for the accommodation block
      rows = 3 + ((x * 7) % 3);
      for (y = 0; y < rows; y++) boxes += '<rect x="' + (120 + x * 36) + '" y="' + (150 - y * 22) + '" width="32" height="19" />';
    }
    return '<svg viewBox="0 0 1000 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<g fill="none" stroke="#c9a45c" stroke-width="2.5" stroke-linejoin="round">' +
      '<path d="M40 172 L960 172 L928 228 L86 228 Z" fill="#16283a"/>' + boxes +
      '<rect x="660" y="62" width="62" height="110" fill="#16283a"/><rect x="652" y="48" width="78" height="14" fill="#16283a"/>' +
      '<path d="M690 48 V20 M676 28 H704"/><rect x="760" y="110" width="20" height="62"/>' +
      '</g><path d="M0 244 q25 -12 50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0" fill="none" stroke="#3b556f" stroke-width="2"/></svg>';
  }

  function photoPanel(call, tag) {
    var p = call && call.profile && call.profile.photo;
    var h = '<div class="photo">';
    if (p && p.file) {
      h += '<img src="' + esc(p.file) + '" alt="' + esc(call.name) + '">';
      h += '<div class="credit">Photo: ' + esc(p.author || 'unknown author') + ' · ' + esc(p.license || '') +
        (p.source_url ? ' · <a href="' + esc(p.source_url) + '" target="_blank" rel="noopener">' + esc(p.source_name || 'source') + '</a>' : '') +
        (p.caption ? '<br>' + esc(p.caption) : '') + '</div>';
    } else {
      var len = call && fv(call.profile, 'length_m');
      h += '<div class="nophoto">' + silhouette() +
        (len ? '<div class="scale">' + esc(Math.round(len)) + ' metres bow to stern</div>' : '') +
        '<div class="note">' + (call ? 'No freely licensed photograph on file for this vessel' : 'Brajdica container terminal, Rijeka') + '</div></div>';
    }
    if (tag) h += '<div class="tag">' + esc(tag) + '</div>';
    return h + '</div>';
  }

  function specs(call) {
    var p = call.profile, out = [], v;
    function add(label, html) { out.push('<div class="spec"><div class="label">' + label + '</div><div class="v">' + html + '</div></div>'); }
    // A low-confidence figure is shown as approximate ("c.").
    if ((v = fv(p, 'teu'))) add('Capacity', (p.fields.teu.confidence === 'low' ? '<small>c.</small> ' : '') + num(v) + ' <small>TEU</small>');
    var L = fv(p, 'length_m'), B = fv(p, 'beam_m');
    if (L) add('Length' + (B ? ' × beam' : ''), esc(Math.round(L)) + (B ? ' × ' + esc(Math.round(B)) : '') + ' <small>m</small>');
    if ((v = fv(p, 'year_built'))) add('Built', esc(v));
    if ((v = fv(p, 'flag'))) add('Flag', esc(v));
    if ((v = fv(p, 'gross_tonnage'))) add('Gross tonnage', num(v));
    if ((v = fv(p, 'builder')) && out.length < 6) add('Builder', esc(v));
    if ((v = fv(p, 'former_names')) && out.length < 5) add('Formerly', esc(String(v).split(',')[0]));
    if (call.shipper && out.length < 6) add('Line', esc(fv(p, 'operator') || call.shipper));
    if (call.imo && out.length < 6) add('IMO', esc(call.imo));
    return out.length ? '<div class="specs">' + out.slice(0, 6).join('') + '</div>' : '';
  }

  function routeBlock(call, isExpected) {
    var prev = prevPortOf(call), next = nextPortOf(call);
    var h = '<div class="route">';
    h += '<div class="leg prev"><div class="label">Previous port</div>' +
      (prev ? '<div class="port">' + esc(prev.name) + '</div><div class="when">' + esc(prev.when) + '</div><div class="kind">' + KIND[prev.kind] + '</div>'
        : '<div class="port none">not established</div>') + '</div>';
    h += '<div class="arrow">→</div>';
    h += '<div class="leg mid"><div class="label">' + (isExpected ? 'Expected at' : 'Now at') + '</div><div class="port">Rijeka</div><div class="when">Brajdica terminal</div></div>';
    h += '<div class="arrow">→</div>';
    h += '<div class="leg next"><div class="label">Next port</div>' +
      (next ? '<div class="port">' + esc(next.name) + '</div>' + (next.when ? '<div class="when">' + esc(next.when) + '</div>' : '') + '<div class="kind">' + KIND[next.kind] + '</div>'
        : '<div class="port none">not established</div>') + '</div>';
    return h + '</div>';
  }

  function timesBlock(call, isExpected) {
    var h = '<div class="times">';
    if (isExpected) {
      h += '<div class="t"><div class="label">Expected arrival</div><div class="big">' + (fmtTime(call.eta) || '—') + '</div><div class="day">' + fmtDay(call.eta, true) + '</div></div>';
      h += '<div class="t"><div class="label">Scheduled departure</div><div class="big">' + (fmtTime(call.etd) || '—') + '</div><div class="day">' + fmtDay(call.etd, true) + '</div></div>';
    } else {
      h += '<div class="t"><div class="label">Arrived</div><div class="big">' + (fmtTime(call.ata) || '—') + '</div><div class="day">' + fmtDay(call.ata, true) + '</div></div>';
      var late = call.etd && parts(call.etd).ms < nowMs();
      h += '<div class="t"><div class="label">Scheduled departure</div><div class="big">' + (fmtTime(call.etd) || '—') + '</div><div class="day">' + fmtDay(call.etd, true) + '</div>' +
        (late ? '<div class="note">Scheduled time has passed — departure not yet recorded</div>' : '') + '</div>';
    }
    return h + '</div>';
  }

  function factLine(call) {
    var f = call.profile && call.profile.facts;
    if (!f || !f.length) return '';
    var i = Math.floor(nowMs() / 3600000) % f.length; // changes hourly, not on every poll
    return '<div class="rule"></div><div class="fact">' + esc(f[i].text) + '</div>';
  }

  function footer(st) {
    var t = data.terminal || {};
    var v;
    if (st.never) v = '<span class="verified stale"><b>Terminal list not yet read</b></span>';
    else {
      v = '<span class="verified' + (st.stale ? ' stale' : '') + '">Verified with terminal <b>' + fmtDayTime(t.fetched_at) + '</b>' +
        (mode === 'colour' ? ' · ' + ago(t.fetched_at) : '') + '</span>';
    }
    if (lastError) v += ' <span class="verified stale">· ' + esc(lastError) + '</span>';
    var other = mode === 'eink' ? 'colour' : 'eink';
    return '<div class="foot"><div>' + v + '</div><div class="links">' +
      '<a id="src-toggle">Sources &amp; freshness</a>' +
      '<a href="?mode=' + other + (params.demo ? '&demo=' + esc(params.demo) : '') + '">' + (other === 'eink' ? 'E-ink' : 'Colour') + ' mode</a></div></div>';
  }

  function placard(o) {
    // o: {stateClass, stateText, stateSub, call, isExpected, title, subtitle, also, st}
    var c = o.call, h = '<div class="placard">';
    h += '<div class="kicker">Brajdica · Adriatic Gate Container Terminal · Rijeka</div>';
    h += '<div class="state ' + o.stateClass + '"><span class="dot"></span><span>' + esc(o.stateText) + '</span>' + (o.stateSub ? '<span class="sub">' + esc(o.stateSub) + '</span>' : '') + '</div>';
    h += '<h1 class="name" id="name">' + esc(o.title) + '</h1>';
    if (o.subtitle) h += '<div class="subname">' + o.subtitle + '</div>';
    h += '<div class="rule brass"></div>';
    if (c) {
      h += routeBlock(c, o.isExpected);
      h += '<div class="rule"></div>' + timesBlock(c, o.isExpected);
      var s = specs(c);
      if (s) h += '<div class="rule"></div>' + s;
      h += factLine(c);
    }
    if (o.also) h += '<div class="rule"></div><div class="also">' + o.also + '</div>';
    h += '<div class="spacer"></div>' + footer(o.st) + '</div>';
    return h;
  }

  function subtitleFor(call) {
    var p = call.profile, bits = [];
    var type = fv(p, 'type');
    bits.push(esc(type || 'Container ship'));
    if (call.voyage_in) bits.push('Voyage ' + esc(call.voyage_in));
    if (!p || !p.research || p.research.status === 'auto') bits.push('<i>profile research pending</i>');
    return bits.join(' · ');
  }

  function render(force) {
    if (!data) {
      app.innerHTML = '<div class="boot"><div class="boot-kicker">Brajdica Watch</div><div class="boot-msg">' +
        esc(lastError || 'Reading the berth…') + '</div></div>';
      return;
    }
    var st = staleInfo();
    var vessels = (data.berth && data.berth.vessels) || [];
    var upcoming = data.upcoming || [];
    var idx = vessels.length ? rotateIndex % vessels.length : 0;
    if (mode === 'eink') idx = 0;

    // Only touch the DOM when something visible changed (kind to e-paper).
    var sig = [data.generated_at, st.stale, idx, mode === 'colour' ? Math.floor(nowMs() / 60000) : 0, lastError, sourcesOpen].join('|');
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    var html = '', call = null, o;
    var nextUp = upcoming[0] || null;
    var nextLine = nextUp ? '<span class="label">Next expected</span> &nbsp;<b>' + esc(nextUp.name) + '</b> · ' + fmtDayTime(nextUp.eta) : '';

    if (data.berth.state === 'unknown' || st.never) {
      o = { stateClass: 'unknown', stateText: 'Berth status unknown', stateSub: 'the terminal list has not been read yet', title: 'Awaiting first reading', st: st, also: nextLine };
      html = photoPanel(null) + placard(o);
    } else if (vessels.length) {
      call = vessels[idx];
      var others = [];
      for (var i = 0; i < vessels.length; i++) if (i !== idx) others.push('<b>' + esc(vessels[i].name) + '</b> (since ' + fmtDayTime(vessels[i].ata) + ')');
      var also = (others.length ? '<span class="label">Also alongside</span> &nbsp;' + others.join(', ') + (nextLine ? '<br>' : '') : '') + nextLine;
      if (st.stale) {
        o = { stateClass: 'stale', stateText: 'Occupancy unconfirmed', stateSub: 'last known alongside · terminal not reached for ' + Math.round(st.hours) + ' h',
          call: call, title: call.name, subtitle: subtitleFor(call), also: also, st: st };
        html = photoPanel(call, 'Last known · unconfirmed') + placard(o);
      } else {
        o = { stateClass: 'occupied', stateText: 'Alongside now', stateSub: call.status ? 'terminal status: ' + titleCase(call.status) : '',
          call: call, title: call.name, subtitle: subtitleFor(call), also: also, st: st };
        html = photoPanel(call) + placard(o);
      }
    } else {
      // Empty berth. The next ship is featured, but always labelled as expected.
      if (st.stale) {
        o = { stateClass: 'stale', stateText: 'Occupancy unconfirmed', stateSub: 'berth was clear when last checked ' + Math.round(st.hours) + ' h ago',
          call: nextUp, isExpected: true, title: 'Berth status unconfirmed', subtitle: nextUp ? 'Next expected: <b>' + esc(nextUp.name) + '</b> · ' + subtitleFor(nextUp) : '', st: st };
      } else {
        // The big title says the berth is clear; the next ship is named in smaller type below it.
        o = { stateClass: 'empty', stateText: 'No vessel alongside', stateSub: '',
          call: nextUp, isExpected: true, title: 'Berth clear',
          subtitle: nextUp ? '<span class="nextname">Next expected: <b>' + esc(nextUp.name) + '</b></span><br>' + subtitleFor(nextUp) : 'No arrivals are listed by the terminal', st: st };
        var after = upcoming[1];
        if (after) o.also = '<span class="label">Then</span> &nbsp;<b>' + esc(after.name) + '</b> · ' + fmtDayTime(after.eta);
      }
      html = photoPanel(nextUp, nextUp ? 'Expected · not yet alongside' : '') + placard(o);
    }

    var ribbon = '';
    if (params.demo || data.simulated) ribbon = '<div class="ribbon">Simulation — not live data' + (data.simulated_note ? ' · ' + esc(data.simulated_note) : '') + '</div>';
    app.innerHTML = ribbon + '<div class="stage' + (ribbon ? ' ribboned' : '') + '">' + html + '</div>' + sourcesPanel(call || nextUp, st);
    document.body.className = document.body.className.replace(/\s*loading/, '');
    document.title = (vessels.length ? vessels[idx].name + ' — ' : '') + 'Brajdica Watch';
    var tg = document.getElementById('src-toggle');
    if (tg) tg.onclick = function () { sourcesOpen = !sourcesOpen; render(true); if (sourcesOpen) { var el = document.getElementById('sources'); if (el && el.scrollIntoView) el.scrollIntoView(); } };
    fitName();
  }

  /* Make the ship's name as large as the placard allows (two lines at most). */
  function fitName() {
    var el = document.getElementById('name');
    if (!el || !el.parentNode) return;
    var portrait = window.innerHeight > window.innerWidth;
    var vmin = Math.min(window.innerWidth, window.innerHeight);
    var max = Math.round(vmin * (mode === 'eink' ? (portrait ? 0.17 : 0.2) : (portrait ? 0.14 : 0.135)));
    var min = 26, size = max;
    el.style.fontSize = size + 'px';
    var guard = 0;
    while (size > min && guard++ < 80 && (el.scrollWidth > el.clientWidth + 1 || el.offsetHeight > size * 2.15)) {
      size = Math.floor(size * 0.94);
      el.style.fontSize = size + 'px';
    }
    // If the content still overflows the screen, shrink the name a little more.
    var pl = el.parentNode;
    function overflows() {
      if (mode === 'eink' || portrait) return !sourcesOpen && document.documentElement.scrollHeight > window.innerHeight + 2;
      return pl.scrollHeight > pl.clientHeight + 2;
    }
    // Vertical overflow: give back a little name size, then (portrait) some photo height.
    var floor = Math.max(min, Math.floor(size * (mode === 'eink' ? 0.4 : 0.62)));
    guard = 0;
    while (size > floor && guard++ < 40 && overflows()) {
      size = Math.floor(size * 0.95);
      el.style.fontSize = size + 'px';
    }
    var ph = document.querySelector ? document.querySelector('.photo') : null;
    if (ph && portrait && mode === 'colour') {
      var h = ph.offsetHeight, minH = Math.round(window.innerHeight * 0.18);
      guard = 0;
      while (h > minH && guard++ < 60 && overflows()) {
        h -= 10;
        ph.style.height = h + 'px';
        ph.style.flex = '0 0 ' + h + 'px';
      }
    }
  }

  // ---------- sources & freshness ----------
  function link(url, text) { return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text || url) + '</a>' : esc(text || ''); }
  function okBadge(ok) { return ok ? '<span class="ok">OK</span>' : '<span class="bad">Unavailable</span>'; }

  function sourcesPanel(call, st) {
    var t = data.terminal || {}, a = data.ais || {}, h, k;
    h = '<div id="sources" class="sources' + (sourcesOpen ? '' : ' closed') + '"><div class="inner">';
    h += '<h2>Sources &amp; freshness</h2><p class="muted">The terminal’s own sailing list decides what is at the berth. AIS is used only to corroborate. All times are Rijeka local time (Europe/Zagreb).</p>';

    h += '<h3>Berth occupancy</h3><table><tr><th>Source</th><th>State</th><th>Last successful read</th><th>Notes</th></tr>';
    h += '<tr><td>' + link(t.url, 'AGCT sailing list (official)') + '</td><td>' + okBadge(t.ok) + '</td><td>' + (t.fetched_at ? fmtDayTime(t.fetched_at) + ' (' + ago(t.fetched_at) + ')' : 'never') + '</td><td>' +
      (t.error ? 'Last attempt ' + fmtDayTime(t.last_attempt_at) + ' failed: ' + esc(t.error) : (t.rows || 0) + ' calls listed') +
      (data.next_check_at ? '<br>Next check planned ' + fmtDayTime(data.next_check_at) + (data.next_check_reason ? ' (' + esc(data.next_check_reason) + ')' : '') : '') +
      (st.stale && !st.never ? '<br><b>A planned check is overdue: occupancy shown as unconfirmed.</b>' : '') + '</td></tr>';
    for (k in a) {
      if (!a.hasOwnProperty(k)) continue;
      var s = a[k];
      h += '<tr><td>' + link(s.url, s.name + ' (AIS)') + '</td><td>' + okBadge(s.ok) + '</td><td>' + (s.fetched_at ? fmtDayTime(s.fetched_at) + ' (' + ago(s.fetched_at) + ')' : 'never') + '</td><td>' +
        esc(s.error ? 'Error: ' + s.error : (s.note || s.summary || '')) + '</td></tr>';
    }
    h += '</table>';

    if (call) {
      h += '<h3>' + esc(call.name) + ' — this call</h3><table><tr><th>Item</th><th>Value</th><th>Kind</th><th>Source</th></tr>';
      h += '<tr><td>Terminal record</td><td>' + esc(call.status || '') + ' · ETA ' + (fmtDayTime(call.eta) || '—') + ' · ATA ' + (fmtDayTime(call.ata) || '—') + ' · ETD ' + (fmtDayTime(call.etd) || '—') + ' · ATD ' + (fmtDayTime(call.atd) || '—') + '</td><td>Official</td><td>' + link(t.url, 'AGCT') + '</td></tr>';
      var ai = call.ais;
      if (ai) {
        h += '<tr><td>AIS check</td><td>' + (ai.found
          ? 'Seen ' + (ai.distance_km != null ? ai.distance_km + ' km from the Rijeka reference point' : 'near Rijeka') + (ai.nav ? ' · ' + esc(ai.nav) : '') +
            (ai.last_report ? ' · last AIS report ' + fmtDayTime(toLocal(ai.last_report)) : ' · within the last 24 h') +
            (ai.destination_raw ? ' · destination “' + esc(ai.destination_raw) + '”' : '')
          : 'Not found in the AIS list (not evidence of absence)') +
          (call.corroboration ? '<br><span class="muted">' + esc(call.corroboration.note) + '</span>' : '') +
          (ai.identity_warning ? '<br><b>' + esc(ai.identity_warning) + '</b>' : '') +
          '</td><td>AIS · checked ' + fmtDayTime(ai.checked_at) + '</td><td>' + link(ai.source_url, ai.source) + '</td></tr>';
      }
      var tr = call.trail;
      if (tr && tr.fetched_at) {
        h += '<tr><td>AIS position &amp; port calls</td><td>' + (tr.identity_warning ? '<b>' + esc(tr.identity_warning) + '</b>' :
          (tr.position ? (tr.quay_distance_km < 1 ? Math.round(tr.quay_distance_km * 1000) + ' m' : tr.quay_distance_km + ' km') + ' from the Brajdica quay' + (tr.position.status ? ' \u00b7 ' + esc(tr.position.status) : '') : 'No position') +
          (tr.last_heard ? ' \u00b7 last heard ' + fmtDayTime(toLocal(tr.last_heard)) : '') +
          (tr.destination_raw ? ' \u00b7 crew-entered destination \u201c' + esc(tr.destination_raw) + '\u201d' : '') +
          (tr.still_in_port ? '<br><span class="muted">Still in ' + esc(tr.still_in_port.name) + ': previous port not yet determined.</span>' : '')) +
          '</td><td>AIS \u00b7 checked ' + fmtDayTime(tr.fetched_at) + '</td><td>' + link(tr.source_url, 'Shiptrail') + '</td></tr>';
      }
      var vy = call.voyage || {};
      var legs = [['Previous port', vy.previous_port, 'departed_at'], ['Next port', vy.next_port, 'eta']];
      for (var i = 0; i < legs.length; i++) {
        var lg = legs[i][1];
        h += '<tr><td>' + legs[i][0] + '</td><td>' + (lg && lg.name ? esc(lg.name) + (lg[legs[i][2]] ? ' · ' + fmtDayTime(lg[legs[i][2]]) : '') : '<span class="muted">not established</span>') +
          '</td><td>' + (lg && lg.name ? esc(KIND[lg.kind] || lg.kind || '') + ' · confidence ' + esc(lg.confidence || '?') : '') + '</td><td>' + (lg && lg.name ? link(lg.source_url, lg.source) : '') + '</td></tr>';
      }
      if (vy.notes) h += '<tr><td>Voyage notes</td><td colspan="3">' + esc(vy.notes) + '</td></tr>';
      h += '</table>';

      var p = call.profile;
      if (p) {
        h += '<h3>Vessel profile' + (p.imo ? ' · IMO ' + esc(p.imo) : '') + (p.mmsi ? ' · MMSI ' + esc(p.mmsi) : '') + '</h3>';
        h += '<table><tr><th>Field</th><th>Value</th><th>Source</th><th>Retrieved</th><th>Confidence</th></tr>';
        for (k in p.fields) {
          if (!p.fields.hasOwnProperty(k)) continue;
          var f = p.fields[k];
          h += '<tr><td>' + esc(k.replace(/_/g, ' ')) + '</td><td>' + esc(f.value) + (f.note ? '<br><span class="muted">' + esc(f.note) + '</span>' : '') + '</td><td>' + link(f.source_url, f.source) + '</td><td>' + (fmtDay(f.retrieved_at) || esc(f.retrieved_at || '')) + '</td><td>' + esc(f.confidence || '') + '</td></tr>';
        }
        h += '</table>';
        if (p.photo) h += '<p>Photograph: “' + esc(p.photo.title || '') + '” by ' + esc(p.photo.author || 'unknown') + ', ' + link(p.photo.license_url, p.photo.license) + ', via ' + link(p.photo.source_url, p.photo.source_name || 'source') + '.</p>';
        else h += '<p class="muted">No freely licensed photograph has been found for this vessel.</p>';
        if (p.facts && p.facts.length) {
          h += '<h3>Notes</h3>';
          for (var j = 0; j < p.facts.length; j++) h += '<p>' + esc(p.facts[j].text) + ' <span class="muted">(' + link(p.facts[j].source_url, p.facts[j].source || 'source') + ', confidence ' + esc(p.facts[j].confidence || '?') + ')</span></p>';
        }
        if (p.research) h += '<p class="muted">Research status: ' + esc(p.research.status) + (p.research.researched_at ? ', ' + fmtDay(p.research.researched_at) : '') + (p.research.missing && p.research.missing.length ? ' · not found: ' + esc(p.research.missing.join(', ')) : '') + (p.research.notes ? ' · ' + esc(p.research.notes) : '') + '</p>';
      }
    }

    var up = data.upcoming || [], dep = data.recent_departures || [];
    if (up.length) {
      h += '<h3>Upcoming calls (terminal schedule)</h3><table><tr><th>Vessel</th><th>ETA</th><th>ETD</th><th>Status</th></tr>';
      for (i = 0; i < up.length; i++) h += '<tr><td>' + esc(up[i].name) + '</td><td>' + fmtDayTime(up[i].eta) + '</td><td>' + fmtDayTime(up[i].etd) + '</td><td>' + esc(up[i].status || '') + '</td></tr>';
      h += '</table>';
    }
    if (dep.length) {
      h += '<h3>Recent departures</h3><table><tr><th>Vessel</th><th>Arrived</th><th>Departed</th></tr>';
      for (i = 0; i < dep.length; i++) h += '<tr><td>' + esc(dep[i].name) + '</td><td>' + fmtDayTime(dep[i].ata) + '</td><td>' + fmtDayTime(dep[i].atd) + '</td></tr>';
      h += '</table>';
    }
    h += '<p class="muted" style="margin-top:22px">Page data generated ' + fmtDayTime(data.generated_at) + '. Full history: <a href="data/calls.json">calls.json</a> · <a href="data/log.json">update log</a>.</p>';
    return h + '</div></div>';
  }

  /* AIS report times are stored in UTC; show them in Rijeka time using the
     offset of the status file itself (good enough within one hour of a DST change). */
  function toLocal(isoUtc) {
    var p = parts(isoUtc), g = /([+-])(\d{2}):(\d{2})$/.exec(data.generated_at || '');
    if (!p || !g) return isoUtc;
    var off = (g[1] === '-' ? -1 : 1) * (parseInt(g[2], 10) * 60 + parseInt(g[3], 10));
    var d = new Date(p.ms + off * 60000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':00' + g[0];
  }

  // ---------- timers ----------
  refresh();
  setInterval(refresh, POLL_MS[mode]);
  setInterval(function () { render(false); }, 60 * 1000); // ages, staleness
  if (mode === 'colour') {
    setInterval(function () {
      if (data && data.berth && data.berth.vessels && data.berth.vessels.length > 1 && !sourcesOpen) { rotateIndex++; render(false); }
    }, ROTATE_MS);
  }
  var resizeTimer = null;
  window.onresize = function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitName, 150); };
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(fitName);
})();
