# Скрипты репозитория

| Папка | Назначение |
|-------|------------|
| `docs-docusaurus/e2e/` + `playwright.config.mjs` | Съёмка PNG для справки (`npm run docs:capture-screenshots` из корня) |
| `scripts/build/` | Сборка vanilla HTML (`assemble-vanilla-pages.mjs`, `sync-vanilla-to-public.mjs`) |
| `scripts/qa/` | Smoke-проверки Playwright и HTTP API (`api-http-smoke.mjs`); логика матрицы Huckster без API (`huckster-matrix-build-verify.mjs`) |
| `scripts/test-page-fetch-proxy-classify.js` | Ручная отладка: загрузка страницы с учётом прокси и эвристики классификации карточки (`node scripts/test-page-fetch-proxy-classify.js`, см. файл) |

Команды из корня: `npm run docs:capture-screenshots`, `npm run sync:vanilla-public`, `npm run test:datagon-smoke-e2e`, `npm run test:api-http-smoke` (нужны `DATAGON_SMOKE_USER` / `DATAGON_SMOKE_PASSWORD`, сервер `npm start`), `npm run test:huckster-matrix` (без сервера и сети).
