# Deploy Checklist

## 1) Local: save and push changes

```bash
cd /Users/stanislav/Documents/projects/p.datagon.ru
git status
git add .
git commit -m "Your commit message"
git push origin main
```

## 2) Server: код + фронт

**Важно:** `npm run build:datagon-spa` на сервере запускает **полную webpack-сборку** CRA — на слабом VPS это даёт **высокую нагрузку**, долгий простой и может **раздувать диск** (кэш npm/webpack, `node_modules`, временные файлы). На проде **предпочтительно собирать на своём ПК** и заливать только готовую папку.

### Вариант A (рекомендуется): сборка на Mac, на сервер только статика

На маке в корне репозитория:

```bash
npm run build:datagon-spa
```

Дальше скопировать на сервер **только** каталог `public/architectui-react-pro/` (rsync/scp/sFTP), например:

```bash
rsync -avz --delete ./public/architectui-react-pro/ user@server:/var/www/.../p.datagon.ru/public/architectui-react-pro/
```

На сервере после копирования:

```bash
cd /var/www/p_datagon_ru_usr/data/www/p.datagon.ru
git pull origin main
npm install --omit=dev
pm2 restart parser-app
```

(Если менялся только фронт и ты уже залил `public/architectui-react-pro/`, иногда достаточно `pm2 restart parser-app`; `git pull` нужен, если обновлялся бэкенд.)

### Вариант B: всё на сервере (мощный VPS / понимаете риск)

```bash
cd /var/www/p_datagon_ru_usr/data/www/p.datagon.ru
git pull origin main
npm install --omit=dev
cd architectui-react-pro && npm ci --legacy-peer-deps && cd ..
npm run build:datagon-spa
pm2 restart parser-app
pm2 status
```

Если **`architectui-react-pro/build`** уже собран (например, залит архивом с макбука), можно **только копировать** в `public/` без webpack на сервере:

```bash
SKIP_REACT_BUILD=1 node scripts/build/sync-react-build-to-public.mjs
pm2 restart parser-app
```

`build:datagon-spa` без `SKIP_REACT_BUILD` собирает CRA и копирует в `public/architectui-react-pro/`.

### React UI на продакшене

Сервер отдаёт SPA из **`public/architectui-react-pro/`** (статика + fallback на `index.html` для `/architectui-react-pro/...`). После выкладки UI: `https://<домен>/architectui-react-pro/`.

Локально проверить наличие сборки:

```bash
test -f public/architectui-react-pro/index.html && echo OK
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
