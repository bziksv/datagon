import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const initialFilters = {
  site_id: "all",
  status: "all",
  source_enabled: "all",
  ms_linked: "all",
  sort_by: "id",
  sort_dir: "asc",
  search: "",
  match_audit: "all",
  gap_filter_enabled: "0",
  gap_exclude_zero: "1",
  gap_competitor: "all",
  gap_min_pct: "-100",
  gap_max_pct: "100",
  usd_to_rub: "",
  eur_to_rub: "",
  comp_sync_rand_min: "0.1",
  comp_sync_rand_max: "1",
  stock_min: "",
  stock_max: "",
  limit: 30,
  offset: 0,
};
const SORT_STORAGE_VERSION = "v1";
const SORTABLE_COLUMNS = [
  { value: "id", label: "ID / КОД" },
  { value: "site", label: "Сайт" },
  { value: "sku", label: "Артикул (SKU)" },
  { value: "name", label: "Название" },
  { value: "price", label: "Цена" },
  { value: "dealmed_price", label: "Цена ДМ" },
  { value: "medkompleks_price", label: "Цена МК" },
  { value: "currency", label: "Валюта" },
  { value: "stock", label: "Остаток" },
  { value: "status", label: "Статус" },
  { value: "updated", label: "Обновлен" },
];

const buildQuery = (params) => {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === "all") return;
    s.set(k, String(v));
  });
  const q = s.toString();
  return q ? `?${q}` : "";
};
const formatNumber = (value) => Number(value || 0).toLocaleString("ru-RU");
const formatRuDateTime = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("ru-RU");
};
const formatFxUpdatedLabel = (value) => {
  if (!value) return "неизвестно";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "неизвестно";
  return d.toLocaleString("ru-RU");
};
const formatMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const buildSiteUrl = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (!/[a-z0-9-]+\.[a-z]{2,}/i.test(v)) return "";
  return `https://${v}`;
};
const normalizeSiteProductUrl = (rawUrl, site) => {
  const direct = buildSiteUrl(rawUrl);
  if (!direct) return "";
  const isWebasyst = String(site?.cms_type || "").toLowerCase() === "webasyst";
  if (!isWebasyst) return direct;
  try {
    const u = new URL(direct);
    const path = String(u.pathname || "/");
    if (!path.startsWith("/product/")) {
      const slug = path.replace(/^\/+/, "").replace(/\/+$/, "");
      if (slug) u.pathname = `/product/${slug}/`;
    } else if (!path.endsWith("/")) {
      u.pathname = `${path}/`;
    }
    return u.toString();
  } catch (_) {
    return direct;
  }
};
const safeLink = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return "";
};
const buildWebasystEditUrl = (site, sourceId) => {
  const id = String(sourceId || "").trim();
  if (!id) return "";
  if (String(site?.cms_type || "").toLowerCase() !== "webasyst") return "";
  const cleanDomain = String(site?.domain || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!cleanDomain) return "";
  return `https://${cleanDomain}/webasyst/shop/?action=products#/product/${encodeURIComponent(id)}/edit/`;
};
const toRubValue = (price, currency, usdRub, eurRub) => {
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  const cur = String(currency || "RUB").trim().toUpperCase();
  if (cur === "RUB" || cur === "RUR" || cur === "₽") return n;
  if (cur === "USD" || cur === "$") return n * Number(usdRub || 90);
  if (cur === "EUR" || cur === "€") return n * Number(eurRub || 100);
  return n;
};
const formatDeviationPct = (myPrice, myCurrency, compPrice, compCurrency, usdRub, eurRub) => {
  const myRub = toRubValue(myPrice, myCurrency, usdRub, eurRub);
  const compRub = toRubValue(compPrice, compCurrency, usdRub, eurRub);
  if (!Number.isFinite(myRub) || !Number.isFinite(compRub) || compRub <= 0) return "н/д";
  const pct = ((myRub - compRub) / compRub) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
};
const formatBasePriceWithRub = (price, currency, usdRub, eurRub) => {
  const cur = String(currency || "RUB").toUpperCase();
  const base = formatMoney(price);
  const rub = toRubValue(price, cur, usdRub, eurRub);
  if (!Number.isFinite(rub)) return { baseText: `${base} ${cur}`, rubText: "" };
  if (cur === "RUB" || cur === "RUR" || cur === "₽") return { baseText: `${base} ${cur}`, rubText: "" };
  return { baseText: `${base} ${cur}`, rubText: `≈ ${formatMoney(rub)} RUB` };
};
const deviationClass = (devText) => {
  const v = String(devText || "").trim();
  if (!v || v === "н/д") return "text-muted";
  if (v.startsWith("-")) return "text-success";
  if (v.startsWith("+")) return "text-danger";
  return "text-muted";
};
const buildMoyskladSearchLink = (code) => {
  const value = String(code || "").trim();
  if (!value) return "";
  return `/moysklad?search=${encodeURIComponent(`code:${value}`)}&page=1`;
};
const parseSmartSearch = (raw) => {
  const out = { site: "", status: "", search: "" };
  const tokens = (raw || "").trim().match(/"[^"]+"|\S+/g) || [];
  const free = [];
  tokens.forEach((token) => {
    const idx = token.indexOf(":");
    if (idx > 0) {
      const key = token.slice(0, idx).toLowerCase();
      let value = token.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key === "site" || key === "site_id") out.site = value;
      else if (key === "status") out.status = value;
      else if (key === "code" || key === "sku" || key === "name" || key === "id") free.push(value);
      else free.push(token);
    } else {
      free.push(token.replace(/^"(.*)"$/, "$1"));
    }
  });
  out.search = free.join(" ").trim();
  return out;
};
const syncUrlFromFilters = (filters) => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === "all") return;
    if (k === "limit" && Number(v) === Number(initialFilters.limit)) return;
    if (k === "offset" && Number(v) === 0) return;
    params.set(k, String(v));
  });
  const next = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState(null, "", next);
};

const MyProductsPage = () => {
  const filtersCollapsedKey = "datagon_my_products_filters_collapsed_v1";
  const [filters, setFilters] = useState(initialFilters);
  const [sites, setSites] = useState([]);
  const [stats, setStats] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fx, setFx] = useState({ usd_to_rub: 0, eur_to_rub: 0 });
  const [fxUpdatedAt, setFxUpdatedAt] = useState(null);
  const [smartSearch, setSmartSearch] = useState("");
  const [tableFilters, setTableFilters] = useState({
    source_id: "",
    site_name: "",
    sku: "",
    name: "",
    currency: "all",
    stock_min: "",
    stock_max: "",
    active: "all",
  });
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });
  const userSortStorageKey = useMemo(() => {
    const user = String(window.localStorage.getItem("currentUser") || "guest").trim() || "guest";
    return `datagon_my_products_sort_${SORT_STORAGE_VERSION}:${user}`;
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = { ...initialFilters };
    const keys = [
      "site_id", "status", "source_enabled", "ms_linked", "sort_by", "sort_dir", "search",
      "match_audit", "gap_filter_enabled", "gap_exclude_zero", "gap_competitor", "gap_min_pct", "gap_max_pct",
      "usd_to_rub", "eur_to_rub", "comp_sync_rand_min", "comp_sync_rand_max",
      "stock_min", "stock_max", "limit", "offset"
    ];
    keys.forEach((k) => {
      const v = params.get(k);
      if (v === null || v === "") return;
      if (k === "limit" || k === "offset") next[k] = Number(v);
      else next[k] = v;
    });
    if (!params.get("sort_by") || !params.get("sort_dir")) {
      try {
        const saved = JSON.parse(window.localStorage.getItem(userSortStorageKey) || "{}");
        if (saved.sort_by) next.sort_by = String(saved.sort_by);
        if (saved.sort_dir === "asc" || saved.sort_dir === "desc") next.sort_dir = saved.sort_dir;
      } catch (_) {}
    }
    setFilters(next);
  }, [userSortStorageKey]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sitesRes, statsRes, productsRes, fxRes] = await Promise.all([
        fetch(`/api/my-sites`),
        fetch(`/api/my-products/stats${buildQuery({
          site_id: filters.site_id,
          status: filters.status,
          source_enabled: filters.source_enabled,
          ms_linked: filters.ms_linked,
          stock_min: filters.stock_min,
          stock_max: filters.stock_max,
        })}`),
        fetch(`/api/my-products${buildQuery(filters)}`),
        fetch(`/api/my-products/fx-rates`),
      ]);

      if (!sitesRes.ok || !statsRes.ok || !productsRes.ok || !fxRes.ok) {
        throw new Error("Ошибка загрузки данных");
      }

      const [sitesJson, statsJson, productsJson, fxJson] = await Promise.all([
        sitesRes.json(),
        statsRes.json(),
        productsRes.json(),
        fxRes.json(),
      ]);

      setSites(Array.isArray(sitesJson) ? sitesJson : []);
      setStats(Array.isArray(statsJson) ? statsJson : []);
      setRows(Array.isArray(productsJson.data) ? productsJson.data : []);
      setTotal(Number(productsJson.total || 0));
      setFx({
        usd_to_rub: Number(fxJson.usd_to_rub || 0),
        eur_to_rub: Number(fxJson.eur_to_rub || 0),
      });
      setFxUpdatedAt(fxJson.updated_at || fxJson.updatedAt || new Date().toISOString());
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    syncUrlFromFilters(filters);
  }, [filters]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        userSortStorageKey,
        JSON.stringify({ sort_by: filters.sort_by, sort_dir: filters.sort_dir }),
      );
    } catch (_) {}
  }, [filters.sort_by, filters.sort_dir, userSortStorageKey]);

  const totals = useMemo(() => {
    return stats.reduce(
      (acc, s) => {
        acc.total += Number(s.total || 0);
        acc.linked += Number(s.linked || 0);
        acc.disabled += Number(s.disabled || 0);
        acc.disappeared += Number(s.disappeared || 0);
        return acc;
      },
      { total: 0, linked: 0, disabled: 0, disappeared: 0 }
    );
  }, [stats]);
  const unlinkedTotal = useMemo(
    () => Math.max(0, Number(totals.total || 0) - Number(totals.linked || 0)),
    [totals.total, totals.linked]
  );
  const selectedSiteName = useMemo(() => {
    if (!filters.site_id || filters.site_id === "all") return "";
    const found = sites.find((s) => String(s.id) === String(filters.site_id));
    return found?.name ? String(found.name) : "";
  }, [filters.site_id, sites]);
  const siteNameById = useMemo(() => {
    const map = {};
    sites.forEach((s) => {
      map[String(s.id)] = s.name || `#${s.id}`;
    });
    return map;
  }, [sites]);
  const siteById = useMemo(() => {
    const map = {};
    sites.forEach((s) => {
      map[String(s.id)] = s;
    });
    return map;
  }, [sites]);
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      const siteName = String(siteNameById[String(r.site_id)] || "");
      if (tableFilters.source_id && !String(r.source_id || "").includes(String(tableFilters.source_id).trim())) return false;
      if (tableFilters.site_name && !siteName.toLowerCase().includes(String(tableFilters.site_name).trim().toLowerCase())) return false;
      if (tableFilters.sku && !String(r.sku || "").toLowerCase().includes(String(tableFilters.sku).trim().toLowerCase())) return false;
      if (tableFilters.name && !String(r.name || "").toLowerCase().includes(String(tableFilters.name).trim().toLowerCase())) return false;
      if (tableFilters.currency !== "all" && String(r.currency || "").toUpperCase() !== String(tableFilters.currency).toUpperCase()) return false;
      const stock = Number(r.stock || 0);
      const min = Number(tableFilters.stock_min || "");
      const max = Number(tableFilters.stock_max || "");
      if (Number.isFinite(min) && String(tableFilters.stock_min).trim() !== "" && stock < min) return false;
      if (Number.isFinite(max) && String(tableFilters.stock_max).trim() !== "" && stock > max) return false;
      const isActive = Number(r.is_active) ? "1" : "0";
      if (tableFilters.active !== "all" && isActive !== tableFilters.active) return false;
      return true;
    });
  }, [rows, tableFilters, siteNameById]);

  const onFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };
  const onApply = () => {
    setFilters((prev) => ({ ...prev, offset: 0 }));
  };
  const setSort = (sortBy) => {
    setFilters((prev) => {
      const sameColumn = prev.sort_by === sortBy;
      const nextDir = sameColumn ? (prev.sort_dir === "asc" ? "desc" : "asc") : "asc";
      return { ...prev, sort_by: sortBy, sort_dir: nextDir, offset: 0 };
    });
  };
  const renderSortArrow = (sortBy) => {
    if (filters.sort_by !== sortBy) return " ↕";
    return filters.sort_dir === "asc" ? " ↑" : " ↓";
  };

  const onApplySmartSearch = () => {
    const parsed = parseSmartSearch(smartSearch);
    setFilters((prev) => {
      const next = { ...prev, offset: 0 };
      if (parsed.site && sites.some((s) => String(s.id) === String(parsed.site))) next.site_id = String(parsed.site);
      if (parsed.status) {
        const statusVal = parsed.status.toLowerCase();
        if (statusVal === "active" || statusVal === "1") next.status = "1";
        else if (statusVal === "inactive" || statusVal === "hidden" || statusVal === "0") next.status = "0";
      }
      if (parsed.search) next.search = parsed.search;
      return next;
    });
  };

  const onRefreshOne = async (row) => {
    try {
      const res = await fetch("/api/my-products/refresh-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_id: Number(row.site_id),
          sku: row.sku || undefined,
          source_id: row.source_id || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "refresh-one failed");
      toast.success("Товар обновлен");
      loadData();
    } catch (e) {
      toast.error(e.message || "Ошибка refresh-one");
    }
  };

  const onSyncPrice = async (row) => {
    const min = filters.comp_sync_rand_min || "0.1";
    const max = filters.comp_sync_rand_max || "1";
    try {
      const res = await fetch("/api/my-products/sync-price-from-competitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_id: Number(row.site_id),
          sku: row.sku,
          source_id: row.source_id || undefined,
          random_min_pct: Number(String(min || "-5").replace(",", ".")),
          random_max_pct: Number(String(max || "0").replace(",", ".")),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || json.message || "sync-price failed");
      const target = json?.data?.target_price;
      const currency = json?.data?.target_currency || row.currency || "RUB";
      const source = json?.data?.competitor_source ? ` (${json.data.competitor_source})` : "";
      toast.success(
        Number.isFinite(Number(target))
          ? `Цена синхронизирована: ${Number(target).toLocaleString("ru-RU")} ${currency}${source}`
          : "Синхронизация цены отправлена"
      );
      await loadData();
    } catch (e) {
      toast.error(e.message || "Ошибка sync-price");
    }
  };

  const runAction = async (url, successText) => {
    try {
      const res = await fetch(url, { method: url.includes("fx-rates") ? "GET" : "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Action failed");
      toast.success(successText);
      loadData();
    } catch (e) {
      toast.error(e.message || "Ошибка действия");
    }
  };
  const runActionWithBody = async (url, body, successText) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Action failed");
      toast.success(successText);
      loadData();
    } catch (e) {
      toast.error(e.message || "Ошибка действия");
    }
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
  const hasConcreteSiteSelected = String(filters.site_id || "") !== "all";

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-box2 icon-gradient bg-tempting-azure"> </i>
            </div>
            <div>
              Мои товары
              <div className="page-title-subheading">
                {selectedSiteName
                  ? `Управление товарами с сайта ${selectedSiteName}, связями с МойСклад и синхронизацией цен.`
                  : "Управление товарами, связями с МойСклад и синхронизацией цен."}
              </div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard
        title="Фильтры и действия"
        hint={`FX: USD ${fx.usd_to_rub.toFixed(2)} | EUR ${fx.eur_to_rub.toFixed(2)} | Обновлен: ${formatFxUpdatedLabel(fxUpdatedAt)}`}
        actions={<button className="btn btn-sm btn-outline-secondary" onClick={toggleFiltersCollapsed}>{filtersCollapsed ? "Развернуть" : "Свернуть"}</button>}
      >
        {!filtersCollapsed ? (
        <>
        <div className="row g-2">
          <div className="col-md-6">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={smartSearch}
              onChange={(e) => setSmartSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onApplySmartSearch(); }}
              placeholder={`code:123 sku:ABC-12 name:"насос 25" или просто текст`}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Сайт</label>
            <select className="form-select" value={filters.site_id} onChange={(e) => onFilterChange("site_id", e.target.value)}>
              <option value="all">Все сайты</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name || `#${s.id}`}</option>
              ))}
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус</label>
            <select className="form-select" value={filters.status} onChange={(e) => onFilterChange("status", e.target.value)}>
              <option value="all">Все</option><option value="1">Активные</option><option value="0">Неактивные</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Связь с МС</label>
            <select className="form-select" value={filters.ms_linked} onChange={(e) => onFilterChange("ms_linked", e.target.value)}>
              <option value="all">Все</option><option value="1">Только связанные</option><option value="0">Только без связи</option>
            </select>
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-2">
            <label className="form-label">ID / КОД</label>
            <input className="form-control" value={tableFilters.source_id} onChange={(e) => setTableFilters((p) => ({ ...p, source_id: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Сайт (таблица)</label>
            <input className="form-control" value={tableFilters.site_name} onChange={(e) => setTableFilters((p) => ({ ...p, site_name: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">SKU (таблица)</label>
            <input className="form-control" value={tableFilters.sku} onChange={(e) => setTableFilters((p) => ({ ...p, sku: e.target.value }))} />
          </div>
          <div className="col-md-3">
            <label className="form-label">Название (таблица)</label>
            <input className="form-control" value={tableFilters.name} onChange={(e) => setTableFilters((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Валюта</label>
            <select className="form-select" value={tableFilters.currency} onChange={(e) => setTableFilters((p) => ({ ...p, currency: e.target.value }))}>
              <option value="all">Все</option>
              <option value="RUB">RUB</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Остаток от</label>
            <input className="form-control" type="number" value={tableFilters.stock_min} onChange={(e) => setTableFilters((p) => ({ ...p, stock_min: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Остаток до</label>
            <input className="form-control" type="number" value={tableFilters.stock_max} onChange={(e) => setTableFilters((p) => ({ ...p, stock_max: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус тбл</label>
            <select className="form-select" value={tableFilters.active} onChange={(e) => setTableFilters((p) => ({ ...p, active: e.target.value }))}>
              <option value="all">Все</option>
              <option value="1">Активен</option>
              <option value="0">Неактивен</option>
            </select>
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-2">
            <label className="form-label">Остаток от</label>
            <input className="form-control" type="number" value={filters.stock_min} onChange={(e) => onFilterChange("stock_min", e.target.value)} placeholder="0" />
          </div>
          <div className="col-md-2">
            <label className="form-label">Остаток до</label>
            <input className="form-control" type="number" value={filters.stock_max} onChange={(e) => onFilterChange("stock_max", e.target.value)} placeholder="1000" />
          </div>
          <div className="col-md-2">
            <label className="form-label">На сайте (вкл/выкл)</label>
            <select className="form-select" value={filters.source_enabled} onChange={(e) => onFilterChange("source_enabled", e.target.value)}>
              <option value="all">Все</option><option value="1">Да</option><option value="0">Нет</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Лимит</label>
            <input className="form-control" type="number" min="1" value={filters.limit} onChange={(e) => onFilterChange("limit", Number(e.target.value || 30))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус сопоставления</label>
            <select className="form-select" value={filters.match_audit} onChange={(e) => onFilterChange("match_audit", e.target.value)}>
              <option value="all">Все</option>
              <option value="confirmed">Только подтверждено</option>
              <option value="unlinked">Только разорвано</option>
              <option value="none">Без действий</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Сортировать по</label>
            <select className="form-select" value={filters.sort_by} onChange={(e) => onFilterChange("sort_by", e.target.value)}>
              {SORTABLE_COLUMNS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Направление</label>
            <select className="form-select" value={filters.sort_dir} onChange={(e) => onFilterChange("sort_dir", e.target.value)}>
              <option value="asc">По возрастанию</option>
              <option value="desc">По убыванию</option>
            </select>
          </div>
          <div className="col-md-2 d-flex align-items-end">
            <button id="myproducts-apply" className="btn btn-sm btn-primary" style={{ height: 38 }} onClick={onApply} disabled={loading}>Применить</button>
            <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-apply">Применить текущие фильтры и обновить таблицу</UncontrolledTooltip>
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-3 d-flex align-items-end">
            <label className="form-check mb-0">
              <input
                className="form-check-input me-1"
                type="checkbox"
                checked={filters.gap_filter_enabled === "1"}
                onChange={(e) => onFilterChange("gap_filter_enabled", e.target.checked ? "1" : "0")}
              />
              Включить фильтр расхождения
            </label>
          </div>
          <div className="col-md-3 d-flex align-items-end">
            <label className="form-check mb-0">
              <input
                className="form-check-input me-1"
                type="checkbox"
                checked={filters.gap_exclude_zero !== "0"}
                onChange={(e) => onFilterChange("gap_exclude_zero", e.target.checked ? "1" : "0")}
              />
              Не показывать Δ 0%
            </label>
          </div>
          <div className="col-md-2">
            <label className="form-label">Конкурент (Δ)</label>
            <select className="form-select" value={filters.gap_competitor} onChange={(e) => onFilterChange("gap_competitor", e.target.value)}>
              <option value="all">Любой (ДМ/МК)</option>
              <option value="dealmed">Деалмед</option>
              <option value="medkompleks">Медкомплекс</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Δ % от</label>
            <input className="form-control" type="number" step="0.01" value={filters.gap_min_pct} onChange={(e) => onFilterChange("gap_min_pct", e.target.value)} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Δ % до</label>
            <input className="form-control" type="number" step="0.01" value={filters.gap_max_pct} onChange={(e) => onFilterChange("gap_max_pct", e.target.value)} />
          </div>
          <div className="col-md-1">
            <label className="form-label">USD-&gt;RUB</label>
            <input className="form-control" type="number" step="0.01" value={filters.usd_to_rub} onChange={(e) => onFilterChange("usd_to_rub", e.target.value)} />
          </div>
          <div className="col-md-1">
            <label className="form-label">EUR-&gt;RUB</label>
            <input className="form-control" type="number" step="0.01" value={filters.eur_to_rub} onChange={(e) => onFilterChange("eur_to_rub", e.target.value)} />
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-2">
            <label className="form-label">Синх. % мин</label>
            <input className="form-control" value={filters.comp_sync_rand_min} onChange={(e) => onFilterChange("comp_sync_rand_min", e.target.value)} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Синх. % макс</label>
            <input className="form-control" value={filters.comp_sync_rand_max} onChange={(e) => onFilterChange("comp_sync_rand_max", e.target.value)} />
          </div>
          <div className="col-md-8" />
        </div>
        <div className="mt-3 d-flex flex-wrap gap-2">
          <button id="myproducts-fx" className="btn btn-sm btn-outline-secondary" onClick={() => runAction("/api/my-products/fx-rates?force=1", "Курс обновлен")}><i className="pe-7s-refresh-2 me-1" />Обновить курс</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-fx">Принудительно обновить валютные курсы</UncontrolledTooltip>
          <button id="myproducts-syncall" className="btn btn-sm btn-outline-primary" onClick={() => runAction("/api/sync-all-start", "Синхронизация запущена")}><i className="pe-7s-repeat me-1" />Синхронизировать все</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-syncall">Запустить синхронизацию товаров по всем сайтам</UncontrolledTooltip>
          <span id="myproducts-sync-selected-site-wrap" className="d-inline-flex">
            <button
              className="btn btn-sm btn-outline-primary"
              disabled={!hasConcreteSiteSelected}
              onClick={() => runActionWithBody("/api/sync-site-start", { site_id: Number(filters.site_id) }, "Синхронизация выбранного сайта запущена")}
            >
              <i className="pe-7s-repeat me-1" />Синхронизировать выбранный сайт
            </button>
          </span>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-sync-selected-site-wrap">
            {hasConcreteSiteSelected ? "Запустить синхронизацию только для выбранного сайта" : "Сначала выберите конкретный сайт (не \"Все сайты\")"}
          </UncontrolledTooltip>
          <button id="myproducts-rebuild-cache" className="btn btn-sm btn-outline-warning" onClick={() => runAction("/api/ms/rebuild-links-cache", "Кэш связей перестроен")}><i className="pe-7s-refresh me-1" />Перестроить кэш</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-rebuild-cache">Перестроить кэш связей с МойСклад</UncontrolledTooltip>
          <button id="myproducts-copy-link" className="btn btn-sm btn-outline-dark" onClick={copyPageLink}><i className="pe-7s-link me-1" />Скопировать ссылку</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="myproducts-copy-link">Скопировать ссылку на текущую страницу с фильтрами</UncontrolledTooltip>
        </div>
        </>
        ) : null}
      </DatagonCard>

      <div className="row row-cols-1 row-cols-md-2 row-cols-xl-5">
        <div className="col">
          <div className="card mb-3 card-body">
            <div className="text-muted"><i className="pe-7s-box2 me-1" />Всего активных</div>
            <h3 className="mb-0">{formatNumber(totals.total)}</h3>
          </div>
        </div>
        <div className="col">
          <div className="card mb-3 card-body">
            <div className="text-muted"><i className="pe-7s-link me-1" />Связано с МойСклад</div>
            <h3 className="mb-0">{formatNumber(totals.linked)}</h3>
          </div>
        </div>
        <div className="col">
          <div className="card mb-3 card-body">
            <div className="text-muted"><i className="pe-7s-unlink me-1" />Без связи</div>
            <h3 className="mb-0">{formatNumber(unlinkedTotal)}</h3>
          </div>
        </div>
        <div className="col">
          <div className="card mb-3 card-body">
            <div className="text-muted"><i className="pe-7s-close-circle me-1" />Выключено на источнике</div>
            <h3 className="mb-0">{formatNumber(totals.disabled)}</h3>
          </div>
        </div>
        <div className="col">
          <div className="card mb-3 card-body">
            <div className="text-muted"><i className="pe-7s-attention me-1" />Исчезнувшие</div>
            <h3 className="mb-0">{formatNumber(totals.disappeared)}</h3>
          </div>
        </div>
      </div>

      <DatagonCard title="Таблица товаров" hint={`Найдено: ${total}; отображено: ${rows.length}`}>
        <div className="table-responsive datagon-my-products-table-wrap">
          <table className="table table-hover table-striped mb-0 datagon-my-products-table">
            <thead>
              <tr>
                <th role="button" onClick={() => setSort("id")}>ID / КОД{renderSortArrow("id")}</th>
                <th role="button" onClick={() => setSort("site")}>Сайт{renderSortArrow("site")}</th>
                <th role="button" onClick={() => setSort("sku")}>Артикул (SKU){renderSortArrow("sku")}</th>
                <th role="button" onClick={() => setSort("name")}>Название{renderSortArrow("name")}</th>
                <th role="button" onClick={() => setSort("price")}>Цена{renderSortArrow("price")}</th>
                <th role="button" onClick={() => setSort("dealmed_price")}>Цена ДМ{renderSortArrow("dealmed_price")}</th>
                <th role="button" onClick={() => setSort("medkompleks_price")}>Цена МК{renderSortArrow("medkompleks_price")}</th>
                <th role="button" onClick={() => setSort("currency")}>Валюта{renderSortArrow("currency")}</th>
                <th role="button" onClick={() => setSort("stock")}>Остаток{renderSortArrow("stock")}</th>
                <th role="button" onClick={() => setSort("status")}>Статус{renderSortArrow("status")}</th>
                <th role="button" onClick={() => setSort("updated")}>Обновлен{renderSortArrow("updated")}</th>
                <th>Цена от конкурента</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan="13" className="text-muted">{loading ? "Загрузка..." : "Нет данных"}</td></tr>
              ) : filteredRows.map((r, idx) => {
                const rowTooltipIdBase = `myproducts-${r.site_id}-${r.source_id || r.id || idx}`;
                const usdRate = Number(filters.usd_to_rub || fx.usd_to_rub || 90);
                const eurRate = Number(filters.eur_to_rub || fx.eur_to_rub || 100);
                const myPriceUi = formatBasePriceWithRub(r.price, r.currency, usdRate, eurRate);
                const dmPriceUi = formatBasePriceWithRub(r.dealmed_price, r.dealmed_currency || "RUB", usdRate, eurRate);
                const mkPriceUi = formatBasePriceWithRub(r.medkompleks_price, r.medkompleks_currency || "RUB", usdRate, eurRate);
                const dealmedDev = (r.dealmed_price === null || r.dealmed_price === undefined)
                  ? "н/д"
                  : formatDeviationPct(r.price, r.currency, r.dealmed_price, r.dealmed_currency, usdRate, eurRate);
                const medkompleksDev = (r.medkompleks_price === null || r.medkompleks_price === undefined)
                  ? "н/д"
                  : formatDeviationPct(r.price, r.currency, r.medkompleks_price, r.medkompleks_currency, usdRate, eurRate);
                return (
                <tr key={`${r.site_id}-${r.source_id}-${r.sku}`}>
                  <td>{r.source_id}</td>
                  <td>{siteNameById[String(r.site_id)] || `#${r.site_id}`}</td>
                  <td>{r.sku}</td>
                  <td>
                    {(() => {
                      const site = siteById[String(r.site_id)];
                      const productUrl = normalizeSiteProductUrl(r.source_url, site);
                      const editUrl = buildWebasystEditUrl(site, r.source_id);
                      return (
                        <>
                          {productUrl ? (
                            <a href={productUrl} target="_blank" rel="noopener noreferrer" className="text-decoration-none text-body">
                              {r.name}
                            </a>
                          ) : (
                            r.name
                          )}
                          {editUrl ? (
                            <a href={editUrl} target="_blank" rel="noopener noreferrer" className="ms-2 small text-decoration-none text-muted" title="Редактировать карточку в Webasyst">
                              [ред.]
                            </a>
                          ) : null}
                        </>
                      );
                    })()}
                    {Number(r.in_moysklad) === 1 ? (
                      <a
                        href={buildMoyskladSearchLink(r.ms_link_code || r.source_id)}
                        className="ms-2 small text-decoration-none text-muted"
                        title={`Есть в МойСклад (код ${r.ms_link_code || r.source_id || "-"})`}
                      >
                        [МойСклад]
                      </a>
                    ) : null}
                  </td>
                  <td>
                    {myPriceUi.baseText}
                    {myPriceUi.rubText ? <div className="small text-muted">{myPriceUi.rubText}</div> : null}
                  </td>
                  <td>
                    {dmPriceUi.baseText}
                    {dmPriceUi.rubText ? <div className="small text-muted">{dmPriceUi.rubText}</div> : null}
                    <div className={`small ${deviationClass(dealmedDev)}`}>Δ {dealmedDev}</div>
                    {safeLink(r.dealmed_url) ? (
                      <div>
                        <a href={safeLink(r.dealmed_url)} target="_blank" rel="noopener noreferrer" className="small text-decoration-none text-muted">
                          [ссылка]
                        </a>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {mkPriceUi.baseText}
                    {mkPriceUi.rubText ? <div className="small text-muted">{mkPriceUi.rubText}</div> : null}
                    <div className={`small ${deviationClass(medkompleksDev)}`}>Δ {medkompleksDev}</div>
                    {safeLink(r.medkompleks_url) ? (
                      <div>
                        <a href={safeLink(r.medkompleks_url)} target="_blank" rel="noopener noreferrer" className="small text-decoration-none text-muted">
                          [ссылка]
                        </a>
                      </div>
                    ) : null}
                  </td>
                  <td>{r.currency}</td>
                  <td>{r.stock}</td>
                  <td>
                    {Number(r.is_active) ? (
                      <span className="badge bg-success">Активен</span>
                    ) : (
                      <span className="badge bg-secondary">Неактивен</span>
                    )}
                    <div className="small text-muted mt-1">
                      На сайте: {Number(r.source_enabled) === 0 ? "выключен" : "включен"}
                    </div>
                  </td>
                  <td>{formatRuDateTime(r.updated_at || r.updated)}</td>
                  <td>
                    {r.gap_competitor || "-"}
                    {r.comp_sync_at ? (
                      <div className="small text-muted mt-1">
                        Синх.: {r.comp_sync_by || "-"}, {formatRuDateTime(r.comp_sync_at)}
                      </div>
                    ) : null}
                  </td>
                  <td className="text-nowrap">
                    <button id={`${rowTooltipIdBase}-refresh`} className="btn btn-sm btn-outline-primary me-1" onClick={() => onRefreshOne(r)}><i className="pe-7s-refresh me-1" />Обновить</button>
                    <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`${rowTooltipIdBase}-refresh`}>Обновить данные товара из источника</UncontrolledTooltip>
                    <button id={`${rowTooltipIdBase}-syncprice`} className="btn btn-sm btn-outline-success" onClick={() => onSyncPrice(r)}><i className="pe-7s-graph3 me-1" />Синх. цену</button>
                    <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`${rowTooltipIdBase}-syncprice`}>Синхронизировать цену товара с правилом конкурентов</UncontrolledTooltip>
                    {(r.match_last_action || r.match_last_by || r.match_last_at) ? (
                      <div className="small text-muted mt-1">
                        {r.match_last_action === "confirmed" ? "Подтверждено" : r.match_last_action === "unlinked" ? "Разорвано" : r.match_last_action}
                        {r.match_last_by ? `: ${r.match_last_by}` : ""}
                        {r.match_last_at ? `, ${formatRuDateTime(r.match_last_at)}` : ""}
                      </div>
                    ) : null}
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </DatagonCard>
    </div>
  );
};

export default MyProductsPage;
