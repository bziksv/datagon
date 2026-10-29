---
id: deploy
title: Деплой
description: Чеклист выкладки и примеры nginx
---

<blockquote class="dg-doc-tip">
Чеклист ниже — для **выкладки кода и статики** на сервер. Отдельные **примеры nginx** лежат в каталоге <code>deploy/</code> в корне репозитория; в Docusaurus они не встраиваются как страницы.
</blockquote>

Чеклист выкладки панели и сервера. Примеры конфигурации nginx — в каталоге **`deploy/`** в корне репозитория (не входят в сборку Docusaurus).

Пользовательская и техническая справка (Docusaurus): из корня репозитория **`npm run docs:docusaurus:build`** — вывод в **`public/docs/`** (часто выкладывается вместе с `public/`).

## Что обычно входит в деплой

| Компонент | Что выложить | Когда пересобирать |
|-----------|----------------|---------------------|
| Панель (`*.html`) | `public/*.html`, `public/datagon-vanilla.js` | после `npm run sync:vanilla-public` из правок в `static-html/vanilla/` |
| Тема | `public/static/css/`, `public/static/media/` | при обновлении стилей/ассетов |
| Справка | `public/docs/` | после `npm run docs:docusaurus:build` |
| Сервер | `server.js`, `routes/`, `lib/` | после `git pull`; обязателен **рестарт Node** |
| Конфиг | `config.js` (или env на сервере) | при смене БД, токенов, порта |

**Nginx** не заменяет Node: запросы к `/api` и динамике должны **проксироваться** на процесс приложения (см. комментарии в файлах в **`deploy/`**).

## 1) Local: save and push changes

```bash
cd /Users/stanislav/Documents/projects/p.datagon.ru
git status
git add .
git commit -m "Your commit message"
git push origin main
```

## 2) Server: код + фронт (vanilla)

Фронт — статические страницы **`public/*.html`** (панель), тема Bootstrap/ArchitectUI — **`public/static/css/main.*.css`** и **`public/static/media/`** (лежат в git). После правок в `static-html/vanilla/` соберите HTML в `public/`:

```bash
npm run sync:vanilla-public
```

На сервере (или через `./scripts/deploy-public.sh`):

```bash
cd /var/www/p_datagon_ru_usr/data/www/p.datagon.ru
git pull origin main
npm install --omit=dev
npm run sync:vanilla-public
pm2 restart parser-app
```

Панель в браузере: **`https://<домен>/dashboard.html`** (корень `/` редиректит сюда; старые пути `/moysklad`, `/my-products` и т.д. — 301 на `/*.html`; закладки `/vanilla/*.html` — 301 в корень).

Проверка статики темы:

```bash
test -f public/static/css/main.*.css && echo OK
```

## 3) Verify deployed version

Run locally and on server, hashes must match:

```bash
git rev-parse --short HEAD
```

## 4) Quick API checks (server or local curl)

```bash
curl -i http://localhost:3000/api/my-sites
curl -i -X POST "http://localhost:3000/api/auth/login" -H "Content-Type: application/json" --data '{"username":"admin","password":"YOUR_PASSWORD"}'
```

Compatibility endpoint (for old cached clients):

```bash
curl -i -X POST "http://localhost:3000/api/login" -H "Content-Type: application/json" --data '{"username":"admin","password":"YOUR_PASSWORD"}'
```

## 5) If something goes wrong

```bash
pm2 logs parser-app --lines 100
pm2 restart parser-app
```

Hard refresh browser cache after deploy:

- macOS: `Cmd + Shift + R`

## Переменные окружения и секреты

- **`DATAGON_AUTO_SYNC_SCHEDULER=off`** — режим «только по кнопке» для **локальной разработки** с общей (продовой) БД: планировщик автосинхронизаций не стартует, локальный процесс не помечает чужие `running`-записи `auto_sync_runs` как «прервано»; кнопки **«Запустить сейчас»** (`POST /api/settings/auto-sync-run`) работают.
  - **Локально всегда:** `npm run dev:local` (агент Cursor и разработчик — та же команда; не `npm start`).
  - **Прод:** переменную **не задавать** — по умолчанию scheduler включён (`pm2` → `node server.js`).
  - В логе при старте локально должна быть строка: `[AUTO SYNC] scheduler ВЫКЛЮЧЕН …`.
- **`DATAGON_AUTO_SYNC_WORKER_ID`** — `1` (default, `parser-app`), `2` (`parser-autosync-w2`), `3` (`parser-autosync-w3`). Назначение задачи → поле `worker` в `lib/datagonAutoSyncRegistry.js` (**банки/Planfix/Bitcop → 2**, **`results_reparse_products` → 3**, остальное → 1). Ручной запуск с HTTP-воркера 1 для чужой задачи пишется в `auto_sync_dispatch`, целевой воркер забирает её за несколько секунд.
- **`DATAGON_HTTP=off`** — процесс без `listen` (только автосинк). Нужен для `parser-autosync-w2` / `parser-autosync-w3`. На основном `parser-app` **не** задавать.
- **Доп. воркеры на проде:**

```bash
cd /var/www/p_datagon_ru_usr/data/www/p.datagon.ru
# тот же DATAGON_VAULT_KEY, что у parser-app (иначе finance_tochka на w2: «Добавьте JWT…»)
DATAGON_VAULT_KEY='…' pm2 start ecosystem.autosync-w2.config.cjs
DATAGON_VAULT_KEY='…' pm2 start ecosystem.autosync-w3.config.cjs
pm2 save
pm2 restart parser-app
pm2 ls   # parser-app + parser-autosync-w2 + parser-autosync-w3
```

- **`DATAGON_STARTUP_DEFER_MS`** — отсрочка тяжёлых фоновых задач после старта (default 60000 мс).
- **`DATAGON_CLOCK_SYNC_SECRET`** — общий секрет для `POST /api/work-schedule/clock/sync-from-crm` (вызов из CRM после attendance). Передавать **только** в header `X-Datagon-Clock-Sync` (не в body). Без него endpoint отвечает 401.
- **`DATAGON_VAULT_KEY`** — ключ AES-256-GCM для WORK vault at-rest (`lib/datagonVaultCrypto.js`): **64 hex** или **base64(32 байта)**. Обязателен **на всех** pm2-процессах Datagon (`parser-app`, `parser-autosync-w2`, `parser-autosync-w3`): банки (`finance_*_credentials`), Bitcop, CMS `db_pass`, WORK vault — `enc:v1:…`. Ручной синк с `/finance.html` идёт через воркер 1; автосинк `finance_tochka` — через **w2**. Без ключа на w2 автосинк не расшифрует JWT и пишет «Добавьте JWT…», хотя UI обновление работает. Без ключа новые секреты пишутся plaintext (warn); уже `enc:v1:…` без ключа не reveal'ятся (503). Массовая миграция legacy: на **проде** сначала выкатить код + тот же ключ в pm2, затем `DATAGON_VAULT_MIGRATE=1` при старте или `node scripts/migrate-work-vault-encrypt.mjs`. Сгенерировать: `openssl rand -hex 32`. Не коммитить ключ; локально с общей БД не шифровать без выката ключа на сервер.
- **`DATAGON_BIND_HOST`** — адрес listen Node (F-DEP-02). По умолчанию **`127.0.0.1`** (nginx `proxy_pass` на localhost). Для отладки снаружи: `DATAGON_BIND_HOST=0.0.0.0`.
- Security headers (F-DEP-03 / F-XSS-02): Express выставляет `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` и **CSP Report-Only** (inline scripts пока нужны). Пример nginx — `deploy/nginx-p.datagon.ru-frontend.conf` (после правки conf: `nginx -t && reload`).
- **nginx HTTP→HTTPS (F-DEP-01):** канон — `return 301 https://$host$request_uri` на `:80` + `Strict-Transport-Security` на `:443`. Упрощённый `deploy/nginx-p.datagon.ru.conf` приведён к тому же паттерну; **не** выкладывать conf, где `:80` проксирует Node без редиректа (cleartext cookie/session).
- **CRM Prime** (репозиторий `crm.prime-ltd`): в `.env` задать `DATAGON_CLOCK_SYNC_URL=https://p.datagon.ru/api/work-schedule/clock/sync-from-crm` и тот же `DATAGON_CLOCK_SYNC_SECRET`; выкатить `app/Models/Attendance_model.php`. Доступ Datagon к БД CRM — уже через `CRM_PRIME_DB_*` (см. `lib/crmPrimeTimesheets.js`).
- **`MS_TOKEN`** (или поле в `config.js`) — не коммитьте в публичный git; на сервере используйте `.env`, переменные systemd/pm2 или секрет-хранилище.
- **Юридические страницы** (`/legal/privacy.html`, `/legal/cookies.html`, `/legal/recommendation.html`, `/legal/consent.html`) отдаются **без авторизации**. Cookie-баннер (как на titlo.ru) показывается **только неавторизованным**; ссылки на политики — в подвале панели и на `/login.html`. Пересборка из ODT (`rules/` → HTML): `npm run build:legal-html` (старый конвейер; актуальные тексты правок 21.08.2026 могут правиться напрямую в `public/legal/*.html`).
- **Пароль БД** — только на машине приложения; в `deploy/` nginx **не** хранит креды MySQL для Node (MySQL обычно на `127.0.0.1` или внутренней сети).
- После смены env — **рестарт** процесса Node, иначе `process.env` останется старым.

## TLS и заголовки

- Терминация TLS чаще на **nginx**; до Node доходит HTTP за reverse proxy — убедитесь, что `X-Forwarded-Proto` и `Host` проброшены, если логика авторизации зависит от схемы.
- Ограничение размера тела для `POST` (импорты, синк) — см. `bodyParser` в `server.js`; при 413 увеличьте лимит **осознанно**.

## Откат (rollback)

1. `git checkout <предыдущий_тег_или_коммит>` **или** `git revert` мержа.
2. `npm install` при смене зависимостей.
3. `npm run sync:vanilla-public` и `npm run docs:docusaurus:build` при изменении фронта/доков.
4. **`pm2 restart`** / рестарт systemd.
5. Проверка `curl` на `/api/auth/me` или логина + одной «тяжёлой» страницы панели.
