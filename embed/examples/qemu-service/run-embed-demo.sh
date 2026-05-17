#!/usr/bin/env bash
#
# run-embed-demo.sh -- end-to-end demo of the embedded SDK backend.
#
# Brings up the full Docker Compose stack with the FastAPI service +
# bundled UI, but with QEMU_BINARY=qemu-system-sparc-embed so the
# emulator runs in-process via libqemu-sparc.so instead of as a
# subprocess. Then exercises both -M gr712rc and -M gr740, reading the
# host-info peripheral that only the embedded wrapper can serve, to
# prove the swap is functional.
#
# Usage:
#   ./embed/examples/qemu-service/run-embed-demo.sh
#
# Requires: docker, docker compose, curl, python3 (for tiny JSON parse).
#
# Leaves the stack DOWN on exit (success or failure). If you want to
# explore the UI in a browser after the verification, set KEEP_UP=1.

set -euo pipefail

# Locate the repo root from this script's own location, so the script
# works no matter where it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

# Colors when stdout is a terminal.
if [[ -t 1 ]]; then
    C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_FAIL=$'\033[1;31m'
    C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
    C_INFO=""; C_OK=""; C_FAIL=""; C_DIM=""; C_RESET=""
fi

step() { echo "${C_INFO}==>${C_RESET} $*"; }
ok()   { echo "${C_OK}OK ${C_RESET} $*"; }
fail() { echo "${C_FAIL}FAIL${C_RESET} $*" >&2; }
dim()  { echo "${C_DIM}$*${C_RESET}"; }

cleanup() {
    local rc=$?
    if [[ "${KEEP_UP:-0}" == "1" ]]; then
        dim "KEEP_UP=1 set; leaving stack running at http://localhost:8080/ui/"
        dim "Stop manually with:  docker compose down"
    else
        step "Tearing down compose stack"
        docker compose down --remove-orphans >/dev/null 2>&1 || true
    fi
    exit $rc
}
trap cleanup EXIT

# --------------------------------------------------------------------
# 1. Build kernels (cheap; idempotent).
# --------------------------------------------------------------------
step "Building gr712rc + gr740 hello kernels (skip if cached)"
make -C apps/01-hello-rtems -s >/dev/null
make -C apps/07-hello-gr740 -s >/dev/null
ok "kernels at apps/01-hello-rtems/hello.exe and apps/07-hello-gr740/hello.exe"

# --------------------------------------------------------------------
# 2. Compose up with the embedded backend.
# --------------------------------------------------------------------
step "docker compose up -d --build (QEMU_BINARY=qemu-system-sparc-embed)"
QEMU_BINARY=qemu-system-sparc-embed docker compose up -d --build 2>&1 \
    | tail -3

step "Waiting for the FastAPI service to come up"
for i in $(seq 1 30); do
    if curl -sf http://localhost:8080/machines >/dev/null; then
        ok "service ready at http://localhost:8080"
        break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
        fail "service did not become ready within 30s"
        docker compose logs | tail -30
        exit 1
    fi
done

# --------------------------------------------------------------------
# 3. Per-machine E2E.
# --------------------------------------------------------------------
HOST_INFO_MAGIC="4c49424f"   # "LIBO" big-endian

check_machine() {
    local machine="$1"
    local kernel_path="$2"
    local host_info_addr="$3"
    local expected_mcode="$4"

    step "Testing machine '$machine' with kernel '$kernel_path'"

    # Upload kernel.
    local kernel_url
    kernel_url=$(curl -s -F "file=@${kernel_path}" \
        http://localhost:8080/uploads \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["kernel_url"])')
    dim "  kernel_url=$kernel_url"

    # Create + start session.
    curl -sf -X POST http://localhost:8080/session \
        -H 'Content-Type: application/json' \
        -d "{\"machine\":\"$machine\",\"kernel_url\":\"$kernel_url\"}" \
        >/dev/null
    curl -sf -X POST http://localhost:8080/session/start >/dev/null
    dim "  session started, waiting 2s for boot"
    sleep 2

    # Read the host-info peripheral.
    local mem_json
    mem_json=$(curl -sf "http://localhost:8080/session/memory?addr=${host_info_addr}&size=16")
    dim "  raw response: $mem_json"

    local data
    data=$(echo "$mem_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])')

    # data looks like "4c49424f 0000000c 00000002 67723730".
    local words=( $data )
    local magic="${words[0]}"
    local pid_hex="${words[1]}"
    local uptime_hex="${words[2]}"
    local mcode="${words[3]}"

    if [[ "$magic" != "$HOST_INFO_MAGIC" ]]; then
        fail "magic mismatch (got 0x$magic, expected 0x$HOST_INFO_MAGIC)"
        fail "the standalone qemu-system-sparc would return all zeros here"
        curl -s -X DELETE http://localhost:8080/session >/dev/null || true
        exit 1
    fi
    if [[ "$mcode" != "$expected_mcode" ]]; then
        fail "machine code mismatch (got 0x$mcode, expected 0x$expected_mcode)"
        curl -s -X DELETE http://localhost:8080/session >/dev/null || true
        exit 1
    fi

    ok  "$machine: magic 0x$magic ('LIBO')"
    ok  "$machine: pid 0x$pid_hex, uptime 0x$uptime_hex s, mcode 0x$mcode"

    curl -s -X DELETE http://localhost:8080/session >/dev/null
}

check_machine gr712rc apps/01-hello-rtems/hello.exe 0x80000a00 67723730
check_machine gr740   apps/07-hello-gr740/hello.exe 0xff900a00 67723731

# --------------------------------------------------------------------
# 4. Banner confirming which binary served the requests.
# --------------------------------------------------------------------
step "Container banner (proof the wrapper is the one running)"
docker compose logs emulator 2>&1 | grep "qemu-system-sparc-embed:" | tail -5 \
    || dim "(no banner -- check 'docker compose logs emulator')"

echo
echo "${C_OK}=== embedded-backend demo PASSED on both gr712rc and gr740 ===${C_RESET}"
echo
echo "The FastAPI service drove the simulation through QMP exactly as it"
echo "would with the standalone binary, but the emulator ran in-process"
echo "via libqemu-sparc.so. The host-info peripheral at 0x80000a00 /"
echo "0xff900a00 is the visible marker -- it has no equivalent in"
echo "qemu-system-sparc."
