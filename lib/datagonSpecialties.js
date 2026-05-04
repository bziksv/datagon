const { PAGE_DEFS } = require('./datagonPageRegistry');

const DEFAULT_SPECIALTY_NAME = 'Полный доступ';

async function ensureSchemaAndSeed(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS specialties (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS app_pages (
            page_key VARCHAR(64) PRIMARY KEY,
            title_ru VARCHAR(200) NOT NULL,
            html_file VARCHAR(120) NOT NULL,
            nav_slug VARCHAR(64) NOT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS specialty_page_modes (
            specialty_id INT NOT NULL,
            page_key VARCHAR(64) NOT NULL,
            mode ENUM('hidden','view','full') NOT NULL DEFAULT 'hidden',
            PRIMARY KEY (specialty_id, page_key),
            CONSTRAINT fk_spm_specialty FOREIGN KEY (specialty_id) REFERENCES specialties(id) ON DELETE CASCADE,
            CONSTRAINT fk_spm_page FOREIGN KEY (page_key) REFERENCES app_pages(page_key) ON DELETE CASCADE
        )
    `);

    const [specCol] = await db.query(`
        SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'specialty_id'
    `);
    if (!specCol[0]?.cnt) {
        await db.query('ALTER TABLE users ADD COLUMN specialty_id INT NULL');
        try {
            await db.query(`
                ALTER TABLE users
                ADD CONSTRAINT fk_users_specialty
                FOREIGN KEY (specialty_id) REFERENCES specialties(id) ON DELETE SET NULL
            `);
        } catch (_) {
            /* constraint уже есть или движок без FK */
        }
    }

    for (const p of PAGE_DEFS) {
        await db.query(
            `INSERT INTO app_pages (page_key, title_ru, html_file, nav_slug, sort_order)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE title_ru = VALUES(title_ru), html_file = VALUES(html_file),
               nav_slug = VALUES(nav_slug), sort_order = VALUES(sort_order)`,
            [p.key, p.title, p.htmlFile, p.navSlug, p.sortOrder]
        );
    }

    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM specialties');
    if (!cnt) {
        await db.query('INSERT INTO specialties (name, sort_order) VALUES (?, 0)', [DEFAULT_SPECIALTY_NAME]);
    }
    const [[defSpec]] = await db.query(
        'SELECT id FROM specialties WHERE name = ? ORDER BY id ASC LIMIT 1',
        [DEFAULT_SPECIALTY_NAME]
    );
    const sid = defSpec && defSpec.id ? defSpec.id : null;
    if (sid) {
        for (const p of PAGE_DEFS) {
            await db.query(
                `INSERT INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, 'full')
                 ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
                [sid, p.key]
            );
        }
        await db.query('UPDATE users SET specialty_id = ? WHERE specialty_id IS NULL', [sid]);
    }
}

/**
 * @returns {Record<string, 'hidden'|'view'|'full'>}
 */
async function getPageModesForSpecialty(db, specialtyId) {
    const out = {};
    if (!specialtyId) {
        for (const p of PAGE_DEFS) out[p.key] = 'full';
        return out;
    }
    const [rows] = await db.query(
        'SELECT page_key, mode FROM specialty_page_modes WHERE specialty_id = ?',
        [specialtyId]
    );
    for (const p of PAGE_DEFS) {
        const row = rows.find((r) => r.page_key === p.key);
        out[p.key] = row && row.mode ? row.mode : 'hidden';
    }
    return out;
}

async function listSpecialties(db) {
    const [rows] = await db.query(
        `SELECT s.id, s.name, s.sort_order, s.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.specialty_id = s.id) AS users_count
         FROM specialties s ORDER BY s.sort_order ASC, s.id ASC`
    );
    return rows;
}

async function createSpecialty(db, name) {
    const n = String(name || '').trim();
    if (!n || n.length < 2) throw new Error('Название специальности обязательно');
    const [r] = await db.query('INSERT INTO specialties (name, sort_order) VALUES (?, 100)', [n]);
    const id = r.insertId;
    for (const p of PAGE_DEFS) {
        await db.query(
            `INSERT INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, 'hidden')`,
            [id, p.key]
        );
    }
    return id;
}

async function renameSpecialty(db, id, name) {
    const n = String(name || '').trim();
    if (!n || n.length < 2) throw new Error('Название обязательно');
    await db.query('UPDATE specialties SET name = ? WHERE id = ?', [n, id]);
}

async function deleteSpecialty(db, id) {
    const [[def]] = await db.query('SELECT id FROM specialties WHERE name = ? LIMIT 1', [DEFAULT_SPECIALTY_NAME]);
    if (def && Number(def.id) === Number(id)) throw new Error('Нельзя удалить системную специальность');
    const [u] = await db.query('SELECT COUNT(*) AS c FROM users WHERE specialty_id = ?', [id]);
    if (Number(u[0]?.c || 0) > 0) throw new Error('К специальности привязаны пользователи');
    await db.query('DELETE FROM specialties WHERE id = ?', [id]);
}

async function setSpecialtyModes(db, specialtyId, modes) {
    if (!modes || typeof modes !== 'object') throw new Error('Нужен объект modes');
    for (const p of PAGE_DEFS) {
        const raw = modes[p.key];
        const mode = raw === 'hidden' || raw === 'view' || raw === 'full' ? raw : 'hidden';
        await db.query(
            `INSERT INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
            [specialtyId, p.key, mode]
        );
    }
}

module.exports = {
    ensureSchemaAndSeed,
    getPageModesForSpecialty,
    listSpecialties,
    createSpecialty,
    renameSpecialty,
    deleteSpecialty,
    setSpecialtyModes,
    DEFAULT_SPECIALTY_NAME
};
