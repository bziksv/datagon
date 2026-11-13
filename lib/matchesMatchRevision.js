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
