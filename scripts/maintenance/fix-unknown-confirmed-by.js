'use strict';

/**
 * Одноразовая ремонтная задача:
 *   - Старые product_matches.confirmed_by/unlinked_by/rejected_by со значением 'unknown'
 *     были записаны из-за бага в resolveActorDisplayName(req) (брал имя только из заголовка
 *     x-auth-username, который у части пользователей не выставлен).
 *   - Согласно решению владельца проекта:
 *       confirmed_at < 2026-05-06 00:00:00 (сервер БД) → 'Станислав'
 *       confirmed_at >= 2026-05-06 00:00:00            → 'Юрий Тарасенко'
 *
 * Скрипт сначала печатает TZ MySQL и dry-run счётчики, затем выполняет UPDATE'ы
 * в одной транзакции и печатает affectedRows. Запускать из корня репозитория:
 *
 *   node scripts/maintenance/fix-unknown-confirmed-by.js [--dry-run]
 */

const path = require('path');
const mysql = require('mysql2/promise');
const config = require(path.join(__dirname, '..', '..', 'config'));

const DRY_RUN = process.argv.includes('--dry-run');
const CUTOFF_LOCAL = '2026-05-06 00:00:00';
const NAME_BEFORE = 'Станислав';
const NAME_AFTER = 'Юрий Тарасенко';

(async () => {
    const c = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });

    try {
        const [tz] = await c.query(
            "SELECT @@session.time_zone AS sess, @@global.time_zone AS glob, NOW() AS now_db, UTC_TIMESTAMP() AS now_utc"
        );
        console.log('TZ:', tz[0]);

        const [sample] = await c.query(
            "SELECT id, confirmed_at AS raw, " +
            "DATE_FORMAT(confirmed_at,'%Y-%m-%d %H:%i:%s') AS local_str, " +
            "DATE_FORMAT(CONVERT_TZ(confirmed_at,@@session.time_zone,'+00:00'),'%Y-%m-%d %H:%i:%s') AS utc_str " +
            "FROM product_matches WHERE id=79467"
        );
        console.log('reference id=79467 ("jp200u"):', sample[0] || null);

        const [counts] = await c.query(
            "SELECT " +
            "  SUM(confirmed_by='unknown' AND confirmed_at  < ?) AS cb_to_st, " +
            "  SUM(confirmed_by='unknown' AND confirmed_at >= ?) AS cb_to_yu, " +
            "  SUM(unlinked_by='unknown'  AND unlinked_at   < ?) AS ub_to_st, " +
            "  SUM(unlinked_by='unknown'  AND unlinked_at  >= ?) AS ub_to_yu, " +
            "  SUM(rejected_by='unknown'  AND rejected_at   < ?) AS rb_to_st, " +
            "  SUM(rejected_by='unknown'  AND rejected_at  >= ?) AS rb_to_yu " +
            "FROM product_matches",
            [CUTOFF_LOCAL, CUTOFF_LOCAL, CUTOFF_LOCAL, CUTOFF_LOCAL, CUTOFF_LOCAL, CUTOFF_LOCAL]
        );
        console.log(`Counts (cutoff = ${CUTOFF_LOCAL}, server local TZ):`, counts[0]);

        if (DRY_RUN) {
            console.log('\n[DRY-RUN] no UPDATE was performed');
            return;
        }

        await c.beginTransaction();
        try {
            const [r1] = await c.query(
                "UPDATE product_matches SET confirmed_by = ? WHERE confirmed_by = 'unknown' AND confirmed_at  < ?",
                [NAME_BEFORE, CUTOFF_LOCAL]
            );
            const [r2] = await c.query(
                "UPDATE product_matches SET confirmed_by = ? WHERE confirmed_by = 'unknown' AND confirmed_at >= ?",
                [NAME_AFTER, CUTOFF_LOCAL]
            );
            const [r3] = await c.query(
                "UPDATE product_matches SET unlinked_by = ? WHERE unlinked_by = 'unknown' AND unlinked_at  < ?",
                [NAME_BEFORE, CUTOFF_LOCAL]
            );
            const [r4] = await c.query(
                "UPDATE product_matches SET unlinked_by = ? WHERE unlinked_by = 'unknown' AND unlinked_at >= ?",
                [NAME_AFTER, CUTOFF_LOCAL]
            );
            const [r5] = await c.query(
                "UPDATE product_matches SET rejected_by = ? WHERE rejected_by = 'unknown' AND rejected_at  < ?",
                [NAME_BEFORE, CUTOFF_LOCAL]
            );
            const [r6] = await c.query(
                "UPDATE product_matches SET rejected_by = ? WHERE rejected_by = 'unknown' AND rejected_at >= ?",
                [NAME_AFTER, CUTOFF_LOCAL]
            );
            await c.commit();
            console.log('\nAffected:', {
                confirmed_by_to_Stanislav: r1.affectedRows,
                confirmed_by_to_Yuri: r2.affectedRows,
                unlinked_by_to_Stanislav: r3.affectedRows,
                unlinked_by_to_Yuri: r4.affectedRows,
                rejected_by_to_Stanislav: r5.affectedRows,
                rejected_by_to_Yuri: r6.affectedRows,
            });
        } catch (e) {
            await c.rollback();
            throw e;
        }

        const [post] = await c.query(
            "SELECT confirmed_by, COUNT(*) AS cnt FROM product_matches WHERE confirmed_at IS NOT NULL GROUP BY confirmed_by ORDER BY cnt DESC LIMIT 20"
        );
        console.log('\nPost-update distinct confirmed_by:', post);
    } finally {
        await c.end();
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
