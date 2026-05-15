# Скрипты репозитория

| Папка | Назначение |
|-------|------------|
| `docs-docusaurus/e2e/` + `playwright.config.mjs` | Съёмка PNG для справки (`npm run docs:capture-screenshots` из корня) |
| `scripts/build/` | Сборка vanilla HTML (`assemble-vanilla-pages.mjs`, `sync-vanilla-to-public.mjs`) |
| `scripts/qa/` | Smoke-проверки Playwright и HTTP API (`api-http-smoke.mjs`); логика матрицы Huckster без API (`huckster-matrix-build-verify.mjs`) |
| `scripts/check-panel-notify-static.mjs` | Статика: в `public/*.html` есть `datagon-vanilla.js` + `datagon-vanilla-shell`, счётчик `data-dg-notify-start`. Запуск: `npm run check:panel-notify-static` (после `npm run sync:vanilla-public`) |
| `scripts/test-page-fetch-proxy-classify.js` | Ручная отладка: загрузка страницы с учётом прокси и эвристики классификации карточки (`node scripts/test-page-fetch-proxy-classify.js`, см. файл) |
| `scripts/backfill-min-stock.js` | Восстанавливает `ms_export.min_stock` (Неснижаемый остаток МС) из уже сохранённых полных карточек `ms_entity_details.payload_json`. Запускается, когда нужно догнать данные без полного синка МС (например, после хотфикса логики `syncMsExport`). Идемпотентен (UPDATE по PK). Запуск: `node scripts/backfill-min-stock.js` |
| `scripts/backfill-ms-entity-denorm.mjs` | Заполняет `ms_entity_details.denorm_*` (артикул, в пути, упаковка, рыночная цена) из `payload_json` — паритет с `saveMoyskladEntityDetails` для лёгкого `GET /api/purchase` без `payload_json` в списке. Запуск: `node scripts/backfill-ms-entity-denorm.mjs` |

Команды из корня: `npm run docs:capture-screenshots`, `npm run sync:vanilla-public`, `npm run test:datagon-smoke-e2e`, `npm run test:api-http-smoke` (нужны `DATAGON_SMOKE_USER` / `DATAGON_SMOKE_PASSWORD`, сервер `npm start`), `npm run test:huckster-matrix` (без сервера и сети), `npm run check:panel-notify-static` (без сервера).
