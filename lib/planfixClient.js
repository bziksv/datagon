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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function planfixNetCode(e) {
    const c = e && e.cause;
    return String((c && c.code) || (e && e.code) || '');
}

function isTransientPlanfixNetError(e) {
    if (!e) return false;
    if (e.http && e.http >= 400 && e.http < 500) return false;
    if (e.name === 'AbortError') return true;
    const code = planfixNetCode(e);
    if (
        /UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(
            code
        )
    ) {
        return true;
    }
    const msg = String((e && e.message) || '');
    return /fetch failed|other side closed|socket|network|ECONNRESET/i.test(msg);
}

function wrapPlanfixNetError(e) {
    if (e && e.status) return e;
    const code = planfixNetCode(e);
    const raw = String((e && e.message) || 'ошибка сети');
    const err = new Error(
        /fetch failed|UND_ERR_SOCKET|other side closed/i.test(`${raw} ${code}`)
            ? `Planfix оборвал соединение (${code || raw}). Повторите синк; для всего года при обрыве берите по месяцам.`
            : raw
    );
    err.status = e && e.name === 'AbortError' ? 504 : 502;
    err.cause = e;
    return err;
}

async function restJsonOnce(appSettings, method, path, body, timeoutMs) {
    const { token, base } = credsFromSettings(appSettings);
    if (!token) {
        const err = new Error('Не задан REST-токен (planfix_rest_api_key)');
        err.status = 400;
        throw err;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    try {
        const res = await fetch(url, {
            method: method || 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                ...(body != null ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body != null ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch (_) {
            json = null;
        }
        const failCode = json && typeof json === 'object' ? json.result : '';
        if (!res.ok || failCode === 'fail' || failCode === 'error') {
            const snippet =
                (json && (json.error || json.message || json.code)) ||
                String(text || '').slice(0, 240) ||
                res.statusText;
            const err = new Error(`Planfix ${method || 'GET'} ${path} HTTP ${res.status}: ${snippet}`);
            err.status = res.ok ? 502 : res.status >= 400 && res.status < 600 ? res.status : 502;
            err.http = res.status;
            err.body = json;
            throw err;
        }
        return json == null ? {} : json;
    } catch (e) {
        if (e && e.name === 'AbortError') {
            const err = new Error('Таймаут запроса к Planfix');
            err.status = 504;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * JSON-запрос к REST. 200 с result=fail тоже ошибка.
 * Обрыв TLS (UND_ERR_SOCKET / fetch failed) — до 4 попыток.
 */
async function restJson(appSettings, method, path, body, timeoutMs) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
            return await restJsonOnce(appSettings, method, path, body, timeoutMs);
        } catch (e) {
            lastErr = e;
            if (!isTransientPlanfixNetError(e) || attempt === 4) break;
            await sleep(700 * attempt);
        }
    }
    throw wrapPlanfixNetError(lastErr);
}

module.exports = {
    DEFAULT_ACCOUNT,
    normAccount,
    restBase,
    credsFromSettings,
    testConnection,
    restJson,
};
