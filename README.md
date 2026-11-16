# Brajdica Watch

A wall display for the container ship currently alongside at the Brajdica / Adriatic Gate
Container Terminal in Rijeka. One static page, refreshed by an hourly unattended Claude Code
cloud task. No server, no database, no AIS receiver.

- **Display:** `https://danielmoneta.github.io/ship-watch/` (GitHub Pages, `main` branch, `/docs` folder)
- **E-ink:** add `?mode=eink` &nbsp;·&nbsp; **Colour:** `?mode=colour` (the choice is remembered on the device)

## How it works

```
 hourly Claude Code cloud task  ──►  node scripts/update.mjs  ──►  docs/data/*.json  ──►  git push main
 (reads AUTOMATION.md)               terminal list + AIS check      (state + history)      │
        │                                                                                   ▼
        └─ only when a ship is new: web research ─► docs/data/vessels/<IMO>.json     GitHub Pages
                                                                                            │
                                               wall tablet / e-ink re-reads status.json every 5–10 min
```

1. **`scripts/update.mjs`** (plain Node, no dependencies) does everything deterministic: fetches the
   official [AGCT sailing list](https://webusercorner.ictsi.hr/?language=EN), parses it, compares it with
   the stored state, records arrivals/departures, checks AIS, and writes the JSON the page reads.
2. **Claude** is only needed for judgement: identifying and researching a ship the first time it
   appears, and finding a properly licensed photo. On a normal hour it runs the script, commits and stops.
3. **GitHub Pages** republishes on every push. The page polls `data/status.json` itself.

### Who decides what is at the berth
The terminal list, and only the terminal list: a call with an ATA and no ATD is alongside.
AIS (Wingo Marine) is recorded next to it as corroboration — "consistent with the quay", "not found",
"stale", or "conflict" — and never changes occupancy. A ship whose AIS destination is Rijeka stays
"expected" until the terminal gives it an ATA. AIS-catcher currently has no receiver coverage of
Brajdica, so its zero count is logged and ignored.

If the terminal cannot be read, the last verified state is kept and the failure logged. Once the last
successful read is older than 3 hours the page switches to **"Occupancy unconfirmed"**.

## Data (all in `docs/data/`, published with the site)

| File | Contents |
|---|---|
| `status.json` | What the page shows: berth state, vessels alongside (with profile), upcoming calls, recent departures, source freshness |
| `calls.json` | Every call seen, keyed `NAME\|arrival voyage`: ETA/ETD/ATA/ATD, status, AIS check, researched voyage (previous/next port). Completed calls are the visit history |
| `vessels/<IMO>.json` | Cached vessel profile. Every field carries `value, source, source_url, retrieved_at, confidence` |
| `vessels/index.json` | Vessel name → IMO |
| `photos/` | Licensed photographs (Wikimedia Commons), attribution stored in the profile |
| `log.json` | Last 500 runs (with errors) and last 500 events |

Profiles are cached by IMO: a returning ship is not researched again. Partial profiles (e.g. no free
photo exists) are retried after 14 days; complete ones after a year.

## The scheduled task

Runs hourly in the Claude Code cloud environment `ship-watch` (which allow-lists the terminal, AIS and
Wikimedia hosts). Its whole prompt is "follow `AUTOMATION.md`" — edit that file to change its behaviour.
Manage it at <https://claude.ai/code/routines>: pause, run now, change the schedule or the model.

**Cost.** GitHub Pages and the repository are free. The task uses your Claude subscription allowance
(no separate bill): 24 short runs a day, plus a longer research run when a new ship appears (a few per
week). If that is more usage than you want, switch the task to a smaller model or to every 2–3 hours.

**Limits worth knowing**
- Cloud tasks cannot run more often than hourly, so an arrival can take up to an hour to appear
  (plus however long the terminal takes to post the ATA).
- Scheduled tasks are a research-preview feature. If the task stops, the page says so within 3 hours
  ("Occupancy unconfirmed") rather than showing stale data as current.
- The terminal's ETAs are shift-slot placeholders (06:30 / 14:30 / 22:30); real arrivals differ by hours.
  That is why checks are not timed around ETAs.
- Free sources rarely expose a ship's previous port after she has arrived; it is captured while she is
  still en route, otherwise shown as "not established".

## Run it yourself

```bash
npm test                        # parser, state-change and outage tests (fixtures + simulations)
node scripts/update.mjs         # one live update
node scripts/validate.mjs       # check data files
npm run serve                   # http://localhost:8080
node scripts/make-demos.mjs     # regenerate simulated states
```

Simulated states (labelled with a red ribbon): `?demo=empty`, `?demo=stale`, `?demo=two`,
`?demo=unidentified`, `?demo=photo`.

## Changing the design

Everything visual is in two files; no build step.

- **`docs/assets/style.css`** — colours, type, layout. The palette is listed at the top; colour mode
  rules come first, the `body.eink …` block at the bottom restyles the same markup for e-paper.
  Fonts are set in `docs/index.html` (Google Fonts link) and the `font-family` lines.
- **`docs/assets/app.js`** — what is shown. `placard()` is the order of the blocks; `specs()` picks the
  (up to six) specification tiles; `routeBlock()` and `timesBlock()` the route and times; `fitName()` sizes
  the ship's name. Polling intervals are at the top (`POLL_MS`).
- After changing either file, bump the `?v=1` on the two asset links in `index.html` so displays reload them.
- Preview with `npm run serve` and the `?demo=` states. Pushing to `main` publishes.

## Wall display set-up

- **Android tablet:** install *Fully Kiosk Browser*, set the start URL, enable "Keep screen on". Or in
  Chrome: menu → *Add to Home screen*, then pin the app (Settings → Security → App pinning).
- **iPad:** Safari → Share → *Add to Home Screen* (opens full-screen), then Settings → Accessibility →
  *Guided Access* to lock it; set Auto-Lock to Never.
- **Desktop / Raspberry Pi:** `chromium --kiosk https://danielmoneta.github.io/ship-watch/`
- **E-ink (Boox, Kindle browser, Kobo, TRMNL-style frames):** open `…/ship-watch/?mode=eink`. Add
  `&photo=1` for a greyscale photo. The page only redraws when the data changes, to avoid flashing.
  Disable the device's sleep/screensaver; on readers that suspend Wi-Fi the page updates when they wake.
- The page re-reads the data every 5 min (colour) / 10 min (e-ink) and fully reloads every 6 hours.
  The device clock must be roughly right: staleness is judged against it.
