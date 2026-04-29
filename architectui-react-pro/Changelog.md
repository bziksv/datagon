# Changelog

All notable changes to this project will be documented in this file.

## [3.2.0] - 2026-02-06

### Updated

- All dependencies bumped to latest versions:
  - React 19.1 → 19.2.4
  - React Router 7.6 → 7.13.0
  - FontAwesome 6 → 7.1.0
  - ApexCharts 4 → 5.3.6
  - Bootstrap 5.3.7 → 5.3.8
  - Recharts 2 → 3.7.0
  - react-datepicker 7 → 9.1.0
  - react-loader-spinner 6 → 8.0.2
  - Redux Toolkit 2.6 → 2.11.2
  - And 40+ other packages to latest

### Fixed

- Dashboard layout inconsistencies across Analytics, CRM, Minimal, and Sales pages
- CRM Dashboard: switched from PageTitleAlt2 to PageTitle for consistency, removed leftover test components
- Minimal Dashboard: restored missing constructor, state, and toggle method (was crashing at runtime)
- Sales Dashboard: moved PageTitle inside TransitionGroup wrapper
- Recharts ResponsiveContainer width/height warnings in hidden containers and dropdown charts
- React 19 `animate` prop DOM warning in VerticalTimeline component
- Subdirectory deployment: added `homepage` field and `BrowserRouter` basename support
- Router "No routes matched" error when deployed to subdirectory

### Removed

- 9 unused dependencies: jquery, popper.js, customize-cra, json-loader, namor, globalize, react-widgets-globalize, prismjs, react-scroll
- 3 dead dependencies: ag-grid-community, ag-grid-react, react-syntax-highlighter (never imported)
- 18 debug `console.log` statements from production code
- 7 backup files (.backup/.bak) left from development
- Dead code: PageTitleAlt2.js (no longer imported)

### Added

- `.gitignore` entries for `*.backup`, `*.bak`, `*.map` files
- Subdirectory deployment documentation in README

## [3.1.0] - 2025-06-30

### Added

- React 19 compatibility with proper concurrent features support
- React Router v7 integration with future flags enabled
- Enhanced sidebar navigation with consistent icon and text colors
- Modern authentication pages with improved UI design
- Tab component synchronization fixes for independent state management

### Changed

- Upgraded React from v18 to v19.1.0
- Upgraded React DOM from v18 to v19.1.0  
- Upgraded React Router to v7.6.2 with new routing structure
- Updated all dependencies to latest compatible versions
- Replaced react-transition-group with React 19 compatible wrapper
- Improved sidebar collapsed/expanded state consistency
- Enhanced user authentication page designs (LoginBoxed, RegisterBoxed, ForgotPasswordBoxed)

### Fixed

- Tab synchronization issues where all tab examples shared state
- Sidebar icon opacity inconsistency between collapsed and expanded states
- Menu item color inconsistency in collapsed hover state
- React Router navigation compatibility with v7 changes
- Transition component compatibility with React 19
- React 19 compatibility warnings and deprecated features

## [3.0.1] - 2023-11-20

### Fixed

- Minor bug fixes and improvements.

## [3.0.0] - 2023-10-19

### Changed

- Migrated to React v18.
- Import SCSS files from `node_modules` by using the sass-loader instead of relative paths like `../../node_modules`.
- Upgraded all dependencies to latest versions.

### Fixed

- Fixed SCSS bugs.

## [2.1.0] - 2022-08-01

### Changed

- Updated all libraries.

## [2.0.0] - 2022-02-08

### Added

- Added `react-app-rewired`.

### Changed

- Updated to React 17.
- Updated to Bootstrap 5.
- Updated to Reactstrap 9.
- Updated all libraries.

## [1.8.0-rc] - 2021-06-10

### Changed

- Updated to React 17.
- Updated dependencies.
- Updated to `react-scripts` 4.

## [1.7.2] - 2021-03-30

### Fixed

- Resolved z-index issue.
- Fixed `react-responsive-tabs` bug.

## [1.7.0] - 2021-03-30

### Changed

- Updated dependencies.

## [1.6.1] - 2020-08-04

### Changed

- Deleted `package-lock.json`.

## [1.6.0] - 2020-05-24

### Changed

- Code cleaning and formatting.
- Updated `react-anime`.
- Resolved resize window issues.
- Resolved some browser console errors.

## [1.5.0] - 2019-10-28

### Fixed

- Mobile sidebar fix.
- Browser compatibility issues.
- Renamed methods.

### Changed

- Updated dependencies.

## [1.2.0] - 2019-04-16

### Fixed

- Tabs issue.
- Various bug fixes.

### Changed

- Updated all `package.json` dependencies to latest versions.

## [1.1.1] - 2018-12-27

### Added

- Initial release.

[3.2.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v3.2.0
[3.1.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v3.1.0
[3.0.1]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v3.0.1
[3.0.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v3.0.0
[2.1.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v2.1.0
[2.0.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v2.0.0
[1.8.0-rc]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.8.0-rc
[1.7.2]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.7.2
[1.7.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.7.0
[1.6.1]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.6.1
[1.6.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.6.0
[1.5.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.5.0
[1.2.0]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.2.0
[1.1.1]: https://github.com/DashboardPack/architectui-react-pro/releases/tag/v1.1.1
