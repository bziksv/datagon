#!/usr/bin/env bash
# Запускать НА СЕРВЕРЕ от root (или пользователя с правами на каталог деплоя).
# Локально из Cursor на твой VPS зайти нельзя — скопируй файл на сервер или вставь содержимое.
#
# Использование:
#   chmod +x fresh-clone-on-server.sh
#   sudo ./fresh-clone-on-server.sh
#
# Переменные (опционально):
#   DEPLOY_ROOT=/var/www/.../p.datagon.ru REPO_URL=https://github.com/bziksv/datagon.git ./fresh-clone-on-server.sh

set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/p_datagon_ru_usr/data/www/p.datagon.ru}"
REPO_URL="${REPO_URL:-https://github.com/bziksv/datagon.git}"
PM2_APP="${PM2_APP:-parser-app}"

case "$DEPLOY_ROOT" in
  */p.datagon.ru) ;;
  *)
    echo "Ошибка: DEPLOY_ROOT должен заканчиваться на /p.datagon.ru (сейчас: $DEPLOY_ROOT)"
    exit 1
    ;;
esac

BACKUP_DIR="${BACKUP_DIR:-/root/datagon-secrets-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$BACKUP_DIR"

if [[ -f "${DEPLOY_ROOT}/config.js" ]]; then
  cp -a "${DEPLOY_ROOT}/config.js" "${BACKUP_DIR}/"
  echo "Сохранён config.js -> ${BACKUP_DIR}/"
fi
if [[ -f "${DEPLOY_ROOT}/.env" ]]; then
  cp -a "${DEPLOY_ROOT}/.env" "${BACKUP_DIR}/"
  echo "Сохранён .env -> ${BACKUP_DIR}/"
fi

OLD="${DEPLOY_ROOT}.old.$(date +%s)"
if [[ -e "$DEPLOY_ROOT" ]]; then
  echo "Переименовываю текущий каталог в ${OLD}"
  mv "$DEPLOY_ROOT" "$OLD"
fi

mkdir -p "$(dirname "$DEPLOY_ROOT")"
echo "Клонирую ${REPO_URL} -> ${DEPLOY_ROOT}"
git clone "$REPO_URL" "$DEPLOY_ROOT"

if [[ -f "${BACKUP_DIR}/config.js" ]]; then
  cp -a "${BACKUP_DIR}/config.js" "${DEPLOY_ROOT}/config.js"
  echo "Восстановлен config.js"
fi
if [[ -f "${BACKUP_DIR}/.env" ]]; then
  cp -a "${BACKUP_DIR}/.env" "${DEPLOY_ROOT}/.env"
  echo "Восстановлен .env"
fi

cd "$DEPLOY_ROOT"
echo "npm install (корень)..."
npm install --omit=dev

echo "Сборка vanilla в public/vanilla..."
npm run sync:vanilla-public

echo "Перезапуск pm2 ${PM2_APP}..."
pm2 restart "$PM2_APP"

echo "Готово. Старый каталог: ${OLD} (удали вручную после проверки: rm -rf ${OLD})"
echo "Бэкап секретов: ${BACKUP_DIR}"
