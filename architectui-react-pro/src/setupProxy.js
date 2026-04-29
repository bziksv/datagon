const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function setupProxy(app) {
  const target = process.env.DATAGON_API_TARGET || "http://localhost:3000";

  app.use(
    "/api",
    createProxyMiddleware({
      target,
      changeOrigin: true,
      // Не поднимать WS-прокси на весь контекст /api — иначе dev-server на :3003
      // может ловить «Invalid frame header» на /ws (HMR клиент webpack).
      ws: false,
      logLevel: "warn",
    })
  );

  // Static docs live under backend `public/docs` (Docusaurus build). CRA dev server must
  // forward `/docs` here; otherwise `/docs/` hits React Router and shows no route match.
  app.use(
    "/docs",
    createProxyMiddleware({
      target,
      changeOrigin: true,
      logLevel: "warn",
    })
  );
};

