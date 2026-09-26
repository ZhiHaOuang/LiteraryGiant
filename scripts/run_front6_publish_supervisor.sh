#!/usr/bin/env bash
# Continue automatically from the completed post-archive plan through a
# low-cost copy smoke, guarded streaming move, full verification, ID mapping,
# and non-destructive upstream reindex staging.

set -uo pipefail

PROJECT=/root/private_data/LiteraryGiant
CATALOG="$PROJECT/Library/Noise/.state/catalog.sqlite3"
ARCHIVE_ROOT="$PROJECT/Library/Noise"
PHASE1="$PROJECT/runs/.state/postarchive-supervisor-20260718"
STATE="$PROJECT/runs/.state/publish-supervisor-20260718"
STATUS="$STATE/status"
LOG="$STATE/supervisor.log"
FINAL_RUN=front6-postarchive-final-plan-v1-20260718
SNAPSHOT="$STATE/pre-move-snapshot.json"
IMPORT_ROOT="$PROJECT/runs/existing-import-staging-20260717"
ID_MAP="$PROJECT/runs/post-merge-id-map-20260718.json"
ID_AUDIT="$PROJECT/runs/processed-id-map-audit-20260718"
REINDEX_PLAN="$PROJECT/runs/processed-reindex-plan-20260718"
REINDEX_STAGING="$PROJECT/runs/processed-reindex-staging-20260718"

SOURCES=(
  /public/home/actueuo6co/txt
  /public/home/actueuo6co/其他
  /public/home/actueuo6co/后宫
  /public/home/actueuo6co/小说合集2
  /public/home/actueuo6co/晋江
  /public/home/actueuo6co/武侠修真
  /public/home/actueuo6co/玄幻魔法
  /public/home/actueuo6co/科幻小说
  '/public/home/actueuo6co/笔趣阁全站网络小说合集 31w本'
  /public/home/actueuo6co/网游竞技
  "$IMPORT_ROOT"
)

mkdir -p "$STATE"
exec 9>"$STATE/lock"
if ! flock -n 9; then
  printf '%s duplicate-supervisor-refused\n' "$(date -u +%FT%TZ)" >"$STATUS"
  exit 90
fi

cd "$PROJECT" || exit 91

set_status() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >"$STATUS"; }
fail() {
  set_status "failed:$1"
  printf '%s FAIL %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"
  exit 1
}
run_required() {
  local label=$1 output=$2
  shift 2
  set_status "running:$label"
  printf '%s START %s\n' "$(date -u +%FT%TZ)" "$label" >>"$LOG"
  if ! PYTHONUNBUFFERED=1 "$@" >"$output" 2>>"$LOG"; then fail "$label"; fi
  printf '%s COMPLETE %s\n' "$(date -u +%FT%TZ)" "$label" >>"$LOG"
}
json_gate() {
  python - "$1" "$2" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
expr = sys.argv[2]
if not eval(expr, {"__builtins__": {}}, {"p": payload}):
    raise SystemExit(f"JSON gate failed: {expr}")
PY
}

set_status waiting:phase1-final-plan
while :; do
  phase1_status=$(awk '{print $2}' "$PHASE1/status" 2>/dev/null || true)
  case "$phase1_status" in
    complete:ready-for-id-map-snapshot-smoke) break ;;
    failed:*) fail "phase1-$phase1_status" ;;
    *) sleep 20 ;;
  esac
done

# Refuse to overwrite prior migration artifacts. A rerun must be reviewed and
# given a fresh run suffix so an old result cannot be mistaken for this run.
[[ ! -e "$ID_MAP" && ! -e "$ID_AUDIT" && ! -e "$REINDEX_PLAN" && ! -e "$REINDEX_STAGING" ]] \
  || fail migration-output-already-exists

smoke_gate="p.get('failed') == 0 and p.get('processed') == 256 and p.get('status') == 'partial' and p.get('remaining', 0) > 0"
if [[ -f "$STATE/copy-smoke.json" ]] && json_gate "$STATE/copy-smoke.json" "$smoke_gate"; then
  printf '%s REUSE verified-copy-smoke\n' "$(date -u +%FT%TZ)" >>"$LOG"
else
  set_status running:copy-smoke
  printf '%s START copy-smoke\n' "$(date -u +%FT%TZ)" >>"$LOG"
  PYTHONUNBUFFERED=1 python scripts/organize_local_novels.py \
    --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
    apply --plan-run-id "$FINAL_RUN" --transfer-mode copy --workers 7 \
    --limit 256 --confirm-transfer-complete \
    >"$STATE/copy-smoke.json" 2>>"$LOG"
  smoke_rc=$?
  # A bounded smoke is intentionally partial and the CLI therefore returns 1.
  [[ "$smoke_rc" == 0 || "$smoke_rc" == 1 ]] || fail "copy-smoke-exit-$smoke_rc"
  json_gate "$STATE/copy-smoke.json" "$smoke_gate" || fail copy-smoke-gate
  printf '%s COMPLETE copy-smoke\n' "$(date -u +%FT%TZ)" >>"$LOG"
fi

# A second bounded batch measures whether extra I/O concurrency can hide the
# remote filesystem latency. It is still a non-destructive copy smoke; CPU use
# remains constrained by the host's 7-core cgroup quota.
io_smoke_gate="p.get('failed') == 0 and p.get('processed') == 256 and p.get('status') == 'partial' and p.get('remaining', 0) > 0"
if [[ -f "$STATE/copy-smoke-w28.json" ]] && json_gate "$STATE/copy-smoke-w28.json" "$io_smoke_gate"; then
  printf '%s REUSE verified-copy-smoke-w28\n' "$(date -u +%FT%TZ)" >>"$LOG"
else
  set_status running:copy-smoke-w28
  smoke_started=$(date +%s)
  printf '%s START copy-smoke-w28\n' "$(date -u +%FT%TZ)" >>"$LOG"
  PYTHONUNBUFFERED=1 python scripts/organize_local_novels.py \
    --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
    apply --plan-run-id "$FINAL_RUN" --transfer-mode copy --workers 28 \
    --limit 256 --confirm-transfer-complete \
    >"$STATE/copy-smoke-w28.json" 2>>"$LOG"
  smoke_rc=$?
  [[ "$smoke_rc" == 0 || "$smoke_rc" == 1 ]] || fail "copy-smoke-w28-exit-$smoke_rc"
  json_gate "$STATE/copy-smoke-w28.json" "$io_smoke_gate" || fail copy-smoke-w28-gate
  printf '%s COMPLETE copy-smoke-w28 elapsed_seconds=%s\n' \
    "$(date -u +%FT%TZ)" "$(( $(date +%s) - smoke_started ))" >>"$LOG"
fi

full_move_gate="p.get('status') == 'complete' and p.get('failed') == 0 and p.get('remaining') == 0"
full_move_complete=0
if [[ -f "$STATE/full-move.json" ]] && json_gate "$STATE/full-move.json" "$full_move_gate"; then
  full_move_complete=1
fi

if [[ "$full_move_complete" == 0 ]]; then
  snapshot_args=(python scripts/organize_local_novels.py --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG")
  for source in "${SOURCES[@]}"; do snapshot_args+=(--source "$source"); done
  snapshot_args+=(snapshot --output "$SNAPSHOT")
  if [[ -f "$SNAPSHOT" ]]; then
    # Reusing a saved snapshot is safe: move apply independently recomputes the
    # current tree and requires an exact match before touching another source.
    printf '%s REUSE stable-snapshot (apply will revalidate)\n' "$(date -u +%FT%TZ)" >>"$LOG"
  else
    run_required stable-snapshot "$STATE/snapshot-command.json" "${snapshot_args[@]}"
  fi

  python - "$CATALOG" "$FINAL_RUN" "$SNAPSHOT" <<'PY' || fail snapshot-plan-gate
import json, sqlite3, sys
catalog, run_id, snapshot_path = sys.argv[1:]
snapshot = json.load(open(snapshot_path, encoding="utf-8"))
db = sqlite3.connect(f"file:{catalog}?mode=ro", uri=True)
planned = db.execute("select count(*) from plan_files where plan_run_id=?", (run_id,)).fetchone()[0]
removed = db.execute(
    "select count(*) from plan_files where plan_run_id=? and raw_transfer_state in "
    "('moved','deduplicated','invalid_deleted','conversion_failed_deleted')",
    (run_id,),
).fetchone()[0]
if snapshot.get("active_transfer_markers"):
    raise SystemExit("active transfer markers remain")
if snapshot.get("archive_count") != 0:
    raise SystemExit("archives remain in source roots")
if snapshot.get("txt_count") + removed != planned:
    raise SystemExit(
        f"snapshot/plan mismatch: live={snapshot.get('txt_count')} "
        f"removed={removed} planned={planned}"
    )
PY
fi

if [[ "$full_move_complete" == 1 ]]; then
  printf '%s REUSE completed-full-move\n' "$(date -u +%FT%TZ)" >>"$LOG"
else
  run_required full-move "$STATE/full-move.json" \
    python scripts/organize_local_novels.py \
      --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
      apply --plan-run-id "$FINAL_RUN" --transfer-mode move --workers 7 \
      --stability-snapshot "$SNAPSHOT" --confirm-transfer-complete \
      --preserve-existing-processed
  json_gate "$STATE/full-move.json" "$full_move_gate"
fi

VERIFY_RUN="front6-postarchive-full-verify-$(date -u +%Y%m%dT%H%M%SZ)"
run_required full-verify "$STATE/full-verify.json" \
  python scripts/organize_local_novels.py \
    --archive-root "$ARCHIVE_ROOT" --catalog-path "$CATALOG" \
    verify --plan-run-id "$FINAL_RUN" --workers 7 \
    --run-id "$VERIFY_RUN"
json_gate "$STATE/full-verify.json" \
  "p.get('status') == 'complete' and p.get('errors') == 0 and p.get('incomplete') == 0"

PLAN_JSONL="$ARCHIVE_ROOT/.state/runs/$FINAL_RUN/plan.jsonl"
run_required id-map-dry "$STATE/id-map-dry.json" \
  python scripts/processed_corpus_migration.py build-id-map \
    --organizer-index "$ARCHIVE_ROOT/index.jsonl" --import-root "$IMPORT_ROOT" \
    --organizer-plan "$PLAN_JSONL" --repair-id-collisions
run_required id-map-write "$STATE/id-map-write.json" \
  python scripts/processed_corpus_migration.py build-id-map \
    --organizer-index "$ARCHIVE_ROOT/index.jsonl" --import-root "$IMPORT_ROOT" \
    --organizer-plan "$PLAN_JSONL" --repair-id-collisions --plan-dir "$ID_AUDIT" \
    --output-id-map "$ID_MAP"

run_required reindex-dry "$STATE/reindex-dry.json" \
  python scripts/processed_corpus_migration.py reindex-staging \
    --library-root "$PROJECT/Library" --import-root "$IMPORT_ROOT" --id-map "$ID_MAP" \
    --plan-dir "$REINDEX_PLAN"
run_required reindex-apply "$STATE/reindex-apply.json" \
  python scripts/processed_corpus_migration.py reindex-staging \
    --library-root "$PROJECT/Library" --import-root "$IMPORT_ROOT" --id-map "$ID_MAP" \
    --apply --staging-root "$REINDEX_STAGING"

set_status complete:ready-for-upstream-switch-review
printf '%s COMPLETE ready-for-upstream-switch-review\n' "$(date -u +%FT%TZ)" >>"$LOG"
