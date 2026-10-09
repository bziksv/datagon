---
id: login
title: Вход и нет доступа
description: /login.html и /no-access.html — сессия, редирект then, матрица страниц
---

Служебные экраны **вне** `PAGE_DEFS` и бокового меню. Карта: [Карта панели](/docs/panel-map/). API: [Auth](/docs/api/#auth).

## `/login.html`

Форма входа (standalone HTML, **без** оболочки `.datagon-vanilla-shell` и без `DatagonNotify`). Исходник: `static-html/vanilla/login.html` → `public/login.html` (`sync:vanilla-public`).

### Поведение

1. Query **`?then=/path.html`** — желаемый URL после входа (сохраняется и уходит в `POST /api/auth/login` как `then`).
2. При уже валидной сессии страница сразу зовёт `GET /api/auth/me?then=…` и делает `location.replace` на `redirect_after_login`.
3. Успешный логин: `localStorage` (`authToken`, `currentUser`, `page_modes`…), затем `POST /api/auth/sync-session-cookie` (httpOnly `dg_session`), редирект на `redirect_after_login`.
4. Ошибки (неверный пароль, архивный пользователь → 403) — inline `.dg-login-error` (не toast).
5. Ссылки на юридические страницы `/legal/*` в подвале; cookie-баннер для неавторизованных — см. [deploy](/docs/deploy/).

### `redirect_after_login`

Сервер (`resolveRedirectAfterLogin` / `lib/datagonPageRegistry.js`):

- учитывает `then`, только если путь безопасный и страница **не скрыта** для актора;
- `/product.html` без `?code=` — **не** принимается как цель;
- иначе — первая доступная страница из `PAGE_DEFS` (кроме `product.html`);
- если матрица закрыла всё → **`/no-access.html`** (не цикл login ↔ dashboard).

Большинство HTML панели без сессии редиректят на `/login.html?then=…` (`server.js`).

## `/no-access.html`

Показывается, когда у пользователя **нет ни одной** открытой страницы панели, либо сервер отправил сюда при попытке открыть скрытый HTML. Исходник: `static-html/vanilla/no-access.html`.

- Кнопка **«Выйти»** → `POST /api/auth/logout` + очистка `localStorage` → `/login.html`.
- Исправление доступа: admin → [Настройки](/docs/settings/) → специальности → матрица «Страницы и API».

## Auth API (кратко)

| Метод | Назначение |
|-------|------------|
| `POST /api/auth/login` | `{ username, password, then? }` → token + `page_modes` + `redirect_after_login` |
| `POST /api/login` | legacy-алиас |
| `GET /api/auth/me?then=` | текущий актор + тот же `redirect_after_login` |
| `POST /api/auth/sync-session-cookie` | выставить httpOnly cookie по token |
| `POST /api/auth/logout` | выход |

Префикс `/api/auth/login` в `API_PREFIX_RULES` → `null` (без page-lock). Остальные `/api/*` требуют сессию.

Архивный пользователь (`is_archived=1`) не входит. Подробности CRUD пользователей и специальностей — [api.md → Auth](/docs/api/#auth) и [settings](/docs/settings/).
