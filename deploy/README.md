# Примеры nginx для p.datagon.ru

Здесь лежат **примеры** конфигов nginx для Datagon. Они не подставляются автоматически: пути к сертификатам, `listen`, логи и `root` нужно привести в соответствие с вашим сервером.

| Файл | Назначение |
|------|------------|
| `nginx-p.datagon.ru.conf` | Упрощённый пример HTTP/HTTPS и `proxy_pass` на Node |
| `nginx-p.datagon.ru-frontend.conf` | Более полный вариант (QUIC, gzip, сценарий с панелью) |

Чеклист выкладки приложения и pm2 — в веб-справке: **`/docs/deploy/`** (после `npm run docs:docusaurus:build`).
