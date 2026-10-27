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
    // F-WS-02: payroll/accounting ACL — флаг, не сравнение display name.
    const [payCol] = await db.query(`
        SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'specialties' AND COLUMN_NAME = 'can_payroll'
    `);
    if (!payCol[0]?.cnt) {
        await db.query(
            'ALTER TABLE specialties ADD COLUMN can_payroll TINYINT(1) NOT NULL DEFAULT 0 AFTER name'
        );
        // Одноразово: бывшая «Бухгалтерия» по имени → can_payroll=1 («Полный доступ» не трогаем).
        await db.query(
            `UPDATE specialties SET can_payroll = 1 WHERE name = 'Бухгалтерия' AND can_payroll = 0`
        );
    }
    // F-SET-05: системная специальность по флагу, не по display name; UNIQUE(name).
    const [sysCol] = await db.query(`
        SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'specialties' AND COLUMN_NAME = 'is_system'
    `);
    if (!sysCol[0]?.cnt) {
        await db.query(
            'ALTER TABLE specialties ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0 AFTER can_payroll'
        );
    }
    await db.query(
        `UPDATE specialties SET is_system = 1
         WHERE name = ? AND is_system = 0
         ORDER BY id ASC LIMIT 1`,
        [DEFAULT_SPECIALTY_NAME]
    );
    // Дубликаты имён → переименовать лишние перед UNIQUE (пользователей переносим на первый id).
    const [dupGroups] = await db.query(`
        SELECT name, MIN(id) AS keep_id, COUNT(*) AS cnt
        FROM specialties
        GROUP BY name
        HAVING COUNT(*) > 1
    `);
    for (const g of dupGroups || []) {
        const keepId = Number(g.keep_id);
        const [dups] = await db.query(
            'SELECT id FROM specialties WHERE name = ? AND id <> ? ORDER BY id ASC',
            [g.name, keepId]
        );
        let n = 2;
        for (const d of dups || []) {
            const newName = `${String(g.name).slice(0, 100)} #${n}`;
            await db.query('UPDATE users SET specialty_id = ? WHERE specialty_id = ?', [keepId, d.id]);
            await db.query('UPDATE specialties SET name = ?, is_system = 0 WHERE id = ?', [newName, d.id]);
            n += 1;
        }
    }
    const [uniqIdx] = await db.query(`
        SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'specialties' AND INDEX_NAME = 'uq_specialties_name'
    `);
    if (!uniqIdx[0]?.cnt) {
        try {
            await db.query('ALTER TABLE specialties ADD UNIQUE KEY uq_specialties_name (name)');
        } catch (e) {
            console.warn('[specialties] UNIQUE(name):', e && e.message ? e.message : e);
        }
    }
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

    // --- Миграция: переименование страниц (page_key) ---
    // Старый key 'exports-marketplaces-unpublished' переехал в 'exports-marketplaces-issues'
    // (см. PAGE_DEFS). FK fk_spm_page объявлен с ON DELETE CASCADE, но БЕЗ ON UPDATE CASCADE,
    // поэтому простой UPDATE app_pages.page_key падает: в specialty_page_modes есть ссылки на
    // старый ключ. Поэтому порядок: 1) создать новую строку в app_pages, 2) перенаправить child
    // на новый ключ, 3) удалить старую строку app_pages.
    const PAGE_KEY_RENAMES = [
        { from: 'exports-marketplaces-unpublished', to: 'exports-marketplaces-issues' },
    ];
    for (const ren of PAGE_KEY_RENAMES) {
        try {
            const [exists] = await db.query(
                'SELECT 1 FROM app_pages WHERE page_key = ? LIMIT 1', [ren.from]
            );
            if (!exists || !exists.length) continue;

            const newDef = PAGE_DEFS.find((p) => p.key === ren.to);
            if (newDef) {
                await db.query(
                    `INSERT INTO app_pages (page_key, title_ru, html_file, nav_slug, sort_order)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE title_ru = VALUES(title_ru), html_file = VALUES(html_file),
                       nav_slug = VALUES(nav_slug), sort_order = VALUES(sort_order)`,
                    [newDef.key, newDef.title, newDef.htmlFile, newDef.navSlug, newDef.sortOrder]
                );
            }

            await db.query(
                `INSERT INTO specialty_page_modes (specialty_id, page_key, mode)
                 SELECT specialty_id, ?, mode FROM specialty_page_modes WHERE page_key = ?
                 ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
                [ren.to, ren.from]
            );
            await db.query('DELETE FROM specialty_page_modes WHERE page_key = ?', [ren.from]);
            await db.query('DELETE FROM app_pages WHERE page_key = ?', [ren.from]);
        } catch (e) {
            console.warn('[specialties] page_key rename', ren.from, '->', ren.to, ':', e && e.message ? e.message : e);
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
        await db.query(
            'INSERT INTO specialties (name, sort_order, is_system) VALUES (?, 0, 1)',
            [DEFAULT_SPECIALTY_NAME]
        );
    }
    const [[defSpec]] = await db.query(
        `SELECT id FROM specialties
         WHERE is_system = 1 OR name = ?
         ORDER BY is_system DESC, id ASC LIMIT 1`,
        [DEFAULT_SPECIALTY_NAME]
    );
    const sid = defSpec && defSpec.id ? defSpec.id : null;
    if (sid) {
        await db.query('UPDATE specialties SET is_system = 1 WHERE id = ?', [sid]);
        for (const p of PAGE_DEFS) {
            await db.query(
                `INSERT INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, 'full')
                 ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
                [sid, p.key]
            );
        }
        await db.query('UPDATE users SET specialty_id = ? WHERE specialty_id IS NULL', [sid]);
    }

    /**
     * Если в PAGE_DEFS добавили новые страницы после создания групп, у старых
     * специальностей не было строк в specialty_page_modes. Без этой дозаливки
     * getPageModesForSpecialty() считает такие страницы hidden, даже если
     * админ уже видит их в справочнике app_pages.
     */
    const [specialties] = await db.query(
        'SELECT id, name, COALESCE(is_system, 0) AS is_system FROM specialties'
    );
    for (const sp of specialties || []) {
        const isDefault = Number(sp.is_system) === 1;
        for (const p of PAGE_DEFS) {
            await db.query(
                `INSERT IGNORE INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, ?)`,
                [sp.id, p.key, isDefault ? 'full' : 'hidden']
            );
        }
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
        `SELECT s.id, s.name, COALESCE(s.can_payroll, 0) AS can_payroll,
                COALESCE(s.is_system, 0) AS is_system, s.sort_order, s.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.specialty_id = s.id AND COALESCE(u.is_archived, 0) = 0) AS users_count
         FROM specialties s ORDER BY s.sort_order ASC, s.id ASC`
    );
    return (rows || []).map((r) => ({
        ...r,
        can_payroll: Number(r.can_payroll || 0) === 1,
        is_system: Number(r.is_system || 0) === 1,
    }));
}

async function assertNotSystemSpecialty(db, id, actionLabel) {
    const [[row]] = await db.query(
        'SELECT id, name, COALESCE(is_system, 0) AS is_system FROM specialties WHERE id = ?',
        [id]
    );
    if (!row) throw new Error('Специальность не найдена');
    if (Number(row.is_system) === 1) {
        throw new Error(
            actionLabel || 'Нельзя изменять системную специальность «Полный доступ»'
        );
    }
    return row;
}

async function createSpecialty(db, name) {
    const n = String(name || '').trim();
    if (!n || n.length < 2) throw new Error('Название специальности обязательно');
    if (n === DEFAULT_SPECIALTY_NAME) {
        throw new Error('Имя «Полный доступ» зарезервировано для системной специальности');
    }
    try {
        const [r] = await db.query(
            'INSERT INTO specialties (name, sort_order, is_system) VALUES (?, 100, 0)',
            [n]
        );
        const id = r.insertId;
        for (const p of PAGE_DEFS) {
            await db.query(
                `INSERT INTO specialty_page_modes (specialty_id, page_key, mode) VALUES (?, ?, 'hidden')`,
                [id, p.key]
            );
        }
        return id;
    } catch (e) {
        if (e && (e.code === 'ER_DUP_ENTRY' || Number(e.errno) === 1062)) {
            throw new Error('Специальность с таким именем уже есть');
        }
        throw e;
    }
}

async function renameSpecialty(db, id, name) {
    await assertNotSystemSpecialty(db, id, 'Нельзя переименовать системную специальность');
    const n = String(name || '').trim();
    if (!n || n.length < 2) throw new Error('Название обязательно');
    if (n === DEFAULT_SPECIALTY_NAME) {
        throw new Error('Имя «Полный доступ» зарезервировано');
    }
    try {
        await db.query('UPDATE specialties SET name = ? WHERE id = ?', [n, id]);
    } catch (e) {
        if (e && (e.code === 'ER_DUP_ENTRY' || Number(e.errno) === 1062)) {
            throw new Error('Специальность с таким именем уже есть');
        }
        throw e;
    }
}

/** @param {{ name?: string, can_payroll?: boolean|number|string }} patch */
async function updateSpecialty(db, id, patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const [[row]] = await db.query(
        'SELECT id, COALESCE(is_system, 0) AS is_system FROM specialties WHERE id = ?',
        [id]
    );
    if (!row) throw new Error('Специальность не найдена');
    const sets = [];
    const vals = [];
    if (p.name != null) {
        if (Number(row.is_system) === 1) {
            throw new Error('Нельзя переименовать системную специальность');
        }
        const n = String(p.name || '').trim();
        if (!n || n.length < 2) throw new Error('Название обязательно');
        if (n === DEFAULT_SPECIALTY_NAME) {
            throw new Error('Имя «Полный доступ» зарезервировано');
        }
        sets.push('name = ?');
        vals.push(n);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'can_payroll')) {
        const v =
            p.can_payroll === true ||
            p.can_payroll === 1 ||
            p.can_payroll === '1' ||
            String(p.can_payroll).toLowerCase() === 'true'
                ? 1
                : 0;
        sets.push('can_payroll = ?');
        vals.push(v);
    }
    if (!sets.length) throw new Error('Нет полей для обновления');
    vals.push(id);
    try {
        await db.query(`UPDATE specialties SET ${sets.join(', ')} WHERE id = ?`, vals);
    } catch (e) {
        if (e && (e.code === 'ER_DUP_ENTRY' || Number(e.errno) === 1062)) {
            throw new Error('Специальность с таким именем уже есть');
        }
        throw e;
    }
}

async function deleteSpecialty(db, id) {
    await assertNotSystemSpecialty(db, id, 'Нельзя удалить системную специальность');
    const [u] = await db.query('SELECT COUNT(*) AS c FROM users WHERE specialty_id = ?', [id]);
    if (Number(u[0]?.c || 0) > 0) throw new Error('К специальности привязаны пользователи');
    await db.query('DELETE FROM specialties WHERE id = ?', [id]);
}

/** Системная «Полный доступ» — по флагу is_system (F-SET-05). */
async function getSystemSpecialtyId(db) {
    const [[row]] = await db.query(
        `SELECT id FROM specialties
         WHERE is_system = 1 OR name = ?
         ORDER BY is_system DESC, id ASC LIMIT 1`,
        [DEFAULT_SPECIALTY_NAME]
    );
    return row && row.id ? Number(row.id) : null;
}

async function isSystemSpecialtyId(db, specialtyId) {
    const id = Number(specialtyId);
    if (!Number.isFinite(id) || id <= 0) return false;
    const [[row]] = await db.query(
        'SELECT COALESCE(is_system, 0) AS is_system FROM specialties WHERE id = ?',
        [id]
    );
    return Number(row?.is_system || 0) === 1;
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
    updateSpecialty,
    deleteSpecialty,
    setSpecialtyModes,
    getSystemSpecialtyId,
    isSystemSpecialtyId,
    DEFAULT_SPECIALTY_NAME
};
