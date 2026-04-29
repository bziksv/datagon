---
id: matches
title: Сопоставление
---

Поиск и подтверждение пар «мой товар ↔ товар конкурента».

## Что есть в разделе

- выбор моего сайта и конкурентов;
- запуск автосопоставления (пакеты, паузы);
- список кандидатов с оценкой схожести;
- действия `Подтвердить` / `Отклонить`.

## Основные API

- `POST /api/matches/start-matching`
- `POST /api/matches/retry-last`
- `POST /api/matches/stop`
- `GET /api/matches/list`
- `POST /api/matches/confirm`
- `POST /api/matches/reject`
