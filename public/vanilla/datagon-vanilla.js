/**
 * Поведение shell как в React AppLayout: сайдбар, мобильное меню, поиск в шапке,
 * раскрытие центральной области шапки (header-mobile-open), выпадающие меню без Bootstrap JS.
 */
(function () {
  var c = document.querySelector(".app-container.datagon-vanilla-shell");
  if (!c) return;

  var key = document.body.getAttribute("data-dg-active-nav");
  if (key) {
    var link = document.querySelector('.metismenu-link[data-nav="' + key + '"]');
    if (link) link.classList.add("active");
  }

  try {
    if (localStorage.getItem("datagon_closed_sidebar_v1") === "1") {
      c.classList.add("closed-sidebar");
    }
  } catch (e) {}

  document.querySelectorAll(".dg-toggle-sidebar").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      c.classList.toggle("closed-sidebar");
      try {
        localStorage.setItem(
          "datagon_closed_sidebar_v1",
          c.classList.contains("closed-sidebar") ? "1" : "0"
        );
      } catch (err) {}
    });
  });

  var overlay = document.querySelector(".sidebar-mobile-overlay");
  if (overlay) {
    overlay.addEventListener("click", function () {
      c.classList.remove("sidebar-mobile-open");
    });
  }

  document.querySelectorAll(".dg-toggle-mobile-sidebar").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      c.classList.toggle("sidebar-mobile-open");
    });
  });

  var headerContent = document.querySelector(".app-header__content");
  document.querySelectorAll(".dg-toggle-header-small").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      if (headerContent) headerContent.classList.toggle("header-mobile-open");
    });
  });

  function getDocsBaseUrl() {
    var loc = window.location;
    if (
      (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") &&
      loc.port === "3003"
    ) {
      return loc.protocol + "//" + loc.hostname + ":3000/docs/";
    }
    return loc.protocol + "//" + loc.host + "/docs/";
  }

  var searchWrap = document.querySelector(".search-wrapper");
  var searchInput = document.querySelector(".search-wrapper .search-input");
  var searchIcon = document.querySelector(".dg-vanilla-search-docs");
  var searchClose = document.querySelector(".dg-vanilla-search-close");

  if (searchIcon) {
    searchIcon.addEventListener("click", function (e) {
      e.preventDefault();
      var q = String(searchInput && searchInput.value ? searchInput.value : "").trim();
      var base = getDocsBaseUrl();
      var target = q ? base + "search?q=" + encodeURIComponent(q) : base;
      window.location.assign(target);
    });
  }
  if (searchClose && searchWrap) {
    searchClose.addEventListener("click", function (e) {
      e.preventDefault();
      searchWrap.classList.toggle("active");
    });
  }

  var HTML_SOURCE_STORAGE_KEY = "datagon_html_source_expanded_v3";
  var sourceToggle = document.querySelector(".datagon-html-source-toggle");
  var sourcePanel = document.querySelector(".datagon-html-source-panel");
  var sourceIcon = sourceToggle ? sourceToggle.querySelector("i") : null;

  function setHtmlSourceExpanded(expanded) {
    if (!sourceToggle || !sourcePanel) return;
    sourceToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    sourcePanel.hidden = !expanded;
    if (sourceIcon) {
      sourceIcon.classList.remove(expanded ? "pe-7s-angle-down" : "pe-7s-angle-up");
      sourceIcon.classList.add(expanded ? "pe-7s-angle-up" : "pe-7s-angle-down");
    }
    try {
      window.localStorage.setItem(HTML_SOURCE_STORAGE_KEY, expanded ? "1" : "0");
    } catch (e) {}
  }

  if (sourceToggle && sourcePanel) {
    var initialExpanded = false;
    try {
      initialExpanded = window.localStorage.getItem(HTML_SOURCE_STORAGE_KEY) === "1";
    } catch (e) {}
    setHtmlSourceExpanded(initialExpanded);
    sourceToggle.addEventListener("click", function (e) {
      e.preventDefault();
      var isOpen = sourceToggle.getAttribute("aria-expanded") === "true";
      setHtmlSourceExpanded(!isOpen);
    });
  }

  // Global button tooltips parity with React DatagonGlobalTooltips.
  var DG_TOOLTIP_DELAY_MS = 80;
  var dgTooltip = null;
  var dgTooltipInner = null;
  var dgTooltipTimer = null;
  var dgTooltipTarget = null;

  function getButtonHintText(button) {
    var explicit = String(button.getAttribute("data-dg-tooltip") || "").trim();
    if (explicit) return explicit;
    var title = String(button.getAttribute("title") || "").trim();
    if (title) return title;
    var aria = String(button.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    return String(button.textContent || "").replace(/\s+/g, " ").trim();
  }

  function ensureTooltipNode() {
    if (dgTooltip) return;
    dgTooltip = document.createElement("div");
    dgTooltip.className = "tooltip bs-tooltip-top show";
    dgTooltip.setAttribute("role", "tooltip");
    dgTooltip.style.position = "fixed";
    dgTooltip.style.pointerEvents = "none";
    dgTooltip.style.zIndex = "2000";
    dgTooltip.style.display = "none";
    dgTooltipInner = document.createElement("div");
    dgTooltipInner.className = "tooltip-inner";

    dgTooltip.appendChild(dgTooltipInner);
    document.body.appendChild(dgTooltip);
  }

  function positionTooltip(target) {
    if (!dgTooltip || !target) return;
    var rect = target.getBoundingClientRect();
    var ttRect = dgTooltip.getBoundingClientRect();
    var gap = 8;
    var left = rect.left + rect.width / 2 - ttRect.width / 2;
    var maxLeft = window.innerWidth - ttRect.width - 6;
    if (left < 6) left = 6;
    if (left > maxLeft) left = maxLeft;
    var top = rect.top - ttRect.height - gap;
    if (top < 6) top = rect.bottom + gap;
    dgTooltip.style.left = Math.round(left) + "px";
    dgTooltip.style.top = Math.round(top) + "px";
  }

  function hideGlobalTooltip() {
    if (dgTooltipTimer) {
      window.clearTimeout(dgTooltipTimer);
      dgTooltipTimer = null;
    }
    dgTooltipTarget = null;
    if (dgTooltip) dgTooltip.style.display = "none";
  }

  function showGlobalTooltip(target, text) {
    ensureTooltipNode();
    if (!dgTooltip || !dgTooltipInner) return;
    dgTooltipInner.textContent = text;
    dgTooltip.style.display = "block";
    positionTooltip(target);
  }

  document
    .querySelectorAll(".datagon-shell button[title]")
    .forEach(function (btn) {
      var title = String(btn.getAttribute("title") || "").trim();
      if (!title) return;
      if (!btn.getAttribute("data-dg-tooltip")) {
        btn.setAttribute("data-dg-tooltip", title);
      }
      btn.removeAttribute("title");
    });

  document.addEventListener(
    "mouseover",
    function (event) {
      var button =
        event.target && event.target.closest
          ? event.target.closest(".datagon-shell button")
          : null;
      if (!(button instanceof HTMLButtonElement)) return;
      if (button.disabled) return;
      var hint = getButtonHintText(button);
      if (!hint) return;

      hideGlobalTooltip();
      dgTooltipTarget = button;
      dgTooltipTimer = window.setTimeout(function () {
        if (!dgTooltipTarget || dgTooltipTarget !== button) return;
        showGlobalTooltip(button, hint);
      }, DG_TOOLTIP_DELAY_MS);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    function (event) {
      var fromButton =
        event.target && event.target.closest
          ? event.target.closest(".datagon-shell button")
          : null;
      if (!(fromButton instanceof HTMLButtonElement)) return;
      var next = event.relatedTarget;
      if (next instanceof Node && fromButton.contains(next)) return;
      hideGlobalTooltip();
    },
    true
  );

  window.addEventListener("scroll", function () {
    if (!dgTooltipTarget || !dgTooltip || dgTooltip.style.display === "none") return;
    positionTooltip(dgTooltipTarget);
  });
  window.addEventListener("resize", function () {
    if (!dgTooltipTarget || !dgTooltip || dgTooltip.style.display === "none") return;
    positionTooltip(dgTooltipTarget);
  });

  function getAuthHeaders() {
    var headers = {};
    var username = window.localStorage.getItem("currentUser");
    var token = window.localStorage.getItem("authToken");
    if (username) headers["x-auth-username"] = username;
    if (token) headers["x-auth-token"] = token;
    return headers;
  }

  function setUserUi(displayName, isAdmin) {
    var role = isAdmin ? "Админ" : "Пользователь";
    var ids = [
      "dg-vanilla-user-display-name",
      "dg-vanilla-user-display-inline",
    ];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = displayName;
    });
    var roleIds = ["dg-vanilla-user-role", "dg-vanilla-user-role-inline"];
    roleIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = role;
    });
  }

  function loadCurrentUserProfile() {
    var fromStorage = String(window.localStorage.getItem("currentUserDisplayName") || window.localStorage.getItem("currentUser") || "Пользователь");
    var isAdminStored = window.localStorage.getItem("isAdmin") === "true" || window.localStorage.getItem("currentUser") === "admin";
    setUserUi(fromStorage, isAdminStored);
    fetch("/api/auth/me", { headers: getAuthHeaders(), credentials: "same-origin" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { r: r, j: j };
        });
      })
      .then(function (x) {
        if (!x.r.ok || !x.j || !x.j.success) return;
        var username = String(x.j.username || "").trim();
        var fullName = String(x.j.full_name || "").trim() || username || fromStorage;
        var isAdmin = Boolean(x.j.isAdmin);
        if (username) window.localStorage.setItem("currentUser", username);
        if (fullName) window.localStorage.setItem("currentUserDisplayName", fullName);
        window.localStorage.setItem("isAdmin", isAdmin ? "true" : "false");
        setUserUi(fullName || "Пользователь", isAdmin);
      })
      .catch(function () {});
  }

  function loadOnlineUsers() {
    var out = document.getElementById("dg-vanilla-online-users");
    var note = document.getElementById("dg-vanilla-online-users-note");
    if (out) out.textContent = "...";
    if (note) note.textContent = "Загрузка...";
    fetch("/api/auth/users", { headers: getAuthHeaders(), credentials: "same-origin" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { r: r, j: j };
        });
      })
      .then(function (x) {
        if (!x.r.ok) throw new Error((x.j && x.j.error) || "Недоступно");
        var rows = Array.isArray(x.j && x.j.data) ? x.j.data : [];
        var online = rows.reduce(function (acc, u) {
          return acc + Number(u.active_sessions || 0);
        }, 0);
        if (out) out.textContent = String(online);
        if (note) note.textContent = "Обновлено сейчас";
      })
      .catch(function (e) {
        if (out) out.textContent = "-";
        if (note) note.textContent = (e && e.message) || "Недоступно";
      });
  }

  // Header theme options drawer toggle (React has ThemeOptions component).
  var themeRoot = document.querySelector(".ui-theme-settings.ui-theme-settings--header");
  var themeBtn = document.getElementById("TooltipDemoVanilla");
  if (themeRoot && themeBtn) {
    themeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      themeRoot.classList.toggle("settings-open");
    });
  }

  function readBoolSetting(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch (e) {}
    return fallback;
  }

  function writeBoolSetting(key, value) {
    try {
      window.localStorage.setItem(key, value ? "1" : "0");
    } catch (e) {}
  }

  function bindClassSwitch(inputId, storageKey, targetEl, className, fallback) {
    var input = document.getElementById(inputId);
    if (!input || !targetEl) return;
    var enabled = readBoolSetting(storageKey, fallback);
    input.checked = enabled;
    targetEl.classList.toggle(className, enabled);
    input.addEventListener("change", function () {
      var next = Boolean(input.checked);
      targetEl.classList.toggle(className, next);
      writeBoolSetting(storageKey, next);
    });
  }

  function bindDisplaySwitch(inputId, storageKey, selector, fallback) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var enabled = readBoolSetting(storageKey, fallback);
    input.checked = enabled;
    document.querySelectorAll(selector).forEach(function (el) {
      el.style.display = enabled ? "" : "none";
    });
    input.addEventListener("change", function () {
      var next = Boolean(input.checked);
      document.querySelectorAll(selector).forEach(function (el) {
        el.style.display = next ? "" : "none";
      });
      writeBoolSetting(storageKey, next);
    });
  }

  var headerEl = document.querySelector(".app-header");
  var sidebarEl = document.querySelector(".app-sidebar");

  bindClassSwitch(
    "dg-theme-fixed-header",
    "datagon_theme_fixed_header_v1",
    c,
    "fixed-header",
    c.classList.contains("fixed-header")
  );
  bindClassSwitch(
    "dg-theme-header-shadow",
    "datagon_theme_header_shadow_v1",
    headerEl,
    "header-shadow",
    headerEl ? headerEl.classList.contains("header-shadow") : true
  );
  bindClassSwitch(
    "dg-theme-fixed-sidebar",
    "datagon_theme_fixed_sidebar_v1",
    c,
    "fixed-sidebar",
    c.classList.contains("fixed-sidebar")
  );
  bindClassSwitch(
    "dg-theme-sidebar-shadow",
    "datagon_theme_sidebar_shadow_v1",
    sidebarEl,
    "sidebar-shadow",
    sidebarEl ? sidebarEl.classList.contains("sidebar-shadow") : true
  );
  bindClassSwitch(
    "dg-theme-fixed-footer",
    "datagon_theme_fixed_footer_v1",
    c,
    "fixed-footer",
    c.classList.contains("fixed-footer")
  );
  bindDisplaySwitch(
    "dg-theme-title-icon",
    "datagon_theme_title_icon_v1",
    ".page-title-icon",
    true
  );
  bindDisplaySwitch(
    "dg-theme-title-subheading",
    "datagon_theme_title_subheading_v1",
    ".page-title-subheading",
    true
  );

  function setActiveSwatch(selector, value, attrName) {
    document.querySelectorAll(selector).forEach(function (sw) {
      var isActive = sw.getAttribute(attrName) === value;
      sw.classList.toggle("active", isActive);
    });
  }

  function applyOneClass(target, classList, nextClass) {
    if (!target) return;
    classList.forEach(function (cn) {
      target.classList.remove(cn);
    });
    if (nextClass && classList.indexOf(nextClass) >= 0) {
      target.classList.add(nextClass);
    }
  }

  var colorSchemes = ["white", "gray"];
  var sidebarColorClasses = [
    "bg-primary",
    "bg-danger",
    "bg-warning",
    "bg-success",
    "bg-info",
    "bg-secondary",
    "bg-dark",
    "bg-plum-plate",
    "bg-arielle-smile",
    "bg-ripe-malin",
    "bg-night-fade",
    "bg-malibu-beach",
  ];
  var headerColorClasses = [
    "bg-primary",
    "bg-danger",
    "bg-warning",
    "bg-success",
    "bg-info",
    "bg-secondary",
    "bg-dark",
    "bg-plum-plate",
  ];

  var savedScheme = "white";
  try {
    var rawScheme = window.localStorage.getItem("datagon_theme_color_scheme_v1");
    if (colorSchemes.indexOf(rawScheme) >= 0) savedScheme = rawScheme;
  } catch (e) {}
  c.classList.remove("app-theme-white", "app-theme-gray");
  c.classList.add(savedScheme === "gray" ? "app-theme-gray" : "app-theme-white");
  setActiveSwatch(".dg-theme-color-scheme", savedScheme, "data-color-scheme");
  document.querySelectorAll(".dg-theme-color-scheme").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var scheme = sw.getAttribute("data-color-scheme");
      if (colorSchemes.indexOf(scheme) < 0) return;
      c.classList.remove("app-theme-white", "app-theme-gray");
      c.classList.add(scheme === "gray" ? "app-theme-gray" : "app-theme-white");
      setActiveSwatch(".dg-theme-color-scheme", scheme, "data-color-scheme");
      try {
        window.localStorage.setItem("datagon_theme_color_scheme_v1", scheme);
      } catch (e) {}
    });
  });

  var savedSidebarColor = "";
  try {
    savedSidebarColor = window.localStorage.getItem("datagon_theme_sidebar_color_v1") || "";
  } catch (e) {}
  applyOneClass(sidebarEl, sidebarColorClasses, savedSidebarColor);
  setActiveSwatch(".dg-theme-sidebar-color", savedSidebarColor, "data-color-class");
  document.querySelectorAll(".dg-theme-sidebar-color").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var cn = sw.getAttribute("data-color-class") || "";
      if (sidebarColorClasses.indexOf(cn) < 0) return;
      applyOneClass(sidebarEl, sidebarColorClasses, cn);
      setActiveSwatch(".dg-theme-sidebar-color", cn, "data-color-class");
      try {
        window.localStorage.setItem("datagon_theme_sidebar_color_v1", cn);
      } catch (e) {}
    });
  });

  var savedHeaderColor = "";
  try {
    savedHeaderColor = window.localStorage.getItem("datagon_theme_header_color_v1") || "";
  } catch (e) {}
  applyOneClass(headerEl, headerColorClasses, savedHeaderColor);
  setActiveSwatch(".dg-theme-header-color", savedHeaderColor, "data-color-class");
  document.querySelectorAll(".dg-theme-header-color").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var cn = sw.getAttribute("data-color-class") || "";
      if (headerColorClasses.indexOf(cn) < 0) return;
      applyOneClass(headerEl, headerColorClasses, cn);
      setActiveSwatch(".dg-theme-header-color", cn, "data-color-class");
      try {
        window.localStorage.setItem("datagon_theme_header_color_v1", cn);
      } catch (e) {}
    });
  });

  var sidebarBgLayer = document.querySelector(".app-sidebar-bg");
  var sidebarBgToggle = document.getElementById("dg-theme-sidebar-bg-image");
  if (sidebarBgLayer && sidebarBgToggle) {
    var bgEnabled = readBoolSetting("datagon_theme_sidebar_bg_image_v1", false);
    sidebarBgToggle.checked = bgEnabled;
    if (bgEnabled) {
      sidebarBgLayer.style.display = "";
      sidebarBgLayer.style.backgroundImage = "url('/vanilla/assets/utils/images/dropdown-header/city2.jpg')";
      sidebarBgLayer.style.backgroundSize = "cover";
      sidebarBgLayer.style.backgroundPosition = "center";
    } else {
      sidebarBgLayer.style.backgroundImage = "";
      sidebarBgLayer.style.display = "none";
    }
    sidebarBgToggle.addEventListener("change", function () {
      var next = Boolean(sidebarBgToggle.checked);
      if (next) {
        sidebarBgLayer.style.display = "";
        sidebarBgLayer.style.backgroundImage = "url('/vanilla/assets/utils/images/dropdown-header/city2.jpg')";
        sidebarBgLayer.style.backgroundSize = "cover";
        sidebarBgLayer.style.backgroundPosition = "center";
      } else {
        sidebarBgLayer.style.backgroundImage = "";
        sidebarBgLayer.style.display = "none";
      }
      writeBoolSetting("datagon_theme_sidebar_bg_image_v1", next);
    });
  }

  var onlineRefreshBtn = document.getElementById("dg-vanilla-online-users-refresh");
  if (onlineRefreshBtn) {
    onlineRefreshBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      loadOnlineUsers();
    });
  }

  // Header mega menu popover (React has Popover in MegaMenu).
  var megaLink = document.getElementById("PopoverMegaMenuVanilla");
  var megaMenu = megaLink ? megaLink.parentElement.querySelector(".dg-vanilla-megamenu") : null;
  function closeMegaMenu() {
    if (megaMenu) megaMenu.classList.remove("show");
  }
  if (megaLink && megaMenu) {
    megaLink.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var open = megaMenu.classList.contains("show");
      closeMegaMenu();
      if (!open) megaMenu.classList.add("show");
    });
  }

  function closeAllDropdowns() {
    closeMegaMenu();
    if (themeRoot) themeRoot.classList.remove("settings-open");
    document.querySelectorAll(".dropdown-menu.show").forEach(function (m) {
      m.classList.remove("show");
    });
    document.querySelectorAll(".dg-vanilla-dropdown-toggle[aria-expanded='true']").forEach(function (b) {
      b.setAttribute("aria-expanded", "false");
    });
    document.querySelectorAll(".dg-vanilla-footer-popover.show").forEach(function (m) {
      m.classList.remove("show");
    });
    document.querySelectorAll(".dg-vanilla-footer-toggle[aria-expanded='true']").forEach(function (b) {
      b.setAttribute("aria-expanded", "false");
    });
  }

  function resolvePlacementMode(menu, opener) {
    if (menu && menu.getAttribute) {
      var explicit = menu.getAttribute("data-dg-placement");
      if (explicit === "left" || explicit === "right" || explicit === "center") return explicit;
    }
    var openerId = opener && opener.getAttribute ? opener.getAttribute("id") : "";
    if (openerId === "PopoverFooter-3") return "center";
    if (openerId === "PopoverFooter-1") return "left";
    if (opener && opener.closest && opener.closest(".app-header-right")) return "right";
    return "left";
  }

  function placeMenuInViewport(menu, opener) {
    if (!menu) return;
    menu.style.transform = "";
    menu.style.left = "";
    menu.style.right = "";
    menu.removeAttribute("data-dg-anchor-right");
    var rect = menu.getBoundingClientRect();
    var openerRect = opener && opener.getBoundingClientRect ? opener.getBoundingClientRect() : null;
    var placement = resolvePlacementMode(menu, opener);
    var desiredLeft = rect.left;
    if (openerRect) {
      if (placement === "right") desiredLeft = openerRect.right - rect.width;
      else if (placement === "center") desiredLeft = openerRect.left + (openerRect.width - rect.width) / 2;
      else desiredLeft = openerRect.left;
    }
    var pad = 8;
    var minLeft = pad;
    var maxLeft = window.innerWidth - rect.width - pad;
    if (maxLeft < minLeft) maxLeft = minLeft;
    if (desiredLeft < minLeft) desiredLeft = minLeft;
    if (desiredLeft > maxLeft) desiredLeft = maxLeft;
    var dx = desiredLeft - rect.left;
    if (dx !== 0) {
      menu.style.transform = "translateX(" + Math.round(dx) + "px)";
    }
  }

  function placeFooterPopover(menu, opener) {
    if (!menu || !opener || !opener.getBoundingClientRect) return;
    menu.style.transform = "";
    menu.style.position = "fixed";
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    menu.style.marginBottom = "0";
    var menuRect = menu.getBoundingClientRect();
    var openerRect = opener.getBoundingClientRect();
    var placement = resolvePlacementMode(menu, opener);
    var desiredLeft = openerRect.left;
    if (placement === "right") desiredLeft = openerRect.right - menuRect.width;
    else if (placement === "center") desiredLeft = openerRect.left + (openerRect.width - menuRect.width) / 2;
    var pad = 8;
    var minLeft = pad;
    var maxLeft = window.innerWidth - menuRect.width - pad;
    if (maxLeft < minLeft) maxLeft = minLeft;
    if (desiredLeft < minLeft) desiredLeft = minLeft;
    if (desiredLeft > maxLeft) desiredLeft = maxLeft;
    var desiredTop = openerRect.top - menuRect.height - 6;
    if (desiredTop < pad) desiredTop = openerRect.bottom + 6;
    menu.style.left = Math.round(desiredLeft) + "px";
    menu.style.top = Math.round(desiredTop) + "px";
  }

  var footerPopoverScrollWatcher = null;
  function stopFooterPopoverScrollWatcher() {
    if (!footerPopoverScrollWatcher) return;
    cancelAnimationFrame(footerPopoverScrollWatcher);
    footerPopoverScrollWatcher = null;
  }
  function startFooterPopoverScrollWatcher() {
    stopFooterPopoverScrollWatcher();
    var mainOuter = document.querySelector(".app-main__outer");
    var lastWinY = window.scrollY || window.pageYOffset || 0;
    var lastMainY = mainOuter ? mainOuter.scrollTop : 0;
    function tick() {
      var opened = document.querySelector(".dg-vanilla-footer-popover.show");
      if (!opened) {
        stopFooterPopoverScrollWatcher();
        return;
      }
      var winY = window.scrollY || window.pageYOffset || 0;
      var mainY = mainOuter ? mainOuter.scrollTop : 0;
      if (winY !== lastWinY || mainY !== lastMainY) {
        closeAllDropdowns();
        stopFooterPopoverScrollWatcher();
        return;
      }
      footerPopoverScrollWatcher = requestAnimationFrame(tick);
    }
    footerPopoverScrollWatcher = requestAnimationFrame(tick);
  }

  document.querySelectorAll(".dg-vanilla-dropdown-toggle").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var drop = btn.closest(".dropdown");
      if (!drop) return;
      var menu = drop.querySelector(".dropdown-menu");
      if (!menu) return;
      var open = menu.classList.contains("show");
      closeAllDropdowns();
      if (!open) {
        menu.classList.add("show");
        btn.setAttribute("aria-expanded", "true");
        window.requestAnimationFrame(function () {
          placeMenuInViewport(menu, btn);
        });
      }
    });
  });

  document.querySelectorAll(".dg-vanilla-footer-toggle").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute("id");
      if (!id) return;
      var menu = document.querySelector('.dg-vanilla-footer-popover[data-footer-popover="' + id + '"]');
      if (!menu) return;
      var open = menu.classList.contains("show");
      closeAllDropdowns();
      if (!open) {
        menu.classList.add("show");
        btn.setAttribute("aria-expanded", "true");
        menu.setAttribute("data-dg-opened-by", id);
        window.requestAnimationFrame(function () {
          placeFooterPopover(menu, btn);
          startFooterPopoverScrollWatcher();
        });
      }
    });
  });

  if (megaLink && megaMenu) {
    megaLink.addEventListener("click", function () {
      if (megaMenu.classList.contains("show")) {
        window.requestAnimationFrame(function () {
          placeMenuInViewport(megaMenu, megaLink);
        });
      }
    });
  }

  window.addEventListener("resize", function () {
    document.querySelectorAll(".dropdown-menu.show, .dg-vanilla-megamenu.show, .dg-vanilla-footer-popover.show").forEach(function (menu) {
      if (menu.classList.contains("dg-vanilla-footer-popover")) {
        var openerId = menu.getAttribute("data-dg-opened-by");
        var opener = openerId ? document.getElementById(openerId) : null;
        if (opener) placeFooterPopover(menu, opener);
      } else {
        placeMenuInViewport(menu);
      }
    });
  });

  function handleFooterMenusOnScroll() {
    var opened = document.querySelector(".dg-vanilla-footer-popover.show");
    if (!opened) return;
    closeAllDropdowns();
    stopFooterPopoverScrollWatcher();
  }
  function hasOpenedFooterPopover() {
    return Boolean(document.querySelector(".dg-vanilla-footer-popover.show"));
  }
  window.addEventListener("scroll", handleFooterMenusOnScroll, { passive: true });
  document.addEventListener("scroll", handleFooterMenusOnScroll, { passive: true, capture: true });
  document.addEventListener("wheel", handleFooterMenusOnScroll, { passive: true });
  document.addEventListener("touchmove", handleFooterMenusOnScroll, { passive: true });
  document.addEventListener("pointerdown", function (e) {
    if (!hasOpenedFooterPopover()) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(".dg-vanilla-footer-popover")) return;
    if (t.closest(".dg-vanilla-footer-toggle")) return;
    if (t.closest(".app-main__outer, .app-main__inner, .table-responsive, .datagon-my-products-table-wrap")) {
      closeAllDropdowns();
      stopFooterPopoverScrollWatcher();
    }
  }, { passive: true });
  [
    ".app-main__outer",
    ".app-main",
    ".table-responsive",
    ".datagon-my-products-table-wrap",
  ].forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      if (el && el.addEventListener) {
        el.addEventListener("scroll", handleFooterMenusOnScroll, { passive: true });
      }
    });
  });

  document.addEventListener("click", function (e) {
    hideGlobalTooltip();
    if (e.target.closest(".ui-theme-settings")) return;
    if (e.target.closest(".dg-vanilla-megamenu")) return;
    if (e.target.closest(".dg-vanilla-footer-popover")) return;
    if (e.target.closest(".dropdown")) return;
    closeAllDropdowns();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      hideGlobalTooltip();
      closeAllDropdowns();
    }
  });

  var calendarBtn = document.getElementById("Tooltip-1");
  if (calendarBtn) {
    calendarBtn.addEventListener("click", function () {
      alert("You don't have any new items in your calendar for today! Go out and play!");
    });
  }

  loadCurrentUserProfile();
  loadOnlineUsers();
})();
