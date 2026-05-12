/**
 * Backfill `ms_export.min_stock` из уже сохранённых полных карточек МС
 * (`ms_entity_details.payload_json`). Используется, чтобы не ждать
 * следующий полный синк МС — все нужные данные уже лежат в БД, потому
 * что `saveMoyskladEntityDetails` пишет туда `JSON.stringify(item)` со
 * всеми полями, включая `minimumBalance`.
 *
 * Поведение:
 *   • Только `kind='product'` (у `bundle` поле не задано в МС-схеме).
 *   • `minimumBalance` парсится как число; `0` сохраняется явно (это
 *     валидный «норматив = 0», его UI отличает от `NULL` = «не задан»).
 *   • Идёт батчами по 1000, каждый — одно `INSERT INTO ms_export ...
 *     ON DUPLICATE KEY UPDATE` через временную таблицу-маркер.
 *
 *   node scripts/backfill-min-stock.js
 */

const config = require('../config');
const mysql = require('mysql2/promise');

(async () => {
    const db = await mysql.createConnection({
        host: config.db.host,
        port: config.db.port || 3306,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });

    try {
        const [{ 0: { total } }] = await db.query(
            "SELECT COUNT(*) AS total FROM ms_entity_details WHERE kind='product'",
        );
        console.log(`payload_json (kind=product): ${total}`);

        const BATCH = 1000;
        let offset = 0;
        let updated = 0;
        let zeros = 0;
        let skipped = 0;

        while (offset < total) {
            const [rows] = await db.query(
                `SELECT code, payload_json
                   FROM ms_entity_details
                  WHERE kind='product'
                  ORDER BY code
                  LIMIT ? OFFSET ?`,
                [BATCH, offset],
            );
            if (!rows.length) break;

            const updates = [];
            for (const r of rows) {
                let payload;
                try { payload = JSON.parse(r.payload_json); }
                catch (_) { skipped += 1; continue; }
                if (!Object.prototype.hasOwnProperty.call(payload, 'minimumBalance')) {
                    skipped += 1; continue;
                }
                const mb = Number(payload.minimumBalance);
                if (!Number.isFinite(mb)) { skipped += 1; continue; }
                updates.push([r.code, mb]);
                if (mb === 0) zeros += 1;
            }

            if (updates.length) {
                /** Точечный UPDATE через CASE WHEN code=... THEN ?: меньше overhead'а
                 * чем 1000 отдельных UPDATE. Безопасно для размера chunk = 1000. */
                const cases = updates.map(() => 'WHEN ? THEN ?').join(' ');
                const codes = updates.map((u) => u[0]);
                const params = [];
                for (const u of updates) params.push(u[0], u[1]);
                params.push(...codes);
                const sql = `UPDATE ms_export
                                SET min_stock = CASE code ${cases} ELSE min_stock END
                              WHERE code IN (${codes.map(() => '?').join(',')})
                                AND type = 'Товар'`;
                const [result] = await db.query(sql, params);
                updated += result.affectedRows || 0;
            }

            offset += rows.length;
            if ((offset / BATCH) % 5 === 0) {
                console.log(`  progress: ${offset}/${total} (updated=${updated}, zeros=${zeros}, skipped=${skipped})`);
            }
        }

        console.log(`DONE: updated=${updated}, zeros=${zeros}, skipped=${skipped}`);

        const [check] = await db.query(
            "SELECT code, name, type, min_stock FROM ms_export WHERE code IN ('10148','26774')",
        );
        console.log('CHECK 10148/26774:', check);

        const [stat] = await db.query(
            'SELECT COUNT(*) AS total, SUM(min_stock IS NOT NULL) AS with_min, SUM(type=\'Товар\' AND min_stock IS NOT NULL) AS goods_with_min FROM ms_export',
        );
        console.log('ms_export stats:', stat[0]);
    } finally {
        await db.end();
    }
})().catch((e) => {
    console.error('ERR:', e && e.message);
    process.exit(1);
});
