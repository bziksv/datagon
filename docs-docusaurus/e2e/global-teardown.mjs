import fs from 'fs';
import { CAPTURE_CREDS_FILE } from './credentials-resolve.mjs';

/**
 * @param {import('@playwright/test').FullConfig} _config
 */
export default async function globalTeardown(_config) {
    try {
        fs.rmSync(CAPTURE_CREDS_FILE, { force: true });
    } catch {
        /* ignore */
    }
}
