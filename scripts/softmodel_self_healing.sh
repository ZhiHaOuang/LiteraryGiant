#!/bin/bash
# Self-healing softmodel (NuExtract chapter extraction / vLLM) runner.
# Supervises the softmodel worker and restarts it if it dies. Checks every 30 min.
# Mirrors scripts/infermodel_self_healing.sh but for the local-vLLM softmodel stage.
#
# Usage (detached, survives the shell/session):
#   setsid bash scripts/softmodel_self_healing.sh </dev/null >/dev/null 2>&1 &

set -uo pipefail

PROJECT_ROOT="/root/private_data/LiteraryGiant"
LOG_DIR="$PROJECT_ROOT/logs"
RUN_DIR="$PROJECT_ROOT/runs"
INPUT="$PROJECT_ROOT/Library/TaciturnRaw/02_CleanedData"
PYTHON="/opt/conda/bin/python"

WATCHDOG_LOG="$LOG_DIR/softmodel_watchdog.log"
WORKER_PID_FILE="$RUN_DIR/softmodel_worker.pid"
WATCHDOG_PID_FILE="$RUN_DIR/softmodel_watchdog.pid"

CHECK_INTERVAL=1800            # 30 minutes
MATCH="Jormungandr\.softmodel" # pgrep pattern that identifies the worker (not this watchdog)

mkdir -p "$LOG_DIR" "$RUN_DIR"
echo $$ > "$WATCHDOG_PID_FILE"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$WATCHDOG_LOG"; }

worker_alive() { pgrep -f "$MATCH" >/dev/null 2>&1; }

start_worker() {
    local ts wlog pid
    ts=$(date +%Y%m%d_%H%M%S)
    wlog="$LOG_DIR/softmodel_selfheal_${ts}.log"
    cd "$PROJECT_ROOT" || { log "FATAL cannot cd $PROJECT_ROOT"; return 1; }
    "$PYTHON" -u -m Jormungandr.softmodel "$INPUT" \
        --nuextract-size 8b \
        --chapter-batch-size 4 \
        --index-flush-interval 4 \
        --state-save-interval 100 \
        >> "$wlog" 2>&1 &
    pid=$!
    echo "$pid" > "$WORKER_PID_FILE"
    log "STARTED softmodel worker PID=$pid log=$wlog"
}

restart_count=0
log "WATCHDOG start pid=$$ interval=${CHECK_INTERVAL}s"

if worker_alive; then
    log "ALIVE softmodel already running; supervising"
else
    start_worker
fi

while true; do
    sleep "$CHECK_INTERVAL"
    if worker_alive; then
        log "ALIVE softmodel healthy restarts=$restart_count"
    else
        restart_count=$((restart_count + 1))
        log "DOWN softmodel worker missing — restarting (#$restart_count)"
        start_worker
    fi
done
