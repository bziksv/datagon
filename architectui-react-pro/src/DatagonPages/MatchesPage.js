import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import DatagonCard from "./DatagonCard";

const PRODUCTS_LIMIT = 50;

const formatNumber = (value) => Number(value || 0).toLocaleString("ru-RU");
const formatDateTime = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ru-RU");
};
const buildSiteUrl = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (!/[a-z0-9-]+\.[a-z]{2,}/i.test(v)) return "";
  return `https://${v}`;
};
const normalizeWebasystProductUrl = (rawUrl, domainRaw, cmsType) => {
  const direct = buildSiteUrl(rawUrl);
  const base = buildSiteUrl(domainRaw);
  if (String(cmsType || "").toLowerCase() !== "webasyst") return direct || base || "";
  const target = direct || base;
  if (!target) return "";
  try {
    const u = new URL(target);
    const path = String(u.pathname || "/");
    if (!path.startsWith("/product/")) {
      const slug = path.replace(/^\/+/, "").replace(/\/+$/, "");
      if (slug) u.pathname = `/product/${slug}/`;
    } else if (!path.endsWith("/")) {
      u.pathname = `${path}/`;
    }
    return u.toString();
  } catch (_) {
    return direct || "";
  }
};
const buildProductSearchUrl = (domainRaw, sku, name) => {
  const base = buildSiteUrl(domainRaw);
  if (!base) return "";
  const query = String(sku || "").trim() || String(name || "").trim();
  if (!query) return base;
  return `${base.replace(/\/$/, "")}/search/?q=${encodeURIComponent(query)}`;
};
const buildWebasystEditUrl = (domainRaw, sourceId, cmsType) => {
  const base = buildSiteUrl(domainRaw);
  const id = String(sourceId || "").trim();
  if (!base || !id) return "";
  if (String(cmsType || "").toLowerCase() !== "webasyst") return "";
  return `${base.replace(/\/$/, "")}/webasyst/shop/?action=products#/product/${encodeURIComponent(id)}/edit/`;
};
const syncUrlFromState = ({
  mySiteId,
  statusFilter,
  searchMode,
  productSearch,
  matchesPage,
  matchesLimit,
}) => {
  const params = new URLSearchParams();
  if (mySiteId) params.set("my_site_id", String(mySiteId));
  if (statusFilter && statusFilter !== "pending") params.set("status", statusFilter);
  if (searchMode && searchMode !== "all") params.set("mode", searchMode);
  if (String(productSearch || "").trim()) params.set("product_search", String(productSearch).trim());
  if (Number(matchesPage) > 1) params.set("matches_page", String(matchesPage));
  if (Number(matchesLimit) !== 100) params.set("matches_limit", String(matchesLimit));
  const next = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState(null, "", next);
};

const MatchesPage = () => {
  const [mySites, setMySites] = useState([]);
  const [competitors, setCompetitors] = useState([]);
  const [mySiteId, setMySiteId] = useState("");
  const [competitorIds, setCompetitorIds] = useState([]);
  const [searchMode, setSearchMode] = useState("all");
  const [statusFilter, setStatusFilter] = useState("pending");
  const [productSearch, setProductSearch] = useState("");
  const [batchSize, setBatchSize] = useState(200);
  const [microPauseMs, setMicroPauseMs] = useState(20);
  const [batchPauseMs, setBatchPauseMs] = useState(1000);

  const [myProducts, setMyProducts] = useState([]);
  const [myProductsPage, setMyProductsPage] = useState(1);
  const [myProductsTotal, setMyProductsTotal] = useState(0);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const [matches, setMatches] = useState([]);
  const [matchesPage, setMatchesPage] = useState(1);
  const [matchesLimit, setMatchesLimit] = useState(100);
  const [matchesTotal, setMatchesTotal] = useState(0);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [matchesSmartSearch, setMatchesSmartSearch] = useState("");
  const [matchesTableFilters, setMatchesTableFilters] = useState({
    my_sku: "",
    competitor_sku: "",
    match_type: "all",
    status: "all",
    confidence_min: "",
    confidence_max: "",
  });
  const [matchesSortBy, setMatchesSortBy] = useState("confidence");
  const [matchesSortDir, setMatchesSortDir] = useState("desc");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mySite = params.get("my_site_id");
    const status = params.get("status");
    const mode = params.get("mode");
    const search = params.get("product_search");
    const pageParam = Number(params.get("matches_page") || 1);
    const limitParam = Number(params.get("matches_limit") || 100);
    if (mySite) setMySiteId(mySite);
    if (status && ["pending", "confirmed", "rejected", "all"].includes(status)) setStatusFilter(status);
    if (mode && ["all", "sku", "name"].includes(mode)) setSearchMode(mode);
    if (search) setProductSearch(search);
    if (Number.isFinite(pageParam) && pageParam > 0) setMatchesPage(pageParam);
    if (Number.isFinite(limitParam) && [50, 100, 200].includes(limitParam)) setMatchesLimit(limitParam);
  }, []);

  useEffect(() => {
    syncUrlFromState({
      mySiteId,
      statusFilter,
      searchMode,
      productSearch,
      matchesPage,
      matchesLimit,
    });
  }, [mySiteId, statusFilter, searchMode, productSearch, matchesPage, matchesLimit]);

  const [jobStatus, setJobStatus] = useState({
    active: false,
    done: false,
    message: "Ожидание",
    processed: 0,
    total: 0,
    foundSku: 0,
    foundName: 0,
    logs: [],
    canRetry: false,
  });

  const selectedSet = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);

  const loadSites = useCallback(async () => {
    try {
      const [myRes, compRes] = await Promise.all([fetch("/api/my-sites"), fetch("/api/projects")]);
      const myJson = await myRes.json().catch(() => []);
      const compJson = await compRes.json().catch(() => []);
      if (!myRes.ok) throw new Error("Не удалось загрузить мои сайты");
      if (!compRes.ok) throw new Error("Не удалось загрузить конкурентов");
      setMySites(Array.isArray(myJson) ? myJson : []);
      setCompetitors(Array.isArray(compJson) ? compJson : []);
      if (!mySiteId && Array.isArray(myJson) && myJson.length) {
        setMySiteId(String(myJson[0].id));
      }
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки справочников");
    }
  }, [mySiteId]);

  const loadMyProducts = useCallback(async () => {
    if (!mySiteId) {
      setMyProducts([]);
      setMyProductsTotal(0);
      return;
    }
    setLoadingProducts(true);
    try {
      const offset = (myProductsPage - 1) * PRODUCTS_LIMIT;
      const q = new URLSearchParams({
        my_site_id: mySiteId,
        limit: String(PRODUCTS_LIMIT),
        offset: String(offset),
      });
      if (String(productSearch || "").trim()) q.set("search", productSearch.trim());
      const res = await fetch(`/api/matches/my-products?${q.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка загрузки товаров");
      setMyProducts(Array.isArray(json.data) ? json.data : []);
      setMyProductsTotal(Number(json.total || 0));
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить товары");
    } finally {
      setLoadingProducts(false);
    }
  }, [mySiteId, myProductsPage, productSearch]);

  const loadMatches = useCallback(async () => {
    if (!mySiteId) {
      setMatches([]);
      setMatchesTotal(0);
      return;
    }
    setLoadingMatches(true);
    try {
      const offset = (matchesPage - 1) * matchesLimit;
      const q = new URLSearchParams({
        my_site_id: mySiteId,
        limit: String(matchesLimit),
        offset: String(offset),
      });
      if (statusFilter !== "all") q.set("status", statusFilter);
      const res = await fetch(`/api/matches/list?${q.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка загрузки совпадений");
      setMatches(Array.isArray(json.data) ? json.data : []);
      setMatchesTotal(Number(json.total || 0));
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить сопоставления");
    } finally {
      setLoadingMatches(false);
    }
  }, [mySiteId, matchesPage, matchesLimit, statusFilter]);

  const loadStatus = useCallback(async () => {
    if (!mySiteId) return;
    try {
      const res = await fetch(`/api/matches/status?my_site_id=${encodeURIComponent(mySiteId)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setJobStatus({
        active: Boolean(json.active),
        done: Boolean(json.done),
        message: json.message || "",
        processed: Number(json.processed || 0),
        total: Number(json.total || 0),
        foundSku: Number(json.foundSku || 0),
        foundName: Number(json.foundName || 0),
        logs: Array.isArray(json.logs) ? json.logs : [],
        canRetry: Boolean(json.canRetry),
      });
    } catch (_) {
      // status poll should be silent on network hiccups
    }
  }, [mySiteId]);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  useEffect(() => {
    if (!mySiteId) return;
    setMyProductsPage(1);
    setMatchesPage(1);
    setSelectedProductIds([]);
  }, [mySiteId]);

  useEffect(() => {
    loadMyProducts();
  }, [loadMyProducts]);

  useEffect(() => {
    loadMatches();
  }, [loadMatches]);

  useEffect(() => {
    loadStatus();
    if (!mySiteId) return undefined;
    const timer = setInterval(loadStatus, 1500);
    return () => clearInterval(timer);
  }, [mySiteId, loadStatus]);

  useEffect(() => {
    if (jobStatus.done) {
      loadMatches();
    }
  }, [jobStatus.done, loadMatches]);

  const toggleCompetitor = (id, checked) => {
    const sid = String(id);
    setCompetitorIds((prev) => {
      const set = new Set(prev.map(String));
      if (checked) set.add(sid);
      else set.delete(sid);
      return Array.from(set);
    });
  };

  const toggleProduct = (id, checked) => {
    setSelectedProductIds((prev) => {
      const set = new Set(prev);
      if (checked) set.add(id);
      else set.delete(id);
      return Array.from(set);
    });
  };

  const toggleAllOnPage = (checked) => {
    setSelectedProductIds((prev) => {
      const set = new Set(prev);
      myProducts.forEach((p) => {
        if (checked) set.add(p.id);
        else set.delete(p.id);
      });
      return Array.from(set);
    });
  };

  const runMatching = async (payload) => {
    try {
      const res = await fetch("/api/matches/start-matching", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось запустить сопоставление");
      toast.success("Сопоставление запущено");
      await loadStatus();
    } catch (e) {
      toast.error(e.message || "Ошибка запуска сопоставления");
    }
  };

  const onRunSelected = async () => {
    if (!mySiteId) return toast.warning("Выберите мой сайт");
    if (!competitorIds.length) return toast.warning("Выберите конкурентов");
    if (!selectedProductIds.length) return toast.warning("Выберите товары");
    await runMatching({
      mySiteId: Number(mySiteId),
      competitorIds: competitorIds.map(Number),
      mode: searchMode,
      productIds: selectedProductIds,
      batchSize: Number(batchSize || 200),
      microPauseMs: Number(microPauseMs || 20),
      batchPauseMs: Number(batchPauseMs || 1000),
    });
  };

  const onRunAuto = async () => {
    if (!mySiteId) return toast.warning("Выберите мой сайт");
    if (!competitorIds.length) return toast.warning("Выберите конкурентов");
    await runMatching({
      mySiteId: Number(mySiteId),
      competitorIds: competitorIds.map(Number),
      mode: searchMode,
      productSearch: String(productSearch || "").trim(),
      batchSize: Number(batchSize || 200),
      microPauseMs: Number(microPauseMs || 20),
      batchPauseMs: Number(batchPauseMs || 1000),
    });
  };

  const onRetryLast = async () => {
    if (!mySiteId) return toast.warning("Выберите мой сайт");
    try {
      const res = await fetch("/api/matches/retry-last", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mySiteId: Number(mySiteId),
          competitorIds: competitorIds.map(Number),
          mode: searchMode,
          productSearch: String(productSearch || "").trim(),
          batchSize: Number(batchSize || 200),
          microPauseMs: Number(microPauseMs || 20),
          batchPauseMs: Number(batchPauseMs || 1000),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось повторить задачу");
      toast.success(`Повтор запущен (из задачи #${json.replayFrom})`);
      await loadStatus();
    } catch (e) {
      toast.error(e.message || "Ошибка повтора");
    }
  };

  const onStop = async () => {
    if (!mySiteId) return toast.warning("Выберите мой сайт");
    try {
      const res = await fetch("/api/matches/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mySiteId: Number(mySiteId) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось остановить задачу");
      toast.success("Остановка запрошена");
      await loadStatus();
    } catch (e) {
      toast.error(e.message || "Ошибка остановки");
    }
  };

  const updateMatch = async (id, action) => {
    const endpoint =
      action === "confirmed"
        ? "/api/matches/confirm"
        : action === "unlink"
          ? "/api/matches/unlink"
          : "/api/matches/reject";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось обновить статус");
      toast.success("Статус обновлен");
      await loadMatches();
    } catch (e) {
      toast.error(e.message || "Ошибка обновления статуса");
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

  const myProductsPages = Math.max(1, Math.ceil(myProductsTotal / PRODUCTS_LIMIT));
  const matchesPages = Math.max(1, Math.ceil(matchesTotal / matchesLimit));
  const progressPct = jobStatus.total > 0 ? Math.round((jobStatus.processed / jobStatus.total) * 100) : 0;
  const filteredSortedMatches = useMemo(() => {
    const term = String(matchesSmartSearch || "").trim().toLowerCase();
    const filtered = !term
      ? matches
      : matches.filter((m) => {
          const hay = [
            m.status,
            m.match_type,
            m.my_sku,
            m.my_product_name,
            m.competitor_sku,
            m.competitor_name,
            m.confirmed_by,
            m.unlinked_by,
          ]
            .map((x) => String(x || "").toLowerCase())
            .join(" ");
          return hay.includes(term);
        });
    const byColumns = filtered.filter((m) => {
      if (matchesTableFilters.my_sku && !String(m.my_sku || "").toLowerCase().includes(String(matchesTableFilters.my_sku).trim().toLowerCase())) return false;
      if (matchesTableFilters.competitor_sku && !String(m.competitor_sku || "").toLowerCase().includes(String(matchesTableFilters.competitor_sku).trim().toLowerCase())) return false;
      if (matchesTableFilters.match_type !== "all" && String(m.match_type || "").toLowerCase() !== String(matchesTableFilters.match_type).toLowerCase()) return false;
      if (matchesTableFilters.status !== "all" && String(m.status || "").toLowerCase() !== String(matchesTableFilters.status).toLowerCase()) return false;
      const pct = Number(m.confidence_score || 0) * 100;
      const min = Number(matchesTableFilters.confidence_min || "");
      const max = Number(matchesTableFilters.confidence_max || "");
      if (Number.isFinite(min) && String(matchesTableFilters.confidence_min).trim() !== "" && pct < min) return false;
      if (Number.isFinite(max) && String(matchesTableFilters.confidence_max).trim() !== "" && pct > max) return false;
      return true;
    });
    const dir = matchesSortDir === "asc" ? 1 : -1;
    return [...byColumns].sort((a, b) => {
      if (matchesSortBy === "confidence") {
        return (Number(a.confidence_score || 0) - Number(b.confidence_score || 0)) * dir;
      }
      const av = String(a[matchesSortBy] || "");
      const bv = String(b[matchesSortBy] || "");
      return av.localeCompare(bv, "ru", { sensitivity: "base" }) * dir;
    });
  }, [matches, matchesSmartSearch, matchesSortBy, matchesSortDir, matchesTableFilters]);

  const onSortMatches = (field) => {
    if (matchesSortBy === field) {
      setMatchesSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setMatchesSortBy(field);
    setMatchesSortDir(field === "confidence" ? "desc" : "asc");
  };
  const statusUi = (status) => {
    if (status === "confirmed") return { icon: "pe-7s-check", badge: "success", label: "Подтверждено" };
    if (status === "rejected") return { icon: "pe-7s-close-circle", badge: "danger", label: "Отклонено" };
    return { icon: "pe-7s-timer", badge: "warning", label: "Ожидает" };
  };
  const scoreUi = (matchType, score) => {
    if (matchType === "sku") return { text: "100% (SKU)", badge: "success" };
    const pct = Math.round(score * 100);
    if (pct >= 90) return { text: `${pct}%`, badge: "success" };
    if (pct >= 70) return { text: `${pct}%`, badge: "warning" };
    return { text: `${pct}%`, badge: "secondary" };
  };

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-link icon-gradient bg-warm-flame"> </i>
            </div>
            <div>
              Сопоставление
              <div className="page-title-subheading">
                Перенос управления matching jobs и ручной валидации совпадений.
              </div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard
        title="Параметры запуска"
        hint={`${jobStatus.message} (${formatNumber(jobStatus.processed)}/${formatNumber(jobStatus.total)}, ${progressPct}%)`}
      >
        <div className="row g-2">
          <div className="col-md-3">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder='sku:ABC-12 name:"насос 25" или просто текст'
            />
          </div>
          <div className="col-md-3">
            <label className="form-label">Мой сайт</label>
            <select className="form-select" value={mySiteId} onChange={(e) => setMySiteId(e.target.value)}>
              <option value="">-- выберите --</option>
              {mySites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label">Режим сопоставления</label>
            <select className="form-select" value={searchMode} onChange={(e) => setSearchMode(e.target.value)}>
              <option value="all">all</option>
              <option value="sku">sku</option>
              <option value="name">name</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Batch</label>
            <input
              className="form-control"
              type="number"
              min="10"
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value || 200))}
            />
          </div>
          <div className="col-md-1">
            <label className="form-label">Micro ms</label>
            <input
              className="form-control"
              type="number"
              min="0"
              value={microPauseMs}
              onChange={(e) => setMicroPauseMs(Number(e.target.value || 20))}
            />
          </div>
          <div className="col-md-1">
            <label className="form-label">Pause ms</label>
            <input
              className="form-control"
              type="number"
              min="0"
              value={batchPauseMs}
              onChange={(e) => setBatchPauseMs(Number(e.target.value || 1000))}
            />
          </div>
        </div>

        <div className="mt-3">
          <label className="form-label d-block mb-1">Конкуренты</label>
          <div className="d-flex flex-wrap gap-3">
            {competitors.map((c) => {
              const checked = competitorIds.includes(String(c.id));
              return (
                <div key={c.id} className="form-check">
                  <input
                    id={`comp-${c.id}`}
                    className="form-check-input"
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleCompetitor(c.id, e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor={`comp-${c.id}`}>
                    {c.name}
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 d-flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={onRunSelected} disabled={!mySiteId || !competitorIds.length}>
            Запустить по выбранным товарам
          </button>
          <button className="btn btn-outline-primary" onClick={onRunAuto} disabled={!mySiteId || !competitorIds.length}>
            Запустить авто по фильтру
          </button>
          <button className="btn btn-outline-warning" onClick={onRetryLast} disabled={!mySiteId || !jobStatus.canRetry}>
            Продолжить/повторить
          </button>
          <button className="btn btn-outline-danger" onClick={onStop} disabled={!mySiteId || !jobStatus.active}>
            Остановить
          </button>
          <button className="btn btn-outline-dark" onClick={copyPageLink}>
            <i className="pe-7s-link me-1" />Скопировать ссылку
          </button>
        </div>
        <div className="mt-2 text-muted small">
          Найдено по job: SKU {formatNumber(jobStatus.foundSku)}, Name {formatNumber(jobStatus.foundName)}
        </div>
        <div className="mt-2 small" style={{ maxHeight: 120, overflow: "auto" }}>
          {(jobStatus.logs || []).slice(0, 10).map((l, i) => (
            <div key={`${i}-${l}`}>• {l}</div>
          ))}
        </div>
      </DatagonCard>

      <DatagonCard
        title="Мои товары для ручного запуска"
        hint={`Выбрано: ${selectedProductIds.length}; всего: ${formatNumber(myProductsTotal)}`}
      >
        <div className="table-responsive datagon-my-products-table-wrap">
          <table className="table table-sm table-hover mb-0 datagon-my-products-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    onChange={(e) => toggleAllOnPage(e.target.checked)}
                    checked={myProducts.length > 0 && myProducts.every((p) => selectedSet.has(p.id))}
                  />
                </th>
                <th>ID</th>
                <th>SKU</th>
                <th>Название</th>
                <th>Цена</th>
              </tr>
            </thead>
            <tbody>
              {myProducts.length === 0 ? (
                <tr>
                  <td colSpan="5" className="text-muted">
                    {loadingProducts ? "Загрузка..." : "Нет товаров"}
                  </td>
                </tr>
              ) : (
                myProducts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input type="checkbox" checked={selectedSet.has(p.id)} onChange={(e) => toggleProduct(p.id, e.target.checked)} />
                    </td>
                    <td>{p.id}</td>
                    <td>{p.sku || "-"}</td>
                    <td>{p.name || "-"}</td>
                    <td>
                      {p.price || 0} {p.currency || "RUB"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 d-flex justify-content-between align-items-center">
          <div className="text-muted small">
            Страница {myProductsPage}/{myProductsPages}
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-outline-secondary" disabled={myProductsPage <= 1} onClick={() => setMyProductsPage((p) => p - 1)}>
              Назад
            </button>
            <button
              className="btn btn-sm btn-outline-secondary"
              disabled={myProductsPage >= myProductsPages}
              onClick={() => setMyProductsPage((p) => p + 1)}
            >
              Вперед
            </button>
          </div>
        </div>
      </DatagonCard>

      <DatagonCard title="Совпадения" hint={`Всего: ${formatNumber(matchesTotal)}`}>
        <div className="row g-2 mb-2">
          <div className="col-md-4">
            <label className="form-label">Умный фильтр по списку</label>
            <input
              className="form-control"
              value={matchesSmartSearch}
              onChange={(e) => setMatchesSmartSearch(e.target.value)}
              placeholder="status:pending / SKU / название / кто подтвердил"
            />
          </div>
          <div className="col-md-3">
            <label className="form-label">Статус</label>
            <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="pending">pending</option>
              <option value="confirmed">confirmed</option>
              <option value="rejected">rejected</option>
              <option value="all">all</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Лимит</label>
            <select className="form-select" value={matchesLimit} onChange={(e) => setMatchesLimit(Number(e.target.value || 100))}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Мой SKU</label>
            <input className="form-control" value={matchesTableFilters.my_sku} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, my_sku: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">SKU конк.</label>
            <input className="form-control" value={matchesTableFilters.competitor_sku} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, competitor_sku: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Тип тбл</label>
            <select className="form-select" value={matchesTableFilters.match_type} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, match_type: e.target.value }))}>
              <option value="all">Все</option>
              <option value="sku">SKU</option>
              <option value="name">NAME</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Статус тбл</label>
            <select className="form-select" value={matchesTableFilters.status} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, status: e.target.value }))}>
              <option value="all">Все</option>
              <option value="pending">pending</option>
              <option value="confirmed">confirmed</option>
              <option value="rejected">rejected</option>
            </select>
          </div>
          <div className="col-md-1">
            <label className="form-label">Схож. от %</label>
            <input className="form-control" type="number" min="0" max="100" value={matchesTableFilters.confidence_min} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, confidence_min: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Схож. до %</label>
            <input className="form-control" type="number" min="0" max="100" value={matchesTableFilters.confidence_max} onChange={(e) => setMatchesTableFilters((p) => ({ ...p, confidence_max: e.target.value }))} />
          </div>
        </div>

        <div className="table-responsive datagon-my-products-table-wrap">
          <table className="table table-hover table-sm mb-0 datagon-my-products-table">
            <thead>
              <tr>
                <th style={{ cursor: "pointer" }} onClick={() => onSortMatches("status")}>Статус</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSortMatches("match_type")}>Тип</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSortMatches("confidence")}>Схожесть</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSortMatches("my_product_name")}>МОЙ ТОВАР (SKU / Название / Цена)</th>
                <th style={{ cursor: "pointer" }} onClick={() => onSortMatches("competitor_name")}>КОНКУРЕНТ (SKU / Название / Цена)</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredSortedMatches.length === 0 ? (
                <tr>
                  <td colSpan="6" className="text-muted">
                    {loadingMatches ? "Загрузка..." : "Нет совпадений"}
                  </td>
                </tr>
              ) : (
                filteredSortedMatches.map((m) => {
                  const score = Number(m.confidence_score || 0);
                  const sUi = statusUi(String(m.status || "").toLowerCase());
                  const cUi = scoreUi(String(m.match_type || "").toLowerCase(), score);
                  const myProductUrl =
                    normalizeWebasystProductUrl(
                      m.my_product_url || "",
                      m.my_site_domain || "",
                      m.my_site_cms_type || ""
                    ) || buildProductSearchUrl(m.my_site_domain || "", m.my_sku || "", m.my_product_name || "");
                  const myEditUrl = buildWebasystEditUrl(m.my_site_domain || "", m.my_source_id || "", m.my_site_cms_type || "");
                  const competitorUrl = buildSiteUrl(m.competitor_url || m.competitor_domain || "");
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className={`badge bg-${sUi.badge}`}>
                          <i className={`${sUi.icon} me-1`} />
                          {sUi.label}
                        </span>
                      </td>
                      <td>{m.match_type}</td>
                      <td><span className={`badge bg-${cUi.badge}`}>{cUi.text}</span></td>
                      <td>
                        <div><b>{m.my_sku || "-"}</b></div>
                        <div>{m.my_product_name || "-"}</div>
                        <div className="text-muted small">
                          {m.my_price ?? "-"} {m.my_currency || ""}
                        </div>
                        <div className="small mt-1 d-flex gap-2 flex-wrap">
                          {myProductUrl && (
                            <a href={myProductUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-link p-0">
                              <i className="pe-7s-home me-1" />Мой товар
                            </a>
                          )}
                          {myEditUrl && (
                            <a href={myEditUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-link p-0">
                              <i className="pe-7s-pen me-1" />Редактировать
                            </a>
                          )}
                        </div>
                      </td>
                      <td>
                        <div><b>{m.competitor_sku || "-"}</b></div>
                        <div>{m.competitor_name || "-"}</div>
                        <div className="text-muted small">
                          {m.competitor_price ?? "-"} {m.competitor_currency || ""}
                        </div>
                        <div className="text-muted small">
                          Обновлено: {formatDateTime(m.competitor_parsed_at)}
                        </div>
                        <div className="small mt-1 d-flex gap-2 flex-wrap">
                          {competitorUrl && (
                            <a href={competitorUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-link p-0">
                              <i className="pe-7s-link me-1" />Конкурент
                            </a>
                          )}
                          {myProductUrl && competitorUrl && (
                            <button
                              className="btn btn-link btn-sm p-0"
                              onClick={() => {
                                window.open(myProductUrl, "_blank", "noopener");
                                window.open(competitorUrl, "_blank", "noopener");
                              }}
                            >
                              <i className="pe-7s-browser me-1" />Оба
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="text-nowrap">
                        {m.status === "pending" ? (
                          <>
                            <button className="btn btn-sm btn-outline-success me-1" onClick={() => updateMatch(m.id, "confirmed")}>
                              <i className="pe-7s-check me-1" />Подтвердить
                            </button>
                            <button className="btn btn-sm btn-outline-danger" onClick={() => updateMatch(m.id, "rejected")}>
                              <i className="pe-7s-close-circle me-1" />Отклонить
                            </button>
                          </>
                        ) : m.status === "confirmed" ? (
                          <>
                            <div className="small text-muted mb-1">
                              Кто: {m.confirmed_by || "-"} | {formatDateTime(m.confirmed_at)}
                            </div>
                            <button className="btn btn-sm btn-outline-warning" onClick={() => updateMatch(m.id, "unlink")}>
                              <i className="pe-7s-link me-1" />Разорвать
                            </button>
                          </>
                        ) : (
                          <span className="text-muted">Отклонено</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 d-flex justify-content-between align-items-center">
          <div className="text-muted small">
            Страница {matchesPage}/{matchesPages}
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-outline-secondary" disabled={matchesPage <= 1} onClick={() => setMatchesPage((p) => p - 1)}>
              Назад
            </button>
            <button className="btn btn-sm btn-outline-secondary" disabled={matchesPage >= matchesPages} onClick={() => setMatchesPage((p) => p + 1)}>
              Вперед
            </button>
          </div>
        </div>
      </DatagonCard>
    </div>
  );
};

export default MatchesPage;
