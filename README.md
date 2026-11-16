# Brajdica Watch

A wall display for the container ship currently alongside at the Brajdica / Adriatic Gate
Container Terminal in Rijeka. One static page, kept current by a free GitHub Actions
job every 15 minutes, with a Claude Code cloud task researching each new ship. No server, no database, no AIS receiver.

- **Display:** `https://danielmoneta.github.io/ship-watch/` (GitHub Pages, `main` branch, `/docs` folder)
- **E-ink:** add `?mode=eink` &nbsp;·&nbsp; **Colour:** `?mode=colour` (the choice is remembered on the device)

## How it works

```
 GitHub Actions, every 15 min ─► node scripts/update.mjs ─► docs/data/*.json ─► commit to main ─► GitHub Pages
 (no AI, free)                    terminal list + AIS check   (only when changed,                      │
        │                                                      or hourly heartbeat)                     ▼
        │ new ship needs research                                             wall tablet / e-ink re-reads
        ▼                                                                     status.json every 5–10 min
 Claude Code cloud task ─► web research ─► vessels/<IMO>.json, photos/, voyages.json ─► commit to main
 (follows AUTOMATION.md)
```

1. **`.github/workflows/update.yml`** runs `scripts/update.mjs` (plain Node, no dependencies) every
   15 minutes: it fetches the official [AGCT sailing list](https://webusercorner.ictsi.hr/?language=EN),
   compares it with the stored state, records arrivals/departures, checks AIS, and writes the JSON the
   page reads. It commits only when something changed, plus one heartbeat an hour.
2. **Claude** is used only for judgement: identifying and researching a ship the first time it appears
   and finding a properly licensed photo. The workflow starts that task through its API trigger
   (`scripts/fire-research.mjs`) when `research_needed` is non-empty; the task also runs on a slow
   schedule as a safety net. The two never edit the same files.
3. **GitHub Pages** republishes on every push. The page polls `data/status.json` itself.

### Who decides what is at the berth
The terminal list, and only the terminal list: a call with an ATA and no ATD is alongside.
AIS (Wingo Marine) is recorded next to it as corroboration — "consistent with the quay", "not found",
"stale", or "conflict" — and never changes occupancy. A ship whose AIS destination is Rijeka stays
"expected" until the terminal gives it an ATA. AIS-catcher currently has no receiver coverage of
Brajdica, so its zero count is logged and ignored.

If the terminal cannot be read, the last verified state is kept and the failure logged; once a planned
check is well overdue the page switches to **"Occupancy unconfirmed"**.

## Data (all in `docs/data/`, published with the site)

| File | Contents |
|---|---|
| `status.json` | What the page shows: berth state, vessels alongside (with profile), upcoming calls, recent departures, source freshness |
| `calls.json` | Every call seen, keyed `NAME\|arrival voyage`: ETA/ETD/ATA/ATD, status, AIS check. Completed calls are the visit history |
| `voyages.json` | Researched previous/next port per call, each labelled actual / scheduled / AIS destination / estimate |
| `vessels/<IMO>.json` | Cached vessel profile. Every field carries `value, source, source_url, retrieved_at, confidence` |
| `vessels/index.json` | Vessel name → IMO |
| `photos/` | Licensed photographs (Wikimedia Commons), attribution stored in the profile |
| `log.json` | Last 500 published runs (with errors) and last 500 events |
| `automation.json` | When research was last requested from Claude |

Profiles are cached by IMO: a returning ship is not researched again. Partial profiles (e.g. no free
photo exists) are retried after 14 days; complete ones after a year.

## Automation

| Piece | Where | When | Cost |
|---|---|---|---|
| **Update berth data** workflow | GitHub → Actions tab | every 15 min (GitHub may delay runs by a few minutes) | free on a public repo |
| **Brajdica Watch – research** task | <https://claude.ai/code/routines> | when the workflow calls it, plus every 6 hours as a safety net | Claude subscription allowance |

**Connecting the two (one-time).** In the Claude task's *Edit* dialog add an **API** trigger, copy the
*Fire URL* and generate a token. Save them in GitHub under *Settings → Secrets and variables → Actions*
as `CLAUDE_FIRE_URL` and `CLAUDE_FIRE_TOKEN`. Without the secrets everything still works; research
simply waits for the task's next scheduled run. The workflow asks at most once per new need and
retries after 6 hours (`docs/data/automation.json` records the last request).

The Claude task's whole prompt is "follow `AUTOMATION.md`" — edit that file to change what it does.
It runs in the cloud environment `ship-watch`, which allow-lists the reference and Wikimedia hosts.

**Staleness.** `status.json` is republished at least hourly. The page turns to
**"Occupancy unconfirmed"** when the file is about 2 h 40 min old, i.e. when the workflow has stopped.

**Cost.** Pages, Actions and the repository are free. Claude usage is a handful of near-empty safety-net
runs a day plus one research run per new ship (a few a week).

**Limits worth knowing**
- GitHub disables scheduled workflows in public repos after 60 days without repository activity. This
  workflow commits at least hourly, which counts as activity; if it is ever disabled, re-enable it on the Actions tab.
- Run the workflow by hand from the Actions tab (*Run workflow*; tick *force* to publish regardless).
- The terminal's ETAs are shift-slot placeholders (06:30 / 14:30 / 22:30); real arrivals differ by hours.
  Polling every 15 minutes makes that irrelevant.
- Claude scheduled tasks and their API trigger are research-preview features and may change.
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
