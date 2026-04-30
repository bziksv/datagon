#!/usr/bin/env node
/**
 * Синхронизирует data/architectui-react-demo-nav.json и inners/ref-react-demo-index.inner.html
 * из NavItems.js — та же иерархия, что в сайдбаре ArchitectUI (VerticalNavWrapper: Menu, UI Components, …).
 *
 *   npm run sync:architectui-nav
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const vanillaDir = path.join(root, 'static-html', 'vanilla');

function resolveTemplateRoot() {
  const fromArg = process.argv[2];
  if (fromArg) return path.resolve(fromArg);
  if (process.env.ARCHITECTUI_REACT_PRO_ROOT) {
    return path.resolve(process.env.ARCHITECTUI_REACT_PRO_ROOT);
  }
  const vend = path.join(root, 'vendor', 'architectui-react-pro');
  if (fs.existsSync(path.join(vend, 'package.json'))) return vend;
  return '';
}

function cloneNav(x) {
  return JSON.parse(JSON.stringify(x));
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Собрать все { label, to } из дерева (для JSON). */
function flattenNav(items, out = []) {
  if (!items || !Array.isArray(items)) return out;
  for (const it of items) {
    if (it.to) out.push({ label: it.label, to: it.to });
    if (it.content) flattenNav(it.content, out);
  }
  return out;
}

function renderNavBranch(items, base) {
  if (!items || !items.length) return '';
  let html = '<ul class="list-unstyled mb-0 ps-0">';
  for (const it of items) {
    if (it.content && it.content.length) {
      html += `<li class="mb-3 pb-2 border-bottom border-light">
        <div class="fw-semibold text-dark mb-2">${esc(it.label)}</div>
        ${renderNavBranch(it.content, base)}
      </li>`;
    } else if (it.to) {
      html += `<li class="mb-2">
        <a class="d-inline-flex flex-wrap align-items-baseline gap-2 text-decoration-none" href="${base}${it.to}">
          <span>${esc(it.label)}</span>
          <code class="small text-muted" style="font-size:0.75rem">${esc(it.to)}</code>
        </a>
      </li>`;
    }
  }
  html += '</ul>';
  return html;
}

function sectionCard(heading, bodyHtml) {
  return `          <div class="main-card mb-3 card">
            <div class="card-body">
              <h5 class="app-sidebar__heading mb-3 pb-2 border-bottom">${esc(heading)}</h5>
${bodyHtml}
            </div>
          </div>`;
}

async function main() {
  const navPathArg = resolveTemplateRoot();
  const navItemsPath = navPathArg
    ? path.join(navPathArg, 'src', 'Layout', 'AppNav', 'NavItems.js')
    : '';

  if (!navItemsPath || !fs.existsSync(navItemsPath)) {
    console.error(
      'Нет NavItems.js — положите шаблон в vendor/architectui-react-pro/ или задайте ARCHITECTUI_REACT_PRO_ROOT / argv[2].',
    );
    process.exit(1);
  }

  const mod = await import(pathToFileURL(navItemsPath).href);
  const { MainNav, ComponentsNav, FormsNav, WidgetsNav, ChartsNav } = mod;

  const mainNav = cloneNav(MainNav);
  const apps = mainNav.find((x) => x.label === 'Applications');
  if (apps && apps.content) {
    apps.content.push({ label: 'Split Layout', to: '/apps/split-layout' });
  }

  const componentsNav = cloneNav(ComponentsNav);
  const compBlock = componentsNav.find((x) => x.label === 'Components');
  if (compBlock && compBlock.content) {
    compBlock.content.push({ label: 'Tree View', to: '/components/tree-view' });
  }

  /** Как в src/Layout/AppNav/VerticalNavWrapper.js */
  const sections = [
    { title: 'Menu', tree: mainNav },
    { title: 'UI Components', tree: componentsNav },
    { title: 'Dashboard Widgets', tree: WidgetsNav },
    { title: 'Forms', tree: FormsNav },
    { title: 'Charts', tree: ChartsNav },
  ];

  const base = '/architectui-react-pro';
  const allPairs = [];
  for (const s of sections) flattenNav(s.tree, allPairs);

  const dataDir = path.join(vanillaDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const jsonPath = path.join(dataDir, 'architectui-react-demo-nav.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        source: 'NavItems.js + Split Layout + Tree View',
        sections: sections.map((s) => ({ title: s.title, links: flattenNav(cloneNav(s.tree), []) })),
        flat: allPairs,
      },
      null,
      2,
    ),
    'utf8',
  );

  const sectionHtml = sections
    .map((s) => sectionCard(s.title, renderNavBranch(s.tree, base)))
    .join('\n');

  const inner = `          <div class="app-page-title">
            <div class="page-title-wrapper">
              <div class="page-title-heading">
                <div class="page-title-icon">
                  <i class="pe-7s-menu icon-gradient bg-mean-fruit"></i>
                </div>
                <div>
                  Полное меню ArchitectUI
                  <div class="page-title-subheading">Те же разделы, что в сайдбаре React-шаблона. Ссылки ведут в <code>${base}/…</code>.</div>
                </div>
              </div>
            </div>
          </div>
${sectionHtml}
          <div class="main-card mb-3 card">
            <div class="card-body">
              <h5 class="card-title">Рабочие экраны Datagon</h5>
              <a href="/sections.html">sections.html</a>
            </div>
          </div>
`;

  const innerPath = path.join(vanillaDir, 'inners', 'ref-react-demo-index.inner.html');
  fs.writeFileSync(innerPath, inner, 'utf8');
  console.log('OK:', jsonPath);
  console.log('OK:', innerPath, `(${allPairs.length} ссылок, ${sections.length} разделов)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
