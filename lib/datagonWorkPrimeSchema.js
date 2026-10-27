/**
 * Таблицы WORK (миграция work.prime-ltd.su).
 */

const {
    isVaultKeyConfigured,
    isEncryptedVaultValue,
    encryptVaultValue,
} = require('./datagonVaultCrypto');
const { WORK_SENSITIVE_KEYS } = require('./datagonSecretRedact');

/** Таблицы vault + колонки, которые шифруем at-rest. */
const WORK_VAULT_TABLE_COLS = {
    work_seo_passwords: ['admin_pass', 'password', 'ftp', 'ssa', 'value_serialize'],
    work_dev_passwords: ['admin_pass', 'password', 'ftp', 'ssa', 'value_serialize'],
    work_context_passwords: ['passYandex', 'passGoogle', 'passMyTarget', 'value_serialize'],
    work_services: ['password'],
};

async function widenWorkVaultColumns(db) {
    const alters = [
        ['work_seo_passwords', 'admin_pass', 'TEXT'],
        ['work_seo_passwords', 'password', 'TEXT'],
        ['work_dev_passwords', 'admin_pass', 'TEXT'],
        ['work_dev_passwords', 'password', 'TEXT'],
        ['work_context_passwords', 'passGoogle', 'TEXT'],
        ['work_context_passwords', 'passMyTarget', 'TEXT'],
        ['work_services', 'password', 'TEXT'],
    ];
    for (const [table, col, typ] of alters) {
        try {
            await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${col}\` ${typ} NULL`);
        } catch (_) {
            /* already TEXT / missing table */
        }
    }
}

/**
 * Одноразово шифрует legacy plaintext в vault-таблицах (если задан DATAGON_VAULT_KEY).
 * Идемпотентно: уже enc:v1: пропускает.
 */
async function migrateWorkVaultEncryptAtRest(db) {
    if (!isVaultKeyConfigured()) return { skipped: true, reason: 'no_key' };
    let updated = 0;
    let scanned = 0;
    for (const [table, cols] of Object.entries(WORK_VAULT_TABLE_COLS)) {
        const colList = cols.filter((c) => WORK_SENSITIVE_KEYS.has(c));
        if (!colList.length) continue;
        const selectCols = ['id'].concat(colList).map((c) => `\`${c}\``).join(',');
        let rows;
        try {
            const [r] = await db.query(`SELECT ${selectCols} FROM \`${table}\``);
            rows = r || [];
        } catch (_) {
            continue;
        }
        for (const row of rows) {
            scanned += 1;
            const sets = [];
            const vals = [];
            for (const col of colList) {
                const raw = row[col];
                if (raw == null || String(raw) === '') continue;
                if (isEncryptedVaultValue(raw)) continue;
                sets.push(`\`${col}\`=?`);
                vals.push(encryptVaultValue(String(raw)));
            }
            if (!sets.length) continue;
            vals.push(row.id);
            await db.query(
                `UPDATE \`${table}\` SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`,
                vals
            );
            updated += 1;
        }
    }
    return { skipped: false, scanned, updated };
}

async function ensureWorkPrimeSchema(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS work_seo_projects (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            our_project INT NOT NULL DEFAULT 0,
            procent_bonus INT NOT NULL DEFAULT 0,
            count_day_fine INT NOT NULL DEFAULT 0,
            procent_fine INT NOT NULL DEFAULT 0,
            procent_for_fine INT NOT NULL DEFAULT 0,
            bonus_add INT NOT NULL DEFAULT 0,
            bonus_enable INT NOT NULL DEFAULT 0,
            positions INT NOT NULL DEFAULT 0,
            enable_procent_seo INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            promotion_type VARCHAR(255) NULL,
            budget VARCHAR(255) NOT NULL DEFAULT '',
            osvoeno VARCHAR(255) NOT NULL DEFAULT '',
            osvoeno_titlo VARCHAR(255) NOT NULL DEFAULT '',
            osvoeno_procent VARCHAR(255) NOT NULL DEFAULT '',
            id_glavn_user VARCHAR(255) NOT NULL DEFAULT '',
            procent_seo VARCHAR(255) NOT NULL DEFAULT '',
            summa_zp VARCHAR(255) NOT NULL DEFAULT '',
            startpoint VARCHAR(255) NOT NULL DEFAULT '',
            lp VARCHAR(255) NOT NULL DEFAULT '',
            start VARCHAR(255) NOT NULL DEFAULT '',
            end VARCHAR(255) NOT NULL DEFAULT '',
            aim VARCHAR(255) NOT NULL DEFAULT '',
            region VARCHAR(255) NOT NULL DEFAULT '',
            dogovor_number VARCHAR(255) NOT NULL DEFAULT '',
            contact_person VARCHAR(255) NOT NULL DEFAULT '',
            phone_person TEXT,
            e_mail VARCHAR(255) NOT NULL DEFAULT '',
            value_serialize MEDIUMTEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_seo_projects_legacy (legacy_id),
            KEY idx_work_seo_projects_status (status),
            KEY idx_work_seo_projects_name (name_project)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Существующие БД: колонка могла отсутствовать.
    try {
        await db.query(
            `ALTER TABLE work_seo_projects ADD COLUMN osvoeno_titlo VARCHAR(255) NOT NULL DEFAULT '' AFTER osvoeno`
        );
    } catch (e) {
        if (!String(e && e.message).includes('Duplicate column')) {
            /* ignore other races; column may already exist */
        }
    }

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_seo_passwords (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            positions INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            id_glavn_user VARCHAR(255) NOT NULL DEFAULT '',
            ssa TEXT,
            ftp TEXT,
            admin_url VARCHAR(512) NOT NULL DEFAULT '',
            admin_login VARCHAR(255) NOT NULL DEFAULT '',
            admin_pass VARCHAR(255) NOT NULL DEFAULT '',
            login VARCHAR(255) NOT NULL DEFAULT '',
            password VARCHAR(255) NOT NULL DEFAULT '',
            value_serialize MEDIUMTEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_seo_passwords_legacy (legacy_id),
            KEY idx_work_seo_passwords_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_dev_passwords (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            positions INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            id_glavn_user VARCHAR(255) NOT NULL DEFAULT '',
            admin_url VARCHAR(512) NOT NULL DEFAULT '',
            admin_login VARCHAR(255) NOT NULL DEFAULT '',
            admin_pass VARCHAR(255) NOT NULL DEFAULT '',
            ssa TEXT,
            ftp TEXT,
            login VARCHAR(255) NOT NULL DEFAULT '',
            password VARCHAR(255) NOT NULL DEFAULT '',
            value_serialize MEDIUMTEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_dev_passwords_legacy (legacy_id),
            KEY idx_work_dev_passwords_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_context_projects (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            our_project INT NOT NULL DEFAULT 0,
            positions INT NOT NULL DEFAULT 0,
            enable_procent_seo INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            ya_direct VARCHAR(255) NOT NULL DEFAULT '',
            go_advords VARCHAR(255) NOT NULL DEFAULT '',
            MyTarget VARCHAR(255) NOT NULL DEFAULT '',
            ost_bslsnse_ya VARCHAR(255) NOT NULL DEFAULT '',
            ost_bslsnse_go INT NOT NULL DEFAULT 0,
            id_glavn_user VARCHAR(255) NOT NULL DEFAULT '',
            procent_seo VARCHAR(255) NOT NULL DEFAULT '',
            dogovor_number TEXT,
            contact_person VARCHAR(255) NOT NULL DEFAULT '',
            phone_person VARCHAR(255) NOT NULL DEFAULT '',
            e_mail VARCHAR(255) NOT NULL DEFAULT '',
            value_serialize MEDIUMTEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_context_projects_legacy (legacy_id),
            KEY idx_work_context_projects_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_context_passwords (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            positions INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            id_glavn_user VARCHAR(255) NOT NULL DEFAULT '',
            loginYandex TEXT,
            passYandex TEXT,
            loginGoogle VARCHAR(255) NOT NULL DEFAULT '',
            passGoogle VARCHAR(255) NOT NULL DEFAULT '',
            loginMyTarget VARCHAR(255) NOT NULL DEFAULT '',
            passMyTarget VARCHAR(255) NOT NULL DEFAULT '',
            value_serialize MEDIUMTEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_context_passwords_legacy (legacy_id),
            KEY idx_work_context_passwords_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_services (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            status INT NOT NULL DEFAULT 1,
            positions INT NOT NULL DEFAULT 0,
            name_project VARCHAR(255) NOT NULL DEFAULT '',
            login VARCHAR(255) NOT NULL DEFAULT '',
            password VARCHAR(255) NOT NULL DEFAULT '',
            dop_infa TEXT,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_services_legacy (legacy_id),
            KEY idx_work_services_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_seo_staff (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_user_id INT UNSIGNED NULL,
            datagon_user_id INT NULL,
            name VARCHAR(255) NOT NULL DEFAULT '',
            email VARCHAR(255) NOT NULL DEFAULT '',
            specialism VARCHAR(255) NOT NULL DEFAULT '',
            level VARCHAR(255) NOT NULL DEFAULT '',
            personal_specialism VARCHAR(255) NOT NULL DEFAULT '',
            seo_procent VARCHAR(255) NOT NULL DEFAULT '',
            sum_many_first VARCHAR(255) NOT NULL DEFAULT '',
            contecst_procent VARCHAR(255) NOT NULL DEFAULT '',
            sum_many_last VARCHAR(255) NOT NULL DEFAULT '',
            itog VARCHAR(255) NOT NULL DEFAULT '',
            status INT NOT NULL DEFAULT 1,
            positions INT NOT NULL DEFAULT 0,
            match_note VARCHAR(255) NULL,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_seo_staff_legacy (legacy_user_id),
            KEY idx_work_seo_staff_datagon (datagon_user_id),
            KEY idx_work_seo_staff_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_assignees (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            legacy_id INT UNSIGNED NULL,
            entity_type TINYINT NOT NULL,
            entity_legacy_id INT NOT NULL,
            entity_id INT UNSIGNED NULL,
            legacy_user_id INT NOT NULL,
            datagon_user_id INT NULL,
            created_at DATETIME NULL,
            updated_at DATETIME NULL,
            UNIQUE KEY uq_work_assignees_legacy (legacy_id),
            KEY idx_work_assignees_entity (entity_type, entity_id),
            KEY idx_work_assignees_legacy_entity (entity_type, entity_legacy_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS work_import_meta (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            source VARCHAR(128) NOT NULL,
            started_at DATETIME NOT NULL,
            finished_at DATETIME NULL,
            ok TINYINT(1) NOT NULL DEFAULT 0,
            stats_json MEDIUMTEXT,
            error_text TEXT,
            KEY idx_work_import_meta_source (source)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Глобальные пороги выплат SEO (как setting_payouts в work.prime-ltd.su).
    await db.query(`
        CREATE TABLE IF NOT EXISTS work_seo_payout_settings (
            id INT UNSIGNED NOT NULL PRIMARY KEY,
            procent_bonus INT NOT NULL DEFAULT 70,
            count_day_fine INT NOT NULL DEFAULT 30,
            procent_fine INT NOT NULL DEFAULT 60,
            procent_for_fine INT NOT NULL DEFAULT 20,
            bonus_add INT NOT NULL DEFAULT 10,
            procent_seo INT NOT NULL DEFAULT 10,
            created_at DATETIME NULL,
            updated_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        INSERT IGNORE INTO work_seo_payout_settings
          (id, procent_bonus, count_day_fine, procent_fine, procent_for_fine, bonus_add, procent_seo, created_at, updated_at)
        VALUES (1, 70, 30, 60, 20, 10, 10, NOW(), NOW())
    `);

    // F-WORK-01: ciphertext длиннее VARCHAR(255) → TEXT.
    // Массовый encrypt legacy — только явно (DATAGON_VAULT_MIGRATE=1 или scripts/migrate-work-vault-encrypt.mjs),
    // чтобы локальный dev с общей БД не зашифровал прод без ключа на сервере.
    await widenWorkVaultColumns(db);
    if (String(process.env.DATAGON_VAULT_MIGRATE || '').trim() === '1') {
        try {
            const mig = await migrateWorkVaultEncryptAtRest(db);
            if (mig && !mig.skipped) {
                console.log(
                    `[vault] WORK encrypt-at-rest migrate: updated=${mig.updated} scanned=${mig.scanned}`
                );
            } else if (mig && mig.skipped) {
                console.warn('[vault] migrate skipped:', mig.reason);
            }
        } catch (e) {
            console.warn('[vault] migrateWorkVaultEncryptAtRest:', e && e.message ? e.message : e);
        }
    }
}

module.exports = {
    ensureWorkPrimeSchema,
    widenWorkVaultColumns,
    migrateWorkVaultEncryptAtRest,
    WORK_VAULT_TABLE_COLS,
};
