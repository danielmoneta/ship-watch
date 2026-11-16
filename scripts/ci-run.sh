#!/usr/bin/env bash
# One update cycle on the GitHub runner: sync, read terminal + AIS, maybe start research, publish.
# Usage: scripts/ci-run.sh [--refresh] [--force]
set -uo pipefail
REFRESH=""; FORCE="false"
for a in "$@"; do case "$a" in --refresh) REFRESH="--refresh";; --force) FORCE="true";; esac; done
TMP="${RUNNER_TEMP:-/tmp}"

git fetch -q origin main && git reset -q --hard origin/main || { echo "sync failed"; exit 1; }

node scripts/update.mjs $REFRESH > "$TMP/summary.json" || { echo "update.mjs crashed"; cat "$TMP/summary.json"; exit 1; }
node -e "const s=require('$TMP/summary.json');console.log(new Date().toISOString(), 'berth:', s.at_berth.map(v=>v.name).join(' + ')||'clear', '| events:', s.events.length, '| research:', s.research_needed.map(n=>n.name).join(', ')||'-', '| publish:', s.publish_reason, '| errors:', s.errors.join('; ')||'-')"

node scripts/fire-research.mjs "$TMP/summary.json" | tee "$TMP/fire.txt"
FIRED="false"; grep -q '^FIRED=1' "$TMP/fire.txt" && FIRED="true"

PUBLISH=$(node -p "require('$TMP/summary.json').publish")
if [ "$PUBLISH" != "true" ] && [ "$FIRED" != "true" ] && [ "$FORCE" != "true" ]; then
  echo "No change since the last publish; nothing to commit."
  git reset -q --hard origin/main
  exit 0
fi
node scripts/validate.mjs || { git reset -q --hard origin/main; exit 1; }
MSG=$(node -e "
  const s = require('$TMP/summary.json');
  const ev = s.events.filter(e => ['arrived','departed'].includes(e.type)).map(e => e.name + ' ' + e.type);
  const berth = s.at_berth.map(v => v.name).join(' + ') || 'berth clear';
  console.log('data: ' + (!s.terminal_ok ? 'terminal unreachable, last state kept' : ev.length ? ev.join(', ') : berth + (s.publish_reason === 'heartbeat' ? ' (heartbeat)' : '')));")
git config user.name "brajdica-watch[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add docs/data
git commit -q -m "$MSG" || { echo "nothing to commit"; exit 0; }
for i in 1 2 3; do
  git push -q origin HEAD:main && { echo "published: $MSG"; exit 0; }
  git pull -q --rebase origin main
done
echo "push failed"; git reset -q --hard origin/main; exit 1
