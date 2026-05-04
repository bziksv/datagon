/**
 * Общий UA, HTTP(S)- и SOCKS5-прокси (ротация при ошибке) и повторные GET для внешних сайтов.
 * Используется: routes/pages.js (discovery + runParser), worker.js.
 */

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SITE_HTML_USER_AGENT =
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)';

const MAX_PROXY_LINES = 40;
const MAX_PROXY_LIST_CHARS = 120000;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseProxyList(raw) {
    if (raw == null) return [];
    const s = String(raw).trim();
    if (!s) return [];
    return s
        .split(/[\r\n,;]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_PROXY_LINES);
}

/**
 * @param {{ enabled?: unknown, list?: unknown }} proxyOpt
 */
function proxyTransportChain(proxyOpt) {
    const enabled = Number(proxyOpt && proxyOpt.enabled) === 1;
    const list = parseProxyList(proxyOpt && proxyOpt.list);
    if (enabled && list.length) return list;
    return [null];
}

/** Без схемы считаем SOCKS5 (частый случай `host:port`). */
function normalizeProxyUrlString(proxyUrl) {
    const u = String(proxyUrl || '').trim();
    if (!u) return '';
    if (!/:\/\//.test(u)) return `socks5://${u.replace(/^\/+/, '')}`;
    return u;
}

function createProxyAgent(proxyUrl) {
    const raw = normalizeProxyUrlString(proxyUrl);
    let proto = '';
    try {
        proto = new URL(raw).protocol.replace(/:$/, '').toLowerCase();
    } catch (_) {
        return new HttpsProxyAgent(proxyUrl, { keepAlive: true });
    }
    if (proto === 'socks5' || proto === 'socks4' || proto === 'socks4a') {
        return new SocksProxyAgent(raw, { keepAlive: true });
    }
    return new HttpsProxyAgent(raw, { keepAlive: true });
}

/**
 * @param {import('axios').AxiosRequestConfig} cfg
 * @param {string | null} proxyUrl
 */
function applyProxyToAxiosConfig(cfg, proxyUrl) {
    if (!proxyUrl) return;
    const agent = createProxyAgent(proxyUrl);
    cfg.httpsAgent = agent;
    cfg.httpAgent = agent;
    cfg.proxy = false;
}

/** Мёртвый/ротируемый SOCKS или отказ порта — сразу следующий прокси, без долгих волн на том же. */
function isLikelyProxyTransportFailure(err) {
    if (!err) return false;
    const code = err.code;
    const codes = new Set([
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNABORTED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EPIPE',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPROTO'
    ]);
    if (codes.has(code)) return true;
    const msg = String(err.message || err || '').toLowerCase();
    if (
        /connection refused|rejected connection|socks.*reject|econnrefused|socket hang up|proxy connection|tunnel.*fail|network.*unreachable/i.test(
            msg
        )
    ) {
        return true;
    }
    if (err.cause && isLikelyProxyTransportFailure(err.cause)) return true;
    return false;
}

function formatFetchErr(lastErr) {
    const st = lastErr && lastErr.response && lastErr.response.status;
    const hint = st ? `HTTP ${st}` : (lastErr && lastErr.code) || '';
    const tail = [hint, lastErr && lastErr.message].filter(Boolean).join(' ').trim();
    return new Error(tail || 'Не удалось загрузить страницу');
}

/**
 * DDoS-Guard / antiDDoS часто отвечают 200 и HTML вместо robots / XML — иначе 0 URL и нет ротации прокси.
 * @param {string} body
 * @param {'robots'|'sitemap'|'html'} kind
 */
function assertDiscoveryBodyNotWafHtml(body, kind) {
    if (kind === 'html') return;
    const t = String(body || '').trimStart();
    if (!t.startsWith('<')) return;
    const looksHtml = /^<\s*!?DOCTYPE\s+html/i.test(t) || /^<\s*html[\s>]/i.test(t);
    if (!looksHtml) return;
    if (kind === 'sitemap') {
        const e = new Error(
            'WAF: вместо sitemap пришла HTML-страница (часто DDoS-Guard); другой прокси или allowlist IP'
        );
        e.response = { status: 403 };
        throw e;
    }
    if (kind === 'robots') {
        const e = new Error(
            'WAF: вместо robots.txt пришла HTML-страница (часто DDoS-Guard); другой прокси или allowlist IP'
        );
        e.response = { status: 403 };
        throw e;
    }
}

/**
 * @param {import('axios').AxiosStatic} axiosImpl
 * @param {string} url
 * @param {{ timeout?: number, proxy?: { enabled?: unknown, list?: unknown } }} [options]
 * @returns {Promise<string>}
 */
async function fetchHtmlForSiteParse(axiosImpl, url, options = {}) {
    const timeout = Math.max(5000, Number(options.timeout) || 20000);
    const proxyOpt = options.proxy || { enabled: false, list: '' };
    let origin = '';
    try {
        origin = new URL(url).origin;
    } catch (_) {
        throw new Error('Некорректный URL');
    }
    const referer = `${origin}/`;

    const headersFull = {
        'User-Agent': SITE_HTML_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer
    };
    const headersMin = {
        'User-Agent': SITE_HTML_USER_AGENT,
        Accept: 'text/html,*/*'
    };

    const wavePausesMs = [0, 900, 2100, 3800];
    const transports = proxyTransportChain(proxyOpt);

    let lastOuter = null;
    proxyOuter: for (const proxyUrl of transports) {
        let lastErr = null;
        for (let w = 0; w < wavePausesMs.length; w++) {
            const pause = wavePausesMs[w];
            if (pause > 0) {
                const jitter = Math.floor(Math.random() * 900);
                await new Promise((r) => setTimeout(r, pause + jitter));
            }
            for (const headers of [headersFull, headersMin]) {
                try {
                    const cfg = {
                        timeout,
                        maxRedirects: 5,
                        headers,
                        responseType: 'text',
                        validateStatus: (s) => s >= 200 && s < 400
                    };
                    applyProxyToAxiosConfig(cfg, proxyUrl);
                    const resp = await axiosImpl.get(url, cfg);
                    return String(resp.data || '');
                } catch (e) {
                    lastErr = e;
                    if (isLikelyProxyTransportFailure(e)) {
                        lastOuter = e;
                        continue proxyOuter;
                    }
                    const st = e && e.response && e.response.status;
                    const code = e && e.code;
                    if (st === 403 || st === 429 || st === 401) continue;
                    if (code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') continue;
                    throw e;
                }
            }
        }
        lastOuter = lastErr;
    }
    throw formatFetchErr(lastOuter);
}

/**
 * GET для автообхода (robots / sitemap / html): UA + прокси-ротация при полном провале транспорта.
 *
 * @param {import('axios').AxiosStatic} axiosImpl
 * @param {string} url
 * @param {number} timeout
 * @param {{
 *   kind?: 'robots'|'sitemap'|'html',
 *   referer?: string,
 *   stickySession?: { ua: string | null } | null,
 *   userAgents: string[],
 *   proxy?: { enabled?: unknown, list?: unknown },
 *   signal?: AbortSignal
 * }} opts
 */
async function fetchDiscoverText(axiosImpl, url, timeout, opts) {
    const kind = opts.kind || 'html';
    const stickySession = opts.stickySession || null;
    const userAgents = Array.isArray(opts.userAgents) && opts.userAgents.length ? opts.userAgents : [SITE_HTML_USER_AGENT];
    let origin = '';
    try {
        origin = new URL(url).origin;
    } catch (_) {
        throw new Error('Некорректный URL');
    }
    const referer = String(opts.referer || '').trim() || `${origin}/`;

    function buildHeaders(userAgent, minimal) {
        if (minimal) {
            const accept =
                kind === 'sitemap'
                    ? 'application/xml,text/xml,*/*'
                    : kind === 'robots'
                      ? 'text/plain,text/html,*/*'
                      : 'text/html,*/*';
            return { 'User-Agent': userAgent, Accept: accept };
        }
        const acceptFull =
            kind === 'robots'
                ? 'text/plain,text/html,application/xhtml+xml,*/*;q=0.8'
                : kind === 'sitemap'
                  ? 'application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8'
                  : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
        return {
            'User-Agent': userAgent,
            Accept: acceptFull,
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            Referer: referer
        };
    }

    async function attemptOneTransport(proxyUrl, userAgent, minimal) {
        const cfg = {
            timeout,
            maxRedirects: 5,
            headers: buildHeaders(userAgent, minimal),
            responseType: 'text',
            validateStatus: (s) => s >= 200 && s < 400
        };
        if (signal) cfg.signal = signal;
        applyProxyToAxiosConfig(cfg, proxyUrl);
        const resp = await axiosImpl.get(url, cfg);
        const text = String(resp.data || '');
        assertDiscoveryBodyNotWafHtml(text, kind);
        return text;
    }

    async function tryUserAgentsForTransport(proxyUrl, uaList, lockOnSuccess) {
        let lastErr = null;
        for (const userAgent of uaList) {
            for (const minimal of [false, true]) {
                try {
                    const text = await attemptOneTransport(proxyUrl, userAgent, minimal);
                    if (lockOnSuccess && stickySession && stickySession.ua == null) {
                        stickySession.ua = userAgent;
                    }
                    return text;
                } catch (e) {
                    lastErr = e;
                    if (isLikelyProxyTransportFailure(e)) {
                        throw Object.assign(new Error('SKIP_PROXY'), {
                            code: 'SKIP_PROXY',
                            cause: e
                        });
                    }
                    const st = e && e.response && e.response.status;
                    if (st === 403 || st === 401 || st === 429) continue;
                    const code = e && e.code;
                    if (code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') continue;
                    throw e;
                }
            }
        }
        throw lastErr || new Error('discover fetch failed');
    }

    const uaSticky = stickySession && stickySession.ua ? [stickySession.ua] : null;
    const uaList = uaSticky || userAgents;
    const lockOnSuccess = !uaSticky;
    const signal = opts.signal || null;

    const transports = proxyTransportChain(opts.proxy || { enabled: false, list: '' });
    let lastOuter = null;
    for (const proxyUrl of transports) {
        try {
            return await tryUserAgentsForTransport(proxyUrl, uaList, lockOnSuccess);
        } catch (e) {
            if (e && e.code === 'SKIP_PROXY') {
                lastOuter = e.cause || e;
                continue;
            }
            lastOuter = e;
        }
    }
    throw lastOuter || new Error('discover: не удалось выполнить запрос');
}

module.exports = {
    SITE_HTML_USER_AGENT,
    parseProxyList,
    fetchHtmlForSiteParse,
    fetchDiscoverText,
    applyProxyToAxiosConfig
};
