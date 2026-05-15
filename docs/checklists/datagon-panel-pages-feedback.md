# Чек-лист страниц панели Datagon — обратная связь по действиям

Источник списка страниц: `lib/datagonPageRegistry.js` (`PAGE_DEFS`).

Цель: пользователь **сразу видит**, что клик сработал (`DatagonNotify`, `busyRun`, inline-баннеры настроек; на `login` — нативные диалоги).

**Автопроверка A и B:** после `npm run sync:vanilla-public`:

```bash
npm run check:panel-notify-static
```

Скрипт: `scripts/check-panel-notify-static.mjs` (добавлен в `package.json`).

## Критерии

| Код | Что проверяем |
|-----|----------------|
| **A** | В собранном `public/*.html`: `datagon-vanilla.js` и `datagon-vanilla-shell`. Исключения: `login.html`, `no-access.html` — см. журнал. |
| **B** | Число `data-dg-notify-start` в HTML. `0` допустим, если нет тяжёлых кнопок (например, `/sections.html`). |
| **C** | Вручную в браузере: 1–2 «тяжёлые» кнопки — тост / баннер / блокировка без «молчания». |

## Страницы: A+B (авто) и C (ручная)

Отметьте **C** после смоука.

- [x] **dashboard** — `/dashboard.html` — C: [ ]
- [x] **my-sites** — `/my-sites.html` — C: [ ]
- [x] **my-products** — `/my-products.html` — C: [ ]
- [x] **moysklad** — `/moysklad.html` — C: [ ]
- [x] **purchase** — `/purchase.html` — C: [ ]
- [x] **product** — `/product.html` — C: [ ]
- [x] **projects** — `/projects.html` — C: [ ]
- [x] **queue** — `/queue.html` — C: [ ]
- [x] **results** — `/results.html` — C: [ ]
- [x] **matches** — `/matches.html` — C: [ ]
- [x] **processes** — `/processes.html` — C: [ ]
- [x] **settings** — `/settings.html` — C: [ ]
- [x] **sections** — `/sections.html` — C: [ ] (каталог ссылок, B=0)
- [x] **exports-marketplaces** — `/exports-marketplaces.html` — C: [ ]
- [x] **exports-marketplaces-ozon** — `/exports-marketplaces-ozon.html` — C: [ ]
- [x] **exports-marketplaces-wildberries** — `/exports-marketplaces-wildberries.html` — C: [ ]
- [x] **exports-marketplaces-yandex** — `/exports-marketplaces-yandex.html` — C: [ ]
- [x] **exports-dimensions** — `/exports-dimensions.html` — C: [ ]
- [x] **exports-marketplaces-issues** — `/exports-marketplaces-issues.html` — C: [ ]
- [x] **exports-huckster** — `/exports-huckster.html` — C: [ ]
- [x] **ms-sales** — `/ms-sales.html` — C: [ ]

### Вне PAGE_DEFS

- [x] **login** — `/login.html` — C: [ ] (без `datagon-vanilla.js`, ожидаемо)
- [x] **no-access** — `/no-access.html` — C: [ ]

### Низкий приоритет

- [ ] `public/ref/*.html` — выравнивание с панелью по необходимости.

---

## Журнал автопроверки

Дата: **2026-05-13** (`npm run sync:vanilla-public` → `npm run check:panel-notify-static`).

| Файл | A | B | Примечание |
|------|---|---|------------|
| dashboard.html | ok | 4 | |
| my-sites.html | ok | 4 | |
| my-products.html | ok | 6 | |
| moysklad.html | ok | 6 | |
| purchase.html | ok | 4 | |
| product.html | ok | 2 | «Применить» периода продаж + ручная запись нулей; `dg-prod-ov-save` — атрибут из JS |
| projects.html | ok | 4 | |
| queue.html | ok | 10 | |
| results.html | ok | 4 | |
| matches.html | ok | 8 | |
| processes.html | ok | 7 | +«По умолчанию», сброс фильтров журнала; остановка МС — явный `DatagonNotify` в скрипте |
| settings.html | ok | 27 | |
| sections.html | ok | 0 | каталог ссылок |
| exports-marketplaces.html | ok | 1 | «Сохранить ключи» |
| exports-marketplaces-ozon.html | ok | 2 | |
| exports-marketplaces-wildberries.html | ok | 2 | |
| exports-marketplaces-yandex.html | ok | 2 | |
| exports-dimensions.html | ok | 8 | |
| exports-marketplaces-issues.html | ok | 4 | |
| exports-huckster.html | ok | 1 | |
| ms-sales.html | ok | 6 | |
| login.html | ok(exp) | 0 | без DatagonNotify |
| no-access.html | ok(exp) | 0 | минимальная страница |

### Продолжение той же сессии

- Карточка товара: `data-dg-notify-start` на «Записать вручную за сегодня»; при сборке формы закупок — на «Сохранить параметры».
- Процессы: после успешной остановки МС / ошибки — `DatagonNotify.toast` вместо только `alert`; мгновенные тосты на «По умолчанию» (фильтры) и сброс фильтров журнала действий.
