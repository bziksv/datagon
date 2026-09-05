'use strict';

/**
 * MySQL ER_LOCK_DEADLOCK (1213): при параллельном парсинге UPDATE/DELETE по prices/pages
 * часто сталкиваются. Повторяем операцию; если не помогло — вызывающий код решает
 * (обычно вернуть страницу в pending, а не липкий error).
 */

function isMysqlDeadlock(err) {
    if (!err) return false;
    const code = err.errno != null ? err.errno : err.code;
    if (code === 1213 || code === 'ER_LOCK_DEADLOCK') return true;
    return /deadlock/i.test(String(err.message || err || ''));
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withDeadlockRetry(fn, opts) {
    const attempts = Math.max(1, Math.min(12, Number(opts && opts.attempts) || 5));
    let last;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            if (!isMysqlDeadlock(e) || i === attempts - 1) throw e;
            const waitMs = 40 + i * 90 + Math.floor(Math.random() * 70);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
    throw last;
}

module.exports = {
    isMysqlDeadlock,
    withDeadlockRetry,
};
