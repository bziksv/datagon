#!/usr/bin/env bash
# Сборка SPA в public/, опционально git push и rsync всего public/ на сервер.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RSYNC_TARGET="${DATAGON_RSYNC_TARGET:-root@155.212.171.103:/var/www/p_datagon_ru_usr/data/www/p.datagon.ru/public/}"
GIT_MSG="${DATAGON_GIT_MSG:-update}"

usage() {
  cat <<'USAGE'
Использование: ./scripts/deploy-public.sh [опции]

  --fresh-spa   Полная переустановка зависимостей CRA: rm node_modules + npm ci --legacy-peer-deps
  --git         git add -A, commit (DATAGON_GIT_MSG или "update"), push origin main
  --no-rsync    только сборка (без rsync)
  --no-install  пропустить npm install в корне репозитория
  -h, --help    эта справка

Переменные:
  DATAGON_RSYNC_TARGET   куда rsync (по умолчанию public/ на 155.212.171.103)
  DATAGON_GIT_MSG        сообщение коммита для --git

Важно: rsync — это каталог public/ целиком (не public/architectui-react-pro/).

На сервере после выкладки: cd .../p.datagon.ru && git pull && npm install --omit=dev && pm2 restart parser-app
USAGE
}

FRESH_SPA=0
DO_GIT=0
NO_RSYNC=0
NO_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh-spa) FRESH_SPA=1 ;;
    --git) DO_GIT=1 ;;
    --no-rsync) NO_RSYNC=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [[ "$NO_INSTALL" -eq 0 ]]; then
  npm install
fi

if [[ "$FRESH_SPA" -eq 1 ]]; then
  echo ">>> fresh-spa: npm ci в architectui-react-pro"
  (cd architectui-react-pro && rm -rf node_modules/.cache node_modules && npm ci --legacy-peer-deps)
fi

echo ">>> build:datagon-spa"
npm run build:datagon-spa

if [[ "$DO_GIT" -eq 1 ]]; then
  echo ">>> git"
  git add -A
  git status
  if ! git diff --cached --quiet; then
    git commit -m "$GIT_MSG"
    git push origin main
  else
    echo "(нет изменений для коммита)"
  fi
fi

if [[ "$NO_RSYNC" -eq 0 ]]; then
  echo ">>> rsync public/ → $RSYNC_TARGET"
  rsync -avz --delete "${ROOT}/public/" "$RSYNC_TARGET"
fi

echo "OK."
