/**
 * Подстановка ссылки на собранный ArchitectUI main.*.css в HTML с плейсхолдером
 * <!-- ARCHITECTUI_MAIN_CSS --> (используется vanilla-шаблоном).
 */
import fs from 'fs';
import path from 'path';

const PLACEHOLDER = '<!-- ARCHITECTUI_MAIN_CSS -->';

/**
 * @param {string} publicDir — корень public/ (где лежит static/css/main.*.css)
 * @returns {string} href вида /static/css/main.&lt;hash&gt;.css или пустая строка
 */
export function resolveArchitectuiMainCssHref(publicDir) {
  const cssDir = path.join(publicDir, 'static', 'css');
  if (!fs.existsSync(cssDir)) return '';
  const cssFiles = fs.readdirSync(cssDir).filter((f) => /^main\.[a-z0-9]+\.css$/i.test(f));
  if (!cssFiles.length) return '';
  cssFiles.sort();
  return '/static/css/' + cssFiles[cssFiles.length - 1];
}

/**
 * @param {string} html
 * @param {string} href — из resolveArchitectuiMainCssHref
 * @returns {string}
 */
export function injectArchitectuiMainCssLink(html, href) {
  if (!href || !html.includes(PLACEHOLDER)) return html;
  const linkTag = '<link rel="stylesheet" href="' + href + '" />';
  return html.split(PLACEHOLDER).join(linkTag);
}
