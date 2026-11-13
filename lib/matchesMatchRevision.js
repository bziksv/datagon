'use strict';

/**
 * Ревизии алгоритма сопоставления (`routes/matches.js`).
 * Новая строка — когда меняется смысл пар или балла (режимы, порог токенов, окончания).
 */
const MATCHES_MATCH_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-11-13',
        notes:
            'Режим name_words: схожесть по словам без учёта порядка; лёгкий допуск на окончания (короткий хвост, у длинных слов до 3 правок). Короткие токены и числа — только точное совпадение. Режим name (Левенштейн строки) без изменений.',
    },
    {
        revision: 2,
        version: '1.1.0',
        date: '2026-11-13',
        notes: 'Режим name_words: порог сохранения пары 75% (было 85%). Остальные режимы без изменений.',
    },
    {
        revision: 3,
        version: '1.2.0',
        date: '2026-11-13',
        notes:
            'match_type: ENUM auto_* → VARCHAR sku/name/manual (фикс «100% по SKU» при score=1). Пропуск товаров с уже confirmed парой у того же конкурента.',
    },
    {
        revision: 4,
        version: '1.2.1',
        date: '2026-11-13',
        notes:
            'name_words: одиночные цифры в токенах; непарная цифра/версия → 0 (МикроТимп-3 ≠ -2, ОТОКОНЦЕПТ-4 ≠ -3).',
    },
    {
        revision: 5,
        version: '1.2.2',
        date: '2026-11-13',
        notes:
            'Режим name («Только название»): индекс exact + бакеты по длине, реже yield — быстрее на больших прайсах без смены формулы схожести.',
    },
    {
        revision: 6,
        version: '1.2.3',
        date: '2026-11-13',
        notes:
            'Режим name: кандидаты = пересечение длины с токенами/prefix4 (балл по-прежнему Левенштейн строки). Иначе 5–8k LD на товар.',
    },
    {
        revision: 7,
        version: '1.2.4',
        date: '2026-11-13',
        notes:
            'Режим name: откат узкого token/prefix-prefilter — снова кандидаты по бакетам длины (как rev.5), полный recall при пороге 85%.',
    },
]);

const MATCHES_MATCH_CURRENT = MATCHES_MATCH_REVISIONS[MATCHES_MATCH_REVISIONS.length - 1];

function getMatchesMatchMeta() {
    return {
        id: 'matches-match',
        version: MATCHES_MATCH_CURRENT.version,
        revision: MATCHES_MATCH_CURRENT.revision,
        label: 'Сопоставление',
        notes: MATCHES_MATCH_CURRENT.notes,
        date: MATCHES_MATCH_CURRENT.date,
    };
}

module.exports = {
    MATCHES_MATCH_REVISIONS,
    MATCHES_MATCH_CURRENT,
    getMatchesMatchMeta,
};
