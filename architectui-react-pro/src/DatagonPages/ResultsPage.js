import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const initialFilters = {
  project_id: "all",
  page_status: "",
  matched: "all",
  availability: "all",
  search: "",
};

const buildUrl = ({ filters, page, limit, sortBy, sortDir }) => {
  const s = new URLSearchParams({
    limit: String(limit),
    offset: String((page - 1) * limit),
    sort_by: sortBy,
    sort_dir: sortDir,
  });
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === "all") return;
    s.set(k, String(v));
  });
  return `/api/results?${s.toString()}`;
};

const syncUrl = ({ filters, page, limit, sortBy, sortDir }) => {
  const s = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === "all") return;
    s.set(k, String(v));
  });
  if (page > 1) s.set("page", String(page));
  if (limit !== 100) s.set("limit", String(limit));
  if (sortBy !== "parsed_at") s.set("sort_by", sortBy);
  if (sortDir !== "desc") s.set("sort_dir", sortDir);
  const next = s.toString() ? `${window.location.pathname}?${s.toString()}` : window.location.pathname;
  window.history.replaceState(null, "", next);
};

const fmtDate = (v) => {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ru-RU");
};

const ResultsPage = () => {
  const filtersCollapsedKey = "datagon_results_filters_collapsed_v1";
  const [filters, setFilters] = useState(initialFilters);
  const [projects, setProjects] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(100);
  const [sortBy, setSortBy] = useState("parsed_at");
  const [sortDir, setSortDir] = useState("desc");
  const [loading, setLoading] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });
  const [tableFilters, setTableFilters] = useState({
    product_name: "",
    sku: "",
    project_name: "",
    page_status: "all",
    availability: "all",
    matched: "all",
    price_min: "",
    price_max: "",
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = { ...initialFilters };
    ["project_id", "page_status", "matched", "availability", "search"].forEach((k) => {
      const v = params.get(k);
      if (v !== null && v !== "") next[k] = v;
    });
    const p = Number(params.get("page") || 1);
    const l = Number(params.get("limit") || 100);
    const sb = params.get("sort_by");
    const sd = params.get("sort_dir");
    setFilters(next);
    if (Number.isFinite(p) && p > 0) setPage(p);
    if ([50, 100, 500, 1000].includes(l)) setLimit(l);
    if (sb) setSortBy(sb);
    if (sd === "asc" || sd === "desc") setSortDir(sd);
  }, []);

  useEffect(() => {
    syncUrl({ filters, page, limit, sortBy, sortDir });
  }, [filters, page, limit, sortBy, sortDir]);

  const loadProjects = useCallback(async () => {
    try {
      const [projectsRes, settingsRes] = await Promise.all([fetch("/api/projects"), fetch("/api/settings")]);
      const projectsJson = await projectsRes.json().catch(() => []);
      const settingsJson = await settingsRes.json().catch(() => ({}));
      if (projectsRes.ok) setProjects(Array.isArray(projectsJson) ? projectsJson : []);
      if (settingsRes.ok) {
        const defaultLimit = Number(settingsJson.default_limit || 100);
        if ([50, 100, 500, 1000].includes(defaultLimit)) setLimit(defaultLimit);
      }
    } catch (_) {
      // non critical
    }
  }, []);

  const loadResults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(buildUrl({ filters, page, limit, sortBy, sortDir }));
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка загрузки результатов");
      setRows(Array.isArray(json.data || json.rows) ? (json.data || json.rows) : []);
      setTotal(Number(json.total || 0));
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить результаты");
    } finally {
      setLoading(false);
    }
  }, [filters, page, limit, sortBy, sortDir]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    loadResults();
  }, [loadResults]);

  const pages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const onSort = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir("asc");
    setPage(1);
  };

  const parseSmart = () => {
    const raw = String(filters.search || "").trim();
    if (!raw) return;
    const tokens = raw.match(/"[^"]+"|\S+/g) || [];
    const next = { ...filters };
    const free = [];
    tokens.forEach((t) => {
      const idx = t.indexOf(":");
      if (idx <= 0) {
        free.push(t.replace(/^"(.*)"$/, "$1"));
        return;
      }
      const key = t.slice(0, idx).toLowerCase();
      const value = t.slice(idx + 1).replace(/^"(.*)"$/, "$1");
      if (key === "project" || key === "project_id") next.project_id = value;
      else if (key === "status" || key === "page_status") next.page_status = value;
      else if (key === "code" || key === "sku" || key === "name") free.push(value);
      else free.push(value);
    });
    next.search = free.join(" ").trim();
    setPage(1);
    setFilters(next);
  };

  const clearResults = async () => {
    if (!window.confirm("Удалить историю результатов по текущему проекту?")) return;
    try {
      const res = await fetch("/api/results/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: filters.project_id === "all" ? null : filters.project_id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось очистить");
      toast.success("История очищена");
      loadResults();
    } catch (e) {
      toast.error(e.message || "Ошибка очистки");
    }
  };

  const reparseAll = async () => {
    if (!window.confirm("Добавить в очередь URL из результатов по текущим фильтрам?")) return;
    try {
      const res = await fetch("/api/parse/refresh-results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: filters.project_id === "all" ? null : filters.project_id,
          page_status: filters.page_status || null,
          search: filters.search || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || json.message || "Не удалось поставить в очередь");
      toast.success(json.message || "URL добавлены в очередь");
    } catch (e) {
      toast.error(e.message || "Ошибка постановки в очередь");
    }
  };

  const reparseOne = async (r) => {
    if (!window.confirm("Поставить страницу в очередь на повторный парсинг?")) return;
    try {
      const res = await fetch("/api/parse/refresh-single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: r.url,
          project_id: r.project_id,
          page_id: r.page_id || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || json.message || "Не удалось поставить в очередь");
      toast.success(json.message || "Добавлено в очередь");
    } catch (e) {
      toast.error(e.message || "Ошибка постановки в очередь");
    }
  };

  const deleteOne = async (id) => {
    if (!window.confirm("Удалить запись из истории?")) return;
    try {
      const res = await fetch(`/api/results/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось удалить");
      toast.success("Запись удалена");
      loadResults();
    } catch (e) {
      toast.error(e.message || "Ошибка удаления");
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
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (tableFilters.product_name && !String(r.product_name || "").toLowerCase().includes(String(tableFilters.product_name).trim().toLowerCase())) return false;
      if (tableFilters.sku && !String(r.sku || "").toLowerCase().includes(String(tableFilters.sku).trim().toLowerCase())) return false;
      if (tableFilters.project_name && !String(r.project_name || "").toLowerCase().includes(String(tableFilters.project_name).trim().toLowerCase())) return false;
      if (tableFilters.page_status !== "all" && String(r.page_status || "").toLowerCase() !== String(tableFilters.page_status).toLowerCase()) return false;
      const availability = Number(r.is_oos || 0) === 1 ? "oos" : "in_stock";
      if (tableFilters.availability !== "all" && availability !== tableFilters.availability) return false;
      const matched = Number(r.is_matched || 0) === 1 ? "1" : "0";
      if (tableFilters.matched !== "all" && matched !== tableFilters.matched) return false;
      const price = Number(r.price || 0);
      const min = Number(tableFilters.price_min || "");
      const max = Number(tableFilters.price_max || "");
      if (Number.isFinite(min) && String(tableFilters.price_min).trim() !== "" && price < min) return false;
      if (Number.isFinite(max) && String(tableFilters.price_max).trim() !== "" && price > max) return false;
      return true;
    });
  }, [rows, tableFilters]);

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-note2 icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Результаты
              <div className="page-title-subheading">История парсинга, сопоставление и повторная постановка в очередь.</div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard
        title="Фильтры и действия"
        hint={`Всего записей: ${total.toLocaleString("ru-RU")}`}
        actions={<button className="btn btn-sm btn-outline-secondary" onClick={toggleFiltersCollapsed}>{filtersCollapsed ? "Развернуть" : "Свернуть"}</button>}
      >
        {!filtersCollapsed ? (
        <>
        <div className="row g-2">
          <div className="col-md-4">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={filters.search}
              onChange={(e) => setFilters((p) => ({ ...p, search: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  parseSmart();
                }
              }}
              placeholder={`code:... sku:... name:"..." project:2`}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Проект</label>
            <select className="form-select" value={filters.project_id} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, project_id: e.target.value })); }}>
              <option value="all">Все проекты</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Сопоставление</label>
            <select className="form-select" value={filters.matched} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, matched: e.target.value })); }}>
              <option value="all">Все</option><option value="1">Только сопоставленные</option><option value="0">Только несопоставленные</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус парсинга</label>
            <select className="form-select" value={filters.page_status} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, page_status: e.target.value })); }}>
              <option value="">Все</option><option value="pending">Ожидает</option><option value="processing">В обработке</option><option value="done">Готово</option><option value="error">Ошибка</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Наличие</label>
            <select className="form-select" value={filters.availability} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, availability: e.target.value })); }}>
              <option value="all">Все</option><option value="in_stock">В наличии</option><option value="oos">Под заказ</option>
            </select>
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-3">
            <label className="form-label">Товар (таблица)</label>
            <input className="form-control" value={tableFilters.product_name} onChange={(e) => setTableFilters((p) => ({ ...p, product_name: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">SKU (таблица)</label>
            <input className="form-control" value={tableFilters.sku} onChange={(e) => setTableFilters((p) => ({ ...p, sku: e.target.value }))} />
          </div>
          <div className="col-md-3">
            <label className="form-label">Проект (таблица)</label>
            <input className="form-control" value={tableFilters.project_name} onChange={(e) => setTableFilters((p) => ({ ...p, project_name: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус таблицы</label>
            <select className="form-select" value={tableFilters.page_status} onChange={(e) => setTableFilters((p) => ({ ...p, page_status: e.target.value }))}>
              <option value="all">Все</option>
              <option value="pending">pending</option>
              <option value="processing">processing</option>
              <option value="done">done</option>
              <option value="error">error</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Наличие тбл</label>
            <select className="form-select" value={tableFilters.availability} onChange={(e) => setTableFilters((p) => ({ ...p, availability: e.target.value }))}>
              <option value="all">Все</option>
              <option value="in_stock">В наличии</option>
              <option value="oos">Под заказ</option>
            </select>
          </div>
        </div>
        <div className="row g-2 mt-1">
          <div className="col-md-2">
            <label className="form-label">Сопост. тбл</label>
            <select className="form-select" value={tableFilters.matched} onChange={(e) => setTableFilters((p) => ({ ...p, matched: e.target.value }))}>
              <option value="all">Все</option>
              <option value="1">Да</option>
              <option value="0">Нет</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Цена от</label>
            <input className="form-control" type="number" value={tableFilters.price_min} onChange={(e) => setTableFilters((p) => ({ ...p, price_min: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Цена до</label>
            <input className="form-control" type="number" value={tableFilters.price_max} onChange={(e) => setTableFilters((p) => ({ ...p, price_max: e.target.value }))} />
          </div>
        </div>
        <div className="mt-3 d-flex flex-wrap gap-2">
          <button
            id="results-apply"
            className="btn btn-sm btn-primary"
            onClick={() => {
              if (String(filters.search || "").trim()) {
                parseSmart();
                return;
              }
              setPage(1);
              loadResults();
            }}
          >
            <i className="pe-7s-search me-1" />Применить
          </button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="results-apply">Применить фильтры результатов</UncontrolledTooltip>
          <button id="results-reparse-all" className="btn btn-sm btn-outline-success" onClick={reparseAll}><i className="pe-7s-refresh-2 me-1" />В очередь на перепарсинг</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="results-reparse-all">Добавить отфильтрованные результаты в очередь повторного парсинга</UncontrolledTooltip>
          <button id="results-clear-history" className="btn btn-sm btn-outline-danger" onClick={clearResults}><i className="pe-7s-trash me-1" />Очистить историю</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="results-clear-history">Очистить историю результатов по текущему проекту</UncontrolledTooltip>
        </div>
        </>
        ) : null}
      </DatagonCard>

      <DatagonCard title="Таблица результатов" hint={`Страница ${page}/${Math.max(1, Math.ceil(total / limit))}`}>
        <div className="table-responsive datagon-my-products-table-wrap">
          <table className="table table-hover table-striped mb-0 datagon-my-products-table">
            <thead>
              <tr>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("parsed_at")}>Дата</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("project_name")}>Проект</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("product_name")}>Товар</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("sku")}>SKU</th>
                <th>Сопоставление</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("page_status")}>Парсинг</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("is_oos")}>Наличие</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("price")}>Цена</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("url")}>URL</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan="10" className="text-muted">{loading ? "Загрузка..." : "Нет результатов"}</td></tr>
              ) : filteredRows.map((r) => {
                const matched = Number(r.is_matched || 0) === 1;
                const pageStatus = String(r.page_status || "").toLowerCase();
                return (
                  <tr key={r.id} className={matched ? "table-success" : ""}>
                    <td>
                      <div><b>Результат:</b> {fmtDate(r.parsed_at)}</div>
                      <div className="small text-muted"><b>Парсинг:</b> {fmtDate(r.page_parsed_at)}</div>
                    </td>
                    <td>{r.project_name || "-"}</td>
                    <td><b>{r.product_name || "-"}</b></td>
                    <td>{r.sku || "-"}</td>
                    <td>{matched ? <span className="badge bg-success">Сопоставлено</span> : "-"}</td>
                    <td>
                      {pageStatus === "pending" && <span className="badge bg-warning">Ожидает</span>}
                      {pageStatus === "processing" && <span className="badge bg-info">В обработке</span>}
                      {pageStatus === "done" && <span className="badge bg-success">Готово</span>}
                      {pageStatus === "error" && <span className="badge bg-danger">Ошибка</span>}
                      {!pageStatus && <span className="text-muted">нет в очереди</span>}
                    </td>
                    <td>{r.is_oos ? <span className="badge bg-danger">Под заказ</span> : <span className="badge bg-success">В наличии</span>}</td>
                    <td>{r.is_oos ? "-" : `${Number(r.price || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.currency || "RUB"}`}</td>
                    <td><a href={r.page_url || r.url} target="_blank" rel="noopener noreferrer">Открыть</a></td>
                    <td className="text-nowrap">
                      <button className="btn btn-sm btn-outline-info me-1" onClick={() => reparseOne(r)}><i className="pe-7s-refresh me-1" />↻</button>
                      <button className="btn btn-sm btn-outline-danger" onClick={() => deleteOne(r.id)}><i className="pe-7s-trash me-1" />×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 d-flex justify-content-between align-items-center">
          <div className="d-flex align-items-center gap-2">
            <span className="small text-muted">Показать:</span>
            <select className="form-select form-select-sm" style={{ width: 110 }} value={limit} onChange={(e) => { setLimit(Number(e.target.value || 100)); setPage(1); }}>
              <option value={50}>50</option><option value={100}>100</option><option value={500}>500</option><option value={1000}>1000</option>
            </select>
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Назад</button>
            <button className="btn btn-sm btn-outline-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Вперед</button>
          </div>
        </div>
      </DatagonCard>
    </div>
  );
};

export default ResultsPage;

