/**
 * После смены source_id Webasyst с product.id на shop_product_skus.id
 * и коллизий product.id ≡ sku.id: правим ссылки матчинга и чистим «призраки».
 */

async function remapMatchProductId(db, siteId, oldId, newId) {
    if (!oldId || !newId || Number(oldId) === Number(newId)) return 0;
    let n = 0;
    for (const table of ['match_manual_archive', 'match_exclusion']) {
        try {
            await db.query(
                `DELETE x_old
                 FROM ${table} x_old
                 INNER JOIN ${table} x_new
                   ON x_new.my_site_id = x_old.my_site_id
                  AND x_new.competitor_site_id = x_old.competitor_site_id
                  AND x_new.my_product_id = ?
                 WHERE x_old.my_site_id = ? AND x_old.my_product_id = ?`,
                [newId, siteId, oldId]
            );
            const [r] = await db.query(
                `UPDATE ${table} SET my_product_id = ? WHERE my_site_id = ? AND my_product_id = ?`,
                [newId, siteId, oldId]
            );
            n += Number(r.affectedRows || 0);
        } catch (_) {}
    }
    try {
        const [r] = await db.query(
            `UPDATE match_product_log SET my_product_id = ? WHERE my_site_id = ? AND my_product_id = ?`,
            [newId, siteId, oldId]
        );
        n += Number(r.affectedRows || 0);
    } catch (_) {}
    return n;
}

/**
 * Пакетный ремап: snapshot (old_id → old_sku) → активная строка с тем же sku.
 * Без N×SELECT (иначе на 40k+ зависает).
 */
async function remapMatchRefsBySkuSnapshot(db, siteId, snapshot) {
    const sid = Number(siteId);
    if (!Number.isFinite(sid) || sid < 1 || !Array.isArray(snapshot) || !snapshot.length) {
        return { remapped: 0 };
    }

    const tmp = `tmp_mp_sku_snap_${sid}_${Date.now()}`;
    let remapped = 0;
    try {
        await db.query(
            `CREATE TEMPORARY TABLE ${tmp} (
                old_id INT NOT NULL,
                sku VARCHAR(191) NOT NULL,
                PRIMARY KEY (old_id),
                KEY idx_sku (sku)
            ) ENGINE=InnoDB`
        );
        const CHUNK = 1000;
        for (let i = 0; i < snapshot.length; i += CHUNK) {
            const chunk = snapshot.slice(i, i + CHUNK);
            const values = [];
            for (const row of chunk) {
                const oldId = Number(row.id);
                const sku = String(row.sku || '').trim().slice(0, 191);
                if (!Number.isFinite(oldId) || oldId < 1 || !sku) continue;
                values.push([oldId, sku]);
            }
            if (!values.length) continue;
            await db.query(`INSERT IGNORE INTO ${tmp} (old_id, sku) VALUES ?`, [values]);
        }

        // Пары old_id → new_id (активная строка с тем же артикулом, другой PK)
        await db.query(
            `CREATE TEMPORARY TABLE ${tmp}_map (
                old_id INT NOT NULL PRIMARY KEY,
                new_id INT NOT NULL
            ) ENGINE=InnoDB`
        );
        await db.query(
            `INSERT INTO ${tmp}_map (old_id, new_id)
             SELECT s.old_id, MIN(a.id) AS new_id
             FROM ${tmp} s
             INNER JOIN my_products a
               ON a.site_id = ?
              AND a.sku = s.sku
              AND a.is_active = 1
              AND a.id <> s.old_id
             GROUP BY s.old_id`,
            [sid]
        );

        for (const table of ['match_manual_archive', 'match_exclusion']) {
            try {
                await db.query(
                    `DELETE x_old
                     FROM ${table} x_old
                     INNER JOIN ${tmp}_map m ON m.old_id = x_old.my_product_id
                     INNER JOIN ${table} x_new
                       ON x_new.my_site_id = x_old.my_site_id
                      AND x_new.competitor_site_id = x_old.competitor_site_id
                      AND x_new.my_product_id = m.new_id
                     WHERE x_old.my_site_id = ?`,
                    [sid]
                );
                const [r] = await db.query(
                    `UPDATE ${table} x
                     INNER JOIN ${tmp}_map m ON m.old_id = x.my_product_id
                     SET x.my_product_id = m.new_id
                     WHERE x.my_site_id = ?`,
                    [sid]
                );
                remapped += Number(r.affectedRows || 0);
            } catch (_) {}
        }
        try {
            const [r] = await db.query(
                `UPDATE match_product_log x
                 INNER JOIN ${tmp}_map m ON m.old_id = x.my_product_id
                 SET x.my_product_id = m.new_id
                 WHERE x.my_site_id = ?`,
                [sid]
            );
            remapped += Number(r.affectedRows || 0);
        } catch (_) {}
    } finally {
        try {
            await db.query(`DROP TEMPORARY TABLE IF EXISTS ${tmp}_map`);
        } catch (_) {}
        try {
            await db.query(`DROP TEMPORARY TABLE IF EXISTS ${tmp}`);
        } catch (_) {}
    }

    return { remapped };
}

async function cleanupInactiveSkuDuplicates(db, siteId) {
    const sid = Number(siteId);
    if (!Number.isFinite(sid) || sid < 1) return { remapped: 0, deleted: 0 };

    const pairsCte = `
        SELECT o.id AS old_id, MIN(a.id) AS new_id
        FROM my_products o
        INNER JOIN my_products a
          ON a.site_id = o.site_id
         AND a.sku = o.sku
         AND a.is_active = 1
         AND a.id <> o.id
        WHERE o.site_id = ?
          AND o.is_active = 0
          AND TRIM(IFNULL(o.sku, '')) <> ''
        GROUP BY o.id
    `;

    let remapped = 0;

    for (const table of ['match_manual_archive', 'match_exclusion']) {
        try {
            await db.query(
                `DELETE x_old
                 FROM ${table} x_old
                 INNER JOIN (${pairsCte}) m ON m.old_id = x_old.my_product_id
                 INNER JOIN ${table} x_new
                   ON x_new.my_site_id = x_old.my_site_id
                  AND x_new.competitor_site_id = x_old.competitor_site_id
                  AND x_new.my_product_id = m.new_id
                 WHERE x_old.my_site_id = ?`,
                [sid, sid]
            );
            const [r] = await db.query(
                `UPDATE ${table} x
                 INNER JOIN (${pairsCte}) m ON m.old_id = x.my_product_id
                 SET x.my_product_id = m.new_id
                 WHERE x.my_site_id = ?`,
                [sid, sid]
            );
            remapped += Number(r.affectedRows || 0);
        } catch (_) {}
    }

    try {
        const [r] = await db.query(
            `UPDATE match_product_log x
             INNER JOIN (${pairsCte}) m ON m.old_id = x.my_product_id
             SET x.my_product_id = m.new_id
             WHERE x.my_site_id = ?`,
            [sid, sid]
        );
        remapped += Number(r.affectedRows || 0);
    } catch (_) {}

    const [del] = await db.query(
        `DELETE o
         FROM my_products o
         INNER JOIN my_products a
           ON a.site_id = o.site_id
          AND a.sku = o.sku
          AND a.is_active = 1
          AND a.id <> o.id
         WHERE o.site_id = ?
           AND o.is_active = 0
           AND TRIM(IFNULL(o.sku, '')) <> ''`,
        [sid]
    );

    return {
        remapped,
        deleted: Number(del.affectedRows || 0)
    };
}

module.exports = {
    cleanupInactiveSkuDuplicates,
    remapMatchRefsBySkuSnapshot,
    remapMatchProductId
};
