import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CAPTURE_CREDS_FILE, resolveCredentials } from './credentials-resolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function globalSetup(config) {
    const baseURL = String(config.use?.baseURL || process.env.DOCS_BASE_URL || 'http://127.0.0.1:3000').replace(
        /\/$/,
        ''
    );
    const dir = path.join(__dirname, '..', '.playwright');
    fs.mkdirSync(dir, { recursive: true });
    const { user, password } = await resolveCredentials(baseURL);
    const realOnly = ['1', 'true', 'yes'].includes(String(process.env.DOCS_CAPTURE_REAL_ONLY || '').toLowerCase());
    if (realOnly && (!user || !password)) {
        console.error(
            'DOCS_CAPTURE_REAL_ONLY: задайте DOCS_USER и DOCS_PASSWORD в окружении или введите их в терминале.\n' +
                'Без входа съёмка идёт только с макетов /doc-screenshots/*-sample.html — они не совпадают с живой панелью.'
        );
        process.exit(1);
    }
    fs.writeFileSync(CAPTURE_CREDS_FILE, JSON.stringify({ user, password }), 'utf8');
    try {
        fs.chmodSync(CAPTURE_CREDS_FILE, 0o600);
    } catch {
        /* Windows и т.п. */
    }
}
