# Deploy Checklist

## 1) Local: save and push changes

```bash
cd /Users/stanislav/Documents/projects/p.datagon.ru
git status
git add .
git commit -m "Your commit message"
git push origin main
```

## 2) Server: pull, собрать React в `public/`, перезапуск

```bash
cd /var/www/p_datagon_ru_usr/data/www/p.datagon.ru
git pull origin main
npm install --omit=dev
cd architectui-react-pro && npm install --legacy-peer-deps && cd ..
npm run build:datagon-spa
pm2 restart parser-app
pm2 status
```

`build:datagon-spa` собирает CRA и копирует артефакт в `public/architectui-react-pro/` (папка в `.gitignore`, на сервере появляется после команды).

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
