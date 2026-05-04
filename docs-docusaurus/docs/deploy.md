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

- **`MS_TOKEN`** (или поле в `config.js`) — не коммитьте в публичный git; на сервере используйте `.env`, переменные systemd/pm2 или секрет-хранилище.
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
