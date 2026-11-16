# Brajdica Watch — instructions for the unattended run

You are running as a scheduled cloud task with nobody watching. Follow these steps exactly,
do not ask questions, and keep the run short. All shell commands run from the repository root.

The repository owner has explicitly authorised this task to **commit and push directly to `main`**
of this repository (GitHub Pages publishes `main:/docs`). Never force-push. Never open a pull request.
Touch only files under `docs/data/`. Do not edit code, tests, the site or this file.

## Step 1 — Update from the terminal (always)

```bash
git checkout main && git pull --ff-only origin main
node scripts/update.mjs > /tmp/bw-summary.json; cat /tmp/bw-summary.json
```

The script reads the official AGCT sailing list (the authority on what is at the berth), checks
AIS, updates `docs/data/`, and prints a JSON summary. It never throws on a source outage: a failed
terminal read keeps the last verified state and is recorded in `errors` and `docs/data/log.json`.

Do **not** "fix" what the script reports by hand. In particular never mark a ship as arrived,
departed or alongside yourself: only the terminal list does that.

## Step 2 — Research (only if `research_needed` is non-empty)

If `research_needed` is `[]`, skip to Step 3. This is the normal case; do no web research at all.

Otherwise handle each entry (at most 3 per run; `at_berth` first). Budget: about 10 web lookups
per vessel. Stop when the budget is spent and record what is still missing.

### 2a. Identify the vessel
- If `imo` is null: find the IMO number for that exact vessel name. Require two independent sources
  that agree (e.g. VesselFinder search results, a carrier or port schedule, Wikidata). Container
  ship names are reused, so check that the candidate is a container ship currently trading in the
  Mediterranean/Adriatic for the line shown in the terminal list. If you cannot be sure, do not guess:
  leave it unidentified and say so in your final summary.
- When identified, add `"NAME": "IMO"` to `docs/data/vessels/index.json` (upper-case, single spaces)
  and create `docs/data/vessels/<IMO>.json`.

### 2b. Profile — `docs/data/vessels/<IMO>.json`
Sources that work from this environment (others are blocked by the network policy; use WebSearch
result summaries for anything else):
- `https://www.vesselfinder.com/vessels/details/<IMO>` — flag, year built, length overall, beam,
  gross tonnage, former names, **Last Port + ATD**, AIS destination + ETA.
- `https://wingo-marine.com/ship/<slug>-<MMSI>` — IMO/MMSI, call sign, AIS dimensions, last AIS report.
- Wikidata (`https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P458=<IMO>&format=json`)
  and English Wikipedia — builder, class, capacity. Wikimedia throttles this network: wait and retry on HTTP 429.
- WebSearch for TEU capacity, builder, class, notable history.

Rules:
- Every field is `{ "value", "source", "source_url", "retrieved_at", "confidence" }`.
  `retrieved_at` is now, as ISO 8601 with the Europe/Zagreb offset. `confidence` is:
  `high` = two independent sources agree, or one authoritative source (registry, class society, builder, owner);
  `medium` = one reputable tracking/database source; `low` = single weak or derived source (say why in `"note"`).
- Allowed field keys: `flag, type, year_built, length_m, beam_m, teu, gross_tonnage, deadweight_t,
  builder, operator, owner, callsign, former_names, class`. Numbers must be JSON numbers.
- **Never invent or estimate.** A field you could not source is omitted and listed in `research.missing`.
  When sources disagree, pick the better-supported value, lower the confidence and explain in `"note"`.
- `facts`: 0–3 short, sourced, genuinely interesting sentences (max 220 characters each), each
  `{ "text", "source", "source_url", "confidence" }`. No filler; none is fine.
- Finish with `research: { "status": "complete" | "partial", "researched_at": <now>, "missing": [...], "notes": "..." }`.
  Use `partial` whenever anything in `flag, year_built, length_m, beam_m, teu, photo` is missing.
  Partial profiles are retried automatically after 14 days; do not retry sooner.
- Keep an existing profile's good data. Add to it; replace a field only with a better-sourced value.

### 2c. Photograph
```bash
node scripts/commons.mjs search <IMO>            # files in Wikimedia Commons' IMO category (preferred)
node scripts/commons.mjs search "<SHIP NAME>"    # exact-phrase fallback
node scripts/commons.mjs fetch "File:<title>" <IMO>   # downloads to docs/data/photos/ and prints the photo block
```
- Use a photo only if its title, description or category shows it is **this ship** (same IMO; a photo
  under a former name is fine when the IMO category confirms it — then set `"caption": "Photographed as <FORMER NAME>, <year>"`).
  A sister ship, a namesake or "a similar vessel" is not acceptable.
- Prefer a clear landscape view of the whole ship, at least 1200 px wide.
- Only licences accepted by the fetch command (CC BY, CC BY-SA, CC0, public domain). Paste the block it
  prints into the profile as `"photo"`. Never hotlink or copy images from tracking or ship-spotting sites.
- No suitable image: set `"photo": null` and add `"photo"` to `research.missing`. That is a normal outcome.

### 2d. Voyage for this call — `docs/data/calls.json`, in the call named by `call_id`
Set `voyage` on the call:
```json
"voyage": {
  "researched_at": "<now>",
  "previous_port": { "name": "Trieste", "locode": "ITTRS", "departed_at": "<ISO or null>", "kind": "actual",
                     "source": "VesselFinder (AIS port call)", "source_url": "...", "retrieved_at": "<now>", "confidence": "medium" },
  "next_port": { "name": "Koper", "locode": "SIKOP", "eta": "<ISO or null>", "kind": "scheduled",
                 "source": "...", "source_url": "...", "retrieved_at": "<now>", "confidence": "medium" },
  "notes": "optional"
}
```
Keep these four things strictly apart — `kind` says which one it is:
- `actual` — a port call that happened, recorded by AIS port-call data or a port authority
  (e.g. VesselFinder "Last Port … ATD"). Only this may be shown as the previous port.
  If "Last Port" already says Rijeka, the ship has arrived and that source no longer shows where she
  came from: use another source or set `previous_port` to `null`.
- `scheduled` — published by the carrier, a terminal or a port schedule.
- `ais_destination` — typed into the AIS transponder by the crew. Often abbreviated, sometimes stale.
- `estimate` — anything inferred (e.g. from the usual rotation of the service). Use sparingly, confidence `low`.

A ship whose AIS destination is Rijeka is *bound for* Rijeka. It is not evidence that she is at Brajdica.
Unknown is a valid answer: set the leg to `null`. Times from sources in UTC must be converted to
Europe/Zagreb and written with the offset. Always set `researched_at`, even when both legs are `null`
(it stops the same question being researched every hour).

### 2e. Rebuild and check
```bash
node scripts/update.mjs --rebuild > /dev/null && node scripts/validate.mjs
```
Fix anything `validate` reports in the files you wrote, then run both again. If you cannot make
validation pass, undo your research edits (`git checkout -- docs/data/vessels docs/data/calls.json`,
delete new untracked files in `docs/data/vessels` and `docs/data/photos`), run the rebuild again, and
report the problem in your final summary.

## Step 3 — Publish (always)

```bash
node scripts/validate.mjs && git add docs/data && git commit -q -m "<message>" && git push origin HEAD:main
```
Commit message: `data: <what happened>` — e.g. `data: hourly check, MSC TERESA alongside`,
`data: MSC EAGLE III arrived 15:20; profile researched`, `data: terminal unreachable, last state kept`.
`status.json` changes on every run (it carries the verification time), so there is always something to commit.

If the repository is not in your working directory, say so in your report and stop: do not improvise.
If the push is rejected because `main` moved: `git pull --rebase origin main`, then push again (up to 3 tries).
If validation fails at this point and you did no research, publish nothing and report the errors.

## Step 4 — Report

End with three lines at most: what is at the berth, what changed, and any errors or research gaps.
Do not create, change or fire any scheduled task, and do not send notifications.
