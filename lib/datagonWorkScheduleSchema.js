'use strict';

/**
 * DDL модуля «График работы» (ws_*).
 */

async function ensureWorkScheduleSchema(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_organization (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            inn VARCHAR(32) NULL,
            address VARCHAR(512) NULL,
            timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow',
            sick_unofficial_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
            seniority_base DECIMAL(12,2) NOT NULL DEFAULT 1000,
            seniority_step DECIMAL(12,2) NOT NULL DEFAULT 500,
            seniority_period_months INT UNSIGNED NOT NULL DEFAULT 6,
            clock_auto_close_hours DECIMAL(6,2) NOT NULL DEFAULT 14,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_department (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            organization_id INT UNSIGNED NOT NULL,
            name VARCHAR(255) NOT NULL,
            head_user_id INT UNSIGNED NULL,
            schedule_type VARCHAR(32) NOT NULL DEFAULT '5/2',
            norm_hours DECIMAL(6,2) NOT NULL DEFAULT 8,
            rate_full_hours DECIMAL(6,2) NOT NULL DEFAULT 7,
            rate_half_hours DECIMAL(6,2) NOT NULL DEFAULT 4,
            vacation_overlap_limit INT UNSIGNED NOT NULL DEFAULT 1,
            premium_rule_json JSON NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_ws_dept_org (organization_id),
            KEY idx_ws_dept_head (head_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_employee (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            organization_id INT UNSIGNED NOT NULL,
            department_id INT UNSIGNED NOT NULL,
            position VARCHAR(255) NULL,
            hire_date DATE NULL,
            fire_date DATE NULL,
            salary DECIMAL(14,2) NOT NULL DEFAULT 0,
            grade VARCHAR(64) NULL,
            official_employment TINYINT(1) NOT NULL DEFAULT 0,
            personal_work_hours_per_day DECIMAL(6,2) NULL,
            personal_rate_full_hours DECIMAL(6,2) NULL,
            personal_rate_half_hours DECIMAL(6,2) NULL,
            personal_sick_leave_rate DECIMAL(12,2) NULL,
            personal_schedule_type VARCHAR(32) NULL,
            personal_seniority_base DECIMAL(12,2) NULL,
            personal_seniority_step DECIMAL(12,2) NULL,
            personal_seniority_period_months INT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ws_emp_user (user_id),
            KEY idx_ws_emp_org (organization_id),
            KEY idx_ws_emp_dept (department_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_work_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            work_date DATE NOT NULL,
            type VARCHAR(32) NOT NULL DEFAULT 'work',
            rate DECIMAL(4,2) NOT NULL DEFAULT 0,
            check_in DATETIME NULL,
            check_out DATETIME NULL,
            check_in_ip VARCHAR(64) NULL,
            check_out_ip VARCHAR(64) NULL,
            check_in_device VARCHAR(255) NULL,
            check_out_device VARCHAR(255) NULL,
            user_agent VARCHAR(512) NULL,
            hours_worked DECIMAL(8,4) NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'clock',
            status VARCHAR(32) NOT NULL DEFAULT 'ok',
            comment VARCHAR(512) NULL,
            edited_by INT UNSIGNED NULL,
            edited_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ws_log_emp_date (employee_id, work_date),
            KEY idx_ws_log_date (work_date),
            KEY idx_ws_log_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_payroll_entry (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            period_ym CHAR(7) NOT NULL,
            base_salary DECIMAL(14,2) NOT NULL DEFAULT 0,
            premium DECIMAL(14,2) NOT NULL DEFAULT 0,
            seniority_bonus DECIMAL(14,2) NOT NULL DEFAULT 0,
            vacation_pay DECIMAL(14,2) NOT NULL DEFAULT 0,
            sick_pay DECIMAL(14,2) NOT NULL DEFAULT 0,
            dayoff_pay DECIMAL(14,2) NOT NULL DEFAULT 0,
            business_trip_pay DECIMAL(14,2) NOT NULL DEFAULT 0,
            vacation_compensation DECIMAL(14,2) NOT NULL DEFAULT 0,
            total DECIMAL(14,2) NOT NULL DEFAULT 0,
            worked_days DECIMAL(8,2) NOT NULL DEFAULT 0,
            norm_days DECIMAL(8,2) NOT NULL DEFAULT 0,
            calculated_at DATETIME NOT NULL,
            UNIQUE KEY uq_ws_pay_emp_period (employee_id, period_ym),
            KEY idx_ws_pay_period (period_ym)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_vacation_request (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            date_from DATE NOT NULL,
            date_to DATE NOT NULL,
            days_count INT UNSIGNED NOT NULL,
            type VARCHAR(32) NOT NULL DEFAULT 'annual',
            status VARCHAR(32) NOT NULL DEFAULT 'pending',
            approver_id INT UNSIGNED NULL,
            approved_at DATETIME NULL,
            reject_reason VARCHAR(512) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_ws_vac_emp (employee_id),
            KEY idx_ws_vac_status (status),
            KEY idx_ws_vac_dates (date_from, date_to)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_sick_leave (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            date_from DATE NOT NULL,
            date_to DATE NOT NULL,
            official TINYINT(1) NOT NULL DEFAULT 0,
            document_number VARCHAR(128) NULL,
            document_file VARCHAR(512) NULL,
            amount DECIMAL(14,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_ws_sick_emp (employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_absence (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            type VARCHAR(32) NOT NULL,
            date_from DATE NOT NULL,
            date_to DATE NOT NULL,
            paid TINYINT(1) NOT NULL DEFAULT 0,
            amount DECIMAL(14,2) NOT NULL DEFAULT 0,
            comment VARCHAR(512) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_ws_abs_emp (employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_vacation_compensation (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            days DECIMAL(8,2) NOT NULL,
            amount DECIMAL(14,2) NOT NULL,
            reason VARCHAR(64) NOT NULL,
            approved_by INT UNSIGNED NULL,
            paid_at DATE NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ws_vc_emp (employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_work_calendar (
            cal_date DATE NOT NULL PRIMARY KEY,
            is_working_day TINYINT(1) NOT NULL DEFAULT 1,
            norm_hours DECIMAL(6,2) NOT NULL DEFAULT 8,
            holiday_name VARCHAR(255) NULL,
            transfer_note VARCHAR(255) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_audit_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            entity_type VARCHAR(64) NOT NULL,
            entity_id VARCHAR(64) NOT NULL,
            action VARCHAR(64) NOT NULL,
            field_name VARCHAR(128) NULL,
            old_value TEXT NULL,
            new_value TEXT NULL,
            user_id INT UNSIGNED NULL,
            user_role VARCHAR(64) NULL,
            ip VARCHAR(64) NULL,
            user_agent VARCHAR(512) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ws_audit_entity (entity_type, entity_id),
            KEY idx_ws_audit_created (created_at),
            KEY idx_ws_audit_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_1c_employee_map (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            employee_id INT UNSIGNED NOT NULL,
            external_code VARCHAR(128) NOT NULL,
            department_code VARCHAR(128) NULL,
            UNIQUE KEY uq_ws_1c_emp (employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ws_notification (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            kind VARCHAR(64) NOT NULL,
            title VARCHAR(255) NOT NULL,
            body VARCHAR(1024) NULL,
            is_read TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ws_notif_user (user_id, is_read)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await seedDefaultOrganizations(db);
}

/**
 * Отделы графика ← специальности из Настроек (`specialties`), без «Полный доступ».
 * Уже существующие имена (без учёта регистра) не дублируются.
 * Нормы по умолчанию: «склад» → 2/2 12ч, остальные → 5/2 8ч (можно править в UI).
 */
async function importDepartmentsFromSpecialties(db, orgId) {
    const oid = Number(orgId);
    if (!oid) return { created: 0, skipped: 0, total_specialties: 0 };
    const stub = JSON.stringify({ kind: 'stub' });
    let specs = [];
    try {
        const [rows] = await db.query(
            `SELECT id, name FROM specialties
             WHERE TRIM(name) <> '' AND name <> ?
             ORDER BY sort_order ASC, name ASC`,
            ['Полный доступ']
        );
        specs = rows || [];
    } catch (e) {
        return { created: 0, skipped: 0, total_specialties: 0, error: e && e.message };
    }
    const [existing] = await db.query(
        'SELECT LOWER(TRIM(name)) AS n FROM ws_department WHERE organization_id = ?',
        [oid]
    );
    const have = new Set((existing || []).map((r) => String(r.n || '')));
    let created = 0;
    let skipped = 0;
    for (const s of specs) {
        const name = String(s.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (have.has(key)) {
            skipped += 1;
            continue;
        }
        const warehouse = /склад/i.test(name);
        await db.query(
            `INSERT INTO ws_department
             (organization_id, name, schedule_type, norm_hours, rate_full_hours, rate_half_hours, premium_rule_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            warehouse
                ? [oid, name, '2/2', 12, 11, 6, stub]
                : [oid, name, '5/2', 8, 7, 4, stub]
        );
        have.add(key);
        created += 1;
    }
    return { created, skipped, total_specialties: specs.length };
}

/**
 * Первичное наполнение юрлиц. Демо «Демо Мед» без сотрудников → Альмамед.
 * Гарантируем как минимум Альмамед + Вилмед. Отделы — из specialties, не демо.
 */
async function seedDefaultOrganizations(db) {
    const [empCnt] = await db.query('SELECT COUNT(*) AS c FROM ws_employee');
    const hasEmployees = Number(empCnt[0] && empCnt[0].c) > 0;

    if (!hasEmployees) {
        const [demo] = await db.query(
            `SELECT id FROM ws_organization WHERE name LIKE '%Демо Мед%' LIMIT 1`
        );
        if (demo.length) {
            await db.query(
                `UPDATE ws_organization SET name = ?, inn = NULL WHERE id = ?`,
                ['ООО «АЛЬМАМЕД»', demo[0].id]
            );
        }
    }

    const defaults = [
        { name: 'ООО «АЛЬМАМЕД»', sick: 2500 },
        { name: 'ООО «ВИЛМЕД»', sick: 2500 },
    ];

    for (const o of defaults) {
        const [ex] = await db.query('SELECT id FROM ws_organization WHERE name = ? LIMIT 1', [o.name]);
        let orgId;
        if (ex.length) {
            orgId = ex[0].id;
        } else {
            const [ins] = await db.query(
                `INSERT INTO ws_organization (name, timezone, sick_unofficial_rate, seniority_base, seniority_step, seniority_period_months)
                 VALUES (?, 'Europe/Moscow', ?, 1000, 500, 6)`,
                [o.name, o.sick]
            );
            orgId = ins.insertId;
        }
        const [deptCnt] = await db.query(
            'SELECT COUNT(*) AS c FROM ws_department WHERE organization_id = ?',
            [orgId]
        );
        if (Number(deptCnt[0].c) === 0) {
            await importDepartmentsFromSpecialties(db, orgId);
        }
    }
}

module.exports = {
    ensureWorkScheduleSchema,
    seedDefaultOrganizations,
    importDepartmentsFromSpecialties,
};
