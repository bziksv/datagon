#!/usr/bin/env bash
# CRA на :3003, прокси /api → бэкенд (порт задаётся DATAGON_API_TARGET)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATAGON_API_TARGET="${DATAGON_API_TARGET:-http://127.0.0.1:3000}"
cd "$ROOT"
# Раскомментируй, если завис старый dev-сервер: pkill -f "react-app-rewired start" 2>/dev/null || true
exec npm --prefix architectui-react-pro run start:3003
