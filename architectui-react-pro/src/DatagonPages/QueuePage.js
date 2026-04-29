import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const defaultFilters = {
  project_id: "all",
  type: "all",
  status: "",
  matched: "all",
  search: "",
};

const statusRu = {
  sitemap: "Sitemap",
  pending: "Ожидает",
  processing: "В обработке",
  done: "Готово",
  error: "Ошибка",
};

const statusBadgeClass = {
  sitemap: "bg-secondary",
  pending: "bg-warning",
  processing: "bg-info",
  done: "bg-success",
  error: "bg-danger",
};

const buildQueueUrl = ({ filters, page, limit, sortBy, sortDir }) => {
  const s = new URLSearchParams({
    limit: String(limit),
    offset: String((page - 1) * limit),
    sort_by: sortBy,
    sort_dir: sortDir,
  });
  Object.entries(filters).forEach(([k, v]) => {
    if (!v || v === "all") return;
    s.set(k, String(v));
  });
  return `/api/pages?${s.toString()}`;
};

const QueuePage = () => {
  const filtersCollapsedKey = "datagon_queue_filters_collapsed_v1";
  const [filters, setFilters] = useState(defaultFilters);
  const [projects, setProjects] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(100);
  const [sortBy, setSortBy] = useState("id");
  const [sortDir, setSortDir] = useState("desc");
  const [uploadProjectId, setUploadProjectId] = useState("");
  const [uploadText, setUploadText] = useState("");
  const [discoveryStatus, setDiscoveryStatus] = useState("Автообход: нет данных");
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });
  const [tableFilters, setTableFilters] = useState({
    id: "",
    url: "",
    added_from: "",
    status: "all",
    page_type: "all",
    matched: "all",
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = { ...defaultFilters };
    ["project_id", "type", "status", "matched", "search"].forEach((k) => {
      const v = params.get(k);
      if (v !== null && v !== "") next[k] = v;
    });
    setFilters(next);
    const p = Number(params.get("page") || 1);
    const l = Number(params.get("limit") || 100);
    const sb = params.get("sort_by") || "id";
    const sd = params.get("sort_dir") === "asc" ? "asc" : "desc";
    if (Number.isFinite(p) && p > 0) setPage(p);
    if ([50, 100, 500, 1000].includes(l)) setLimit(l);
    setSortBy(sb);
    setSortDir(sd);
  }, []);

  useEffect(() => {
    const s = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (!v || v === "all") return;
      s.set(k, String(v));
    });
    if (page > 1) s.set("page", String(page));
    if (limit !== 100) s.set("limit", String(limit));
    if (sortBy !== "id") s.set("sort_by", sortBy);
    if (sortDir !== "desc") s.set("sort_dir", sortDir);
    const next = s.toString() ? `${window.location.pathname}?${s.toString()}` : window.location.pathname;
    window.history.replaceState(null, "", next);
  }, [filters, page, limit, sortBy, sortDir]);

  const loadBaseData = useCallback(async () => {
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

  const refreshDiscoveryStatus = useCallback(async (projectId) => {
    if (!projectId || projectId === "all") {
      setDiscoveryStatus("Автообход: выберите конкретный проект");
      return;
    }
    try {
      const res = await fetch(`/api/pages/discover-status?project_id=${encodeURIComponent(projectId)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось получить статус");
      const activeLabel = json.active ? "выполняется" : "ожидание";
      const base = `Автообход (${activeLabel}): найдено ${json.discovered || 0}, новых из sitemap ${json.added_sitemap || 0}, добавлено со стр. ${json.added_from_page || 0}`;
      setDiscoveryStatus(json.message ? `${base} | ${json.message}` : base);
    } catch (e) {
      setDiscoveryStatus(`Автообход: ошибка статуса - ${e.message}`);
    }
  }, []);

  const loadPages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(buildQueueUrl({ filters, page, limit, sortBy, sortDir }));
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка загрузки очереди");
      const data = json.data || json.rows || [];
      setRows(Array.isArray(data) ? data : []);
      setTotal(Number(json.total || 0));
      const activeProject = filters.project_id !== "all" ? filters.project_id : uploadProjectId;
      refreshDiscoveryStatus(activeProject);
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки очереди");
    } finally {
      setLoading(false);
    }
  }, [filters, page, limit, sortBy, sortDir, uploadProjectId, refreshDiscoveryStatus]);

  useEffect(() => {
    loadBaseData();
  }, [loadBaseData]);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadPages();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadPages]);

  const pagesCount = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const parseSmartSearch = () => {
    const raw = String(filters.search || "").trim();
    if (!raw) return;
    const tokens = raw.match(/"[^"]+"|\S+/g) || [];
    const next = { ...filters };
    const free = [];
    tokens.forEach((token) => {
      const idx = token.indexOf(":");
      if (idx > 0) {
        const key = token.slice(0, idx).toLowerCase();
        const value = token.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
        if (key === "project" || key === "project_id") next.project_id = value;
        else if (key === "type") next.type = value;
        else if (key === "status") next.status = value;
        else if (key === "code" || key === "sku" || key === "name") free.push(value);
        else free.push(token);
      } else {
        free.push(token.replace(/^"(.*)"$/, "$1"));
      }
    });
    next.search = free.join(" ").trim();
    setPage(1);
    setFilters(next);
  };

  const addBulk = async () => {
    if (!uploadProjectId || !uploadText.trim()) {
      toast.warning("Выберите проект и вставьте URL");
      return;
    }
    try {
      const res = await fetch("/api/pages/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: uploadProjectId, urls_text: uploadText }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось загрузить URL");
      setUploadText("");
      toast.success(`Добавлено URL: ${json.count || 0}`);
      loadPages();
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки URL");
    }
  };

  const postQueueAction = async (url, body, successMessage) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json.success === false && !json.message)) throw new Error(json.error || json.message || "Ошибка действия");
      if (successMessage) toast.success(successMessage);
      return json;
    } catch (e) {
      toast.error(e.message || "Ошибка действия");
      return null;
    }
  };

  const activeProjectId = filters.project_id !== "all" ? filters.project_id : uploadProjectId;

  const startDiscovery = async () => {
    if (!activeProjectId) return toast.warning("Выберите конкретный проект");
    if (!window.confirm("Запустить автообход URL?")) return;
    const json = await postQueueAction("/api/pages/discover-start", { project_id: Number(activeProjectId) }, "Автообход запущен");
    if (json) refreshDiscoveryStatus(activeProjectId);
  };

  const stopDiscovery = async () => {
    if (!activeProjectId) return toast.warning("Выберите конкретный проект");
    if (!window.confirm("Остановить автообход URL?")) return;
    const json = await postQueueAction("/api/pages/discover-stop", { project_id: Number(activeProjectId) }, "Остановка запрошена");
    if (json) refreshDiscoveryStatus(activeProjectId);
  };

  const parseVisible = async () => {
    if (!window.confirm("Запустить парсинг видимых страниц?")) return;
    const json = await postQueueAction("/api/parse/visible", {
      project_id: filters.project_id === "all" ? null : filters.project_id,
      status: filters.status || null,
      type: filters.type === "all" ? null : filters.type,
    }, "Парсинг запущен");
    if (json) setTimeout(loadPages, 1000);
  };

  const resetOrClear = async (mode, type) => {
    const isReset = type === "reset";
    if (!window.confirm(isReset ? "Вернуть страницы в очередь?" : "Удалить страницы?")) return;
    const payload = {
      project_id: filters.project_id === "all" ? null : filters.project_id,
      status: mode === "filtered" ? (filters.status || null) : null,
      type: mode === "filtered" ? (filters.type === "all" ? null : filters.type) : null,
    };
    const json = await postQueueAction(isReset ? "/api/pages/reset" : "/api/pages/clear", payload);
    if (json) {
      if (isReset) toast.success(`В pending: ${json.reset ?? 0}`);
      else toast.success(`Удалено: ${json.deleted ?? 0}`);
      loadPages();
    }
  };

  const parsePage = async (id) => {
    const json = await postQueueAction(`/api/parse/page/${id}`, {}, "Страница отправлена в парсинг");
    if (json) setTimeout(loadPages, 1000);
  };

  const deletePage = async (id) => {
    if (!window.confirm("Удалить страницу из очереди?")) return;
    try {
      const res = await fetch(`/api/pages/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось удалить");
      toast.success("Страница удалена");
      loadPages();
    } catch (e) {
      toast.error(e.message || "Ошибка удаления");
    }
  };

  const onSort = (field) => {
    if (sortBy === field) {
      setSortDir((v) => (v === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("asc");
    }
    setPage(1);
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

  const renderHighlightedUrl = (urlValue) => {
    const source = String(urlValue || "");
    const needle = String(filters.search || "").trim();
    if (!needle) return source;
    const idx = source.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return source;
    return (
      <>
        {source.slice(0, idx)}
        <mark>{source.slice(idx, idx + needle.length)}</mark>
        {source.slice(idx + needle.length)}
      </>
    );
  };
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (tableFilters.id && !String(r.id || "").includes(String(tableFilters.id).trim())) return false;
      if (tableFilters.url && !String(r.url || "").toLowerCase().includes(String(tableFilters.url).trim().toLowerCase())) return false;
      if (tableFilters.added_from && !String(r.added_from || "").toLowerCase().includes(String(tableFilters.added_from).trim().toLowerCase())) return false;
      if (tableFilters.status !== "all" && String(r.status || "").toLowerCase() !== String(tableFilters.status).toLowerCase()) return false;
      if (tableFilters.page_type !== "all" && String(r.page_type || "").toLowerCase() !== String(tableFilters.page_type).toLowerCase()) return false;
      const isMatched = Number(r.is_matched || 0) === 1 ? "1" : "0";
      if (tableFilters.matched !== "all" && isMatched !== tableFilters.matched) return false;
      return true;
    });
  }, [rows, tableFilters]);

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-network icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Очередь парсинга
              <div className="page-title-subheading">Загрузка URL, управление автообходом и очередью задач.</div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard title="Загрузка URL">
        <div className="row g-2">
          <div className="col-md-3">
            <label className="form-label">Проект</label>
            <select className="form-select" value={uploadProjectId} onChange={(e) => setUploadProjectId(e.target.value)}>
              <option value="">Выберите проект...</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="col-md-9">
            <label className="form-label">URL (каждый с новой строки)</label>
            <textarea className="form-control" rows={3} value={uploadText} onChange={(e) => setUploadText(e.target.value)} placeholder="https://site.ru/catalog/item-1" />
          </div>
        </div>
        <div className="mt-2">
          <button id="queue-upload-urls" className="btn btn-primary" onClick={addBulk}><i className="pe-7s-upload me-1" />Загрузить URL</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-upload-urls">Добавить список URL в очередь парсинга</UncontrolledTooltip>
        </div>
      </DatagonCard>

      <DatagonCard
        title="Фильтры и действия"
        hint={discoveryStatus}
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
                if (e.key === "Enter") parseSmartSearch();
              }}
              placeholder='code:123 sku:ABC-12 name:"насос 25" project:3 type:product status:pending'
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
            <label className="form-label">Тип</label>
            <select className="form-select" value={filters.type} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, type: e.target.value })); }}>
              <option value="all">Все типы</option>
              <option value="product">Товары</option>
              <option value="category">Категории</option>
              <option value="info">Инфо</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус</label>
            <select className="form-select" value={filters.status} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, status: e.target.value })); }}>
              <option value="">Все статусы</option>
              <option value="sitemap">Sitemap</option>
              <option value="pending">Ожидают</option>
              <option value="processing">В обработке</option>
              <option value="error">Ошибки</option>
              <option value="done">Готово</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Сопоставление</label>
            <select className="form-select" value={filters.matched} onChange={(e) => { setPage(1); setFilters((p) => ({ ...p, matched: e.target.value })); }}>
              <option value="all">Все</option>
              <option value="1">Только сопоставленные</option>
              <option value="0">Только несопоставленные</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">ID</label>
            <input className="form-control" value={tableFilters.id} onChange={(e) => setTableFilters((p) => ({ ...p, id: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">URL</label>
            <input className="form-control" value={tableFilters.url} onChange={(e) => setTableFilters((p) => ({ ...p, url: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Добавлено откуда</label>
            <input className="form-control" value={tableFilters.added_from} onChange={(e) => setTableFilters((p) => ({ ...p, added_from: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Статус (таблица)</label>
            <select className="form-select" value={tableFilters.status} onChange={(e) => setTableFilters((p) => ({ ...p, status: e.target.value }))}>
              <option value="all">Все</option>
              <option value="sitemap">Sitemap</option>
              <option value="pending">Ожидает</option>
              <option value="processing">В обработке</option>
              <option value="done">Готово</option>
              <option value="error">Ошибка</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Тип (таблица)</label>
            <select className="form-select" value={tableFilters.page_type} onChange={(e) => setTableFilters((p) => ({ ...p, page_type: e.target.value }))}>
              <option value="all">Все</option>
              <option value="product">Товар</option>
              <option value="category">Категория</option>
              <option value="info">Инфо</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Сопоставление (таблица)</label>
            <select className="form-select" value={tableFilters.matched} onChange={(e) => setTableFilters((p) => ({ ...p, matched: e.target.value }))}>
              <option value="all">Все</option>
              <option value="1">Сопоставленные</option>
              <option value="0">Несопоставленные</option>
            </select>
          </div>
        </div>
        <div className="mt-3 d-flex flex-wrap gap-2">
          <button
            id="queue-apply"
            className="btn btn-sm btn-primary"
            onClick={() => {
              if (String(filters.search || "").trim()) {
                parseSmartSearch();
                return;
              }
              setPage(1);
              loadPages();
            }}
          >
            <i className="pe-7s-search me-1" />Применить
          </button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-apply">Применить фильтры очереди</UncontrolledTooltip>
          <button id="queue-reset" className="btn btn-sm btn-outline-secondary" onClick={() => { setFilters(defaultFilters); setPage(1); }}><i className="pe-7s-broom me-1" />Сбросить фильтры</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-reset">Сбросить фильтры к значениям по умолчанию</UncontrolledTooltip>
          <button id="queue-discovery-start" className="btn btn-sm btn-outline-primary" onClick={startDiscovery}><i className="pe-7s-compass me-1" />Запустить автообход</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-discovery-start">Запустить автообход сайта и заполнение очереди</UncontrolledTooltip>
          <button id="queue-discovery-stop" className="btn btn-sm btn-outline-warning" onClick={stopDiscovery}><i className="pe-7s-close-circle me-1" />Остановить автообход</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-discovery-stop">Остановить текущий автообход</UncontrolledTooltip>
          <button id="queue-status-refresh" className="btn btn-sm btn-outline-info" onClick={() => refreshDiscoveryStatus(activeProjectId)}><i className="pe-7s-signal me-1" />Обновить статус</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-status-refresh">Обновить статус автообхода</UncontrolledTooltip>
          <button id="queue-reset-filtered" className="btn btn-sm btn-outline-info" onClick={() => resetOrClear("filtered", "reset")}><i className="pe-7s-back-2 me-1" />Вернуть в очередь (фильтр)</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-reset-filtered">Вернуть отфильтрованные записи в pending</UncontrolledTooltip>
          <button id="queue-parse-visible" className="btn btn-sm btn-outline-success" onClick={parseVisible}><i className="pe-7s-play me-1" />Парсинг видимых</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-parse-visible">Запустить парсинг видимых записей таблицы</UncontrolledTooltip>
          <button id="queue-clear-filtered" className="btn btn-sm btn-outline-warning" onClick={() => resetOrClear("filtered", "clear")}><i className="pe-7s-trash me-1" />Удалить по фильтрам</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-clear-filtered">Удалить записи, попавшие под текущий фильтр</UncontrolledTooltip>
          <button id="queue-clear-all" className="btn btn-sm btn-outline-danger" onClick={() => resetOrClear("all", "clear")}><i className="pe-7s-close me-1" />Полностью очистить очередь</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-clear-all">Удалить все записи очереди парсинга</UncontrolledTooltip>
          <button id="queue-copy-link" className="btn btn-sm btn-outline-dark" onClick={copyPageLink}><i className="pe-7s-link me-1" />Скопировать ссылку</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="queue-copy-link">Скопировать ссылку на текущую страницу</UncontrolledTooltip>
        </div>
        <p className="small text-muted mt-2 mb-0">
          <b>Автообход URL:</b> читает <code>robots.txt</code>, затем <code>Sitemap:</code> и внутренние ссылки. Новые URL пишутся в <code>Sitemap</code>, после завершения переводятся в <code>pending</code>.
        </p>
        </>
        ) : null}
      </DatagonCard>

      <DatagonCard title="Текущая очередь" hint={`Всего: ${total.toLocaleString("ru-RU")}`}>
        <div className="table-responsive datagon-my-products-table-wrap">
          <table className="table table-hover table-striped mb-0 datagon-my-products-table">
            <thead>
              <tr>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("id")}>ID</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("project_id")}>Проект</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("page_type")}>Тип</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("url")}>URL</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("added_from")}>Добавлено</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("added_at")}>Дата добавления</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("status")}>Статус</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSort("parsed_at")}>Дата парсинга</th>
                <th>Сопоставление</th>
                <th>Ошибка</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan="11" className="text-muted">{loading ? "Загрузка..." : "Нет данных"}</td></tr>
              ) : filteredRows.map((r) => {
                const matched = Number(r.is_matched || 0) === 1;
                const projectName = projects.find((p) => String(p.id) === String(r.project_id))?.name || r.project_id;
                const canRun = ["sitemap", "pending", "error"].includes(String(r.status || "").toLowerCase());
                return (
                  <tr key={r.id} className={matched ? "table-success" : ""}>
                    <td>{r.id}</td>
                    <td>{projectName}</td>
                    <td>{r.page_type || "-"}</td>
                    <td style={{ maxWidth: 320 }} className="text-truncate">
                      <a href={r.url} target="_blank" rel="noopener noreferrer">{renderHighlightedUrl(r.url)}</a>
                    </td>
                    <td>{r.added_from || "-"}</td>
                    <td>{r.added_at ? new Date(r.added_at).toLocaleString("ru-RU") : "-"}</td>
                    <td>
                      <span className={`badge ${statusBadgeClass[String(r.status || "").toLowerCase()] || "bg-secondary"}`}>
                        {statusRu[String(r.status || "").toLowerCase()] || r.status || "-"}
                      </span>
                    </td>
                    <td>{r.parsed_at ? new Date(r.parsed_at).toLocaleString("ru-RU") : "-"}</td>
                    <td>{matched ? <span className="badge bg-success">Сопоставлено</span> : "-"}</td>
                    <td className="small text-danger">{r.last_error || ""}</td>
                    <td className="text-nowrap">
                      {canRun ? <button className="btn btn-sm btn-outline-primary me-1" onClick={() => parsePage(r.id)}>Запуск</button> : null}
                      <button className="btn btn-sm btn-outline-danger" onClick={() => deletePage(r.id)}>Удалить</button>
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
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Назад</button>
            <button className="btn btn-sm btn-outline-secondary" disabled={page >= pagesCount} onClick={() => setPage((p) => p + 1)}>Вперед</button>
          </div>
        </div>
      </DatagonCard>
    </div>
  );
};

export default QueuePage;

