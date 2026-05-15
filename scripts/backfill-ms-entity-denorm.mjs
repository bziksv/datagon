/**
 * Заполняет `ms_entity_details.denorm_*` из уже сохранённого `payload_json`
 * (паритет с `saveMoyskladEntityDetails` + `lib/datagonMsEntityPurchaseDenorm.js`).
 *
 *   node scripts/backfill-ms-entity-denorm.mjs
 *
 * Идёт батчами; при большой базе лучше запускать в screen/tmux.
 */

import config from '../config.js';
import mysql from 'mysql2/promise';
import denormMod from '../lib/datagonMsEntityPurchaseDenorm.js';

const { computeMsEntityPurchaseDenorm } = denormMod;

const BATCH = 400;

async function main() {
    const db = await mysql.createConnection({
        host: config.db.host,
        port: config.db.port || 3306,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });
    try {
        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM ms_entity_details');
        const n = Number(total || 0);
        console.log(`ms_entity_details rows: ${n}`);
        let offset = 0;
        let touched = 0;
        while (offset < n) {
            const [rows] = await db.query(
                `SELECT uuid, payload_json FROM ms_entity_details ORDER BY uuid LIMIT ? OFFSET ?`,
                [BATCH, offset],
            );
            if (!rows.length) break;
            for (const r of rows) {
                let entity;
                try {
                    entity = JSON.parse(r.payload_json);
                } catch {
                    continue;
                }
                if (!entity || typeof entity !== 'object') continue;
                const dn = computeMsEntityPurchaseDenorm(entity);
                await db.query(
                    `UPDATE ms_entity_details SET
                        denorm_article = ?,
                        denorm_in_transit = ?,
                        denorm_pack_qty_auto = ?,
                        denorm_market_price_rub = ?
                     WHERE uuid = ?`,
                    [
                        dn.denorm_article,
                        dn.denorm_in_transit,
                        dn.denorm_pack_qty_auto,
                        dn.denorm_market_price_rub,
                        r.uuid,
                    ],
                );
                touched += 1;
            }
            offset += rows.length;
            if (offset % (BATCH * 5) === 0 || offset >= n) {
                console.log(`progress: ${Math.min(offset, n)}/${n} (updates attempted: ${touched})`);
            }
        }
        console.log('done');
    } finally {
        await db.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
