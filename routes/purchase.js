'use strict';

/**
 * Закупки — страница планирования закупок поверх ms_export.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Дополнительные сырые поля (артикул, packagings, в пути / inTransit) —
 *     из `ms_entity_details.payload_json` (JSON ответа entity/product|bundle).
 *   • Редактируемые значения (Неснижаемый остаток Датагон / Кратность товара /
 *     Мин.Остаток сч.как / Предлагаемый нес.остаток) хранятся в отдельной
 *     таблице `dg_purchase_overrides` (PK = code), чтобы синк МС не затирал
 *     их и схема ms_export не разрасталась.
 *   • Фильтр по умолчанию (по требованию пользователя):
 *       is_archived = 0 (только активные)
 *       stock_position = 'да' (только складская позиция)
 *       type = 'Товар' (исключаем комплекты)
 *
 * Эндпоинты:
 *   GET    /api/purchase            — список товаров с overrides и raw-полями.
 *   POST   /api/purchase/override   — сохранить одно значение (code + field + value).
 *
 * См. правила:
 *   .cursor/rules/datagon-list-page-baseline-moysklad.mdc
 *   .cursor/rules/datagon-list-query-patterns.mdc
 *   .cursor/rules/datagon-table-filter-apply.mdc
 *   .cursor/rules/datagon-node-restart-lock.mdc
 *   .cursor/rules/datagon-documentation-sync.mdc
 */

const express = require('express');

let schemaReady = false;

const OVERRIDE_FIELDS = new Set([
    'min_stock_dg',
    'multiplicity',
    'min_stock_calc_as',
    'proposed_min_stock',
    'pack_qty_manual'
]);

const ALLOWED_SORT = {
    code: 'mse.code',
    article: 'article_sort',
    name: 'mse.name',
    supplier: 'mse.supplier',
    buy_price: 'buy_price_num',
    min_stock: 'mse.min_stock',
    automation_price: 'mse.automation_price',
    min_stock_dg: 'po.min_stock_dg',
    multiplicity: 'po.multiplicity',
    min_stock_calc_as: 'po.min_stock_calc_as',
    proposed_min_stock: 'po.proposed_min_stock',
    stock: 'mse.stock',
    is_archived: 'mse.is_archived'
};

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_purchase_overrides (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            min_stock_dg DECIMAL(15,3) NULL DEFAULT NULL,
            multiplicity DECIMAL(15,3) NULL DEFAULT NULL,
            min_stock_calc_as DECIMAL(15,3) NULL DEFAULT NULL,
            proposed_min_stock DECIMAL(15,3) NULL DEFAULT NULL,
            pack_qty_manual DECIMAL(15,3) NULL DEFAULT NULL,
            note VARCHAR(500) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_purchase_overrides_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function parseFlexibleNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s.replace(/\s/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Безопасный парс payload_json одной строки ms_entity_details. */
function parsePayloadSafe(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

/** Кол-во штук в стандартной упаковке: ищем первый packaging с quantity > 1. */
function extractPackQty(payload) {
    if (!payload || !Array.isArray(payload.packagings)) return '';
    for (const pk of payload.packagings) {
        if (!pk) continue;
        const q = Number(pk.quantity);
        if (Number.isFinite(q) && q > 0) return q;
    }
    return '';
}

/** «Ожидание» поставки: МС возвращает поле inTransit в `report/stock/all`,
 *  но мы его не закэшировали в ms_export — вернём пустое и оставим место
 *  для будущего наполнения через расширение синка. */
function extractInTransit(_payload) {
    return '';
}

function buildSupplierLabel(s1Raw, s2Raw) {
    const s1 = String(s1Raw || '').trim();
    const s2 = String(s2Raw || '').trim();
    if (!s1 && !s2) return '';
    if (s1 && !s2) return s1;
    if (!s1 && s2) return s2;
    if (s1.toLowerCase() === s2.toLowerCase()) return s1;
    return `${s1}/${s2}`;
}

function createPurchaseRouter(db /* , appSettings */) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);

            const limitRaw = parseInt(req.query.limit, 10);
            const offsetRaw = parseInt(req.query.offset, 10);
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
            const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

            const search = String(req.query.search || '').trim();
            const supplier = String(req.query.supplier || '').trim();
            const archived = String(req.query.archived || 'active').toLowerCase();
            const stockPositionMode = String(req.query.stock_position || 'yes').toLowerCase();
            const includeBundles = String(req.query.include_bundles || '0') === '1';
            const onlyStock = String(req.query.only_stock || '0') === '1';

            const sortKey = ALLOWED_SORT[String(req.query.sort_by || 'code')] ? String(req.query.sort_by || 'code') : 'code';
            const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

            const where = ['1=1'];
            const params = [];

            if (archived === 'active') where.push('mse.is_archived = 0');
            else if (archived === 'archive' || archived === 'archived' || archived === '1') where.push('mse.is_archived = 1');

            if (stockPositionMode === 'yes') where.push("LOWER(mse.stock_position) = 'да'");
            else if (stockPositionMode === 'no') where.push("(mse.stock_position IS NULL OR LOWER(mse.stock_position) <> 'да')");

            if (!includeBundles) where.push("(mse.type IS NULL OR LOWER(mse.type) NOT LIKE '%комплект%')");

            if (search) {
                const v = `%${search.toLowerCase()}%`;
                where.push('(LOWER(mse.code) LIKE ? OR LOWER(mse.name) LIKE ? OR LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
                params.push(v, v, v, v);
            }

            if (supplier) {
                const v = `%${supplier.toLowerCase()}%`;
                where.push('(LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
                params.push(v, v);
            }

            if (onlyStock) where.push('COALESCE(mse.stock, 0) > 0');

            const whereSql = where.join(' AND ');
            const buyPriceExpr = "COALESCE(CAST(REPLACE(REPLACE(REPLACE(REPLACE(mse.buy_price, '₽', ''), ' ', ''), ' ', ''), ',', '.') AS DECIMAL(15,2)), 0)";
            const articleSortExpr = "COALESCE(med.code, mse.code)";

            const orderExpr = sortKey === 'buy_price'
                ? buyPriceExpr
                : sortKey === 'article'
                    ? articleSortExpr
                    : ALLOWED_SORT[sortKey];

            const baseFromJoin = `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `;

            const listSql = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity, po.min_stock_calc_as,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                    med.payload_json
                ${baseFromJoin}
                WHERE ${whereSql}
                ORDER BY ${orderExpr} ${sortDir}, mse.id ASC
                LIMIT ? OFFSET ?
            `;
            const countSql = `SELECT COUNT(*) AS cnt ${baseFromJoin} WHERE ${whereSql}`;

            const [[rows], [countRow]] = await Promise.all([
                db.query(listSql, [...params, limit, offset]),
                db.query(countSql, params)
            ]);

            const data = rows.map((r) => {
                const payload = parsePayloadSafe(r.payload_json);
                const article = payload && typeof payload.article === 'string' ? payload.article : '';
                const packQtyAuto = extractPackQty(payload);
                const inTransit = extractInTransit(payload);
                const supplierLabel = buildSupplierLabel(r.supplier, r.supplier2);
                return {
                    code: r.code || '',
                    article,
                    name: r.name || '',
                    is_archived: Number(r.is_archived || 0),
                    type: r.type || '',
                    uuid: r.uuid || '',
                    supplier: r.supplier || '',
                    supplier2: r.supplier2 || '',
                    supplier_label: supplierLabel,
                    buy_price: r.buy_price || '',
                    min_stock: r.min_stock,
                    automation_price: r.automation_price || '',
                    proposed_min_stock: r.proposed_min_stock,
                    min_stock_dg: r.min_stock_dg,
                    multiplicity: r.multiplicity,
                    min_stock_calc_as: r.min_stock_calc_as,
                    pack_qty: r.pack_qty_manual != null ? r.pack_qty_manual : packQtyAuto,
                    pack_qty_auto: packQtyAuto,
                    pack_qty_manual: r.pack_qty_manual,
                    stock: Number(r.stock || 0),
                    in_transit: inTransit,
                    no_longer_cooperation: r.no_longer_cooperation || '',
                    stock_position: r.stock_position || '',
                    override_updated_at: r.override_updated_at || null
                };
            });

            res.json({
                success: true,
                total: Number(countRow[0]?.cnt || 0),
                limit,
                offset,
                sort_by: sortKey,
                sort_dir: sortDir.toLowerCase(),
                data
            });
        } catch (err) {
            console.error('[purchase][list] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    router.post('/override', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String((req.body && req.body.code) || '').trim();
            const field = String((req.body && req.body.field) || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code товара' });
            if (!OVERRIDE_FIELDS.has(field)) {
                return res.status(400).json({ success: false, error: `Недопустимое поле: ${field}` });
            }

            const rawValue = req.body ? req.body.value : null;
            const num = rawValue === '' || rawValue == null ? null : parseFlexibleNumber(rawValue);
            if (rawValue !== '' && rawValue != null && num == null) {
                return res.status(400).json({ success: false, error: 'Значение должно быть числом или пустым' });
            }

            const upsertSql = `
                INSERT INTO dg_purchase_overrides (code, ${field})
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})
            `;
            await db.query(upsertSql, [code, num]);

            const [verifyRows] = await db.query(
                `SELECT code, min_stock_dg, multiplicity, min_stock_calc_as, proposed_min_stock, pack_qty_manual, updated_at
                 FROM dg_purchase_overrides WHERE code = ? LIMIT 1`,
                [code]
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;
            res.json({ success: true, code, field, value: num, stored });
        } catch (err) {
            console.error('[purchase][override] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    return router;
}

module.exports = createPurchaseRouter;
module.exports.createPurchaseRouter = createPurchaseRouter;
module.exports.ensureSchema = ensureSchema;
