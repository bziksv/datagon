import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const initialFilters = {
  limit: 100,
  type: "all",
  archived: "active",
  stock_position: "yes",
  on_site: "all",
  search: "",
  supplier: "",
  supplier2: "",
  manager: "",
  content_manager: "",
  only_stock: "0",
  no_coop: "0",
  has_buy_price: "0",
  has_price_comment: "0",
  has_automation: "0",
};

const SORTABLE_FIELDS = [
  "code",
  "name",
  "manager",
  "content_manager",
  "type",
  "stock_position",
  "no_longer_cooperation",
  "stock",
  "stock_days",
  "price_comment",
  "vat",
  "vat_on_product",
  "buy_price",
  "supplier",
  "supplier2",
  "automation_price",
  "packing_standard",
  "packing_own_box",
  "packing_weight",
  "is_archived",
  "updated_label",
];

const buildQuery = (params) => {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    s.set(k, String(v));
  });
  const q = s.toString();
  return q ? `?${q}` : "";
};

const formatNumber = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString("ru-RU") : "0";
};

const formatMoneyText = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = Number(raw.replace(/[^\d.,-]/g, "").replace(",", "."));
  if (!Number.isFinite(parsed)) return raw;
  return `${parsed.toLocaleString("ru-RU")} ₽`;
};
const DEFAULT_COL_STYLE = {
  minWidth: 120,
  whiteSpace: "normal",
  wordBreak: "break-word",
  overflowWrap: "break-word",
  overflow: "hidden",
  verticalAlign: "top",
};
const HEADER_COL_STYLE = {
  fontSize: 12,
  lineHeight: 1.2,
  paddingTop: 8,
  paddingBottom: 8,
  textAlign: "center",
  verticalAlign: "middle",
};
const CLAMP_2_STYLE = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  whiteSpace: "normal",
  wordBreak: "break-word",
  textOverflow: "ellipsis",
  lineHeight: 1.25,
  maxHeight: "2.5em",
};
/** Колонки с числами / кодами / деньгами — выравнивание по центру (ячеек и заголовков согласованно). */
const COLUMN_CENTER_KEYS = new Set([
  "code",
  "stock_position",
  "no_longer_cooperation",
  "stock",
  "stock_days",
  "vat",
  "vat_on_product",
  "buy_price",
  "automation_price",
  "packing_weight",
]);

const COLUMN_STYLES = {
  code: { minWidth: 75, width: 75, maxWidth: 75 },
  name: { minWidth: 320, whiteSpace: "normal", wordBreak: "break-word" },
  manager: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  content_manager: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  type: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  stock_position: { minWidth: 95, whiteSpace: "normal", wordBreak: "break-word" },
  no_longer_cooperation: { minWidth: 95, whiteSpace: "normal", wordBreak: "break-word" },
  stock: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  stock_days: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  price_comment: { minWidth: 220, whiteSpace: "normal", wordBreak: "break-word" },
  vat: { minWidth: 90, whiteSpace: "normal", wordBreak: "break-word" },
  vat_on_product: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  buy_price: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  supplier: { minWidth: 240, whiteSpace: "normal", wordBreak: "break-word" },
  supplier2: { minWidth: 240, whiteSpace: "normal", wordBreak: "break-word" },
  automation_price: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  packing_standard: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  packing_own_box: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  packing_weight: { minWidth: 110, whiteSpace: "normal", wordBreak: "break-word" },
  updated_label: { minWidth: 220, whiteSpace: "normal", wordBreak: "break-word" },
};
const getColStyle = (key) => {
  const merged = { ...DEFAULT_COL_STYLE, ...(COLUMN_STYLES[key] || {}) };
  if (COLUMN_CENTER_KEYS.has(key)) {
    return { ...merged, textAlign: "center", verticalAlign: "middle" };
  }
  return merged;
};

/** Класс на ячейке + SCSS (запасной вариант). Основное выравнивание — `numericInner`: внутренний div с Bootstrap `.text-center !important`. */
const numericCellProps = (key) =>
  COLUMN_CENTER_KEYS.has(key) ? { className: "dg-ms-numeric" } : {};

const numericInner = (key, children) =>
  COLUMN_CENTER_KEYS.has(key) ? (
    <div
      className="text-center w-100 dg-ms-numeric-inner d-block"
      style={{ fontVariantNumeric: "tabular-nums", boxSizing: "border-box" }}
    >
      {children}
    </div>
  ) : (
    children
  );
const getHeaderColStyle = (key, isSortable) => ({
  ...getColStyle(key),
  ...HEADER_COL_STYLE,
  cursor: isSortable ? "pointer" : "default",
});
const TABLE_COLUMNS = [
  ["code", "ID / КОД"],
  ["name", "Наименование товара"],
  ["manager", "Менеджер"],
  ["content_manager", "Контент-менеджер"],
  ["type", "Тип"],
  ["stock_position", "Склад. поз."],
  ["no_longer_cooperation", "Перестали сотруднич."],
  ["stock", "Остаток"],
  ["stock_days", "Дней на складе"],
  ["price_comment", "Проработка цены / коммент"],
  ["vat", "НДС"],
  ["vat_on_product", "НДС на товаре или комплекте"],
  ["buy_price", "Закуп. цена"],
  ["supplier", "Поставщик"],
  ["supplier2", "Поставщик 2"],
  ["automation_price", "Автоматизация цены"],
  ["packing_standard", "Упаковка (стандарт)"],
  ["packing_own_box", "Упаковка (своя коробка)"],
  ["packing_weight", "Вес с упаковкой"],
  ["updated_label", "Обновлено"],
];

const buildMoyskladCardUrl = (row) => {
  const code = String(row?.code || "").trim();
  if (!code) return "";
  return `https://online.moysklad.ru/app/#good?global_codeFilter=${encodeURIComponent(code)},equals`;
};
const buildMyProductsLinkedUrl = (row) => {
  const code = String(row?.code || "").trim();
  if (!code) return "";
  return `/my-products?site_id=all&status=all&ms_linked=1&search=${encodeURIComponent(code)}`;
};

/** Сайты из кэша связей (GROUP_CONCAT) — компактные бейджи под названием */
const MoyskladLinkedSites = ({ siteNames }) => {
  let raw = "";
  if (siteNames == null) raw = "";
  else if (typeof siteNames === "string") raw = siteNames;
  else if (Array.isArray(siteNames)) raw = siteNames.join(", ");
  else raw = String(siteNames);
  const sites = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sites.length) return null;
  return (
    <div className="mt-2 pt-1" style={{ borderTop: "1px solid #eef1f5" }}>
      <div className="d-flex flex-wrap align-items-center gap-2">
        <span className="text-muted" style={{ fontSize: "0.7rem", whiteSpace: "nowrap" }}>
          Связано с сайтами
        </span>
        <div className="d-flex flex-wrap gap-1">
          {sites.map((name, i) => (
            <span
              key={`site-${i}-${name.slice(0, 40)}`}
              className="badge rounded-pill bg-light text-secondary border text-truncate d-inline-block"
              style={{ fontSize: "0.72rem", fontWeight: 500, maxWidth: 260 }}
              title={name}
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

const syncUrlFromState = ({ filters, page, sortBy, sortDir }) => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === "all") return;
    if (k === "limit" && Number(v) === Number(initialFilters.limit)) return;
    if (String(v) === String(initialFilters[k])) return;
    params.set(k, String(v));
  });
  if (Number(page) > 1) params.set("page", String(page));
  if (sortBy !== "code") params.set("sort_by", sortBy);
  if (sortDir !== "asc") params.set("sort_dir", sortDir);
  const next = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState(null, "", next);
};

const MoyskladPage = () => {
  const filtersCollapsedKey = "datagon_moysklad_filters_collapsed_v1";
  const userColumnWidthKey = useMemo(() => {
    const user = String(window.localStorage.getItem("currentUser") || "guest").trim() || "guest";
    return `datagon_moysklad_col_widths_v1:${user}`;
  }, []);
  const [filters, setFilters] = useState(initialFilters);
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState(null);
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState("code");
  const [sortDir, setSortDir] = useState("asc");
  const [tableFilters, setTableFilters] = useState({
    code: "",
    name: "",
    supplier: "",
    supplier2: "",
    manager: "",
    content_manager: "",
    type: "all",
    stock_min: "",
    stock_max: "",
    archived: "all",
  });
  const [columnWidths, setColumnWidths] = useState({});
  const resizeRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = { ...initialFilters };
    const keys = [
      "limit",
      "type",
      "archived",
      "stock_position",
      "on_site",
      "search",
      "supplier",
      "supplier2",
      "manager",
      "content_manager",
      "only_stock",
      "no_coop",
      "has_buy_price",
      "has_price_comment",
      "has_automation",
    ];
    keys.forEach((k) => {
      const v = params.get(k);
      if (v === null || v === "") return;
      if (k === "limit") next[k] = Number(v);
      else next[k] = v;
    });
    const pageParam = Number(params.get("page") || 1);
    const sortByParam = params.get("sort_by");
    const sortDirParam = params.get("sort_dir");
    setFilters(next);
    if (Number.isFinite(pageParam) && pageParam > 0) setPage(pageParam);
    if (sortByParam && SORTABLE_FIELDS.includes(sortByParam)) setSortBy(sortByParam);
    if (sortDirParam === "asc" || sortDirParam === "desc") setSortDir(sortDirParam);
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(userColumnWidthKey) || "{}");
      if (saved && typeof saved === "object") setColumnWidths(saved);
    } catch (_) {}
  }, [userColumnWidthKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(userColumnWidthKey, JSON.stringify(columnWidths || {}));
    } catch (_) {}
  }, [columnWidths, userColumnWidthKey]);

  useEffect(() => {
    const onMouseMove = (e) => {
      const state = resizeRef.current;
      if (!state) return;
      const delta = e.clientX - state.startX;
      const nextWidth = Math.max(60, Math.min(700, Math.round(state.startWidth + delta)));
      setColumnWidths((prev) => ({ ...prev, [state.key]: nextWidth }));
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };
    const onMouseUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const totalPages = useMemo(() => {
    const p = Math.ceil(Number(total || 0) / Number(filters.limit || 100));
    return Math.max(1, p);
  }, [filters.limit, total]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/ms/status");
      if (!res.ok) return;
      const json = await res.json();
      setStatus(json);
    } catch (_) {
      // silent polling errors
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * Number(filters.limit || 100);
      const commonParams = {
        ...filters,
      };
      const [statsRes, exportRes] = await Promise.all([
        fetch(`/api/ms/stats${buildQuery(commonParams)}`),
        fetch(
          `/api/ms/export${buildQuery({
            ...commonParams,
            offset,
            sort_by: sortBy,
            sort_dir: sortDir,
          })}`
        ),
      ]);

      const statsJson = await statsRes.json().catch(() => ({}));
      const exportJson = await exportRes.json().catch(() => ({}));
      if (!statsRes.ok) throw new Error(statsJson.error || "Ошибка загрузки статистики");
      if (!exportRes.ok) throw new Error(exportJson.error || "Ошибка загрузки таблицы");

      setStats(statsJson);
      setRows(Array.isArray(exportJson.data) ? exportJson.data : []);
      setTotal(Number(exportJson.total || 0));
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить данные МойСклад");
    } finally {
      setLoading(false);
    }
  }, [filters, page, sortBy, sortDir]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    syncUrlFromState({ filters, page, sortBy, sortDir });
  }, [filters, page, sortBy, sortDir]);

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 2000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  const onFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const onApplyFilters = () => {
    setPage(1);
    loadData();
  };

  const onResetFilters = () => {
    setFilters(initialFilters);
    setSortBy("code");
    setSortDir("asc");
    setPage(1);
  };

  const runAction = async (url, message, options = {}) => {
    const method = options.method || "POST";
    try {
      const res = await fetch(url, { method });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка действия");
      toast.success(json.message || message);
      await Promise.all([loadStatus(), loadData()]);
    } catch (e) {
      toast.error(e.message || "Ошибка запроса");
    }
  };

  const onSort = (field) => {
    if (!SORTABLE_FIELDS.includes(field)) return;
    if (sortBy === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir("asc");
  };
  const copyPageLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Ссылка скопирована");
    } catch (_) {
      toast.error("Не удалось скопировать ссылку");
    }
  };
  const toggleFiltersCollapsed = () => {
    setFiltersCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(filtersCollapsedKey, next ? "1" : "0");
      } catch (_) {}
      return next;
    });
  };
  const startColumnResize = (e, key) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    const currentWidth = Number(columnWidths[key] || th?.getBoundingClientRect?.().width || getColStyle(key).minWidth || 120);
    resizeRef.current = {
      key,
      startX: e.clientX,
      startWidth: currentWidth,
    };
  };
  const getSizedColStyle = (key, isHeader = false, isSortable = false) => {
    const base = isHeader ? getHeaderColStyle(key, isSortable) : getColStyle(key);
    const w = Number(columnWidths[key] || 0);
    if (!Number.isFinite(w) || w <= 0) return base;
    return { ...base, width: w, minWidth: w, maxWidth: w };
  };

  const statusText = useMemo(() => {
    if (!status) return "Загрузка статуса...";
    const totalRows = Number(status.total || 0);
    const processedRows = Number(status.processed || 0);
    const percent = totalRows > 0 ? Math.round((processedRows / totalRows) * 100) : 0;
    if (status.active) {
      return `${status.message || "Синхронизация идет"} (${processedRows}/${totalRows}, ${percent}%)`;
    }
    return status.message || "Ожидание";
  }, [status]);
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (tableFilters.code && !String(r.code || "").toLowerCase().includes(String(tableFilters.code).trim().toLowerCase())) return false;
      if (tableFilters.name && !String(r.name || "").toLowerCase().includes(String(tableFilters.name).trim().toLowerCase())) return false;
      if (tableFilters.supplier && !String(r.supplier || "").toLowerCase().includes(String(tableFilters.supplier).trim().toLowerCase())) return false;
      if (tableFilters.supplier2 && !String(r.supplier2 || "").toLowerCase().includes(String(tableFilters.supplier2).trim().toLowerCase())) return false;
      if (tableFilters.manager && !String(r.manager || "").toLowerCase().includes(String(tableFilters.manager).trim().toLowerCase())) return false;
      if (tableFilters.content_manager && !String(r.content_manager || "").toLowerCase().includes(String(tableFilters.content_manager).trim().toLowerCase())) return false;
      if (tableFilters.type !== "all" && String(r.type || "").toLowerCase() !== String(tableFilters.type).toLowerCase()) return false;
      const stock = Number(r.stock || 0);
      const min = Number(tableFilters.stock_min || "");
      const max = Number(tableFilters.stock_max || "");
      if (Number.isFinite(min) && String(tableFilters.stock_min).trim() !== "" && stock < min) return false;
      if (Number.isFinite(max) && String(tableFilters.stock_max).trim() !== "" && stock > max) return false;
      const archived = Number(r.is_archived || 0) === 1 ? "1" : "0";
      if (tableFilters.archived !== "all" && archived !== tableFilters.archived) return false;
      return true;
    });
  }, [rows, tableFilters]);

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-shopbag icon-gradient bg-plum-plate"> </i>
            </div>
            <div>
              МойСклад
              {process.env.NODE_ENV === "development" ? (
                <span className="badge bg-secondary ms-2 align-middle" style={{ fontSize: "0.65rem", fontWeight: 600 }}>
                  webpack-dev
                </span>
              ) : null}
              <div className="page-title-subheading">
                Раздел предназначен для выгрузки и синхронизации с сервисом «МойСклад».
              </div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard
        title="Фильтры и действия"
        hint={statusText}
        actions={<button className="btn btn-sm btn-outline-secondary" onClick={toggleFiltersCollapsed}>{filtersCollapsed ? "Развернуть" : "Свернуть"}</button>}
      >
        {!filtersCollapsed ? (
        <>
        <div className="row g-2 align-items-end">
          <div className="col-md-4">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              placeholder={`sku:AB-12 "насос 25" | name:valtec`}
              value={filters.search}
              onChange={(e) => onFilterChange("search", e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">ID / КОД</label>
            <input className="form-control" value={tableFilters.code} onChange={(e) => setTableFilters((p) => ({ ...p, code: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Наименование товара</label>
            <input className="form-control" value={tableFilters.name} onChange={(e) => setTableFilters((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Тип</label>
            <select className="form-select" value={tableFilters.type} onChange={(e) => setTableFilters((p) => ({ ...p, type: e.target.value }))}>
              <option value="all">Все</option>
              <option value="товар">Товар</option>
              <option value="комплект">Комплект</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Архивные</label>
            <select className="form-select" value={tableFilters.archived} onChange={(e) => setTableFilters((p) => ({ ...p, archived: e.target.value }))}>
              <option value="all">Все</option>
              <option value="0">Активные</option>
              <option value="1">Архив</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Поставщик</label>
            <input className="form-control" value={tableFilters.supplier} onChange={(e) => setTableFilters((p) => ({ ...p, supplier: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Поставщик 2</label>
            <input className="form-control" value={tableFilters.supplier2} onChange={(e) => setTableFilters((p) => ({ ...p, supplier2: e.target.value }))} />
          </div>
        </div>
        <div className="row g-2 align-items-end mt-1">
          <div className="col-md-2">
            <label className="form-label">Менеджер</label>
            <input className="form-control" value={tableFilters.manager} onChange={(e) => setTableFilters((p) => ({ ...p, manager: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Контент-менеджер</label>
            <input className="form-control" value={tableFilters.content_manager} onChange={(e) => setTableFilters((p) => ({ ...p, content_manager: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Остаток от</label>
            <input className="form-control" type="number" value={tableFilters.stock_min} onChange={(e) => setTableFilters((p) => ({ ...p, stock_min: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Остаток до</label>
            <input className="form-control" type="number" value={tableFilters.stock_max} onChange={(e) => setTableFilters((p) => ({ ...p, stock_max: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Поставщик</label>
            <input
              className="form-control"
              value={filters.supplier}
              onChange={(e) => onFilterChange("supplier", e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Поставщик 2</label>
            <input
              className="form-control"
              value={filters.supplier2}
              onChange={(e) => onFilterChange("supplier2", e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Менеджер</label>
            <input
              className="form-control"
              value={filters.manager}
              onChange={(e) => onFilterChange("manager", e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Контент-менеджер</label>
            <input
              className="form-control"
              value={filters.content_manager}
              onChange={(e) => onFilterChange("content_manager", e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Тип</label>
            <select className="form-select" value={filters.type} onChange={(e) => onFilterChange("type", e.target.value)}>
              <option value="all">Все</option>
              <option value="Товар">Товары</option>
              <option value="Комплект">Комплекты</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Складская позиция</label>
            <select
              className="form-select"
              value={filters.stock_position}
              onChange={(e) => onFilterChange("stock_position", e.target.value)}
            >
              <option value="yes">Только Да</option>
              <option value="no">Только Нет</option>
              <option value="all">Все</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">На сайте</label>
            <select className="form-select" value={filters.on_site} onChange={(e) => onFilterChange("on_site", e.target.value)}>
              <option value="all">Все</option>
              <option value="1">Только есть</option>
              <option value="0">Только нет</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус</label>
            <select
              className="form-select"
              value={filters.archived}
              onChange={(e) => onFilterChange("archived", e.target.value)}
            >
              <option value="active">Активные</option>
              <option value="archived">Архивные</option>
              <option value="all">Все</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">На странице</label>
            <select
              className="form-select"
              value={filters.limit}
              onChange={(e) => onFilterChange("limit", Number(e.target.value || 100))}
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
          </div>
        </div>
        <div className="mt-3 d-flex flex-wrap gap-3">
          <div className="form-check">
            <input
              id="only_stock"
              className="form-check-input"
              type="checkbox"
              checked={filters.only_stock === "1"}
              onChange={(e) => onFilterChange("only_stock", e.target.checked ? "1" : "0")}
            />
            <label className="form-check-label" htmlFor="only_stock">Только с остатком &gt; 0</label>
          </div>
          <div className="form-check">
            <input
              id="no_coop"
              className="form-check-input"
              type="checkbox"
              checked={filters.no_coop === "1"}
              onChange={(e) => onFilterChange("no_coop", e.target.checked ? "1" : "0")}
            />
            <label className="form-check-label" htmlFor="no_coop">Перестали сотрудничать</label>
          </div>
          <div className="form-check">
            <input
              id="has_buy_price"
              className="form-check-input"
              type="checkbox"
              checked={filters.has_buy_price === "1"}
              onChange={(e) => onFilterChange("has_buy_price", e.target.checked ? "1" : "0")}
            />
            <label className="form-check-label" htmlFor="has_buy_price">Только с закупочной ценой</label>
          </div>
        </div>
        <div className="mt-3 d-flex flex-wrap gap-2">
          <button id="moysklad-apply" className="btn btn-sm btn-primary" onClick={onApplyFilters} disabled={loading}><i className="pe-7s-search me-1" />Применить</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-apply">Применить фильтры к выгрузке</UncontrolledTooltip>
          <button id="moysklad-reset" className="btn btn-sm btn-outline-secondary" onClick={onResetFilters} disabled={loading}><i className="pe-7s-refresh me-1" />Сбросить</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-reset">Сбросить фильтры и сортировку</UncontrolledTooltip>
          <button id="moysklad-sync" className="btn btn-sm btn-outline-success" onClick={() => runAction("/api/ms/sync", "Синхронизация запущена")} disabled={Boolean(status?.active)}>
            <i className="pe-7s-play me-1" />Запустить синхронизацию
          </button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-sync">Запустить синхронизацию МойСклад</UncontrolledTooltip>
          <button id="moysklad-stop" className="btn btn-sm btn-outline-warning" onClick={() => runAction("/api/ms/stop", "Остановка запрошена")} disabled={!Boolean(status?.active)}>
            <i className="pe-7s-close-circle me-1" />Остановить
          </button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-stop">Остановить текущую синхронизацию</UncontrolledTooltip>
          <button id="moysklad-rebuild-cache" className="btn btn-sm btn-outline-info" onClick={() => runAction("/api/ms/rebuild-links-cache", "Кэш связей перестроен")}>
            <i className="pe-7s-refresh-2 me-1" />Перестроить кэш связей
          </button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-rebuild-cache">Перестроить кэш связей с товарами сайта</UncontrolledTooltip>
          <button id="moysklad-refresh" className="btn btn-sm btn-outline-primary" onClick={loadData} disabled={loading}><i className="pe-7s-refresh me-1" />Обновить</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-refresh">Обновить таблицу и статистику</UncontrolledTooltip>
          <button id="moysklad-copy-link" className="btn btn-sm btn-outline-dark" onClick={copyPageLink}><i className="pe-7s-link me-1" />Скопировать ссылку</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="moysklad-copy-link">Скопировать ссылку на текущую страницу</UncontrolledTooltip>
        </div>
        </>
        ) : null}
      </DatagonCard>

      <div className="row">
        <div className="col-md-4">
          <div className="card mb-3 card-body text-center">
            <div className="text-muted"><i className="pe-7s-menu me-1" />Всего в выборке</div>
            <h3 className="mb-0" style={{ fontVariantNumeric: "tabular-nums" }}>{formatNumber(stats?.total)}</h3>
          </div>
        </div>
        <div className="col-md-4">
          <div className="card mb-3 card-body text-center">
            <div className="text-muted"><i className="pe-7s-box1 me-1" />Товары / Комплекты</div>
            <h3 className="mb-0" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatNumber(stats?.products)} / {formatNumber(stats?.bundles)}
            </h3>
          </div>
        </div>
        <div className="col-md-4">
          <div className="card mb-3 card-body text-center">
            <div className="text-muted"><i className="pe-7s-cash me-1" />Сумма остатков</div>
            <h3 className="mb-0" style={{ fontVariantNumeric: "tabular-nums" }}>{formatMoneyText(stats?.inventory_value)}</h3>
          </div>
        </div>
      </div>

      <DatagonCard title="Выгрузка МойСклад" hint={`Найдено: ${formatNumber(total)}; страница ${page}/${totalPages}`}>
        <div style={{ width: "100%", maxWidth: "100%", overflowX: "hidden", overflowY: "visible" }}>
          <div
            className="table-responsive datagon-my-products-table-wrap"
            style={{
              display: "block",
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              overflowX: "auto",
              overflowY: "visible",
              position: "relative",
              WebkitOverflowScrolling: "touch",
            }}
          >
          <table className="table table-hover table-striped mb-0 datagon-my-products-table dg-ms-table" style={{ width: "max-content", minWidth: 2200, maxWidth: "none", tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                {TABLE_COLUMNS.map(([key, label]) => (
                  <th
                    key={key}
                    {...numericCellProps(key)}
                    style={{
                      ...getSizedColStyle(key, true, SORTABLE_FIELDS.includes(key)),
                      position: "sticky",
                      top: 64,
                      zIndex: 30,
                      background: "#f8f9fa",
                      borderRight: "1px solid #e6e9ee",
                    }}
                    onClick={() => onSort(key)}
                  >
                    {numericInner(key, (
                      <>
                        {label} {sortBy === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                      </>
                    ))}
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      title="Потяните, чтобы изменить ширину"
                      onMouseDown={(e) => startColumnResize(e, key)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        width: 6,
                        height: "100%",
                        cursor: "col-resize",
                        zIndex: 4,
                        background: "linear-gradient(to right, transparent 47%, #d9dee5 47%, #d9dee5 53%, transparent 53%)",
                        opacity: 0.55,
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan="20" className="text-muted">
                    {loading ? "Загрузка..." : "Нет данных"}
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => (
                  <tr key={`${r.code}-${r.uuid || ""}`} className={Number(r.is_archived) === 1 ? "table-danger" : ""}>
                    <td {...numericCellProps("code")} style={{ ...getSizedColStyle("code"), borderRight: "1px solid #f3f5f8" }}>{numericInner("code", r.code)}</td>
                    <td style={{ ...getSizedColStyle("name"), borderRight: "1px solid #f3f5f8" }}>
                      {Number(r.is_archived) === 1 && <span className="badge bg-danger me-1">Архив</span>}
                      {buildMoyskladCardUrl(r) ? (
                        <a href={buildMoyskladCardUrl(r)} target="_blank" rel="noopener noreferrer" className="text-decoration-none text-body">
                          <span style={{ whiteSpace: "normal", wordBreak: "break-word" }} title={r.name || ""}>{r.name}</span>
                        </a>
                      ) : (
                        <span style={{ whiteSpace: "normal", wordBreak: "break-word" }} title={r.name || ""}>{r.name}</span>
                      )}
                      {Number(r.in_my_products || 0) === 1 && (
                        <a
                          href={buildMyProductsLinkedUrl(r)}
                          className="ms-2 small text-decoration-none"
                          title={
                            r.site_names
                              ? `Открыть в Мои товары: ${String(r.site_names)}`
                              : `Открыть в Мои товары (код ${r.code || "-"})`
                          }
                        >
                          [Мои товары]
                        </a>
                      )}
                      <MoyskladLinkedSites siteNames={r.site_names} />
                    </td>
                    <td style={{ ...getSizedColStyle("manager"), borderRight: "1px solid #f3f5f8" }}>{r.manager || "-"}</td>
                    <td style={{ ...getSizedColStyle("content_manager"), borderRight: "1px solid #f3f5f8" }}>{r.content_manager || "-"}</td>
                    <td style={{ ...getSizedColStyle("type"), borderRight: "1px solid #f3f5f8" }}>{r.type}</td>
                    <td {...numericCellProps("stock_position")} style={{ ...getSizedColStyle("stock_position"), borderRight: "1px solid #f3f5f8" }}>
                      {numericInner(
                        "stock_position",
                        String(r.stock_position || "").toLowerCase() === "да" ? (
                          <span className="badge bg-success">Да</span>
                        ) : (
                          <span className="badge bg-secondary">{r.stock_position || "-"}</span>
                        ),
                      )}
                    </td>
                    <td {...numericCellProps("no_longer_cooperation")} style={{ ...getSizedColStyle("no_longer_cooperation"), borderRight: "1px solid #f3f5f8" }}>
                      {numericInner("no_longer_cooperation", r.no_longer_cooperation || "-")}
                    </td>
                    <td {...numericCellProps("stock")} style={{ ...getSizedColStyle("stock"), borderRight: "1px solid #f3f5f8" }}>{numericInner("stock", formatNumber(r.stock))}</td>
                    <td {...numericCellProps("stock_days")} style={{ ...getSizedColStyle("stock_days"), borderRight: "1px solid #f3f5f8" }}>{numericInner("stock_days", r.stock_days)}</td>
                    <td style={{ ...getSizedColStyle("price_comment"), borderRight: "1px solid #f3f5f8" }}>
                      <span style={CLAMP_2_STYLE} title={r.price_comment || ""}>
                        {r.price_comment || "-"}
                      </span>
                    </td>
                    <td {...numericCellProps("vat")} style={{ ...getSizedColStyle("vat"), borderRight: "1px solid #f3f5f8" }}>{numericInner("vat", r.vat || "-")}</td>
                    <td {...numericCellProps("vat_on_product")} style={{ ...getSizedColStyle("vat_on_product"), borderRight: "1px solid #f3f5f8" }}>
                      {numericInner("vat_on_product", r.vat_on_product || "-")}
                    </td>
                    <td {...numericCellProps("buy_price")} style={{ ...getSizedColStyle("buy_price"), borderRight: "1px solid #f3f5f8" }}>{numericInner("buy_price", formatMoneyText(r.buy_price))}</td>
                    <td style={{ ...getSizedColStyle("supplier"), borderRight: "1px solid #f3f5f8" }}>{r.supplier || "-"}</td>
                    <td style={{ ...getSizedColStyle("supplier2"), borderRight: "1px solid #f3f5f8" }}>{r.supplier2 || "-"}</td>
                    <td {...numericCellProps("automation_price")} style={{ ...getSizedColStyle("automation_price"), borderRight: "1px solid #f3f5f8" }}>
                      {numericInner("automation_price", r.automation_price || "-")}
                    </td>
                    <td style={{ ...getSizedColStyle("packing_standard"), borderRight: "1px solid #f3f5f8" }}>{r.packing_standard || "-"}</td>
                    <td style={{ ...getSizedColStyle("packing_own_box"), borderRight: "1px solid #f3f5f8" }}>{r.packing_own_box || "-"}</td>
                    <td {...numericCellProps("packing_weight")} style={{ ...getSizedColStyle("packing_weight"), borderRight: "1px solid #f3f5f8" }}>
                      {numericInner("packing_weight", r.packing_weight || "-")}
                    </td>
                    <td style={{ ...getSizedColStyle("updated_label"), borderRight: "1px solid #f3f5f8" }}>{r.updated_label}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>
        </div>
        <div className="mt-3 d-flex justify-content-between align-items-center">
          <div className="text-muted">
            Всего: {formatNumber(total)}
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Назад
            </button>
            <button
              className="btn btn-sm btn-outline-secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Вперед
            </button>
          </div>
        </div>
      </DatagonCard>
    </div>
  );
};

export default MoyskladPage;
