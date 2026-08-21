/**
 * Юридические ссылки и cookie-баннер для неавторизованных (как на titlo.ru).
 * Подключается на login.html и в оболочке панели.
 *
 * На /login.html баннер показывается всегда (пока нет согласия) — даже если в
 * localStorage остались старые currentUser/authToken (сессия уже недействительна).
 * На остальных страницах — только без признаков авторизации.
 */
(function () {
  var CONSENT_KEY = "datagon_cookie_consent_v1";
  var STYLE_ID = "dg-legal-consent-style";

  function isLoginPage() {
    try {
      return /\/login\.html$/i.test(String(window.location.pathname || ""));
    } catch (e) {
      return false;
    }
  }

  function hasAuthHint() {
    try {
      var u = String(window.localStorage.getItem("currentUser") || "").trim();
      var t = String(window.localStorage.getItem("authToken") || "").trim();
      return !!(u && t);
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
      "max-width:1100px;margin-left:auto;margin-right:auto;padding:14px 16px;border-radius:12px;" +
      "background:#fff;color:#1e293b;box-shadow:0 12px 40px rgba(15,23,42,.22),0 0 0 1px rgba(15,23,42,.08);" +
      "font:13px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif}" +
      ".dg-legal-consent__text{flex:1 1 280px;margin:0;color:#334155}" +
      ".dg-legal-consent__text a{color:#2f5de0;text-decoration:underline;text-underline-offset:2px}" +
      ".dg-legal-consent__text a:hover{color:#1e40af}" +
      ".dg-legal-consent__btn{flex:0 0 auto;min-width:110px;appearance:none;border:0;border-radius:8px;" +
      "padding:8px 18px;background:#2f5de0;color:#fff;font:600 13px/1.2 inherit;cursor:pointer}" +
      ".dg-legal-consent__btn:hover{background:#1e40af}" +
      ".datagon-vanilla-shell .app-footer-right{display:flex;flex-wrap:wrap;align-items:center;" +
      "justify-content:flex-end;gap:6px 12px;padding:4px 8px 4px 12px;max-width:min(100%,520px)}" +
      ".datagon-vanilla-shell .dg-footer-legal-link{font-size:11px;line-height:1.25;color:#6c757d;" +
      "text-decoration:none;white-space:nowrap}" +
      ".datagon-vanilla-shell .dg-footer-legal-link:hover{color:#2f5de0;text-decoration:underline}" +
      "@media (max-width:767.98px){.datagon-vanilla-shell .app-footer-right{max-width:100%;justify-content:flex-start}" +
      ".datagon-vanilla-shell .dg-footer-legal-link{white-space:normal}" +
      ".dg-legal-consent{left:10px;right:10px;bottom:10px}}";
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
      '<a href="/legal/cookies.html" target="_blank" rel="noopener">политикой cookie-файлов</a>, ' +
      '<a href="/legal/privacy.html" target="_blank" rel="noopener">политикой обработки персональных данных</a> и ' +
      '<a href="/legal/consent.html" target="_blank" rel="noopener">согласием на обработку ПДн</a>.</p>' +
      '<button type="button" class="dg-legal-consent__btn" id="dg-legal-consent-accept">Принять</button>';
    document.body.appendChild(box);
    var btn = document.getElementById("dg-legal-consent-accept");
    if (btn) {
      btn.addEventListener("click", function () {
        setConsent();
        hideBanner(box);
      });
    }
  }

  function shouldShowConsent() {
    if (hasConsent()) return false;
    if (isLoginPage()) return true;
    return !hasAuthHint();
  }

  function initConsent() {
    if (!shouldShowConsent()) return;
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
