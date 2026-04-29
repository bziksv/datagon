# ArchitectUI Bootstrap 5 ReactJS Theme Pro

ArchitectUI is a Modern Clean Responsive React 19, Bootstrap 5 Admin UI Dashboard Template. It is used by thousands of developers to build SaaS and various other admin panels for web apps.

### Made with love by DashboardPack.com

## Preview Version Available [here](https://dashboardpack.com/theme-details/architectui-dashboard-react-pro/)

![ArchitectUI Bootstrap 5 ReactJS Theme Pro](https://colorlib.com/wp/wp-content/uploads/sites/2/architectui-react-dashboard-template.jpg.webp)

## What's New in v3.2.0

- **All Dependencies Updated**: Every package bumped to latest — React 19.2, React Router 7.13, FontAwesome 7, ApexCharts 5, Bootstrap 5.3.8, Recharts 3.7, react-datepicker 9, and more
- **Codebase Cleanup**: Removed debug console.log statements, backup files, dead code, and 9 unused dependencies
- **Dashboard Consistency**: Fixed layout inconsistencies across Analytics, CRM, Minimal, and Sales dashboards
- **Subdirectory Deployment**: Built-in support for hosting at any URL path (configurable via `homepage` in package.json)
- **Chart Fixes**: Resolved ResponsiveContainer width/height warnings in hidden containers and dropdowns
- **React 19 Compatibility**: Fixed `animate` prop DOM warning in timeline components

## Requirements

- Node.js LTS (18.x or higher recommended)
- npm 8.x or higher

## Installation

Download and uncompress the theme package archive in your desired folder location.

Download and install Node.js LTS from https://nodejs.org/en/download/

```bash
npm install --legacy-peer-deps
```

After npm finishes installing the modules from package.json you can go ahead and start the application. To do so, run the command below.

```bash
npm run start
```

After the command finishes, you should see a Compiled successfully! message in your terminal window. Also, a web server service will be started so you can view your app in the browser: http://localhost:3000

To create a production optimized build run the command below:

```bash
npm run build
```

This creates a folder in the root of your project named `build`. You can preview the production build locally:

```bash
npx serve -s build -l 4000
```

This will start a local web server on port 4000, on which the production folder (/build/) will be available in your browser.

### Deploying to a Subdirectory

By default the build is configured for `/architectui-react-pro/`. To change the deployment path, update the `homepage` field in `package.json`:

```json
"homepage": "/your-path/"
```

Then rebuild. For root deployment, set `"homepage": "/"`.

## Technology Stack

- **React 19.2.4** — Latest React with concurrent features
- **React Router 7.13.0** — Modern routing with future flags
- **Bootstrap 5.3.8** — Responsive CSS framework
- **Reactstrap 9.2.3** — Bootstrap 5 React components
- **Redux Toolkit 2.11** — State management
- **FontAwesome 7.1** — Icon library
- **ApexCharts 5.3** — Interactive charts
- **Chart.js 4.5 & Recharts 3.7** — Data visualization
- **SCSS** — Enhanced styling capabilities

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Support

For technical support and questions, please visit [DashboardPack.com](https://dashboardpack.com)
