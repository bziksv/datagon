#!/usr/bin/env node
/**
 * Если шаблон ArchitectUI ошибочно лежит в public/html/ — переносит в vendor/architectui-react-pro/
 * (исходники не должны быть под public/: их отдаёт express.static).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const wrong = path.join(root, 'public', 'html');
const target = path.join(root, 'vendor', 'architectui-react-pro');

function main() {
  if (!fs.existsSync(path.join(wrong, 'package.json'))) {
    console.log('Нет', wrong, 'с package.json — нечего переносить.');
    process.exit(0);
  }
  if (fs.existsSync(path.join(target, 'package.json'))) {
    console.error('Уже есть', target, '— удалите или переименуйте вручную, затем повторите.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(wrong, target);
  console.log('OK: перенесено', wrong, '→', target);
  console.log('Дальше: cd', root, '&& npm run build:architectui-demo');
}

main();
