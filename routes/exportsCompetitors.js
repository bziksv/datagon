'use strict';

/**
 * Маркетплейсы → Конкуренты: список товаров ms_export для поиска на Ozon / WB / Я.Маркет.
 * Статусы «Конкуренты Ozon/WB/Я.М.» — dg_mp_competitor_marks:
 * 0 пусто, 1 включена, 2 не требуется, 3 конкурентов нет.
 * Экран: /exports-marketplaces-competitors.html
 */

const express = require('express');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const BUY_PRICE_SQL =
    "COALESCE(CAST(REPLACE(REPLACE(REPLACE(REPLACE(mse.buy_price, '₽', ''), ' ', ''), ' ', ''), ',', '.') AS DECIMAL(15,2)), 0)";

const MARK_FIELDS = new Set(['ozon', 'wb', 'yandex']);
/** 0 — не отмечено, 1 — включена, 2 — не требуется, 3 — конкурентов нет */
const MARK_VALUES = new Set([0, 1, 2, 3]);

const SORT_KEYS = new Set(['code', 'article', 'name', 'manager', 'buy_price', 'stock', 'updated_at']);

let schemaReady = false;

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_mp_competitor_marks (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            ozon TINYINT NOT NULL DEFAULT 0,
            wb TINYINT NOT NULL DEFAULT 0,
            yandex TINYINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by_user_id INT NULL,
            INDEX idx_dg_mp_comp_marks_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        const [cols] = await db.query(
            `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'dg_mp_competitor_marks'
               AND COLUMN_NAME = 'yandex'`
        );
        if (!cols || !cols.length) {
            await db.query(
                'ALTER TABLE dg_mp_competitor_marks ADD COLUMN yandex TINYINT NOT NULL DEFAULT 0 AFTER wb'
            );
        }
    } catch (e) {
        console.warn(
            '[exports/competitors] schema migrate yandex:',
            e && e.message ? e.message : e
        );
    }
    schemaReady = true;
}

function normalizeMarkValue(raw) {
    if (raw === true || raw === 'true' || raw === 'on') return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    const v = Math.trunc(n);
    return MARK_VALUES.has(v) ? v : 0;
}

function normalizeMarkFilter(raw) {
    const s = String(raw == null ? '' : raw)
        .trim()
        .toLowerCase();
    if (!s || s === 'all') return 'all';
    if (s === '0' || s === 'empty' || s === 'unset' || s === 'none') return 0;
    if (s === '1' || s === 'on' || s === 'yes' || s === 'enabled') return 1;
    if (s === '2' || s === 'skip' || s === 'not_required' || s === 'na') return 2;
    if (
        s === '3' ||
        s === 'no_competitors' ||
        s === 'absent' ||
        s === 'missing' ||
        s === 'нету' ||
        s === 'нет'
    ) {
        return 3;
    }
    const n = Number(s);
    if (n === 0 || n === 1 || n === 2 || n === 3) return n;
    return 'all';
}

function parseDateOnly(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
}

function formatUpdatedAt(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(v);
}

function parseFlexibleNumber(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(
        String(raw)
            .replace(/[\s\u00A0\u202F]/g, '')
            .replace(/,/g, '.')
            .replace(/[^\d.-]/g, '')
    );
    return Number.isFinite(n) ? n : null;
}

function parseLimitOffset(q) {
    const limitRaw = parseInt(q.limit, 10);
    const offsetRaw = parseInt(q.offset, 10);
    const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, limitRaw) : DEFAULT_LIMIT;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    return { limit, offset };
}

function sessionUserId(req) {
    const u = req && (req.user || (req.session && req.session.user));
    if (!u) return null;
    const id = Number(u.id || u.user_id || 0);
    return Number.isFinite(id) && id > 0 ? id : null;
}

/** Как на МойСклад: слова через пробел = AND; группы через | = OR; кавычки = фраза. */
function tokenizeGroup(group) {
    const tokens = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(group)) !== null) {
        const v = (m[1] || m[2] || '').trim();
        if (v) tokens.push(v);
    }
    return tokens;
}

function swapKeyboardLayout(token) {
    const ru = 'йцукенгшщзхъфывапролджэячсмитьбю';
    const en = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
    const map = new Map();
    for (let i = 0; i < ru.length; i += 1) {
        map.set(ru[i], en[i]);
        map.set(ru[i].toUpperCase(), en[i].toUpperCase());
        map.set(en[i], ru[i]);
        map.set(en[i].toUpperCase(), ru[i].toUpperCase());
    }
    return token
        .split('')
        .map((ch) => map.get(ch) || ch)
        .join('');
}

function translitRuToLat(token) {
    const m = {
        а: 'a',
        б: 'b',
        в: 'v',
        г: 'g',
        д: 'd',
        е: 'e',
        ё: 'e',
        ж: 'zh',
        з: 'z',
        и: 'i',
        й: 'y',
        к: 'k',
        л: 'l',
        м: 'm',
        н: 'n',
        о: 'o',
        п: 'p',
        р: 'r',
        с: 's',
        т: 't',
        у: 'u',
        ф: 'f',
        х: 'h',
        ц: 'ts',
        ч: 'ch',
        ш: 'sh',
        щ: 'sch',
        ъ: '',
        ы: 'y',
        ь: '',
        э: 'e',
        ю: 'yu',
        я: 'ya',
    };
    return token
        .split('')
        .map((ch) => {
            const low = ch.toLowerCase();
            const repl = m[low];
            if (repl === undefined) return ch;
            return ch === low ? repl : repl.toUpperCase();
        })
        .join('');
}

function translitLatToRu(token) {
    const direct = {
        a: 'а',
        b: 'б',
        c: 'к',
        d: 'д',
        e: 'е',
        f: 'ф',
        g: 'г',
        h: 'х',
        i: 'и',
        j: 'й',
        k: 'к',
        l: 'л',
        m: 'м',
        n: 'н',
        o: 'о',
        p: 'п',
        q: 'к',
        r: 'р',
        s: 'с',
        t: 'т',
        u: 'у',
        v: 'в',
        w: 'в',
        x: 'кс',
        y: 'й',
        z: 'з',
    };
    return token
        .split('')
        .map((ch) => {
            const low = ch.toLowerCase();
            const repl = direct[low];
            if (!repl) return ch;
            return ch === low ? repl : repl.toUpperCase();
        })
        .join('');
}

function tokenVariants(rawToken) {
    const base = String(rawToken || '').trim();
    if (!base) return [];
    const variants = new Set([base]);
    const swapped = swapKeyboardLayout(base).trim();
    if (swapped) variants.add(swapped);
    const ruToLat = translitRuToLat(base).trim();
    if (ruToLat) variants.add(ruToLat);
    const latToRu = translitLatToRu(base).trim();
    if (latToRu) variants.add(latToRu);
    return Array.from(variants).filter((v) => v.length > 0);
}

const SMART_ANY_FIELDS =
    "(mse.code LIKE ? OR mse.name LIKE ? OR COALESCE(med.denorm_article, '') LIKE ? OR COALESCE(mse.manager, '') LIKE ?)";

function appendFieldLikeAny(andClauses, params, fieldsSql, token) {
    const variants = tokenVariants(token);
    if (!variants.length) return;
    const parts = [];
    for (const v of variants) {
        const val = `%${v}%`;
        parts.push(fieldsSql);
        for (let i = 0; i < (fieldsSql.match(/\?/g) || []).length; i += 1) {
            params.push(val);
        }
    }
    andClauses.push(`(${parts.join(' OR ')})`);
}

function buildCompetitorsSmartSearch(rawSearch) {
    const search = String(rawSearch || '').trim();
    if (!search) return { sql: '', params: [] };

    const groups = search.split('|').map((x) => x.trim()).filter(Boolean);
    if (!groups.length) return { sql: '', params: [] };

    const orClauses = [];
    const params = [];

    for (const group of groups) {
        const tokens = tokenizeGroup(group);
        if (!tokens.length) continue;
        const andClauses = [];

        for (const token of tokens) {
            const idx = token.indexOf(':');
            let key = '';
            let value = token;
            if (idx > 0) {
                key = token.slice(0, idx).toLowerCase();
                value = token.slice(idx + 1);
            }
            if (!String(value).trim()) continue;

            if (key === 'sku' || key === 'code') {
                appendFieldLikeAny(andClauses, params, '(mse.code LIKE ?)', value);
            } else if (key === 'name') {
                appendFieldLikeAny(andClauses, params, '(mse.name LIKE ?)', value);
            } else if (key === 'article' || key === 'art') {
                appendFieldLikeAny(
                    andClauses,
                    params,
                    "(COALESCE(med.denorm_article, '') LIKE ?)",
                    value
                );
            } else if (key === 'manager') {
                appendFieldLikeAny(andClauses, params, '(mse.manager LIKE ?)', value);
            } else {
                appendFieldLikeAny(andClauses, params, SMART_ANY_FIELDS, value);
            }
        }

        if (andClauses.length) {
            orClauses.push(`(${andClauses.join(' AND ')})`);
        }
    }

    if (!orClauses.length) return { sql: '', params: [] };
    return { sql: `(${orClauses.join(' OR ')})`, params };
}

module.exports = function exportsCompetitorsRouter(db) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const q = req.query || {};
            const { limit, offset } = parseLimitOffset(q);
            const search = String(q.search || '').trim();
            const buyMin = parseFlexibleNumber(q.buy_price_min);
            const buyMax = parseFlexibleNumber(q.buy_price_max);
            const typeRaw = String(q.type || 'all').trim().toLowerCase();
            const stockPos = String(q.stock_position || 'yes').trim().toLowerCase();
            const managerRaw = String(q.manager || '').trim();
            const markOzon = normalizeMarkFilter(q.competitors_ozon ?? q.mark_ozon);
            const markWb = normalizeMarkFilter(q.competitors_wb ?? q.mark_wb);
            const markYandex = normalizeMarkFilter(
                q.competitors_yandex ?? q.mark_yandex ?? q.competitors_ym
            );
            const updatedFrom = parseDateOnly(q.updated_from ?? q.updated_at_from);
            const updatedTo = parseDateOnly(q.updated_to ?? q.updated_at_to);
            const updatedNone =
                String(q.updated_none || q.no_updated || '').trim() === '1' ||
                String(q.updated_none || '').trim().toLowerCase() === 'yes';
            const sortRaw = String(q.sort_by || 'code').trim();
            const sortBy = SORT_KEYS.has(sortRaw) ? sortRaw : 'code';
            const sortDir = String(q.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

            const where = ["TRIM(COALESCE(mse.code, '')) <> ''"];
            const params = [];

            if (search) {
                const smart = buildCompetitorsSmartSearch(search);
                if (smart.sql) {
                    where.push(smart.sql);
                    params.push(...smart.params);
                }
            }
            if (buyMin != null) {
                where.push(`${BUY_PRICE_SQL} >= ?`);
                params.push(buyMin);
            }
            if (buyMax != null) {
                where.push(`${BUY_PRICE_SQL} <= ?`);
                params.push(buyMax);
            }
            if (typeRaw === 'product' || typeRaw === 'товар') {
                where.push(`LOWER(TRIM(COALESCE(mse.type, ''))) = ?`);
                params.push('товар');
            } else if (typeRaw === 'bundle' || typeRaw === 'комплект') {
                where.push(`LOWER(TRIM(COALESCE(mse.type, ''))) = ?`);
                params.push('комплект');
            }
            if (stockPos === 'yes') {
                where.push('mse.stock_position = ?');
                params.push('Да');
            } else if (stockPos === 'no') {
                where.push('mse.stock_position = ?');
                params.push('Нет');
            }
            if (managerRaw === '__empty__') {
                where.push("TRIM(COALESCE(mse.manager, '')) = ''");
            } else if (managerRaw) {
                where.push("TRIM(COALESCE(mse.manager, '')) = ?");
                params.push(managerRaw);
            }
            if (markOzon !== 'all') {
                where.push('COALESCE(mcm.ozon, 0) = ?');
                params.push(markOzon);
            }
            if (markWb !== 'all') {
                where.push('COALESCE(mcm.wb, 0) = ?');
                params.push(markWb);
            }
            if (markYandex !== 'all') {
                where.push('COALESCE(mcm.yandex, 0) = ?');
                params.push(markYandex);
            }
            if (updatedNone) {
                where.push('mcm.updated_at IS NULL');
            } else {
                if (updatedFrom) {
                    where.push('DATE(mcm.updated_at) >= ?');
                    params.push(updatedFrom);
                }
                if (updatedTo) {
                    where.push('DATE(mcm.updated_at) <= ?');
                    params.push(updatedTo);
                }
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const orderCol =
                sortBy === 'buy_price'
                    ? BUY_PRICE_SQL
                    : sortBy === 'stock'
                      ? 'COALESCE(mse.stock, 0)'
                      : sortBy === 'article'
                        ? "COALESCE(med.denorm_article, '')"
                        : sortBy === 'manager'
                          ? "COALESCE(mse.manager, '')"
                          : sortBy === 'updated_at'
                            ? 'mcm.updated_at'
                            : sortBy === 'name'
                              ? 'mse.name'
                              : 'mse.code';

            const fromSql = `
                FROM ms_export mse
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                LEFT JOIN dg_mp_competitor_marks mcm ON mcm.code = mse.code
                ${whereSql}`;

            const [[countRow]] = await db.query(
                `SELECT COUNT(*) AS total ${fromSql}`,
                params
            );
            const total = Number(countRow?.total || 0);

            const [rows] = await db.query(
                `SELECT
                    mse.code,
                    mse.name,
                    mse.manager,
                    mse.buy_price,
                    mse.stock,
                    mse.type,
                    mse.stock_position,
                    COALESCE(med.denorm_article, '') AS article,
                    COALESCE(mcm.ozon, 0) AS mark_ozon,
                    COALESCE(mcm.wb, 0) AS mark_wb,
                    COALESCE(mcm.yandex, 0) AS mark_yandex,
                    mcm.updated_at AS marks_updated_at
                 ${fromSql}
                 ORDER BY ${orderCol} ${sortDir}, mse.code ASC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            const [managerRows] = await db.query(
                `SELECT TRIM(manager) AS manager
                 FROM ms_export
                 WHERE TRIM(COALESCE(manager, '')) <> ''
                 GROUP BY TRIM(manager)
                 ORDER BY TRIM(manager) ASC`
            );
            const managers = (managerRows || [])
                .map((r) => String(r.manager || '').trim())
                .filter(Boolean);

            const items = (rows || []).map((r) => ({
                code: String(r.code || '').trim(),
                article: String(r.article || '').trim(),
                manager: String(r.manager || '').trim(),
                name: String(r.name || '').trim(),
                buy_price: r.buy_price != null ? String(r.buy_price) : '',
                stock: r.stock != null && r.stock !== '' ? Number(r.stock) : null,
                type: String(r.type || '').trim(),
                stock_position: String(r.stock_position || '').trim(),
                competitors_ozon: normalizeMarkValue(r.mark_ozon),
                competitors_wb: normalizeMarkValue(r.mark_wb),
                competitors_yandex: normalizeMarkValue(r.mark_yandex),
                updated_at: formatUpdatedAt(r.marks_updated_at),
            }));

            res.json({
                success: true,
                total,
                limit,
                offset,
                sort_by: sortBy,
                sort_dir: sortDir.toLowerCase(),
                managers,
                filters: {
                    type: typeRaw === 'product' || typeRaw === 'товар'
                        ? 'product'
                        : typeRaw === 'bundle' || typeRaw === 'комплект'
                          ? 'bundle'
                          : 'all',
                    stock_position: stockPos === 'no' ? 'no' : stockPos === 'all' ? 'all' : 'yes',
                    manager: managerRaw || '',
                    competitors_ozon: markOzon === 'all' ? 'all' : String(markOzon),
                    competitors_wb: markWb === 'all' ? 'all' : String(markWb),
                    competitors_yandex: markYandex === 'all' ? 'all' : String(markYandex),
                    updated_from: updatedFrom || '',
                    updated_to: updatedTo || '',
                    updated_none: updatedNone ? '1' : '0',
                },
                items,
            });
        } catch (e) {
            console.error('[exports/competitors]', e);
            res.status(500).json({
                success: false,
                error: String((e && e.message) || e || 'Ошибка списка'),
            });
        }
    });

    /**
     * POST /api/exports/competitors/mark
     * Body: { code, field: "ozon"|"wb"|"yandex", value: 0|1|2|3 }
     * 0 — пусто, 1 — включена, 2 — не требуется, 3 — конкурентов нет
     */
    router.post('/mark', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const code = String(body.code || '').trim();
            let fieldRaw = String(body.field || '')
                .trim()
                .toLowerCase()
                .replace(/^competitors_/, '');
            if (fieldRaw === 'ym' || fieldRaw === 'ya') fieldRaw = 'yandex';
            const field = MARK_FIELDS.has(fieldRaw) ? fieldRaw : '';
            const value = normalizeMarkValue(body.value);
            if (!code) {
                return res.status(400).json({ success: false, error: 'Нужен code' });
            }
            if (!field) {
                return res.status(400).json({
                    success: false,
                    error: 'field: ozon | wb | yandex',
                });
            }

            const userId = sessionUserId(req);
            const col = field;
            await db.query(
                `INSERT INTO dg_mp_competitor_marks (code, ${col}, updated_by_user_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   ${col} = VALUES(${col}),
                   updated_by_user_id = VALUES(updated_by_user_id)`,
                [code, value, userId]
            );

            const [[row]] = await db.query(
                `SELECT code, ozon, wb, yandex, updated_at FROM dg_mp_competitor_marks WHERE code = ? LIMIT 1`,
                [code]
            );

            res.json({
                success: true,
                code,
                field: col,
                value,
                competitors_ozon: normalizeMarkValue(row?.ozon),
                competitors_wb: normalizeMarkValue(row?.wb),
                competitors_yandex: normalizeMarkValue(row?.yandex),
                updated_at: formatUpdatedAt(row?.updated_at),
            });
        } catch (e) {
            console.error('[exports/competitors/mark]', e);
            res.status(500).json({
                success: false,
                error: String((e && e.message) || e || 'Ошибка сохранения'),
            });
        }
    });

    return router;
};

module.exports.ensureSchema = ensureSchema;
