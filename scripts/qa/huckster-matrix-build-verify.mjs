/**
 * Регрессия логики матрицы Huckster: строка = объединение UID по кабинетам;
 * пустой UID/наименование в блоке кабинета, если позиции нет в данных этого кабинета.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildMatrix } = require('../../lib/hucksterBuildMatrix.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

const shops3 = [
    { id: 'ozon', name: 'Ozon', marketplace: 'ozon', shop_id: '1' },
    { id: 'wb', name: 'WB FBS', marketplace: 'wildberries', shop_id: '2' },
    { id: 'ym', name: 'ЯМ', marketplace: 'yandex', shop_id: '3' },
];

const rowOnlyWb = {
    uid: '371-2',
    name: 'Набор стоматологический…',
    updatedAt: '2026-01-01T12:00:00.000Z',
    repricerEnabled: true,
    inUnitModel: true,
    unitModelNames: 'M1',
};

// Сценарий как у пользователя: UID только в WB
const m1 = buildMatrix(
    shops3,
    {
        ozon: [],
        wb: [rowOnlyWb],
        ym: [],
    },
    '2026-05-07T00:00:00.000Z'
);
assert(m1.total_uids === 1, 'total_uids');
const dataRow1 = m1.rows[1];
assert(dataRow1[1] === '', `ozon uid expected "" when нет в repricer Ozon, got ${JSON.stringify(dataRow1[1])}`);
assert(dataRow1[2] === '', 'ozon name empty');
assert(dataRow1[3] === '—' && dataRow1[4] === '—' && dataRow1[5] === '—', 'ozon repricer/unit/models dashes');
assert(dataRow1[6] === '', 'sep before wb');
assert(dataRow1[7] === '371-2', 'wb uid');
assert(dataRow1[8] === rowOnlyWb.name, 'wb name');

// Тот же UID во всех кабинетах — все блоки заполнены
const m2 = buildMatrix(
    shops3,
    {
        ozon: [{ ...rowOnlyWb, name: 'Ozon copy' }],
        wb: [rowOnlyWb],
        ym: [{ ...rowOnlyWb, name: 'YM copy' }],
    },
    '2026-05-07T00:00:00.000Z'
);
const dataRow2 = m2.rows[1];
assert(dataRow2[1] === '371-2' && dataRow2[7] === '371-2', 'uid in ozon and wb');
assert(dataRow2[13] === '371-2', 'uid in ym (index 6 sep + 7 wb cols = 13 for ym uid)');

// Проверка индексов: [0]=updated, [1-5]=ozon, [6]=sep, [7-11]=wb, [12]=sep, [13-17]=ym, [18]=sync
assert(dataRow2[18] != null && String(dataRow2[18]).length > 0, 'sync column');

console.log('OK: huckster-matrix-build-verify');
