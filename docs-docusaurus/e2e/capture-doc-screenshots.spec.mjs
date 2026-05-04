import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test } from '@playwright/test';
import { readCapturedCredentials } from './credentials-resolve.mjs';
import { targets } from './targets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'static', 'screenshots');

function deviceScaleFactorFromEnv() {
    return Math.min(2, Math.max(1, parseInt(process.env.DOCS_CAPTURE_DPR || '1', 10) || 1));
}

/** Первая строка таблицы (если есть) — чтобы viewport-скрин не поймал пустой скелет. */
const firstDataRowSelector = {
    'moysklad.png': '#dg-tbody tr',
    'myproducts.png': '#dg-tbody tr',
    'queue.png': '#dg-q-main-table tbody tr',
    'results.png': '#dg-res-tbody tr',
    'matches.png': '#dg-matches-tbody tr'
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} file
 * @param {boolean} isSample
 */
async function waitForFirstTableRow(page, file, isSample) {
    if (isSample) return;
    const sel = firstDataRowSelector[file];
    if (!sel) return;
    await page.locator(sel).first().waitFor({ state: 'visible', timeout: 50_000 }).catch(() => {});
}

/** @param {import('@playwright/test').Page} page */
function isLikelyLoginPage(page) {
    try {
        const u = page.url() || '';
        if (/login\.html/i.test(u)) return true;
    } catch {
        /* ignore */
    }
    return false;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} baseUrl
 * @param {string} user
 * @param {string} password
 */
async function loginViaApi(page, baseUrl, user, password) {
    const ok = await page.evaluate(
        async ({ baseUrl: b, user: u, password: p }) => {
            try {
                const res = await fetch(`${b}/api/auth/login`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const data = await res.json();
                if (!data.success) return { ok: false, error: data.error || 'login failed' };
                localStorage.setItem('isLoggedIn', 'true');
                if (data.username) localStorage.setItem('currentUser', data.username);
                localStorage.setItem('currentUserDisplayName', data.full_name || data.username || '');
                localStorage.setItem('isAdmin', data.isAdmin ? 'true' : 'false');
                if (data.auth_token) localStorage.setItem('authToken', data.auth_token);
                return { ok: true };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        },
        { baseUrl, user, password }
    );
    return ok;
}

test.describe.configure({ mode: 'serial' });

test.describe('Скриншоты для Docusaurus', () => {
    /** @type {import('@playwright/test').BrowserContext | undefined} */
    let context;
    /** @type {string} */
    let baseUrlNorm;

    test.beforeAll(async ({ browser, baseURL }) => {
        fs.mkdirSync(outDir, { recursive: true });
        baseUrlNorm = String(baseURL || 'http://127.0.0.1:3000').replace(/\/$/, '');
        const creds = readCapturedCredentials();
        const viewportW = Math.max(900, parseInt(process.env.DOCS_VIEWPORT || '1400', 10) || 1400);
        const dpr = deviceScaleFactorFromEnv();

        context = await browser.newContext({
            baseURL: baseURL || undefined,
            viewport: { width: viewportW, height: 900 },
            deviceScaleFactor: dpr,
            colorScheme: 'light',
            ignoreHTTPSErrors: true
        });

        if (creds.user && creds.password) {
            const p = await context.newPage();
            await p.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
            const r = await loginViaApi(p, baseUrlNorm, creds.user, creds.password);
            if (!r.ok) {
                console.warn(`[capture] вход не удался: ${r.error || 'unknown'}`);
            }
            await p.close();
        } else {
            const needCreds = targets.some((t) => t.auth);
            if (needCreds) {
                console.warn(
                    '[capture] без логина экраны панели снимаются с /doc-screenshots/*-sample.html (как и раньше).'
                );
            }
        }
    });

    test.afterAll(async () => {
        await context?.close();
    });

    for (const t of targets) {
        test(t.file, async () => {
            if (!context) throw new Error('context not ready');
            const creds = readCapturedCredentials();
            const page = await context.newPage();
            try {
                let shootPath = t.path;
                if (t.auth && t.pathNoAuth && (!creds.user || !creds.password)) {
                    shootPath = t.pathNoAuth;
                }

                await page.goto(shootPath, { waitUntil: 'domcontentloaded', timeout: 60_000 });

                if (t.auth && creds.user && creds.password) {
                    if (isLikelyLoginPage(page)) {
                        const r = await loginViaApi(page, baseUrlNorm, creds.user, creds.password);
                        if (!r.ok) {
                            console.warn(`  [${t.file}] вход не удался: ${r.error || 'unknown'}`);
                        }
                        await page.goto(t.path, { waitUntil: 'load', timeout: 60_000 });
                    }
                    if (t.pathNoAuth && isLikelyLoginPage(page)) {
                        console.warn(`  [${t.file}] после входа всё ещё login — снимаю статический макет`);
                        await page.goto(t.pathNoAuth, { waitUntil: 'load', timeout: 60_000 });
                    }
                }

                const isSample = /\/doc-screenshots\//.test(shootPath);
                await page.waitForLoadState('load').catch(() => {});
                if (!isSample) {
                    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
                }
                await page.evaluate(() => document.fonts.ready).catch(() => {});
                const settleMs = Number(process.env.DOCS_CAPTURE_SETTLE_MS);
                const settle =
                    Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : isSample ? 650 : 2200;
                await new Promise((r) => setTimeout(r, settle));

                await waitForFirstTableRow(page, t.file, isSample);

                const useFullPage = t.capture !== 'viewport';
                await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

                const outPath = path.join(outDir, t.file);
                await page.screenshot({
                    path: outPath,
                    fullPage: useFullPage,
                    animations: 'disabled',
                    scale: 'device',
                    caret: 'hide'
                });
                console.log('OK', outPath);
            } finally {
                await page.close();
            }
        });
    }
});
