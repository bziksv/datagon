import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const STYLE_ID = "datagon-columns-toolbox-style-v1";
const TOOLBOX_CLASS = "datagon-columns-toolbox";
const PANEL_CLASS = "datagon-columns-panel";

/** Map (не WeakMap): при cleanup нужно отключить все observer'ы, даже если getTables() уже пуст из‑за React. */
const observedTables = new Map();

const normalizeLabel = (text, index) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t || `Колонка ${index + 1}`;
};

const userScopedStorageKey = (pathname, tableKey) => {
  const user = String(window.localStorage.getItem("currentUser") || "guest").trim() || "guest";
  return `table_columns_v2:${pathname}:${tableKey}:${user}`;
};

const ensureStyles = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${TOOLBOX_CLASS} {
      margin: 0 0 10px 0;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #fafbfc;
      padding: 8px;
    }
    .${TOOLBOX_CLASS} .columns-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .${TOOLBOX_CLASS} .columns-title {
      font-size: 12px;
      color: #6b7280;
    }
    .${TOOLBOX_CLASS} .btn {
      outline: none !important;
      border-color: #d1d5db !important;
      -webkit-tap-highlight-color: transparent;
    }
    .${TOOLBOX_CLASS} .btn:focus,
    .${TOOLBOX_CLASS} .btn:active,
    .${TOOLBOX_CLASS} .btn.active,
    .${TOOLBOX_CLASS} .btn:not(:disabled):not(.disabled):active {
      box-shadow: none !important;
      outline: none !important;
      border-color: #d1d5db !important;
    }
    .${TOOLBOX_CLASS} .btn:focus-visible {
      box-shadow: 0 0 0 0.15rem rgba(63, 106, 216, 0.22) !important;
      border-color: #7fa1ea !important;
    }
    .${PANEL_CLASS} {
      margin-top: 8px;
      border-top: 1px dashed #d1d5db;
      padding-top: 8px;
      display: none;
    }
    .${PANEL_CLASS}.open { display: block; }
    .${PANEL_CLASS} .columns-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .${PANEL_CLASS} .columns-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 6px 10px;
    }
    .${PANEL_CLASS} label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #374151;
      user-select: none;
    }
    .${PANEL_CLASS} input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
    }
  `;
  document.head.appendChild(style);
};

const readState = (storageKey, columns) => {
  const defaults = {};
  columns.forEach((c) => {
    defaults[c.key] = true;
  });
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    const merged = { ...defaults, ...parsed };
    const visibleCount = columns.reduce((acc, c) => acc + (merged[c.key] !== false ? 1 : 0), 0);
    const minVisible = Math.min(3, columns.length);
    if (visibleCount < minVisible) return defaults;
    return merged;
  } catch (_) {
    return defaults;
  }
};

const saveState = (storageKey, state) => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (_) {}
};

const getHeaderMeta = (table) => {
  const ths = Array.from(table.querySelectorAll("thead th"));
  return ths.map((th, idx) => ({
    idx,
    key: th.dataset.colKey || `col_${idx}`,
    label: normalizeLabel(th.textContent, idx),
  }));
};

const applyVisibility = (table, columns, state) => {
  const rows = Array.from(table.querySelectorAll("tr"));
  rows.forEach((row) => {
    const cells = Array.from(row.children);
    columns.forEach((col) => {
      const cell = cells[col.idx];
      if (!cell) return;
      const visible = state[col.key] !== false;
      cell.style.display = visible ? "" : "none";
    });
  });
};

const cleanupOrphanToolboxes = () => {
  const nodes = Array.from(document.querySelectorAll(`.${TOOLBOX_CLASS}`));
  nodes.forEach((node) => {
    const next = node.nextElementSibling;
    if (!next || next.tagName !== "TABLE") node.remove();
  });
};

const setupTableToolbox = (table, tableKey) => {
  if (!table || !table.querySelector("thead")) return;
  if (table.dataset.columnsManaged === "1") {
    // Table might be re-rendered while toolbox node was dropped.
    // Recreate toolbox if previous managed marker is stale.
    const prev = table.previousElementSibling;
    const hasToolbox = Boolean(prev && prev.classList && prev.classList.contains(TOOLBOX_CLASS));
    if (hasToolbox) return;
    table.dataset.columnsManaged = "0";
  }

  const columns = getHeaderMeta(table);
  if (!columns.length) return;

  const storageKey = userScopedStorageKey(window.location.pathname, tableKey);
  let state = readState(storageKey, columns);
  saveState(storageKey, state);
  applyVisibility(table, columns, state);

  const box = document.createElement("div");
  box.className = TOOLBOX_CLASS;
  box.innerHTML = `
    <div class="columns-top">
      <button type="button" class="btn btn-sm">🧩 Столбцы</button>
      <div class="columns-title">Включение/выключение видимых столбцов:</div>
    </div>
    <div class="${PANEL_CLASS}">
      <div class="columns-actions">
        <button type="button" class="btn btn-sm" data-action="all">Выделить все</button>
        <button type="button" class="btn btn-sm" data-action="none">Снять все</button>
        <button type="button" class="btn btn-sm" data-action="default">По умолчанию</button>
      </div>
      <div class="columns-grid"></div>
    </div>
  `;

  const toggleBtn = box.querySelector("button.btn");
  const panel = box.querySelector(`.${PANEL_CLASS}`);
  const grid = box.querySelector(".columns-grid");
  const actionButtons = Array.from(box.querySelectorAll("[data-action]"));
  const syncToolboxWidth = () => {
    const w = Math.max(table.scrollWidth || 0, table.getBoundingClientRect().width || 0);
    if (!w) return;
    box.style.width = `${Math.ceil(w)}px`;
    box.style.minWidth = `${Math.ceil(w)}px`;
    box.style.boxSizing = "border-box";
  };

  const renderChecks = () => {
    grid.innerHTML = "";
    columns.forEach((col) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" ${state[col.key] !== false ? "checked" : ""}><span>${col.label}</span>`;
      const input = label.querySelector("input");
      input.addEventListener("change", () => {
        state[col.key] = input.checked;
        saveState(storageKey, state);
        applyVisibility(table, columns, state);
      });
      grid.appendChild(label);
    });
  };

  toggleBtn.addEventListener("click", () => {
    panel.classList.toggle("open");
  });

  actionButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action");
      if (action === "all" || action === "default") {
        columns.forEach((c) => {
          state[c.key] = true;
        });
      } else if (action === "none") {
        columns.forEach((c) => {
          state[c.key] = false;
        });
      }
      saveState(storageKey, state);
      renderChecks();
      applyVisibility(table, columns, state);
    });
  });

  const prevObs = observedTables.get(table);
  if (prevObs) {
    try {
      prevObs.disconnect();
    } catch (_) {}
    observedTables.delete(table);
  }

  const observer = new MutationObserver(() => {
    try {
      applyVisibility(table, columns, state);
      syncToolboxWidth();
    } catch (_) {}
  });
  observer.observe(table, { childList: true, subtree: true });
  observedTables.set(table, observer);

  table.parentNode.insertBefore(box, table);
  table.dataset.columnsManaged = "1";
  renderChecks();
  syncToolboxWidth();
};

const DatagonColumnsManager = () => {
  const location = useLocation();

  useEffect(() => {
    const path = String(location.pathname || "");
    const isDatagonRoute =
      path === "/datagon" ||
      path.startsWith("/datagon/") ||
      /^\/(dashboard|my-sites|my-products|moysklad|matches|matching|queue|results|projects|processes|settings)(\/|$)/.test(
        path
      );
    if (!isDatagonRoute) return;

    ensureStyles();
    const getTables = () => {
      const inMain = Array.from(document.querySelectorAll(".app-main__inner table.table"));
      return inMain.length ? inMain : Array.from(document.querySelectorAll("table.table"));
    };
    const attachToolboxes = () => {
      cleanupOrphanToolboxes();
      const tables = getTables();
      let idx = 0;
      tables.forEach((table) => {
        const key = table.id || `table_${idx++}`;
        setupTableToolbox(table, key);
      });
    };

    // Initial pass + extra passes after async React renders.
    attachToolboxes();
    const rafId = window.requestAnimationFrame(attachToolboxes);
    const timerId = window.setTimeout(attachToolboxes, 250);

    // Keep toolbox present after rerenders/data refreshes.
    const root = document.querySelector(".app-main__inner") || document.body;
    let rootObserver = null;
    if (root) {
      rootObserver = new MutationObserver(() => {
        attachToolboxes();
      });
      rootObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      try {
        window.cancelAnimationFrame(rafId);
      } catch (_) {}
      try {
        window.clearTimeout(timerId);
      } catch (_) {}
      if (rootObserver) {
        try {
          rootObserver.disconnect();
        } catch (_) {}
      }
      observedTables.forEach((observer) => {
        try {
          observer.disconnect();
        } catch (_) {}
      });
      observedTables.clear();
    };
  }, [location.pathname]);

  return null;
};

export default DatagonColumnsManager;

