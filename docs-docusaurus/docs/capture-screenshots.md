---
id: capture-screenshots
title: Скриншоты для справки
description: Подробная инструкция по съёмке PNG (@playwright/test) для страниц Docusaurus
---

Съёмка завязана на пакет **`docs-docusaurus`**: официальный **`@playwright/test`** (конфиг **`playwright.config.mjs`**, сценарий **`e2e/capture-doc-screenshots.spec.mjs`**). Chromium в headless-режиме открывает панель Datagon, при необходимости выполняется **вход через API** (`POST /api/auth/login` и `localStorage` в контексте браузера), PNG сохраняются в **`static/screenshots/`** (`docs-docusaurus/static/screenshots/`). Для длинных таблиц в кадр попадает **viewport** (видимая область окна); для коротких экранов и макетов — **полная страница** (`full`), см. поле **`capture`** в **`e2e/targets.mjs`**. Дальше — **`npm run docs:docusaurus:build`**, чтобы файлы попали в `public/docs/`.

Качество кадра: по умолчанию **`DOCS_CAPTURE_DPR=1`** (читаемый размер PNG в справке); для Retina можно **`DOCS_CAPTURE_DPR=2`**. Ожидание **`document.fonts.ready`**, в **`page.screenshot`** отключены анимации и каретка. Для **живых** страниц дополнительно **`networkidle`** (с таймаутом) и пауза **~2.2 с**.

**Область кадра:** у длинных табличных экранов (очередь, мои товары, МойСклад, результаты, сопоставление, логи) в **`e2e/targets.mjs`** задано **`capture: 'viewport'`** — снимается **видимое окно** (~высота 900px), а не вся простыня >10 000px `fullPage`, которую Docusaurus сжимает до «серой полоски». Дашборд, мои сайты, проекты, настройки и макеты — **`capture: 'full'`** (страница умеренной высоты). Полностраничная съёмка всего: задайте в цели `capture: 'full'` или временно поменяйте в `targets.mjs`.

## Про `manual.png`

Главная **веб-справка** в браузере открывается по **`/docs/`** уже внутри приложения (после входа), с cookie. Скрипт съёмки ходит в headless Chromium **без** этой сессии: при попытке открыть настоящий **`/docs/`** с базой приложения получается **петля редиректов** (session-bridge к логину и обратно). Поэтому цель **`manual.png`** в **`e2e/targets.mjs`** зашита как **`/doc-screenshots/manual-sample.html`** — статическая страница «похоже на справку», без Docusaurus внутри. Это **не баг**: так в репозитории можно держать осмысленный скрин главной справки без секретов и без отдельного сервера только для доков. Остальные PNG — экраны панели **`/*.html`**, их можно снимать с кредами или с макетов, см. таблицу ниже.

## Почему на `/docs/` скрины «не как в панели»

В git по умолчанию лежат PNG, снятые **без** логина в приложение: тогда Playwright открывает **`/doc-screenshots/*-sample.html`** — это **упрощённые статические макеты** (тот же CSS-темы, но не те же данные, не весь JS и не все блоки). Они нужны для **воспроизводимой** справки без секретов в CI.

**Как в старой документации «v1» с реальным интерфейсом:** один раз (или перед релизом) поднимите **`npm start`**, задайте учётку и выполните съёмку с **настоящими** страницами `/*.html`, затем закоммитьте обновлённые файлы в **`docs-docusaurus/static/screenshots/`** и пересоберите доки. Тогда картинки в текстах совпадут с тем, что видит пользователь в панели.

**Жёстко запретить макеты** (сразу ошибка, если нет кредов):

```bash
npm run docs:capture-screenshots:real
```

(эквивалент: `DOCS_CAPTURE_REAL_ONLY=1` перед `npm run docs:capture-screenshots`).

Дополнительная пауза перед затвором (мс), если нужно дольше ждать тяжёлые экраны: **`DOCS_CAPTURE_SETTLE_MS`** (по умолчанию для живых страниц ~2200, для макетов ~650).

## Зачем отдельный шаг

- Справка собирается **`docusaurus build`** в `public/docs/` **целиком**; если класть PNG только в `public/docs/screenshots/` без исходников в `static/`, следующая сборка **затрёт** файлы.
- Хранение в **`docs-docusaurus/static/screenshots/`** даёт воспроизводимый git-артефакт и стабильные URL **`/docs/screenshots/*.png`**.

## Установка зависимостей

1. Зависимости **Docusaurus** (в т.ч. `@playwright/test`):

```bash
npm run docs:docusaurus:install
```

2. Бинарник **Chromium** для Playwright (из корня репозитория):

```bash
npm run docs:install-browsers
```

При сообщении «Executable doesn't exist» повторите `docs:install-browsers` или из каталога `docs-docusaurus`: `npm run capture-screenshots:install`.

## Запуск приложения

В отдельном терминале:

```bash
npm start
```

По умолчанию скрипт съёмки ходит на **`http://127.0.0.1:3000`** — это можно переопределить переменной **`DOCS_BASE_URL`**.

## Команда съёмки

**Интерактивно** (в терминале рамка с теми же шагами команд: `npm start` → съёмка → `docs:docusaurus:build`, плюс логин; **Enter** на логине — только макеты; пароль **не печатается** на экран):

```bash
cd /path/to/p.datagon.ru
npm run docs:capture-screenshots
npm run docs:docusaurus:build
```

То же из каталога **`docs-docusaurus`**: `npm run capture-screenshots`.

**Без запросов** (удобно для CI и скриптов):

```bash
DOCS_USER=ваш_логин DOCS_PASSWORD='ваш_пароль' npm run docs:capture-screenshots
npm run docs:docusaurus:build
```

Если задан только **`DOCS_USER`**, пароль всё равно спросят в терминале (если это интерактивный TTY).

Без логина (Enter или пустые переменные) экраны панели снимаются со **статических макетов** **`/doc-screenshots/*-sample.html`**. С кредами — с настоящих **`/*.html`**; если после входа снова редирект на логин, для целей с `pathNoAuth` срабатывает макет.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|------------|----------------|------------|
| `DOCS_BASE_URL` | `http://127.0.0.1:3000` | базовый URL приложения |
| `DOCS_USER` | пусто | логин для `POST /api/auth/login` |
| `DOCS_PASSWORD` | пусто | пароль |
| `DOCS_VIEWPORT` | `1400` | ширина окна (высота у скрипта фиксирована 900) |
| `DOCS_CAPTURE_REAL_ONLY` | пусто | если `1` / `true` / `yes` — без `DOCS_USER`+`DOCS_PASSWORD` съёмка **не стартует** (никаких макетов) |
| `DOCS_CAPTURE_SETTLE_MS` | авто | пауза перед скриншотом (мс); по умолчанию больше для живых страниц, меньше для макетов |
| `DOCS_CAPTURE_DPR` | `1` | плотность пикселей Chromium (`1` или `2`); `2` даёт более крупные файлы |

## Какие файлы получаются

| Файл | URL, который открывается | Кадр (`e2e/targets.mjs`) |
|------|---------------------------|-------------------------|
| `manual.png` | `/doc-screenshots/manual-sample.html` (без cookie реальный `/docs/` даёт петлю редиректов) | full |
| `dashboard.png` | `/dashboard.html` при входе; без пароля — `/doc-screenshots/dashboard-sample.html` | full |
| `queue.png` | `/queue.html` / `queue-sample.html` | viewport |
| `mysites.png` | `/my-sites.html` / `mysites-sample.html` | full |
| `myproducts.png` | `/my-products.html` / `myproducts-sample.html` | viewport |
| `moysklad.png` | `/moysklad.html` / `moysklad-sample.html` | viewport |
| `projects.png` | `/projects.html` / `projects-sample.html` | full |
| `results.png` | `/results.html` / `results-sample.html` | viewport |
| `matches.png` | `/matches.html` / `matches-sample.html` | viewport |
| `processes.png` | `/processes.html` / `processes-sample.html` | viewport |
| `settings.png` | `/settings.html` / `settings-sample.html` | full |

После `npm run docs:capture-screenshots` без пароля макеты дают читаемый кадр (для табличных целей — **viewport**, не вся высота макета). Микро-заглушки 1×1 возможны только если съёмка не запускалась или цель упала по timeout.

## Если съёмка падает с ошибкой

- **Timeout** при `goto` — сервер не запущен, неверный порт, VPN.
- **Login failed** — проверьте креды; убедитесь, что `POST /api/auth/login` с тем же телом работает через `curl` (см. [главная FAQ](/docs/) п.1).
- **Chromium** не стартует — переустановите браузеры Playwright.

## Статические макеты (без пароля)

Для репозитория без секретов скрипт использует HTML-страницы, не требующие сессии:

| PNG | Макет на сервере (`/doc-screenshots/…`) |
|-----|------------------------------------------|
| `manual.png` | `manual-sample.html` |
| `dashboard.png` | `dashboard-sample.html` |
| `queue.png` | `queue-sample.html` |
| `mysites.png` | `mysites-sample.html` |
| `myproducts.png` | `myproducts-sample.html` |
| `moysklad.png` | `moysklad-sample.html` |
| `projects.png` | `projects-sample.html` |
| `results.png` | `results-sample.html` |
| `matches.png` | `matches-sample.html` |
| `processes.png` | `processes-sample.html` |
| `settings.png` | `settings-sample.html` |

Исходники лежат в **`static-html/vanilla/doc-screenshots/`** и копируются в `public/` через `npm run sync:vanilla-public`. В `server.js` путь `/doc-screenshots/` исключён из редиректа на логин.

## Отладка Playwright

- **`PWDEBUG=1`** перед командой или **`npm run capture-screenshots -- --debug`** (из `docs-docusaurus`) — пошаговый запуск.
- Временно в **`playwright.config.mjs`** в проекте `chromium` можно добавить `launchOptions: { headless: false }`, чтобы видеть браузер.
- **`npx playwright install chromium`** в каталоге `docs-docusaurus` — если «Executable doesn't exist».
- Для каждого PNG открывается **новая страница** в одном **browser context** (сессия входа переиспользуется между кадрами).

## После съёмки

1. Просмотрите PNG в `docs-docusaurus/static/screenshots/` (нет ли пустых/логин-страниц).
2. Закоммитьте файлы в git при необходимости.
3. На сервере выполните деплой вместе с `public/docs/` после `npm run docs:docusaurus:build`.
