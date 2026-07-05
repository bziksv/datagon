/**
 * Исключение заказов МС по имени ответственного (owner / employee).
 * Настройка: app_settings.ms_orders_exclude_owner_names — по одному на строку или через запятую.
 *
 * «Новикова И.» должна матчить «Новикова Ирина», «Ирина Новикова» и т.п.
 */

function normalizeForMatch(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseExcludeOwnerNames(raw) {
    return String(raw || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * @param {string} ownerName
 * @param {string[]} patterns — как в настройках (не обязательно lowerCase)
 */
function isOwnerNameExcluded(ownerName, patterns) {
    if (!patterns || !patterns.length) return false;
    const n = normalizeForMatch(ownerName);
    if (!n) return false;

    return patterns.some((rawPat) => {
        const p = normalizeForMatch(rawPat);
        if (!p) return false;

        /** «новикова и.» → «новикова и» ⊆ «новикова ирина» */
        if (n.includes(p)) return true;

        const patParts = p.split(/\s+/).filter(Boolean);
        const ownerParts = n.split(/\s+/).filter(Boolean);
        if (!patParts.length || !ownerParts.length) return false;

        const surname = patParts[0];
        /** Фамилия в начале или в конце ФИО */
        const ownerHasSurname =
            ownerParts[0] === surname ||
            ownerParts[ownerParts.length - 1] === surname ||
            n.includes(surname);
        if (!ownerHasSurname) return false;

        /** Только фамилия в паттерне — исключаем всех с этой фамилией */
        if (patParts.length === 1) return true;

        const nameHint = patParts.slice(1).join(' ');
        /** Инициал или начало имени: «и» ↔ «ирина» */
        if (nameHint.length === 1) {
            for (const part of ownerParts) {
                if (part !== surname && part.charAt(0) === nameHint.charAt(0)) return true;
            }
            return false;
        }

        return ownerParts.some((part) => part.includes(nameHint) || nameHint.includes(part));
    });
}

function patternToSqlLike(rawPat) {
    const p = normalizeForMatch(rawPat);
    if (!p) return null;
    return '%' + p + '%';
}

/** SQL: owner_name без точек, lower — NOT LIKE для каждого паттерна. */
function buildOwnerExcludeWhere(patterns, column = 'o.owner_name') {
    if (!patterns.length) return { sql: '', params: [] };
    const wheres = [];
    const params = [];
    const normCol = `LOWER(REPLACE(REPLACE(TRIM(COALESCE(${column}, '')), '.', ' '), '  ', ' '))`;
    for (const raw of patterns) {
        const like = patternToSqlLike(raw);
        if (!like) continue;
        wheres.push(`${normCol} NOT LIKE ?`);
        params.push(like);
    }
    if (!wheres.length) return { sql: '', params: [] };
    return { sql: ' AND ' + wheres.join(' AND '), params };
}

/**
 * Удалить из БД заказы исключённых ответственных (и их позиции).
 * @returns {Promise<number>} число удалённых заказов
 */
async function purgeExcludedOrders(db, patterns) {
    const parsed = parseExcludeOwnerNames(patterns);
    if (!parsed.length) return 0;

    const [rows] = await db.query('SELECT uuid, owner_name FROM ms_customer_order');
    const uuids = (rows || [])
        .filter((r) => isOwnerNameExcluded(r.owner_name, parsed))
        .map((r) => String(r.uuid).toLowerCase());
    if (!uuids.length) return 0;

    const BATCH = 500;
    for (let i = 0; i < uuids.length; i += BATCH) {
        const slice = uuids.slice(i, i + BATCH);
        const ph = slice.map(() => '?').join(',');
        await db.query(`DELETE FROM ms_customer_order_position WHERE order_uuid IN (${ph})`, slice);
        await db.query(`DELETE FROM ms_customer_order WHERE uuid IN (${ph})`, slice);
    }
    return uuids.length;
}

module.exports = {
    normalizeForMatch,
    parseExcludeOwnerNames,
    isOwnerNameExcluded,
    buildOwnerExcludeWhere,
    purgeExcludedOrders,
};
