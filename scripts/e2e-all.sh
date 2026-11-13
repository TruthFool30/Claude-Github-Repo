#!/usr/bin/env bash
# Run every Playwright e2e script, each against its own freshly seeded production server.
#   npm run build && scripts/e2e-all.sh            # all scripts
#   scripts/e2e-all.sh e2e-budget e2e-import       # just these
# Needs the client built (npm run build) and Chromium for Playwright (npx playwright install chromium,
# or CHROMIUM=/path/to/chrome). Exits non-zero if any script fails and prints its log and the server log.
set -u
cd "$(dirname "$0")/.."
scripts=("$@")
[ ${#scripts[@]} -eq 0 ] && scripts=($(ls scripts/e2e-*.mjs | xargs -n1 basename | sed 's/\.mjs$//'))
port=${E2E_PORT:-4900}
failed=()
for s in "${scripts[@]}"; do
  port=$((port + 1))
  dir=$(mktemp -d)
  # e2e-foundation checks the login rate limit (429), so it runs with limits on; the others turn them off.
  if [ "$s" = e2e-foundation ]; then limits=on; else limits=off; fi
  DB_PATH="$dir/hearth.db" UPLOAD_DIR="$dir/uploads" npm run seed >"$dir/seed.log" 2>&1
  DB_PATH="$dir/hearth.db" UPLOAD_DIR="$dir/uploads" PORT=$port HEARTH_RATE_LIMITS=$limits \
    node --disable-warning=ExperimentalWarning server/src/index.js >"$dir/server.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do curl -sf "http://localhost:$port/api/health" >/dev/null && break; sleep 0.5; done
  start=$SECONDS
  if BASE="http://localhost:$port" SHOTS="$dir/shots" timeout 900 node "scripts/$s.mjs" >"$dir/e2e.log" 2>&1; then
    echo "ok   $s ($((SECONDS - start))s)"
  else
    echo "FAIL $s ($((SECONDS - start))s)"
    failed+=("$s")
    echo "----- $s output -----"; tail -n 60 "$dir/e2e.log"
    echo "----- $s server log -----"; tail -n 40 "$dir/server.log"
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -rf "$dir"
done
if [ ${#failed[@]} -gt 0 ]; then echo "Failed: ${failed[*]}"; exit 1; fi
echo "All ${#scripts[@]} e2e scripts passed."
