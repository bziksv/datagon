'use strict';

/**
 * Денорм габаритов МС из attributes карточки → колонки ms_entity_details.
 * Нужен для быстрого SQL-фильтра «проблемные товары» на /exports-dimensions
 * без скана payload_json по десяткам тысяч строк.
 */

const DIM_ATTRS = [
    { key: 'packing_type', attr: '!!Тип УПАКОВКИ', kind: 'string' },
    { key: 'length_cm', attr: '!!Длина (см) КОРОБКА/Пакет станд. уп.', kind: 'number' },
    { key: 'width_cm', attr: '!!Ширина (см) КОРОБКА/Пакет станд. уп.', kind: 'number' },
    { key: 'height_box_cm', attr: '!!Высота (см) КОРОБКА станд. уп.', kind: 'number' },
    { key: 'height_bag_cm', attr: '!!Высота (см) Пакет!', kind: 'number' },
    { key: 'weight_kg', attr: '!!Вес (кг)', kind: 'number' },
];

function extractAttrRaw(payload, attrName) {
    if (!payload || !Array.isArray(payload.attributes)) return '';
    const a = payload.attributes.find((x) => x && x.name === attrName);
    if (!a) return '';
    const v = a.value;
    if (v == null) return '';
    if (typeof v === 'object') {
        if (typeof v.name === 'string') return v.name;
        return '';
    }
    return String(v);
}

function parseNum(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).trim().replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {object|null} entity — объект сущности МС или распарсенный payload_json
 * @returns {{
 *   denorm_dim_packing_type: string|null,
 *   denorm_dim_length_cm: number|null,
 *   denorm_dim_width_cm: number|null,
 *   denorm_dim_height_box_cm: number|null,
 *   denorm_dim_height_bag_cm: number|null,
 *   denorm_dim_weight_kg: number|null,
 * }}
 */
function computeMsEntityDimsDenorm(entity) {
    const empty = {
        denorm_dim_packing_type: null,
        denorm_dim_length_cm: null,
        denorm_dim_width_cm: null,
        denorm_dim_height_box_cm: null,
        denorm_dim_height_bag_cm: null,
        denorm_dim_weight_kg: null,
    };
    if (!entity || typeof entity !== 'object') return empty;

    const out = { ...empty };
    for (const def of DIM_ATTRS) {
        const raw = extractAttrRaw(entity, def.attr);
        if (def.kind === 'string') {
            const s = String(raw || '').trim();
            out.denorm_dim_packing_type = s ? s.slice(0, 255) : null;
        } else if (def.key === 'length_cm') {
            out.denorm_dim_length_cm = parseNum(raw);
        } else if (def.key === 'width_cm') {
            out.denorm_dim_width_cm = parseNum(raw);
        } else if (def.key === 'height_box_cm') {
            out.denorm_dim_height_box_cm = parseNum(raw);
        } else if (def.key === 'height_bag_cm') {
            out.denorm_dim_height_bag_cm = parseNum(raw);
        } else if (def.key === 'weight_kg') {
            out.denorm_dim_weight_kg = parseNum(raw);
        }
    }
    return out;
}

/** Колонки для INSERT/UPDATE ms_entity_details. */
const DENORM_DIM_COLUMNS = [
    'denorm_dim_packing_type',
    'denorm_dim_length_cm',
    'denorm_dim_width_cm',
    'denorm_dim_height_box_cm',
    'denorm_dim_height_bag_cm',
    'denorm_dim_weight_kg',
    'denorm_dims_at',
];

module.exports = {
    DIM_ATTRS,
    DENORM_DIM_COLUMNS,
    computeMsEntityDimsDenorm,
};
