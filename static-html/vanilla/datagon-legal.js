/**
 * Юридические ссылки и cookie-баннер для неавторизованных (как на titlo.ru).
 * Подключается на login.html и в оболочке панели.
 */
(function () {
  var CONSENT_KEY = "datagon_cookie_consent_v1";
  var STYLE_ID = "dg-legal-consent-style";

  function hasAuthHint() {
    try {
      var u = String(window.localStorage.getItem("currentUser") || "").trim();
      var t = String(window.localStorage.getItem("authToken") || "").trim();
      var logged = String(window.localStorage.getItem("isLoggedIn") || "") === "true";
      return !!(u && t) || logged;
    } catch (e) {
      return false;
    }
  }

  function hasConsent() {
    try {
      return String(window.localStorage.getItem(CONSENT_KEY) || "") === "1";
    } catch (e) {
      return false;
    }
  }

  function setConsent() {
    try {
      window.localStorage.setItem(CONSENT_KEY, "1");
    } catch (e) {}
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = document.createElement("style");
    css.id = STYLE_ID;
    css.textContent =
      ".dg-legal-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:10050;" +
      "display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 16px;" +
      "max-width:1100px;margin:0 auto;padding:14px 16px;border-radius:12px;" +
      "background:#fff;color:#1e293b;box-shadow:0 12px 40px rgba(15,23,42,.18),0 0 0 1px rgba(15,23,42,.06);" +
      "font-size:13px;line-height:1.45}" +
      ".dg-legal-consent__text{flex:1 1 280px;margin:0;color:#334155}" +
      ".dg-legal-consent__text a{color:#2f5de0;text-decoration:underline;text-underline-offset:2px}" +
      ".dg-legal-consent__text a:hover{color:#1e40af}" +
      ".dg-legal-consent__btn{flex:0 0 auto;min-width:110px}" +
      ".datagon-vanilla-shell .app-footer-right{display:flex;flex-wrap:wrap;align-items:center;" +
      "justify-content:flex-end;gap:6px 12px;padding:4px 8px 4px 12px;max-width:min(100%,520px)}" +
      ".datagon-vanilla-shell .dg-footer-legal-link{font-size:11px;line-height:1.25;color:#6c757d;" +
      "text-decoration:none;white-space:nowrap}" +
      ".datagon-vanilla-shell .dg-footer-legal-link:hover{color:#2f5de0;text-decoration:underline}" +
      "@media (max-width:767.98px){.datagon-vanilla-shell .app-footer-right{max-width:100%;justify-content:flex-start}" +
      ".datagon-vanilla-shell .dg-footer-legal-link{white-space:normal}}";
    document.head.appendChild(css);
  }

  function hideBanner(el) {
    if (!el) return;
    el.remove();
  }

  function showConsentBanner() {
    if (document.getElementById("dg-legal-consent")) return;
    ensureStyles();
    var box = document.createElement("div");
    box.id = "dg-legal-consent";
    box.className = "dg-legal-consent";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-label", "Согласие на использование cookie");
    box.innerHTML =
      '<p class="dg-legal-consent__text">Мы используем cookie для оптимизации работы сайта и анализа посещаемости. ' +
      "Используя сайт, вы соглашаетесь с " +
      '<a href="/legal/cookies.html" target="_blank" rel="noopener">политикой cookie-файлов</a> и ' +
      '<a href="/legal/privacy.html" target="_blank" rel="noopener">политикой обработки персональных данных</a>.</p>' +
      '<button type="button" class="btn btn-primary btn-sm dg-legal-consent__btn" id="dg-legal-consent-accept">Принять</button>';
    document.body.appendChild(box);
    var btn = document.getElementById("dg-legal-consent-accept");
    if (btn) {
      btn.addEventListener("click", function () {
        setConsent();
        hideBanner(box);
      });
    }
  }

  function initConsent() {
    if (hasAuthHint()) return;
    if (hasConsent()) return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showConsentBanner);
    } else {
      showConsentBanner();
    }
  }

  window.DatagonLegal = {
    initConsent: initConsent,
    hasConsent: hasConsent,
    CONSENT_KEY: CONSENT_KEY,
  };

  initConsent();
})();
