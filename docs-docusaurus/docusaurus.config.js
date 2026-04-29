/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Datagon Docs",
  tagline: "Документация Datagon",
  favicon: "img/favicon.svg",
  url: "http://localhost:3000",
  baseUrl: "/docs/",
  trailingSlash: true,
  onBrokenLinks: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  i18n: {
    defaultLocale: "ru",
    locales: ["ru"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: require.resolve("./sidebars.js"),
        },
        blog: false,
        pages: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      },
    ],
  ],
  plugins: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        language: ["ru", "en"],
        hashed: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: "Datagon Docs",
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Разделы",
        },
      ],
    },
  },
};

module.exports = config;
