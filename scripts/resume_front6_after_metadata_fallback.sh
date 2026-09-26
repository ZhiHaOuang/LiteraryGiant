#!/usr/bin/env bash
# Resume the frozen front6 workflow after bounded manual review of the two
# persistent vLLM response omissions.

set -uo pipefail
PROJECT=/root/private_data/LiteraryGiant
CATALOG="$PROJECT/Library/Noise/.state/catalog.sqlite3"
ARCHIVE_ROOT="$PROJECT/Library/Noise"
STATE="$PROJECT/runs/.state/postarchive-supervisor-20260718"
STATUS="$STATE/status"
LOG="$STATE/supervisor.log"
FINAL_RUN=front6-postarchive-final-plan-v1-20260718
REVIEW_RUN=front6-manual-metadata-fallback-review-v1-20260718

cd "$PROJECT" || exit 91
exec 9>"$STATE/resume.lock"
flock -n 9 || exit 90
set_status() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >"$STATUS"; }
fail() {
  set_status "failed:$1"
  printf '%s FAIL %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
  exit 1
}

review_gate=$(sqlite3 -readonly "$CATALOG" \
  "select status || '|' || coalesce(json_extract(summary_json,'$.unresolved'),-1) from runs where run_id='$REVIEW_RUN';")
[[ "$review_gate" == 'complete|0' ]] || fail "manual-review-gate-$review_gate"

set_status resuming:final-plan
printf '%s START resumed-final-plan\n' "$(date -u +%FT%TZ)" >>"$LOG"
if ! PYTHONUNBUFFERED=1 python scripts/organize_local_novels.py \
  --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
  plan --run-id "$FINAL_RUN" --minimum-fuzzy-chars 50000 \
  --same-edition-containment 0.96 --same-work-containment 0.92 \
  --max-candidate-pair-rows 25000000 \
  >"$STATE/final-plan.json" 2>>"$LOG"; then
  fail resumed-final-plan
fi

python - "$CATALOG" "$FINAL_RUN" "$STATE/final-plan-gate.json" <<'PY' || fail final-plan-gate
import json, sqlite3, sys
from pathlib import Path
catalog_path, run_id, output = sys.argv[1:]
db = sqlite3.connect(f"file:{catalog_path}?mode=ro", uri=True)
row = db.execute("select status,summary_json from runs where run_id=?", (run_id,)).fetchone()
if row is None or row[0] != "complete": raise SystemExit("final plan incomplete")
summary = json.loads(row[1])
active = db.execute("select count(*) from files where scan_status in ('ok','invalid','quarantine')").fetchone()[0]
planned = db.execute("select count(*) from plan_files where plan_run_id=?", (run_id,)).fetchone()[0]
if summary.get("draft") is not False or active != planned or planned != summary.get("planned_files"):
    raise SystemExit(f"count mismatch active={active} planned={planned} summary={summary.get('planned_files')}")
Path(output).write_text(json.dumps({"active":active,"planned":planned,"summary":summary}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
PY

set_status complete:ready-for-id-map-snapshot-smoke
printf '%s COMPLETE resumed-final-plan\n' "$(date -u +%FT%TZ)" >>"$LOG"
