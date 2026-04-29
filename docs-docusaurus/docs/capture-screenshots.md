---
id: capture-screenshots
title: Переснять скриншоты
---

Обновление PNG для документации (для разработчиков).

## Шаги

1. `npm install`
2. `npm run docs:install-browsers`
3. запустить приложение `npm start`
4. выполнить:

```bash
DOCS_USER=логин DOCS_PASSWORD='пароль' npm run docs:capture-screenshots
```

Скриншоты обновляются в `public/docs/screenshots/`.
