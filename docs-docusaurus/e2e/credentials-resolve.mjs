import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} baseUrl */
export function printCredentialsBanner(baseUrl) {
    const lines = [
        '  Съёмка PNG для Docusaurus (@playwright/test)',
        `  База: ${baseUrl}`,
        '',
        '  Команды:',
        '    1) другой терминал (корень репо): npm start',
        '    2) из корня: npm run docs:capture-screenshots',
        '    3) или здесь: npm run capture-screenshots',
        '    4) после PNG: npm run docs:docusaurus:build (из корня)',
        '    Другой URL: DOCS_BASE_URL=http://127.0.0.1:PORT npm run capture-screenshots',
        '',
        '  Enter на логине — только макеты /doc-screenshots/*-sample.html (упрощённый вид, не как живая панель).',
        '  Чтобы PNG как в продакшен-интерфейсе — введите логин и пароль (в TTY пароль не отображается).',
        '  Жёстко без макетов: DOCS_CAPTURE_REAL_ONLY=1 npm run docs:capture-screenshots'
    ];
    const w = Math.max(...lines.map((l) => l.length));
    const bar = '─'.repeat(w + 2);
    console.log(`\n┌${bar}┐`);
    for (const l of lines) console.log(`│ ${l.padEnd(w)} │`);
    console.log(`└${bar}┘\n`);
}

/**
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function readPasswordMasked(prompt) {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        const readline = await import('readline/promises');
        const rl = readline.createInterface({ input: stdin, output: process.stdout });
        try {
            return (await rl.question(`${prompt}(ввод виден — нет интерактивного TTY): `)).trim();
        } finally {
            rl.close();
        }
    }

    process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
        let acc = '';
        const cleanup = () => {
            try {
                stdin.setRawMode(false);
            } catch {
                /* ignore */
            }
            stdin.removeListener('data', onData);
        };
        const onData = (buf) => {
            const s = buf.toString('utf8');
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                const code = s.charCodeAt(i);
                if (c === '\r' || c === '\n') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(acc);
                    return;
                }
                if (c === '\u0003') {
                    cleanup();
                    process.exit(130);
                }
                if (c === '\b' || code === 127) acc = acc.slice(0, -1);
                else if (code >= 32) acc += c;
            }
        };
        try {
            stdin.setRawMode(true);
        } catch (e) {
            reject(e);
            return;
        }
        stdin.on('data', onData);
    });
}

/**
 * @param {string} baseUrl
 * @returns {Promise<{ user: string, password: string }>}
 */
export async function resolveCredentials(baseUrl) {
    let user = String(process.env.DOCS_USER || '').trim();
    let password = String(process.env.DOCS_PASSWORD || '').trim();
    if (user && password) return { user, password };

    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) return { user, password };

    printCredentialsBanner(baseUrl);

    const readline = await import('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        if (!user) {
            user = (await rl.question('Логин [Enter — пропустить]: ')).trim();
        }
        if (!user) return { user: '', password: '' };

        if (!password) {
            rl.close();
            password = (await readPasswordMasked('Пароль: ')).trim();
            return { user, password };
        }
        return { user, password };
    } finally {
        try {
            rl.close();
        } catch {
            /* уже закрыт */
        }
    }
}

export const CAPTURE_CREDS_FILE = path.join(__dirname, '..', '.playwright', 'capture-creds.json');

/**
 * @returns {{ user: string, password: string }}
 */
export function readCapturedCredentials() {
    if (!fs.existsSync(CAPTURE_CREDS_FILE)) return { user: '', password: '' };
    try {
        const j = JSON.parse(fs.readFileSync(CAPTURE_CREDS_FILE, 'utf8'));
        return {
            user: String(j.user || '').trim(),
            password: String(j.password || '').trim()
        };
    } catch {
        return { user: '', password: '' };
    }
}
