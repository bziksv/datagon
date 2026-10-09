---
id: network-prices
title: Цены сети
description: Эталонный сайт → целевые витрины с наценкой/скидкой %; матрица, связь артикулов, запись в CMS
---

Страница **`/network-prices.html`** — перенос цен с **эталона** (по умолчанию Альмамед, `app_settings.network_prices_source_site_id`) на целевые сайты с заданным `%`. Карта: [Карта панели](/docs/panel-map/). API: `/api/network-prices` → `routes/networkPrices.js` — [REST API → Цены сети](/docs/api/#цены-сети).

## Доступ

Ключ матрицы — **`network-prices`**.

| Режим | Что доступно |
|-------|----------------|
| **`hidden`** | HTML и `/api/network-prices` недоступны |
| **`view`** | Настройки/матрица/лог — GET; запись, apply, link/unlink, activate/deactivate — нет |
| **`full`** | `%` сайтов, связи, задачи контенту, apply (с confirm), деактивация на сателлите |

## Правило цены

1. Сайт с `enabled=0` или `price_pct` NULL — **пропуск**.
2. Эталон EUR/USD → RUB (курс ЦБ, как «Мои товары»), затем `proposed = round(source_rub × (1 + price_pct/100))`.
3. **Эталон 0 → всегда пишем 0** на сателлит («цена по запросу»).
4. Если живая цена сайта **> 0** — пишем только при расхождении с `proposed` **> 3%**.
5. Пустой эталон (не число) — не пишем. **Остаток** в v1 только в матрице, в CMS не уходит.
6. После пакета на Bitrix — `cache_clear.php` на домене сателлита.

Связь пар: ручная (`network_product_links`) или авто по одинаковому артикулу, пока нет `network_product_link_ignore`.

## Как пользоваться

1. Блок настроек: эталон + `%` / вкл. по целевым сайтам → сохранить (`POST /settings`).
2. Выберите **целевой сайт**, фильтры связи (`all` / `linked` / …), поиск → **«Применить»** (матрица только после этого; не на каждый `input`).
3. Связь: ручной link (модалка) / unlink (ignore + confirm). Задача **контент-отделу** — `POST /content-task`.
4. **«Применить цены»** — своя confirm-модалка (`#dg-npr-confirm-overlay`); сначала можно dry-run. Итог — `#dg-np-action-log` (scanned / written / skipped / errors / duration). Фоновый прогон: `GET /apply-status`, **Остановить** → `POST /apply-stop`.
5. Выкл. на сателлите / Включить — confirm; Bitrix гасит `ACTIVE` + кэш, Webasyst — `status`.
6. Микрокнопка **«лог»** на строке → `#dg-npr-row-log-overlay` (`GET /action-log`).

## Автосинк

`task: 'network_prices'` — карточка на [Настройках](/docs/settings/) (`auto_sync_network_prices_*`, default **11:00** МСК), журнал на [Активность / Логи](/docs/processes/). Runner: `triggerNetworkPricesSyncFromSettings` — все enabled-сайты с заданным `%`.

## Связь с другими разделами

- [Мои сайты](/docs/mysites/) — источники CMS.
- [Мои товары](/docs/myproducts/) — локальный кэш; живая цена цели в матрице берётся из CMS, не только из кэша.
