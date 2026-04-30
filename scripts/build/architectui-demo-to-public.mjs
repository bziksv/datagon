#!/usr/bin/env node
/**
 * Собирает CRA ArchitectUI React PRO и копирует build → public/architectui-react-pro/
 * (должен совпадать с "homepage" в package.json шаблона: /architectui-react-pro/).
 *
 *   npm run build:architectui-demo
 *
 * Источник по умолчанию: vendor/architectui-react-pro (если есть package.json).
 * Иначе: ARCHITECTUI_REACT_PRO_ROOT или аргумент CLI.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function resolveSrcRoot() {
  const fromArg = process.argv[2];
  if (fromArg) return path.resolve(fromArg);
  if (process.env.ARCHITECTUI_REACT_PRO_ROOT) {
    return path.resolve(process.env.ARCHITECTUI_REACT_PRO_ROOT);
  }
  const vend = path.join(root, 'vendor', 'architectui-react-pro');
  if (fs.existsSync(path.join(vend, 'package.json'))) return vend;
  return '';
}

const srcRoot = resolveSrcRoot();
const pkg = srcRoot ? path.join(srcRoot, 'package.json') : '';

function main() {
  if (!srcRoot || !fs.existsSync(pkg)) {
    console.error(
      'Нет каталога с шаблоном ArchitectUI (нужен package.json).\n' +
        '  Положите исходники в: vendor/architectui-react-pro/\n' +
        '  или: ARCHITECTUI_REACT_PRO_ROOT=/path npm run build:architectui-demo\n' +
        '  или: node scripts/build/architectui-demo-to-public.mjs /path\n' +
        '  Ошибочно положили в public/? Выполните: npm run relocate:architectui-from-public',
    );
    process.exit(1);
  }
  const env = { ...process.env, DISABLE_ESLINT_PLUGIN: 'true' };
  // Шаблон тянет eslint-config-airbnb с peer react-hooks@^4 при react-hooks@7 — без флага npm ci падает (ERESOLVE).
  console.log('[architectui-demo] npm ci --legacy-peer-deps в', srcRoot);
  const ci = spawnSync('npm', ['ci', '--legacy-peer-deps'], { cwd: srcRoot, stdio: 'inherit', env });
  if (ci.status !== 0) {
    console.error('[architectui-demo] npm ci завершился с кодом', ci.status);
    process.exit(ci.status || 1);
  }
  console.log('[architectui-demo] npm run build');
  const bd = spawnSync('npm', ['run', 'build'], { cwd: srcRoot, stdio: 'inherit', env });
  if (bd.status !== 0) {
    console.error('[architectui-demo] build завершился с кодом', bd.status);
    process.exit(bd.status || 1);
  }
  const buildDir = path.join(srcRoot, 'build');
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    console.error('[architectui-demo] нет', path.join(buildDir, 'index.html'));
    process.exit(1);
  }
  const outDir = path.join(root, 'public', 'architectui-react-pro');
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.cpSync(buildDir, outDir, { recursive: true });
  console.log('OK: скопировано в', outDir);
}

main();
