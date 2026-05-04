import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseURL = (process.env.DOCS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const viewportW = Math.max(900, parseInt(process.env.DOCS_VIEWPORT || '1400', 10) || 1400);
const dpr = Math.min(2, Math.max(1, parseInt(process.env.DOCS_CAPTURE_DPR || '1', 10) || 1));

export default defineConfig({
    testDir: 'e2e',
    testMatch: '**/capture-doc-screenshots.spec.mjs',
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? [['github'], ['line']] : [['list']],
    globalSetup: path.join(__dirname, 'e2e', 'global-setup.mjs'),
    globalTeardown: path.join(__dirname, 'e2e', 'global-teardown.mjs'),
    use: {
        baseURL,
        viewport: { width: viewportW, height: 900 },
        deviceScaleFactor: dpr,
        colorScheme: 'light',
        navigationTimeout: 60_000,
        actionTimeout: 45_000,
        ignoreHTTPSErrors: true,
        screenshot: 'off',
        video: 'off',
        trace: 'off'
    },
    projects: [
        {
            name: 'chromium',
            use: {
                launchOptions: { args: ['--disable-dev-shm-usage', '--font-render-hinting=none'] }
            }
        }
    ]
});
