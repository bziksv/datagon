---
id: dashboard
title: Дашборд
description: Оперативный обзор очередей, синхронизаций, размера БД и диска
---

Страница **`/dashboard.html`** — первый пункт бокового меню («Дашборд»). Ключ матрицы специальностей: **`dashboard`**. Редирект с `/` и `/dashboard` ведёт сюда. Логотип в шапке тоже открывает дашборд.

Карта меню: [Карта панели](/docs/panel-map/). Подробный HTTP — [REST API → Обзор процессов](/docs/api/#обзор-процессов).

## Как пользоваться

1. Откройте `/dashboard.html` (нужен вход в панель).
2. **Обновить** (`#dashboard-refresh`) — перечитывает сводку (`GET /api/processes/overview`).
3. **Обновить размер БД** — `GET /api/processes/db-size?refresh=1` (иначе суточный/короткий кэш).
4. Блок **Дисковое пространство** — разбивка каталогов проекта и ФС; **Пересчитать** → `GET /api/processes/disk-usage?refresh=1`. Карточку можно свернуть (`localStorage`).
5. **Синхронизировать всё** — `POST /api/sync-all-start` (фоновый глобальный синк источников); кнопка с тостом/`busyRun`.

Метрики на экране (из overview): очередь парсинга (всего / готово / ошибки) и «здоровье», прогресс глобального синка и МойСклад, сопоставление, runtime (CPU/RAM/uptime), краткий список автосинков за сегодня.

## Доступ и API

| Действие UI | Метод | Ключ матрицы API |
|-------------|--------|------------------|
| HTML дашборда | — | `dashboard` |
| Размер БД | `GET /api/processes/db-size` | **`dashboard`** |
| Диск | `GET /api/processes/disk-usage` | **`dashboard`** |
| Сводка / очереди / синки | `GET /api/processes/overview` | **`processes`** (Активность/Логи) |
| Синхронизировать всё | `POST /api/sync-all-start` | **`settings`** |

Важно: чтобы карточки «Сводка», прогресс синков и матчинга заполнялись, у специальности нужен доступ к **`processes`** не хуже `view`. Иначе HTML дашборда откроется, а overview вернёт 403. Кнопка «Синхронизировать всё» требует **`settings`** = `full` (изменяющий метод).

Автозадача `db_size` в [Настройках](/docs/settings/) раз в сутки обновляет и размер БД, и разбивку диска (см. [Логи](/docs/processes/)).

## Файлы

- UI: `static-html/vanilla/inners/dashboard.{inner,scripts,head}.html` → `public/dashboard.html`
- API overview / db-size / disk-usage: `server.js`
- Реестр: `lib/datagonPageRegistry.js` (`dashboard`)
