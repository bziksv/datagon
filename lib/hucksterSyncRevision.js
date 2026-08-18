'use strict';

/**
 * Ревизии скрипта синка Huckster (`routes/exportsHuckster.js`).
 * При изменении алгоритма (repricer/unit/мост МС) — новая строка + bump version.
 */
const HUCKSTER_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-05-26',
        matrix_kind: 'ms_bridge_v1',
        matrix_lost_kind: 'huckster_lost_v1',
        notes:
            'Repricer items/list и unit/set/get — пагинация limit=900; unit/set/list без offset; мост ms_export; набор 1 — фильтр Unit «онлайн»+«калькулятор».',
    },
    {
        revision: 2,
        version: '1.0.1',
        date: '2026-05-26',
        matrix_kind: 'ms_bridge_v1',
        matrix_lost_kind: 'huckster_lost_v1',
        notes:
            'Unit/repricer: offset += фактическая длина страницы; короткая страница (< limit) не конец, если cursor.total > offset (иначе терялись UID, напр. 3110 в модели ЯМ).',
    },
    {
        revision: 3,
        version: '1.0.2',
        date: '2026-06-02',
        matrix_kind: 'ms_bridge_v1',
        matrix_lost_kind: 'huckster_lost_v1',
        notes:
            'Unit-модели ЯМ: shop timeout 300s (было 90s) — полная пагинация нескольких unit/set по кабинету.',
    },
    {
        revision: 4,
        version: '1.0.3',
        date: '2026-08-18',
        matrix_kind: 'ms_bridge_v1',
        matrix_lost_kind: 'huckster_lost_v1',
        notes:
            'Сшивка кода МС с UID Huckster без учёта регистра (5041-KOMPLECT-2 ↔ 5041-komplect-2).',
    },
]);

const HUCKSTER_SYNC_CURRENT = HUCKSTER_SYNC_REVISIONS[HUCKSTER_SYNC_REVISIONS.length - 1];

const HUCKSTER_MATRIX_KIND = HUCKSTER_SYNC_CURRENT.matrix_kind;
const HUCKSTER_MATRIX_LOST_KIND = HUCKSTER_SYNC_CURRENT.matrix_lost_kind;

function getHucksterSyncMeta() {
    return {
        id: 'huckster-sync',
        version: HUCKSTER_SYNC_CURRENT.version,
        revision: HUCKSTER_SYNC_CURRENT.revision,
        matrix_kind: HUCKSTER_MATRIX_KIND,
        matrix_lost_kind: HUCKSTER_MATRIX_LOST_KIND,
        label: 'Синк Huckster',
        notes: HUCKSTER_SYNC_CURRENT.notes,
        date: HUCKSTER_SYNC_CURRENT.date,
    };
}

module.exports = {
    HUCKSTER_SYNC_REVISIONS,
    HUCKSTER_SYNC_CURRENT,
    HUCKSTER_MATRIX_KIND,
    HUCKSTER_MATRIX_LOST_KIND,
    getHucksterSyncMeta,
};
