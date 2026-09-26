#!/usr/bin/env bash
# Continue the post-archive, non-destructive organizer phases with hard gates.

set -uo pipefail

PROJECT=/root/private_data/LiteraryGiant
CATALOG="$PROJECT/Library/Noise/.state/catalog.sqlite3"
ARCHIVE_ROOT="$PROJECT/Library/Noise"
STATE="$PROJECT/runs/.state/postarchive-supervisor-20260718"
LOG="$STATE/supervisor.log"
STATUS="$STATE/status"

SCAN_RUN=front6-postarchive-incremental-scan-w7-20260717
QUALITY_DRY_RUN=front6-quality-revalidate-dry-v1-20260718
QUALITY_APPLY_RUN=front6-quality-revalidate-apply-v1-20260718
DRAFT_RUN=front6-postarchive-draft-plan-v1-20260718
FINAL_RUN=front6-postarchive-final-plan-v1-20260718

mkdir -p "$STATE"
exec 9>"$STATE/lock"
if ! flock -n 9; then
    printf '%s duplicate-supervisor-refused\n' "$(date -u +%FT%TZ)" >"$STATUS"
    exit 90
fi

cd "$PROJECT" || exit 91

set_status() {
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >"$STATUS"
}

run_status() {
    sqlite3 -readonly "$CATALOG" \
        "SELECT status FROM runs WHERE run_id='$1';" 2>/dev/null
}

fail() {
    set_status "failed:$1"
    printf '%s FAIL %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
    exit 1
}

run_required() {
    local label=$1
    local output=$2
    shift 2
    set_status "running:$label"
    printf '%s START %s\n' "$(date -u +%FT%TZ)" "$label" >>"$LOG"
    if ! PYTHONUNBUFFERED=1 "$@" >"$output" 2>>"$LOG"; then
        fail "$label"
    fi
    printf '%s COMPLETE %s\n' "$(date -u +%FT%TZ)" "$label" >>"$LOG"
}

set_status "waiting:$SCAN_RUN"
while :; do
    scan_status=$(run_status "$SCAN_RUN")
    case "$scan_status" in
        complete) break ;;
        running|'') sleep 20 ;;
        *) fail "scan-status-$scan_status" ;;
    esac
done

scan_unresolved=$(sqlite3 -readonly "$CATALOG" \
    "SELECT COALESCE(json_extract(summary_json,'$.unresolved'),-1) FROM runs WHERE run_id='$SCAN_RUN';")
if [[ "$scan_unresolved" != 0 ]]; then
    fail "scan-unresolved-$scan_unresolved"
fi

run_required quality-dry-run "$STATE/quality-dry-run.json" \
    python scripts/organize_local_novels.py \
        --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
        revalidate-quarantine --workers 7 \
        --max-literal-replacement-rate 0.0002 --run-id "$QUALITY_DRY_RUN"

run_required quality-apply "$STATE/quality-apply.json" \
    python scripts/organize_local_novels.py \
        --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
        revalidate-quarantine --workers 7 \
        --max-literal-replacement-rate 0.0002 --run-id "$QUALITY_APPLY_RUN" --apply

quality_gate=$(sqlite3 -readonly "$CATALOG" \
    "SELECT status || '|' || COALESCE(json_extract(summary_json,'$.unresolved'),-1) || '|' || COALESCE(json_extract(summary_json,'$.remaining'),-1) FROM runs WHERE run_id='$QUALITY_APPLY_RUN';")
if [[ "$quality_gate" != 'complete|0|0' ]]; then
    fail "quality-gate-$quality_gate"
fi

run_required draft-plan "$STATE/draft-plan.json" \
    python scripts/organize_local_novels.py \
        --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
        plan --run-id "$DRAFT_RUN" --draft \
        --minimum-fuzzy-chars 50000 --same-edition-containment 0.96 \
        --same-work-containment 0.92 --max-candidate-pair-rows 25000000

metadata_complete=0
for attempt in 1 2 3; do
    llm_run="front6-postarchive-metadata-hard-v1-a${attempt}-20260718"
    set_status "running:metadata-attempt-$attempt"
    printf '%s START metadata-attempt-%s\n' "$(date -u +%FT%TZ)" "$attempt" >>"$LOG"
    PYTHONUNBUFFERED=1 python scripts/organize_local_novels.py \
        --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
        enrich-metadata --model novel-metadata \
        --base-url http://127.0.0.1:8000/v1 \
        --title-confidence-below 0.80 --genre-confidence-below 0.55 \
        --accept-confidence 0.72 --batch-size 48 --items-per-request 2 \
        --candidate-mode difficult --representative-plan-run-id "$DRAFT_RUN" \
        --run-id "$llm_run" \
        >"$STATE/metadata-attempt-$attempt.json" 2>>"$LOG"
    llm_status=$(run_status "$llm_run")
    printf '%s END metadata-attempt-%s status=%s\n' \
        "$(date -u +%FT%TZ)" "$attempt" "$llm_status" >>"$LOG"
    if [[ "$llm_status" == complete ]]; then
        metadata_complete=1
        break
    fi
    if [[ "$llm_status" != partial ]]; then
        fail "metadata-attempt-$attempt-status-$llm_status"
    fi
done
if [[ "$metadata_complete" != 1 ]]; then
    fail metadata-retries-exhausted
fi

run_required final-plan "$STATE/final-plan.json" \
    python scripts/organize_local_novels.py \
        --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
        plan --run-id "$FINAL_RUN" \
        --minimum-fuzzy-chars 50000 --same-edition-containment 0.96 \
        --same-work-containment 0.92 --max-candidate-pair-rows 25000000

python - "$CATALOG" "$FINAL_RUN" "$STATE/final-plan-gate.json" <<'PY'
import json
import sqlite3
import sys
from pathlib import Path

catalog_path, run_id, output = sys.argv[1:]
connection = sqlite3.connect(f"file:{catalog_path}?mode=ro", uri=True)
row = connection.execute(
    "SELECT status, summary_json FROM runs WHERE run_id=?", (run_id,)
).fetchone()
if row is None or row[0] != "complete":
    raise SystemExit("final plan is not complete")
summary = json.loads(row[1])
active = connection.execute(
    "SELECT COUNT(*) FROM files WHERE scan_status IN ('ok','invalid','quarantine')"
).fetchone()[0]
planned = connection.execute(
    "SELECT COUNT(*) FROM plan_files WHERE plan_run_id=?", (run_id,)
).fetchone()[0]
actions = connection.execute(
    "SELECT json_extract(row_json,'$.planned_action'), COUNT(*) "
    "FROM plan_files WHERE plan_run_id=? GROUP BY 1", (run_id,)
).fetchall()
if summary.get("draft") is not False or planned != active or planned != summary.get("planned_files"):
    raise SystemExit(
        f"final plan count gate failed: active={active}, planned={planned}, "
        f"summary={summary.get('planned_files')}"
    )
payload = {
    "run_id": run_id,
    "active_files": active,
    "planned_files": planned,
    "actions": dict(actions),
    "works": summary.get("works"),
    "editions": summary.get("editions"),
}
Path(output).write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
PY
if [[ $? != 0 ]]; then
    fail final-plan-gate
fi

set_status "complete:ready-for-id-map-snapshot-smoke"
printf '%s COMPLETE ready-for-id-map-snapshot-smoke\n' "$(date -u +%FT%TZ)" >>"$LOG"
