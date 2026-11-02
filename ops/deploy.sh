#!/usr/bin/env bash
set -euo pipefail
umask 077
component=${1:?component required}
revision=${2:?commit SHA required}
[[ "$component" =~ ^(backend|frontend)$ && "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
root=/data/science-evaluation
exec 9>"$root/deploy.lock"
flock -w 600 9
release=$(mktemp -d "$root/releases/$component/$revision.XXXXXX")
tar --extract --gzip --no-same-owner --file=- --directory="$release"
printf '%s\n' "$revision" > "$release/REVISION"
if [[ "$component" == backend ]]; then
  (cd "$release" && npm ci --omit=dev --no-audit --no-fund)
  # Never restart an evaluator while it is executing, scoring, or generating a report.
  cd "$release"
  node --env-file="$root/shared/backend.env" - <<'JS'
const { Pool } = require('pg');
(async () => { const pool = new Pool({connectionString: process.env.EVALUATION_DATABASE_URL}); try {
  const r = await pool.query("SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE status IN ('queued','running','scoring')");
  const reports = await pool.query("SELECT count(*)::int AS n FROM evaluation_daily_reports WHERE status='generating'");
  if(r.rows[0].n || reports.rows[0].n) throw Error('Active evaluations or reports: deployment deferred; rerun after completion');
} finally { await pool.end(); } })().catch(e => { console.error(e.message); process.exitCode = 1; });
JS
  url=http://127.0.0.1:7714/health
else
  if [[ ! -f "$release/server.js" ]]; then
    (cd "$release"
      export NEXT_TELEMETRY_DISABLED=1
      npx --yes yarn@1.22.22 install --frozen-lockfile
      npx --yes yarn@1.22.22 build
      test -f .next/standalone/server.js
      if [[ -d public ]]; then cp -r public .next/standalone/; fi
      cp -r .next/static .next/standalone/.next/
      printf "require('./.next/standalone/server.js');\n" > server.js
    )
  fi
  url=http://127.0.0.1:1101/login
fi
old=
if [[ -L "$root/current-$component" ]]; then old=$(readlink -f "$root/current-$component"); fi
ln -sfn "$release" "$root/next-$component"
mv -Tf "$root/next-$component" "$root/current-$component"
if sudo /usr/bin/systemctl restart "science-evaluation-$component.service"; then
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 "$url" >/dev/null; then
    if [[ -n "$old" ]]; then ln -sfn "$old" "$root/previous-$component"; fi
    echo "Deployed $component $revision"
    exit 0
  fi
  sleep 2
done
fi
if [[ -n "$old" ]]; then
  ln -s "$old" "$root/rollback-$component"
  mv -Tf "$root/rollback-$component" "$root/current-$component"
  sudo /usr/bin/systemctl restart "science-evaluation-$component.service"
else
  sudo /usr/bin/systemctl stop "science-evaluation-$component.service"
fi
echo 'Health check failed; restored previous release when available' >&2
exit 1
