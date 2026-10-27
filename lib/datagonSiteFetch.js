/**
 * Общий UA, HTTP(S)- и SOCKS5-прокси (ротация при ошибке) и повторные GET для внешних сайтов.
 * Используется: routes/pages.js (discovery + runParser), worker.js.
 */

const dns = require('dns').promises;
const net = require('net');
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

/** F-PAR-01: блокировка loopback / RFC1918 / link-local / cloud metadata. */
function ipv4ToInt(ip) {
    const p = String(ip || '')
        .split('.')
        .map((x) => Number(x));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isBlockedIpAddress(addr) {
    const a = String(addr || '').trim().toLowerCase();
    if (!a) return true;
    if (net.isIPv4(a)) {
        const n = ipv4ToInt(a);
        if (n == null) return true;
        if (n === 0) return true; // 0.0.0.0
        if ((n >>> 24) === 127) return true; // 127.0.0.0/8
        if ((n >>> 24) === 10) return true; // 10.0.0.0/8
        if ((n >>> 24) === 169 && ((n >>> 16) & 0xff) === 254) return true; // 169.254.0.0/16 (metadata)
        if ((n >>> 24) === 192 && ((n >>> 16) & 0xff) === 168) return true; // 192.168.0.0/16
        if ((n >>> 24) === 172 && ((n >>> 16) & 0xff) >= 16 && ((n >>> 16) & 0xff) <= 31) return true; // 172.16/12
        if ((n >>> 24) === 100 && ((n >>> 16) & 0xff) >= 64 && ((n >>> 16) & 0xff) <= 127) return true; // CGNAT 100.64/10
        return false;
    }
    if (net.isIPv6(a)) {
        if (a === '::1' || a === '::') return true;
        if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA
        if (a.startsWith('fe80')) return true; // link-local
        // IPv4-mapped ::ffff:a.b.c.d
        const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
        if (m) return isBlockedIpAddress(m[1]);
        return false;
    }
    return true;
}

/**
 * Резолв DNS + deny private/metadata. Бросает Error с code SSRF_BLOCKED.
 * @param {string} urlStr
 */
async function assertUrlSafeForEgress(urlStr) {
    let u;
    try {
        u = new URL(String(urlStr || ''));
    } catch (_) {
        const e = new Error('Некорректный URL');
        e.code = 'BAD_URL';
        throw e;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        const e = new Error('Разрешены только http/https');
        e.code = 'SSRF_BLOCKED';
        throw e;
    }
    const host = String(u.hostname || '').trim().toLowerCase();
    if (!host) {
        const e = new Error('Пустой host');
        e.code = 'SSRF_BLOCKED';
        throw e;
    }
    if (
        host === 'localhost' ||
        host === 'metadata.google.internal' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local')
    ) {
        const e = new Error('SSRF: запрещённый host');
        e.code = 'SSRF_BLOCKED';
        throw e;
    }
    let addrs = [];
    if (net.isIP(host)) {
        addrs = [host];
    } else {
        try {
            const looked = await dns.lookup(host, { all: true, verbatim: true });
            addrs = (looked || []).map((x) => x.address).filter(Boolean);
        } catch (err) {
            const e = new Error('DNS lookup failed: ' + ((err && err.message) || err));
            e.code = 'DNS_FAIL';
            throw e;
        }
    }
    if (!addrs.length) {
        const e = new Error('DNS: нет адресов');
        e.code = 'DNS_FAIL';
        throw e;
    }
    for (const addr of addrs) {
        if (isBlockedIpAddress(addr)) {
            const e = new Error('SSRF: private/metadata IP заблокирован (' + addr + ')');
            e.code = 'SSRF_BLOCKED';
            throw e;
        }
    }
    return u;
}

function axiosSsrfHooks() {
    return {
        maxRedirects: 5,
        beforeRedirect(options) {
            // axios передаёт absolute URL в options.href / options.pathname+hostname
            const href =
                (options && (options.href || options.url)) ||
                (options && options.protocol && options.hostname
                    ? `${options.protocol}//${options.hostname}${options.path || options.pathname || ''}`
                    : '');
            if (!href) {
                const e = new Error('SSRF: redirect без URL');
                e.code = 'SSRF_BLOCKED';
                throw e;
            }
            // sync check host/IP literal; full DNS на redirect — через sync isIP only + hostname deny
            let u;
            try {
                u = new URL(href);
            } catch (_) {
                const e = new Error('SSRF: bad redirect URL');
                e.code = 'SSRF_BLOCKED';
                throw e;
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                const e = new Error('SSRF: redirect scheme');
                e.code = 'SSRF_BLOCKED';
                throw e;
            }
            const host = String(u.hostname || '').toLowerCase();
            if (
                host === 'localhost' ||
                host.endsWith('.localhost') ||
                host.endsWith('.local') ||
                host === 'metadata.google.internal'
            ) {
                const e = new Error('SSRF: redirect host blocked');
                e.code = 'SSRF_BLOCKED';
                throw e;
            }
            if (net.isIP(host) && isBlockedIpAddress(host)) {
                const e = new Error('SSRF: redirect to private IP');
                e.code = 'SSRF_BLOCKED';
                throw e;
            }
        },
    };
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
    const safe = await assertUrlSafeForEgress(url);
    const origin = safe.origin;
    const referer = `${origin}/`;
    const ssrf = axiosSsrfHooks();

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
                        maxRedirects: ssrf.maxRedirects,
                        beforeRedirect: ssrf.beforeRedirect,
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
    const safe = await assertUrlSafeForEgress(url);
    const origin = safe.origin;
    const referer = String(opts.referer || '').trim() || `${origin}/`;
    const ssrf = axiosSsrfHooks();

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
            maxRedirects: ssrf.maxRedirects,
            beforeRedirect: ssrf.beforeRedirect,
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
    applyProxyToAxiosConfig,
    assertUrlSafeForEgress,
    isBlockedIpAddress,
};
