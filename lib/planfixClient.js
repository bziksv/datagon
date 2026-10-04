'use strict';

/**
 * Клиент REST API ПланФикс (аккаунт вида https://{account}.planfix.ru/rest).
 * Пока только ping / userinfo — выборка заявок будет отдельно.
 * @see https://planfix.ru/help/REST_API
 */

const DEFAULT_ACCOUNT = 'almamed';

function normAccount(raw) {
    const s = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\.planfix\.(ru|com).*$/i, '')
        .replace(/[^a-z0-9-]/g, '');
    return s || DEFAULT_ACCOUNT;
}

function restBase(account) {
    return `https://${normAccount(account)}.planfix.ru/rest`;
}

function credsFromSettings(appSettings) {
    const account = normAccount(appSettings && appSettings.planfix_account);
    const token = String((appSettings && appSettings.planfix_rest_api_key) || '').trim();
    return { account, token, base: restBase(account) };
}

/**
 * GET /userinfo (fallback GET /ping). Bearer-токен из «Доступ к API».
 * @returns {Promise<{ ok: boolean, status: number, base: string, message: string, user?: object }>}
 */
async function testConnection(appSettings) {
    const { account, token, base } = credsFromSettings(appSettings);
    if (!token) {
        return { ok: false, status: 0, base, message: 'Не задан REST-токен (planfix_rest_api_key)' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    };
    try {
        let res = await fetch(`${base}/userinfo`, { method: 'GET', headers, signal: ctrl.signal });
        let bodyText = await res.text();
        if (!res.ok) {
            const ping = await fetch(`${base}/ping`, { method: 'GET', headers, signal: ctrl.signal });
            if (ping.ok) {
                return {
                    ok: true,
                    status: ping.status,
                    base,
                    account,
                    message: `Пинг ${account}.planfix.ru успешен (HTTP ${ping.status}); /userinfo вернул ${res.status}`,
                };
            }
            let snippet = bodyText.slice(0, 240);
            try {
                const j = JSON.parse(bodyText);
                snippet = j.error || j.message || snippet;
            } catch (_) {}
            return {
                ok: false,
                status: res.status,
                base,
                account,
                message: `Planfix HTTP ${res.status}: ${snippet || res.statusText}`,
            };
        }
        let user = null;
        try {
            user = JSON.parse(bodyText);
        } catch (_) {}
        const name =
            (user && (user.name || user.fullName || user.email || (user.user && user.user.name))) || '';
        return {
            ok: true,
            status: res.status,
            base,
            account,
            message: name
                ? `Подключение ок: ${String(name).slice(0, 80)}`
                : `Подключение ок (HTTP ${res.status}, ${account}.planfix.ru)`,
            user: user && typeof user === 'object' ? { id: user.id, name: user.name || user.fullName || '' } : undefined,
        };
    } catch (e) {
        const aborted = e && e.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            base,
            account,
            message: aborted ? 'Таймаут 15 с — Planfix не ответил' : e && e.message ? e.message : 'Ошибка запроса',
        };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    DEFAULT_ACCOUNT,
    normAccount,
    restBase,
    credsFromSettings,
    testConnection,
};
