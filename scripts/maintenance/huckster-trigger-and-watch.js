'use strict';

/**
 * Ремонтная задача: ручной запуск Huckster sync БЕЗ браузера.
 *   - Поднимает свой mysql-pool из config.
 *   - Грузит actual app_settings (как server.js при старте).
 *   - Создаёт routerFactory(_db, appSettings) и вызывает factory.triggerSync().
 *   - Подписывается на getSyncState() каждую секунду и печатает прогресс/ошибку.
 *
 * Скрипт нужен, чтобы понять причину «молчаливого» падения 09.05.2026 в 07:00.
 * После доработок в routes/exportsHuckster.js (lastPhase + sync_iife_entered)
 * причина теперь обязана попасть в logs/huckster-sync.log и в syncState.error.phase.
 */

const path = require('path');
const mysql = require('mysql2/promise');
const config = require(path.join(__dirname, '..', '..', 'config'));

(async () => {
    const db = mysql.createPool({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
    });

    const appSettings = {};
    const [rows] = await db.query('SELECT setting_key, setting_value FROM app_settings');
    for (const r of rows) appSettings[r.setting_key] = r.setting_value;

    const routerFactory = require(path.join(__dirname, '..', '..', 'routes', 'exportsHuckster'));
    routerFactory(db, appSettings);
    const triggerSync = routerFactory.triggerSync;
    const getSyncState = routerFactory.getSyncState;
    if (typeof triggerSync !== 'function' || typeof getSyncState !== 'function') {
        console.error('triggerSync / getSyncState не экспортированы');
        process.exit(2);
    }

    console.log('[huckster] triggering sync...');
    const startRes = await triggerSync();
    console.log('[huckster] startRes:', startRes);

    const startedAt = Date.now();
    const HARD_LIMIT_MS = 30 * 60 * 1000; // 30 минут — для диагностики

    /* eslint-disable no-await-in-loop */
    while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = getSyncState();
        const dt = Math.round((Date.now() - startedAt) / 1000);
        process.stdout.write(
            `[+${dt.toString().padStart(4, ' ')}s] active=${s.active} ok=${s.result_success} ` +
            `snap=${s.snapshot_saved_at ? 'yes' : '-'} status="${(s.status_text || '').slice(0, 80)}"` +
            (s.error ? ` ERROR: ${s.error.code || ''} [${s.error.phase || '-'}] ${(s.error.error || '').slice(0, 120)}` : '') +
            '\n'
        );
        if (!s.active) {
            console.log('---- final state ----');
            console.log(JSON.stringify(s, null, 2));
            break;
        }
        if (Date.now() - startedAt > HARD_LIMIT_MS) {
            console.log('hard limit reached, stop watching (sync may still continue in background)');
            break;
        }
    }
    /* eslint-enable no-await-in-loop */

    await db.end();
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
