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
    var ids = ["dg-vanilla-user-display-inline"];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = displayName;
    });
    var roleIds = ["dg-vanilla-user-role-inline"];
    roleIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = role;
    });
  }

  function performVanillaLogout() {
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
      body: "{}",
    })
      .catch(function () {})
      .then(function () {
        try {
          window.localStorage.removeItem("authToken");
          window.localStorage.removeItem("currentUser");
          window.localStorage.removeItem("currentUserDisplayName");
          window.localStorage.removeItem("isAdmin");
          window.localStorage.removeItem("isLoggedIn");
        } catch (e) {}
        window.location.replace("/sections.html");
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
      sidebarBgLayer.style.backgroundImage = "url('/assets/utils/images/dropdown-header/city2.jpg')";
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
        sidebarBgLayer.style.backgroundImage = "url('/assets/utils/images/dropdown-header/city2.jpg')";
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

  // Global table baseline (except moysklad that has dedicated tuned logic).
  function ensureTableBaselineStyles() {
    if (document.getElementById("dg-table-baseline-styles")) return;
    var style = document.createElement("style");
    style.id = "dg-table-baseline-styles";
    style.textContent = [
      ".table-responsive.dg-table-baseline-wrap{overflow-x:auto;overflow-y:visible;position:relative;}",
      ".table-responsive.dg-table-baseline-wrap > table.table{min-width:100%;table-layout:auto;}",
      ".table-responsive.dg-table-baseline-wrap > table.table[data-dg-sticky-enabled='1'] > thead > tr > th{position:sticky;top:var(--dg-table-sticky-top,60px);z-index:8;background:#f8f9fa;border-bottom:1px solid #e6e9ee;}",
      ".table-responsive.dg-table-baseline-wrap > table.table > tbody > tr > td{vertical-align:middle;}",
      ".table-responsive.datagon-my-products-table-wrap.dg-table-baseline-wrap{overflow:visible!important;max-height:none!important;}",
      ".table-responsive.datagon-my-products-table-wrap.dg-table-baseline-wrap,.table-responsive.datagon-my-products-table-wrap.dg-table-baseline-wrap > table{transform:none!important;filter:none!important;perspective:none!important;}",
      ".table.datagon-my-products-table{font-size:.8rem;line-height:1.25;font-variant-numeric:tabular-nums;}",
      "table.table.datagon-my-products-table:not(#dg-matches-list-table):not(#dg-res-main-table) > thead > tr > th{background:#fff!important;border-bottom:1px solid #e6e9ee;}",
      "table.table.datagon-my-products-table:not(#dg-matches-list-table):not(#dg-res-main-table) > tbody > tr > td{border-right:1px solid #f3f5f8;}",
      ".table-responsive.dg-table-baseline-wrap td a,.table-responsive.dg-table-baseline-wrap th a{display:inline-flex;align-items:center;gap:4px;}",
      ".table-responsive.dg-table-baseline-wrap td i,.table-responsive.dg-table-baseline-wrap th i{vertical-align:middle;}",
      ".datagon-columns-toolbox{margin:0 0 10px 0;border:1px solid #e5e7eb;border-radius:8px;background:#fafbfc;padding:8px;}",
      ".datagon-columns-toolbox .columns-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}",
      ".datagon-columns-toolbox .columns-title{font-size:12px;color:#6b7280;display:none;}",
      ".datagon-columns-toolbox .btn{border-color:#d1d5db!important;box-shadow:none!important;}",
      ".datagon-columns-panel{margin-top:8px;border-top:1px dashed #d1d5db;padding-top:8px;display:none;}",
      ".datagon-columns-panel.open{display:block;}",
      ".datagon-columns-panel .columns-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 10px;}",
      ".datagon-columns-panel label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#374151;user-select:none;}",
    ].join("");
    document.head.appendChild(style);
  }

  function getAppHeaderStickyTop() {
    var app = document.querySelector(".app-container");
    var header = document.querySelector(".app-header");
    var fixed = Boolean(app && app.classList && app.classList.contains("fixed-header"));
    if (!fixed) return 0;
    if (!header || !header.getBoundingClientRect) return 60;
    var r = header.getBoundingClientRect();
    var h = r && r.height ? r.height : 60;
    return h > 0 ? h : 60;
  }

  function shouldSkipGlobalTableBaseline(table) {
    if (!table) return true;
    var id = String(table.id || "");
    // These pages manage table behavior locally (columns, widths, sorting).
    if (
      id === "dg-q-main-table" ||
      id === "dg-res-main-table" ||
      id === "dg-matches-list-table" ||
      id === "mp-main-table"
    )
      return true;
    return false;
  }

  function markBaselineTables() {
    ensureTableBaselineStyles();
    var wraps = Array.prototype.slice.call(document.querySelectorAll(".table-responsive"));
    if (!wraps.length) return 0;
    var count = 0;

    wraps.forEach(function (wrap) {
      var table = wrap.querySelector(":scope > table.table");
      if (!table) return;
      if (shouldSkipGlobalTableBaseline(table)) return;
      if (table.classList.contains("dg-ms-table")) return;
      var thead = table.tHead;
      if (!thead) return;
      wrap.classList.add("dg-table-baseline-wrap");
      table.setAttribute("data-dg-table-baseline", "1");
      var stickyEnabled = table.getAttribute("data-dg-sticky") === "1";
      table.setAttribute(
        "data-dg-sticky-enabled",
        stickyEnabled ? "1" : "0"
      );
      count++;
    });
    return count;
  }

  function getTableColumnLabels(table) {
    var headRow = table.tHead && table.tHead.rows && table.tHead.rows[0] ? table.tHead.rows[0] : null;
    if (!headRow) return [];
    return Array.prototype.map.call(headRow.cells, function (cell, idx) {
      var txt = String(cell.getAttribute("data-col-label") || cell.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      return txt || "Столбец " + (idx + 1);
    });
  }

  function applyTableColumnVisibility(table, visible) {
    var headRow = table.tHead && table.tHead.rows && table.tHead.rows[0] ? table.tHead.rows[0] : null;
    if (!headRow) return;
    var colCount = headRow.cells.length;
    for (var col = 0; col < colCount; col++) {
      var show = visible[col] !== false;
      Array.prototype.forEach.call(table.rows || [], function (row) {
        if (row.cells && row.cells[col]) row.cells[col].style.display = show ? "" : "none";
      });
    }
  }

  function setupColumnsToolboxForTable(wrap, table, tableIndex) {
    if (!wrap || !table) return;
    if (shouldSkipGlobalTableBaseline(table)) return;
    if (table.classList.contains("dg-ms-table")) return;
    if (wrap.previousElementSibling && wrap.previousElementSibling.classList && wrap.previousElementSibling.classList.contains("datagon-columns-toolbox")) return;
    if (table.getAttribute("data-dg-columns-toolbox-ready") === "1") return;

    var labels = getTableColumnLabels(table);
    if (!labels.length) return;
    table.setAttribute("data-dg-columns-toolbox-ready", "1");
    var storageKey = "datagon_table_columns_v1:" + window.location.pathname + ":" + tableIndex;

    var visible = labels.map(function () {
      return true;
    });
    try {
      var raw = localStorage.getItem(storageKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === labels.length) {
          visible = parsed.map(function (v) {
            return v !== false;
          });
        }
      }
    } catch (e) {}

    function persist() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(visible));
      } catch (e) {}
    }
    function sync() {
      applyTableColumnVisibility(table, visible);
      persist();
      inputs.forEach(function (input, i) {
        input.checked = visible[i] !== false;
      });
    }

    var toolbox = document.createElement("div");
    toolbox.className = "datagon-columns-toolbox mb-2";
    var top = document.createElement("div");
    top.className = "columns-top";
    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn btn-sm";
    toggleBtn.textContent = "🧩 Столбцы";
    var title = document.createElement("div");
    title.className = "columns-title";
    title.textContent = "Включение/выключение видимых столбцов:";
    top.appendChild(toggleBtn);
    top.appendChild(title);
    toolbox.appendChild(top);

    var panel = document.createElement("div");
    panel.className = "datagon-columns-panel";
    var actions = document.createElement("div");
    actions.className = "columns-actions mb-2";
    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "btn btn-sm me-1";
    allBtn.textContent = "Выделить все";
    var noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "btn btn-sm me-1";
    noneBtn.textContent = "Снять все";
    var defaultBtn = document.createElement("button");
    defaultBtn.type = "button";
    defaultBtn.className = "btn btn-sm";
    defaultBtn.textContent = "По умолчанию";
    actions.appendChild(allBtn);
    actions.appendChild(noneBtn);
    actions.appendChild(defaultBtn);
    panel.appendChild(actions);

    var grid = document.createElement("div");
    grid.className = "columns-grid";
    var inputs = [];
    labels.forEach(function (label, idx) {
      var lb = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visible[idx] !== false;
      cb.addEventListener("change", function () {
        var next = visible.slice();
        next[idx] = cb.checked;
        if (!next.some(Boolean)) {
          cb.checked = true;
          return;
        }
        visible = next;
        sync();
      });
      inputs.push(cb);
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode(label));
      grid.appendChild(lb);
    });
    panel.appendChild(grid);
    toolbox.appendChild(panel);
    wrap.parentNode.insertBefore(toolbox, wrap);

    toggleBtn.addEventListener("click", function () {
      panel.classList.toggle("open");
    });
    allBtn.addEventListener("click", function () {
      visible = visible.map(function () {
        return true;
      });
      sync();
    });
    noneBtn.addEventListener("click", function () {
      visible = visible.map(function (_, idx) {
        return idx === 0;
      });
      sync();
    });
    defaultBtn.addEventListener("click", function () {
      visible = labels.map(function () {
        return true;
      });
      sync();
    });
    sync();
  }

  function initGlobalTableBaseline() {
    function updateStickyTopOnly() {
      if (!markBaselineTables()) return;
      var headerTop = getAppHeaderStickyTop();
      document.documentElement.style.setProperty("--dg-table-sticky-top", headerTop + "px");
      var tables = Array.prototype.slice.call(document.querySelectorAll(".table-responsive.dg-table-baseline-wrap > table.table[data-dg-table-baseline='1']"));
      tables.forEach(function (table, idx) {
        setupColumnsToolboxForTable(table.closest(".table-responsive"), table, idx);
      });
    }

    updateStickyTopOnly();
    window.addEventListener("resize", updateStickyTopOnly);

    var obsRoot = document.querySelector(".app-main__inner") || document.body;
    if (obsRoot && window.MutationObserver) {
      var observer = new MutationObserver(function () {
        updateStickyTopOnly();
      });
      observer.observe(obsRoot, { childList: true, subtree: true });
    }
  }

  initGlobalTableBaseline();
  loadCurrentUserProfile();
  loadOnlineUsers();

  var logoutBtn = document.querySelector(".dg-vanilla-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeAllDropdowns();
      performVanillaLogout();
    });
  }
})();
