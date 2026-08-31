#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
PID=$(netstat -ano | grep "127.0.0.1:55432" | grep LISTENING | awk '{print $5}' | head -1 || true)
if [ -n "$PID" ]; then powershell.exe -Command "Stop-Process -Id $PID -Force" >/dev/null 2>&1 || true; fi
sleep 1
rm -rf .dev-db
echo "harness reset"
