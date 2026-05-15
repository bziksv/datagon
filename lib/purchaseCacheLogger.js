'use strict';

/**
 * Отдельный файл логов для прогрева кэша закупок (не смешивать с logs/server.out).
 * Пишет в logs/purchase-cache.log (JSONL).
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'purchase-cache.log');

function ensureLogFile() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
    } catch (_) {
        /* ignore */
    }
}

function purchaseCacheLogFire(runLabel, message, meta) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        run: String(runLabel || ''),
        msg: String(message || ''),
        meta: meta && typeof meta === 'object' ? meta : { v: meta },
    });
    try {
        ensureLogFile();
        fs.appendFile(LOG_FILE, line + '\n', () => {});
    } catch (_) {
        /* ignore */
    }
}

function purchaseCacheLogListFire(runLabel, message, rows) {
    purchaseCacheLogFire(runLabel, message, { n: Array.isArray(rows) ? rows.length : 0 });
}

module.exports = {
    purchaseCacheLogFire,
    purchaseCacheLogListFire,
    LOG_FILE,
};
