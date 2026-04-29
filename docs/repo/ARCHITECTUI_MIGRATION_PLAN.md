# Переход Datagon на ArchitectUI React PRO

Цель: поэтапно перенести интерфейс Datagon на `architectui-react-pro` без остановки работы текущего приложения.

## Что считаем источником

- Базовый UI-source-of-truth: `architectui-react-pro/src/**`.
- Текущий Datagon backend/API остается в `server.js` + `routes/**`.
- На первом этапе переносится только фронтенд-слой.

## Принцип миграции

1. Не делаем big-bang переписывание всего UI сразу.
2. Стартуем с параллельного React-frontend, который работает с текущими `/api/...`.
3. Переносим экраны блоками по приоритету нагрузки и бизнес-ценности.
4. Держим старый `public/*.html` как fallback до конца миграции.

## Этап 0. Подготовка (1-2 дня)

- [ ] Зафиксировать целевые UX-паттерны из ArchitectUI (sidebar/topbar/cards/tables/forms/status badges).
- [ ] Составить mapping: `public/*.html` -> будущие React routes.
- [ ] Определить общие UI-модули: layout, data table wrapper, filter panel, action toolbar, status widgets.
- [ ] Согласовать стратегию auth (reuse текущей сессии/cookie или token bridge).

Deliverables:
- Документ route-mapping;
- Набор UI-правил/примитивов.

## Route mapping (legacy -> React)

Ниже целевое соответствие экранов текущего UI и будущих React-роутов на базе ArchitectUI.

| Legacy экран | Новый route | React-страница (предложение) | Приоритет |
|---|---|---|---|
| `public/index.html` | `/dashboard` | `src/pages/Dashboard/OverviewPage.tsx` | P1 |
| `public/mysites.html` | `/my-sites` | `src/pages/MySites/MySitesPage.tsx` | P2 |
| `public/myproducts.html` | `/my-products` | `src/pages/MyProducts/MyProductsPage.tsx` | P1 |
| `public/moysklad.html` | `/moysklad` | `src/pages/Moysklad/MoyskladPage.tsx` | P1 |
| `public/matches.html` | `/matches` | `src/pages/Matches/MatchesPage.tsx` | P1 |
| `public/queue.html` | `/queue` | `src/pages/Queue/QueuePage.tsx` | P2 |
| `public/results.html` | `/results` | `src/pages/Results/ResultsPage.tsx` | P2 |
| `public/projects.html` | `/projects` | `src/pages/Projects/ProjectsPage.tsx` | P3 |
| `public/processes.html` | `/processes` | `src/pages/Processes/ProcessesPage.tsx` | P3 |
| `public/settings.html` | `/settings` | `src/pages/Settings/SettingsPage.tsx` | P2 |
| `public/docs/manual.html` | `/docs` | `src/pages/Docs/DocsPage.tsx` (или external link) | P4 |

## Детализация P1-экранов (что переносим в первую волну)

### `/my-products`

- Фильтры: `site_id`, `status`, `source_enabled`, `ms_linked`, `search`, `limit/offset`.
- Статистика/бейджи из `/api/my-products/stats`.
- Таблица с действиями:
  - `POST /api/my-products/refresh-one`
  - `POST /api/my-products/sync-price-from-competitor`
- Сервисные действия:
  - `GET /api/my-products/fx-rates`
  - `POST /api/sync-all-start`
  - `POST /api/ms/rebuild-links-cache`

### `/moysklad`

- Фильтры: `type`, `archived`, `stock_position`, `on_site`, `search`, `limit/offset`.
- Метрики: `/api/ms/stats`.
- Статус джобы: `/api/ms/status`.
- Таблица: `/api/ms/export`.
- Действия:
  - `POST /api/ms/sync`
  - `POST /api/ms/stop`
  - `POST /api/ms/rebuild-links-cache`

### `/matches`

- Выбор `my_site`, список конкурентов.
- Запуск/продолжение/остановка:
  - `POST /api/matches/start-matching`
  - `POST /api/matches/retry-last`
  - `POST /api/matches/stop`
- Статус джобы: `GET /api/matches/status`.
- Таблица сопоставлений: `GET /api/matches/list`.
- Действия строк:
  - `POST /api/matches/confirm`
  - `POST /api/matches/reject`
  - `POST /api/matches/unlink`

## Предлагаемая структура React-модулей

```text
src/
  app/
    router.tsx
    layout/
      AppShell.tsx
      Sidebar.tsx
      Header.tsx
  shared/
    api/
      client.ts
      myProducts.ts
      moysklad.ts
      matches.ts
    ui/
      DataTable/
      FilterBar/
      StatCards/
      StatusBadge/
  pages/
    MyProducts/
    Moysklad/
    Matches/
    ...
```

## Очередность внедрения (практический порядок)

1. Каркас и роутинг (`/dashboard`, `/my-products`, `/moysklad`, `/matches`).
2. Полный перенос `my-products` (самый частый операционный экран).
3. Полный перенос `moysklad`.
4. Полный перенос `matches`.
5. После P1 — `settings`, `queue`, `results`, `mysites`.

## Definition of Ready для старта реализации

- [ ] Подтвержден final route mapping.
- [ ] Подтверждено, что ArchitectUI — единственный UI-source.
- [ ] Согласованы требования parity для P1 (что обязательно 1:1, а что можно улучшить).
- [ ] Зафиксирован plan переключения пользователей на новый UI поэтапно.

## Этап 1. Каркас React-приложения (2-4 дня)

- [ ] Поднять React-app на базе `architectui-react-pro`.
- [ ] Настроить layout (sidebar/topbar/content shell) строго по шаблону.
- [ ] Подключить API-client для Datagon (`/api/...`), базовый error handling.
- [ ] Реализовать guard авторизации и logout.

Deliverables:
- Рабочий shell;
- Router + protected routes;
- API service layer.

## Этап 2. Перенос приоритетных экранов (1-2 недели)

Приоритет:
1) `Мои товары`  
2) `МойСклад`  
3) `Сопоставление`  
4) `Очередь`  
5) `Результаты`  
6) Остальные.

Для каждого экрана:
- [ ] Фильтры + таблицы + действия + статусы;
- [ ] Пагинация/сортировка/скрытие столбцов;
- [ ] Отработка edge-cases и ошибок API;
- [ ] Визуальное соответствие ArchitectUI.

Deliverables:
- Экран в React с parity по функционалу;
- Чеклист функционального соответствия старому экрану.

## Этап 3. Переход в эксплуатацию (3-5 дней)

- [ ] Канареечный запуск для ограниченного круга пользователей.
- [ ] Сбор обратной связи и фиксы.
- [ ] Переключение default entrypoint на React UI.
- [ ] Legacy `public/*.html` оставить в read-only режиме на переходный период.

Deliverables:
- Новый UI как основной;
- План отката на legacy.

## Этап 4. После перехода

- [ ] Удалить/заморозить дублирующий legacy UI.
- [ ] Обновить `README.md`, `docs/repo/API.md`, `public/docs/*`.
- [ ] Добавить smoke e2e на ключевые user-flows (myproducts/moysklad/matches).

## Риски и как снижать

- Риск: несовпадение поведения старых и новых экранов.  
  Решение: parity-чеклист на каждый экран + поэтапный релиз.

- Риск: перегрузка API из-за нового фронта.  
  Решение: reuse текущих кешей/TTL, контроль polling, профилирование SQL.

- Риск: затяжной переход.  
  Решение: строгий scope per-экран и промежуточные релизы.

## Definition of Done (миграции)

- Все критичные сценарии (очередь, результаты, myproducts, moysklad, matches) работают в React UI.
- UX/визуал соответствуют ArchitectUI.
- Производительность не хуже текущей (или лучше) по целевым операциям.
- Legacy отключен или оставлен только как аварийный fallback.

## Где актуальный статус (2026-04-29)

Матрица паритета 3000↔React, cutover, **smoke-сборка** (`npm install` + `npm run build` в `architectui-react-pro`), обновлённый **`README.md`**, HTTP-smoke по shell и **`npm run test:datagon-smoke-e2e`** (`scripts/qa/datagon-smoke-e2e.mjs`) живут в этом репозитории **`p.datagon.ru`** (раньше дублировались в отдельной папке `p.datagon.3003-final`).
