# Deploy Checklist

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
