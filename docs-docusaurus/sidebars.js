/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
module.exports = {
  docsSidebar: [
    "manual",
    "panel-map",
    "glossary",
    {
      type: "category",
      label: "Система",
      items: ["dashboard", "settings", "processes", "db-admin", "sections", "login", "script-versioning"],
    },
    {
      type: "category",
      label: "Финансы и кадры",
      items: ["finance", "manager-sales", "ops-sheet", "work-schedule"],
    },
    {
      type: "category",
      label: "Сайты и каталог",
      items: ["mysites", "network-prices", "myproducts", "moysklad", "ms-orders", "ms-sales", "medmarket"],
    },
    {
      type: "category",
      label: "Парсинг",
      items: ["projects", "queue", "results", "matches"],
    },
    {
      type: "category",
      label: "Маркетплейсы",
      items: ["marketplaces"],
    },
    {
      type: "category",
      label: "Закупки и аналитика",
      items: ["purchase", "suppliers", "supplier-analysis", "product-analysis", "product"],
    },
    {
      type: "category",
      label: "Разработка",
      items: ["api", "deploy", "architectui-migration", "capture-screenshots"],
    },
  ],
};
