# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ArchitectUI React Pro (v3.2.0) — a professional admin dashboard template built with React 19, Bootstrap 5.3, and Redux Toolkit. Made by DashboardPack.

## Commands

```bash
npm start          # Dev server at localhost:3000 (uses react-app-rewired, ESLint disabled)
npm run build      # Production build to /build/
npm test           # Run tests via react-app-rewired (no test files exist yet)
```

Install dependencies: `npm install --legacy-peer-deps` (required due to peer dep conflicts between React 19 and some older packages).

Serve production build: `npx serve -s build -l 4000`

## Architecture

### Entry & Routing Flow

`src/index.js` → creates Redux store, wraps app in `BrowserRouter` (with `basename={process.env.PUBLIC_URL}` for subdirectory deployment and React Router v7 future flags) + Redux `Provider` → renders `src/DemoPages/Main/index.js`.

**Main** (class component, Redux-connected) applies responsive layout classes based on viewport width via `ResizeObserver`. At `<1250px`, sidebar auto-closes and becomes fixed.

**AppMain** (`src/Layout/AppMain/index.js`) defines all routes with lazy-loaded sections wrapped in `Suspense`:
- `/dashboards/*`, `/elements/*`, `/components/*`, `/forms/*`, `/charts/*`, `/tables/*`, `/widgets/*`, `/apps/*` — wrapped in `AppLayout` (header + sidebar + footer)
- `/pages/*` — auth pages (login, register, forgot password) rendered without layout chrome
- `/` redirects to `/dashboards/analytics`

### Layout Components (`src/Layout/`)

`AppLayout.js` composes `AppHeader` → `AppSidebar` + main content area → `AppFooter`. Each layout component connects to Redux for theme state.

**PageTitle variants** (all Redux-connected, each with different action button layouts):

- `PageTitle.js` — main variant, random action buttons from 3 variations. Used by most pages.
- `PageTitleAlt.js` — toast notification button with gradient icon. Used by FAQ section.
- `PageTitleAlt3.js` — breadcrumb-style actions. Used by Minimal dashboard variations.

### State Management

Single Redux slice: `src/reducers/ThemeOptions.js` (Redux Toolkit `createSlice`). Controls layout toggles (fixed header/sidebar/footer, closed sidebar, mobile menu) and theme settings (color scheme, background image). Store configured in `src/config/configureStore.js`.

Actions are imported from ThemeOptions: `setEnableFixedHeader`, `setEnableMobileMenu`, `setColorScheme`, etc. Selectors: `selectThemeOptions`, `selectColorScheme`, `selectEnableFixedHeader`.

### Page Organization (`src/DemoPages/`)

Each section directory (Dashboards, Components, Forms, Tables, Charts, etc.) has its own `index.js` that defines sub-routes. Route index components are functional; page components are mostly class-based (327 class vs 10 functional).

### Reusable Components (`src/components/`)

Compatibility wrappers and custom components:

- `React19Transition` — wraps react-transition-group for React 19 compatibility
- `React19Timeline` — custom VerticalTimeline/VerticalTimelineElement (replaces react-vertical-timeline-component)
- `CustomScrollbar` — perfect-scrollbar wrapper
- `SimpleCarousel` — react-slick wrapper
- `ReactTableCompat` — @tanstack/react-table wrapper
- `CompatProgress` — Reactstrap Progress compatibility wrapper

### SCSS Architecture (`src/assets/`)

Entry point: `src/assets/base.scss`. Imports flow: Google Fonts → theme variables (`themes/default/variables`) → Bootstrap 5 from node_modules → Perfect Scrollbar → layout → utils → elements → widgets → pages → components → responsive.

Organized into: `layout/` (header, sidebar, footer, responsive), `elements/` (buttons, forms, cards, tabs, modals), `components/` (third-party styling), `themes/` (color schemes), `widgets/` (dashboard boxes), `pages/` (auth pages).

### Build Configuration

`config-overrides.js` handles:
- Node.js polyfills (buffer, crypto, stream, assert, http, https, url)
- rc-tabs aliases pointing to shims in `src/rc-tabs-shims/`
- Source map warning suppression
- webpack-dev-server v5 compatibility (middleware API migration, HTTPS config)

### Deployment

The `homepage` field in `package.json` is set to `/architectui-react-pro/` for subdirectory deployment. This sets `PUBLIC_URL` for asset paths. The `BrowserRouter` uses `basename={process.env.PUBLIC_URL}` to match. Change `homepage` to `/` or your subdirectory as needed.

### Key Libraries

- **UI**: Reactstrap 9.2.3 (Bootstrap 5.3.8 React components), react-bootstrap
- **Charts**: ApexCharts 5, Chart.js (react-chartjs-2), Recharts 3.7
- **Data tables**: react-data-table-component, @tanstack/react-table
- **Forms**: redux-form, availity-reactstrap-validation, react-select, react-datepicker 9
- **Navigation**: @metismenu/react, react-router-dom v7
- **Icons**: FontAwesome 7 (@fortawesome suite), pe7-icon, react-icons
- **Maps**: google-map-react, react-map-gl
- **DnD**: react-dnd + react-dnd-html5-backend

### Responsive Behavior

The `Main` component applies CSS classes dynamically:
- `.app-container.app-theme-{colorScheme}` — always present
- `.fixed-header`, `.fixed-sidebar`, `.fixed-footer` — from Redux state
- `.closed-sidebar`, `.closed-sidebar-mobile` — auto-applied below 1250px
- `.sidebar-mobile-open` — mobile menu toggle

### Conventions

- ESLint (Airbnb config) + Prettier configured but ESLint is disabled at build time via `DISABLE_ESLINT_PLUGIN=true`
- Most pages are class components; route index files and AppMain/AppLayout are functional
- SCSS partials use underscore prefix (`_sidebar.scss`)
- CSS class naming follows BEM-like patterns (`.app-header__content`)
- Package version pinning via `overrides` and `resolutions` in package.json for React 19 compatibility
- No debug `console.log` in production code (intentional logs only in serviceWorker.js, Clipboard demo, and Guided Tours demo)
