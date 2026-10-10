/**
 * Формула выплат SEO (паритет work.prime-ltd.su setting_payouts + cron summa_zp).
 * osvoeno / osvoeno_procent берём из проекта (без SE Ranking).
 */

function parseMoney(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function parseIntSafe(v, fallback = 0) {
    const n = parseInt(String(v == null ? '' : v).trim(), 10);
    return Number.isFinite(n) ? n : fallback;
}

/** end: дд/мм/гггг | дд.мм.гггг | дд-мм-гггг | YYYY-MM-DD → Date local midnight или null */
function parseWorkEndDate(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return null;
}

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + Number(days) || 0);
    return d;
}

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {object} project row work_seo_projects
 * @param {object} settings work_seo_payout_settings
 * @returns {{ summa_zp: string, procent_seo: string|number, skipped?: boolean, reason?: string }}
 */
function calcSeoSummaZp(project, settings) {
    const promo = String(project.promotion_type || '')
        .trim()
        .toLowerCase();
    if (promo === 'traffic') {
        return {
            summa_zp: String(project.summa_zp != null ? project.summa_zp : ''),
            procent_seo: project.procent_seo,
            skipped: true,
            reason: 'traffic',
        };
    }

    let procentSeo = String(project.procent_seo == null ? '' : project.procent_seo).trim();
    const enableGlobal = Number(project.enable_procent_seo) === 1;
    if (!procentSeo || enableGlobal) {
        procentSeo = String(settings.procent_seo);
    }

    const budgetFull = parseMoney(project.budget);
    const osvoeno = parseMoney(project.osvoeno);
    let osvoenoPct = parseMoney(project.osvoeno_procent);
    if (!osvoenoPct && budgetFull > 0 && osvoeno > 0) {
        osvoenoPct = Math.ceil((osvoeno / budgetFull) * 100);
    }

    // Как в WORK: для начисления после срока база = min(osvoeno, budget)
    let budgetBase = osvoeno > budgetFull ? budgetFull : osvoeno;
    if (!budgetBase) budgetBase = 0;

    const end = parseWorkEndDate(project.end);
    const today = startOfToday();
    // До даты конца (строго раньше) — фаза «вывода» / стартового бонуса
    const beforeEnd = end ? today.getTime() < end.getTime() : false;

    let summa;
    if (beforeEnd) {
        const bonusAdd =
            Number(project.bonus_enable) === 1
                ? parseMoney(project.bonus_add)
                : parseMoney(settings.bonus_add);
        summa = (budgetFull / 100) * bonusAdd;
    } else {
        const useGlobal =
            Number(project.procent_bonus) === 0 &&
            Number(project.count_day_fine) === 0 &&
            Number(project.procent_fine) === 0;
        const thrBonus = useGlobal
            ? parseIntSafe(settings.procent_bonus)
            : parseIntSafe(project.procent_bonus);
        const thrFineDays = useGlobal
            ? parseIntSafe(settings.count_day_fine)
            : parseIntSafe(project.count_day_fine);
        const thrFinePct = useGlobal
            ? parseIntSafe(settings.procent_fine)
            : parseIntSafe(project.procent_fine);
        const thrForFine = useGlobal
            ? parseIntSafe(settings.procent_for_fine)
            : parseIntSafe(project.procent_for_fine);

        const fineAfter = end ? addDays(end, thrFineDays) : null;
        const now = new Date();

        if (osvoenoPct >= thrBonus) {
            summa = (budgetBase / 100) * parseMoney(procentSeo);
        } else if (fineAfter && now.getTime() > fineAfter.getTime() && osvoenoPct < thrFinePct) {
            // Как в PHP: '-' . (budget - osvoeno) / 100 * procent_for_fine → отрицательная строка
            summa = -((budgetFull - osvoeno) / 100) * thrForFine;
        } else {
            summa = 0;
        }
    }

    const rounded = round2(summa);
    // Храним как в WORK: отрицательные с ведущим минусом в строке
    const summaStr = rounded < 0 ? String(rounded) : String(rounded);

    return {
        summa_zp: summaStr,
        procent_seo: procentSeo,
        skipped: false,
        osvoeno_procent: osvoenoPct,
    };
}

async function getSeoPayoutSettings(db) {
    const [rows] = await db.query(`SELECT * FROM work_seo_payout_settings WHERE id = 1 LIMIT 1`);
    if (rows && rows[0]) return rows[0];
    await db.query(`
        INSERT IGNORE INTO work_seo_payout_settings
          (id, procent_bonus, count_day_fine, procent_fine, procent_for_fine, bonus_add, procent_seo, created_at, updated_at)
        VALUES (1, 70, 30, 60, 20, 10, 10, NOW(), NOW())
    `);
    const [again] = await db.query(`SELECT * FROM work_seo_payout_settings WHERE id = 1 LIMIT 1`);
    return again[0];
}

function normalizeSettingsBody(body) {
    const keys = [
        'procent_bonus',
        'count_day_fine',
        'procent_fine',
        'procent_for_fine',
        'bonus_add',
        'procent_seo',
    ];
    const out = {};
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(body || {}, k)) continue;
        out[k] = parseIntSafe(body[k], 0);
    }
    return out;
}

async function saveSeoPayoutSettings(db, body) {
    const data = normalizeSettingsBody(body);
    const keys = Object.keys(data);
    if (!keys.length) {
        return getSeoPayoutSettings(db);
    }
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await db.query(
        `UPDATE work_seo_payout_settings SET ${sets}, updated_at = NOW() WHERE id = 1`,
        keys.map((k) => data[k])
    );
    return getSeoPayoutSettings(db);
}

/**
 * Пересчёт summa_zp (и procent_seo при глобальном %) для активных SEO-проектов.
 */
async function recalcAllSeoSummaZp(db) {
    const t0 = Date.now();
    const settings = await getSeoPayoutSettings(db);
    const [rows] = await db.query(
        `SELECT id, status, promotion_type, budget, osvoeno, osvoeno_procent, end,
                procent_seo, enable_procent_seo, procent_bonus, count_day_fine, procent_fine,
                procent_for_fine, bonus_add, bonus_enable, summa_zp
         FROM work_seo_projects
         WHERE status = 1`
    );
    let updated = 0;
    let skipped = 0;
    let unchanged = 0;
    const errors = [];
    for (const p of rows || []) {
        try {
            const r = calcSeoSummaZp(p, settings);
            if (r.skipped) {
                skipped += 1;
                continue;
            }
            const prev = String(p.summa_zp == null ? '' : p.summa_zp).trim();
            const next = String(r.summa_zp).trim();
            const prevPct = String(p.procent_seo == null ? '' : p.procent_seo).trim();
            const nextPct = String(r.procent_seo == null ? '' : r.procent_seo).trim();
            if (prev === next && prevPct === nextPct) {
                unchanged += 1;
                continue;
            }
            await db.query(
                `UPDATE work_seo_projects
                 SET summa_zp = ?, procent_seo = ?, updated_at = NOW()
                 WHERE id = ?`,
                [next, nextPct, p.id]
            );
            updated += 1;
        } catch (e) {
            errors.push({ id: p.id, error: e.message || String(e) });
            if (errors.length >= 20) break;
        }
    }
    return {
        total: (rows || []).length,
        updated,
        skipped,
        unchanged,
        errors,
        duration_sec: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
        settings: {
            procent_bonus: settings.procent_bonus,
            count_day_fine: settings.count_day_fine,
            procent_fine: settings.procent_fine,
            procent_for_fine: settings.procent_for_fine,
            bonus_add: settings.bonus_add,
            procent_seo: settings.procent_seo,
        },
    };
}

module.exports = {
    calcSeoSummaZp,
    getSeoPayoutSettings,
    saveSeoPayoutSettings,
    recalcAllSeoSummaZp,
    normalizeSettingsBody,
};
