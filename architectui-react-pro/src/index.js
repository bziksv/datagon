import "./polyfills";
import React from "react";
import { createRoot } from 'react-dom/client';

import * as serviceWorker from "./serviceWorker";

// React Router v7 compatible imports
import { BrowserRouter } from "react-router-dom";

import "@fontsource/nunito-sans/300.css";
import "@fontsource/nunito-sans/400.css";
import "@fontsource/nunito-sans/600.css";
import "@fontsource/nunito-sans/700.css";
import "@fontsource/nunito-sans/800.css";
import "@fontsource/nunito-sans/900.css";
import "@fontsource/nunito-sans/400-italic.css";
import "./assets/base.scss";
import Main from "./DemoPages/Main";
import configureReduxStore from "./config/configureStore";
import { Provider } from "react-redux";

const store = configureReduxStore();
const rootElement = document.getElementById("root");

const DEMO_EXTERNAL_LINKS = [
  "colorlib.com",
  "codepen.io",
  "twitter.com/lucasbebber",
  "github.com/bvaughn/react-virtualized",
];

const neutralizeDemoLinks = (scope = document) => {
  const links = scope.querySelectorAll("a[href]");
  links.forEach((link) => {
    const href = String(link.getAttribute("href") || "").trim().toLowerCase();
    if (!href.startsWith("http")) return;
    const isDemoExternal = DEMO_EXTERNAL_LINKS.some((token) =>
      href.includes(token)
    );
    if (!isDemoExternal) return;
    link.setAttribute("href", "#");
    link.removeAttribute("target");
    link.removeAttribute("rel");
  });
};

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const applyNeutralization = () => neutralizeDemoLinks(document);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyNeutralization, {
      once: true,
    });
  } else {
    applyNeutralization();
  }
  const observer = new MutationObserver(() => applyNeutralization());
  observer.observe(document.body, { childList: true, subtree: true });
}

// Dev: корень порта (/moysklad). Prod: SPA отдаётся с корня сайта (public/index.html + basename "").
// Если когда‑то соберёте под подпапку — выставьте homepage/PUBLIC_URL и basename совпадёт с деплоем.
const routerBasename = (() => {
  const raw = String(process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (!raw || raw === ".") {
    return "";
  }
  return raw;
})();

const renderApp = (Component) => (
  <BrowserRouter
    basename={routerBasename}
    future={{
      v7_startTransition: true,
      v7_relativeSplatPath: true,
    }}
  >
    <Provider store={store}>
      <Component />
    </Provider>
  </BrowserRouter>
);

const root = createRoot(rootElement);
root.render(renderApp(Main));

if (module.hot) {
  module.hot.accept("./DemoPages/Main", () => {
    const NextApp = require("./DemoPages/Main").default;
    root.render(renderApp(NextApp));
  });
}

serviceWorker.unregister();