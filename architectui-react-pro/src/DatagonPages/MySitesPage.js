import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const emptyForm = {
  name: "",
  domain: "",
  cms_type: "bitrix",
  db_host: "localhost",
  db_name: "",
  db_user: "",
  db_pass: "",
  table_products: "b_catalog_product",
  field_name: "NAME",
  field_sku: "ARTICLE",
  field_code: "XML_ID",
  field_price: "PRICE",
  field_currency: "CURRENCY",
  field_stock: "QUANTITY",
  wa_table_skus: "shop_product_skus",
  wa_field_sku_val: "sku",
  wa_field_price_val: "price",
  wa_field_stock_val: "count",
};

const siteKey = (s) => `${s.id}-${s.name}`;

const MySitesPage = () => {
  const [sites, setSites] = useState([]);
  const [statsMap, setStatsMap] = useState({});
  const [verifyMap, setVerifyMap] = useState({});
  const [form, setForm] = useState(emptyForm);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [previewSite, setPreviewSite] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [syncState, setSyncState] = useState({ text: "", tone: "muted", running: false });
  const [sitesSmartSearch, setSitesSmartSearch] = useState("");
  const [tableFilters, setTableFilters] = useState({
    id: "",
    name: "",
    cms_type: "all",
    domain: "",
  });

  const collapsedKey = "mysites_add_form_collapsed_v1";

  const loadMySites = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/my-sites");
      const json = await res.json().catch(() => []);
      if (!res.ok) throw new Error("Не удалось загрузить сайты");
      setSites(Array.isArray(json) ? json : []);
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки сайтов");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSiteStats = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("/api/my-products/stats", { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const json = await res.json().catch(() => []);
      if (!Array.isArray(json)) return;
      const next = {};
      json.forEach((s) => {
        next[s.site_id] = s;
      });
      setStatsMap(next);
    } catch (_) {
      // non critical
    }
  }, []);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(collapsedKey) === "1");
    loadMySites();
    loadSiteStats();
  }, [loadMySites, loadSiteStats]);

  const validateForm = (f) => {
    const required = ["name", "domain", "db_host", "db_name", "db_user", "db_pass"];
    const miss = required.find((k) => !String(f[k] || "").trim());
    if (miss) {
      toast.error("Заполните все обязательные поля");
      return false;
    }
    return true;
  };

  const saveSite = async (body, id = null) => {
    const method = id ? "PUT" : "POST";
    const url = id ? `/api/my-sites/${id}` : "/api/my-sites";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить подключение");
  };

  const onCreate = async () => {
    if (!validateForm(form)) return;
    try {
      await saveSite(form);
      toast.success("Подключение сохранено");
      setForm(emptyForm);
      loadMySites();
      loadSiteStats();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const onEditSave = async () => {
    if (!editingSite) return;
    if (!validateForm(editingSite)) return;
    try {
      await saveSite(editingSite, editingSite.id);
      toast.success("Изменения сохранены");
      setEditingSite(null);
      loadMySites();
      loadSiteStats();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const onDelete = async (id) => {
    if (!window.confirm("Удалить сайт?")) return;
    try {
      const res = await fetch(`/api/my-sites/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось удалить");
      toast.success("Сайт удален");
      loadMySites();
      loadSiteStats();
    } catch (e) {
      toast.error(e.message || "Ошибка удаления");
    }
  };

  const onVerify = async (site) => {
    setVerifyMap((p) => ({ ...p, [site.id]: { text: "Проверка...", tone: "text-info" } }));
    try {
      const res = await fetch(`/api/my-sites/${site.id}/verify-stats`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось проверить статистику");
      const source = json.source || {};
      const datagon = json.datagon || {};
      const diff = json.diff || {};
      const status = json.matches ? "Совпадает" : "Расхождение";
      const text = `${status}: Источник ${source.total || 0}/${source.active || 0}/${source.disabled || 0} | Датагон ${datagon.total || 0}/${datagon.active || 0}/${datagon.disabled || 0} | Δ ${diff.total || 0}/${diff.active || 0}/${diff.disabled || 0}`;
      setVerifyMap((p) => ({
        ...p,
        [site.id]: { text, tone: json.matches ? "text-success" : "text-warning" },
      }));
      loadSiteStats();
    } catch (e) {
      setVerifyMap((p) => ({ ...p, [site.id]: { text: `Ошибка: ${e.message}`, tone: "text-danger" } }));
    }
  };

  const fetchPreview = async (site) => {
    setPreviewSite(site);
    setPreviewRows([]);
    setSyncState({ text: "", tone: "muted", running: false });
    try {
      const res = await fetch(`/api/my-sites/${site.id}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось получить товары");
      setPreviewRows(Array.isArray(json.data) ? json.data : []);
    } catch (e) {
      toast.error(e.message || "Ошибка предпросмотра");
    }
  };

  const syncPreviewSite = async () => {
    if (!previewSite) return;
    if (!window.confirm("Начать синхронизацию сайта?")) return;
    setSyncState({ text: "Синхронизация: 0/?", tone: "info", running: true });
    try {
      const initRes = await fetch(`/api/my-sites/${previewSite.id}/sync?init=true`, { method: "POST" });
      const initJson = await initRes.json().catch(() => ({}));
      if (!initRes.ok || !initJson.success) throw new Error(initJson.error || "Ошибка инициализации");
      const total = Number(initJson.total || 0);
      let offset = 0;
      let processed = 0;
      while (true) {
        const res = await fetch(`/api/my-sites/${previewSite.id}/sync?batch=500&offset=${offset}`, { method: "POST" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error(json.error || "Ошибка синхронизации");
        processed += Number(json.processed || 0);
        offset = Number(json.nextOffset || offset);
        setSyncState({
          text: total > 0 ? `Синхронизация: ${Math.min(processed, total)}/${total}` : `Синхронизация: обработано ${processed}`,
          tone: "info",
          running: true,
        });
        if (json.done || !json.hasMore) {
          setSyncState({
            text: `Готово. Обработано: ${processed}, скрыто: ${Number(json.deactivated || 0)}`,
            tone: "success",
            running: false,
          });
          break;
        }
      }
      loadSiteStats();
      fetchPreview(previewSite);
    } catch (e) {
      setSyncState({ text: `Ошибка: ${e.message}`, tone: "danger", running: false });
    }
  };

  const statsLabel = useMemo(() => {
    return `${sites.length} подключений`;
  }, [sites.length]);
  const filteredSites = useMemo(() => {
    const needle = String(sitesSmartSearch || "").trim().toLowerCase();
    return sites.filter((s) => {
      if (needle) {
        const hay = `${s.id || ""} ${s.name || ""} ${s.domain || ""} ${s.cms_type || ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (tableFilters.id && !String(s.id || "").includes(String(tableFilters.id).trim())) return false;
      if (tableFilters.name && !String(s.name || "").toLowerCase().includes(String(tableFilters.name).trim().toLowerCase())) return false;
      if (tableFilters.domain && !String(s.domain || "").toLowerCase().includes(String(tableFilters.domain).trim().toLowerCase())) return false;
      if (tableFilters.cms_type !== "all" && String(s.cms_type || "bitrix").toLowerCase() !== String(tableFilters.cms_type).toLowerCase()) return false;
      return true;
    });
  }, [sites, sitesSmartSearch, tableFilters]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(collapsedKey, next ? "1" : "0");
  };

  const copyPageLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Ссылка скопирована");
    } catch (_) {
      toast.error("Не удалось скопировать ссылку");
    }
  };

  const renderSiteStats = (site) => {
    const st = statsMap[site.id];
    if (!st) return <span className="text-muted">Загрузка...</span>;
    if (!Number(st.total || 0)) return <span className="text-muted">Нет товаров</span>;
    return (
      <div className="d-flex flex-wrap gap-1">
        <span className="badge bg-secondary">Всего: {st.total}</span>
        <a className="badge bg-success text-decoration-none" href={`/my-products?site_id=${site.id}&source_enabled=1`}>Активных: {st.active}</a>
        <a className="badge bg-danger text-decoration-none" href={`/my-products?site_id=${site.id}&source_enabled=0`}>Выключенных: {st.disabled}</a>
        <a className="badge bg-warning text-decoration-none" href={`/my-products?site_id=${site.id}&status=0`}>Исчезли: {st.disappeared}</a>
      </div>
    );
  };

  const formState = editingSite || form;
  const setFormState = editingSite ? setEditingSite : setForm;

  return (
    <div className="datagon-my-sites-page">
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-global icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Мои сайты
              <div className="page-title-subheading">Подключения к сайтам-источникам, проверка и синхронизация в Датагон.</div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard title={editingSite ? "Редактировать подключение" : "Добавить мой сайт"}>
        <div className="d-flex justify-content-end mb-2">
          <button className="btn btn-sm btn-outline-secondary" onClick={toggleCollapsed}>{collapsed ? "Развернуть" : "Свернуть"}</button>
        </div>
        {!collapsed && (
          <>
            <div className="row g-2">
              <div className="col-md-4"><label className="form-label">Название *</label><input className="form-control" value={formState.name} onChange={(e) => setFormState((p) => ({ ...p, name: e.target.value }))} /></div>
              <div className="col-md-4"><label className="form-label">Домен *</label><input className="form-control" value={formState.domain} onChange={(e) => setFormState((p) => ({ ...p, domain: e.target.value }))} /></div>
              <div className="col-md-4"><label className="form-label">CMS *</label><select className="form-select" value={formState.cms_type} onChange={(e) => setFormState((p) => ({ ...p, cms_type: e.target.value }))}><option value="bitrix">1C-Bitrix</option><option value="webasyst">Webasyst</option></select></div>
            </div>
            <div className="row g-2 mt-1">
              <div className="col-md-3"><label className="form-label">Хост БД *</label><input className="form-control" value={formState.db_host} onChange={(e) => setFormState((p) => ({ ...p, db_host: e.target.value }))} /></div>
              <div className="col-md-3"><label className="form-label">Имя БД *</label><input className="form-control" value={formState.db_name} onChange={(e) => setFormState((p) => ({ ...p, db_name: e.target.value }))} /></div>
              <div className="col-md-3"><label className="form-label">Пользователь *</label><input className="form-control" value={formState.db_user} onChange={(e) => setFormState((p) => ({ ...p, db_user: e.target.value }))} /></div>
              <div className="col-md-3"><label className="form-label">Пароль *</label><input type="password" className="form-control" value={formState.db_pass} onChange={(e) => setFormState((p) => ({ ...p, db_pass: e.target.value }))} /></div>
            </div>
            {formState.cms_type === "webasyst" ? (
              <div className="row g-2 mt-1">
                <div className="col-md-3"><label className="form-label">Таблица товаров</label><input className="form-control" value={formState.table_products} onChange={(e) => setFormState((p) => ({ ...p, table_products: e.target.value }))} /></div>
                <div className="col-md-3"><label className="form-label">Таблица SKU</label><input className="form-control" value={formState.wa_table_skus} onChange={(e) => setFormState((p) => ({ ...p, wa_table_skus: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Поле SKU</label><input className="form-control" value={formState.wa_field_sku_val} onChange={(e) => setFormState((p) => ({ ...p, wa_field_sku_val: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Поле цены</label><input className="form-control" value={formState.wa_field_price_val} onChange={(e) => setFormState((p) => ({ ...p, wa_field_price_val: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Поле остатков</label><input className="form-control" value={formState.wa_field_stock_val} onChange={(e) => setFormState((p) => ({ ...p, wa_field_stock_val: e.target.value }))} /></div>
              </div>
            ) : (
              <div className="row g-2 mt-1">
                <div className="col-md-2"><label className="form-label">Таблица</label><input className="form-control" value={formState.table_products} onChange={(e) => setFormState((p) => ({ ...p, table_products: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Название</label><input className="form-control" value={formState.field_name} onChange={(e) => setFormState((p) => ({ ...p, field_name: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Артикул</label><input className="form-control" value={formState.field_sku} onChange={(e) => setFormState((p) => ({ ...p, field_sku: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Код</label><input className="form-control" value={formState.field_code} onChange={(e) => setFormState((p) => ({ ...p, field_code: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Цена</label><input className="form-control" value={formState.field_price} onChange={(e) => setFormState((p) => ({ ...p, field_price: e.target.value }))} /></div>
                <div className="col-md-2"><label className="form-label">Остаток</label><input className="form-control" value={formState.field_stock} onChange={(e) => setFormState((p) => ({ ...p, field_stock: e.target.value }))} /></div>
              </div>
            )}
            <div className="mt-3 d-flex gap-2">
              <button className="btn btn-success datagon-btn-soft-success" onClick={editingSite ? onEditSave : onCreate}>{editingSite ? "Сохранить изменения" : "Сохранить подключение"}</button>
              {editingSite ? <button className="btn btn-outline-secondary" onClick={() => setEditingSite(null)}>Отмена редактирования</button> : null}
              <button className="btn btn-outline-secondary" onClick={copyPageLink}><i className="pe-7s-link me-1" />Скопировать ссылку</button>
            </div>
          </>
        )}
      </DatagonCard>

      <DatagonCard title="Подключенные сайты" hint={statsLabel}>
        <p className="small text-muted">
          Быстрые бейджи в статистике открывают предфильтрованную страницу товаров по выбранному сайту.
        </p>
        <div className="row g-2 mb-2">
          <div className="col-md-4">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={sitesSmartSearch}
              onChange={(e) => setSitesSmartSearch(e.target.value)}
              placeholder='id:2 domain:site.ru или просто текст'
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">ID</label>
            <input className="form-control" value={tableFilters.id} onChange={(e) => setTableFilters((p) => ({ ...p, id: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Название</label>
            <input className="form-control" value={tableFilters.name} onChange={(e) => setTableFilters((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">CMS</label>
            <select className="form-select" value={tableFilters.cms_type} onChange={(e) => setTableFilters((p) => ({ ...p, cms_type: e.target.value }))}>
              <option value="all">Все</option>
              <option value="bitrix">1C-Bitrix</option>
              <option value="webasyst">Webasyst</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Домен</label>
            <input className="form-control" value={tableFilters.domain} onChange={(e) => setTableFilters((p) => ({ ...p, domain: e.target.value }))} />
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-hover table-striped mb-0">
            <thead>
              <tr><th>ID</th><th>Название / CMS</th><th>Домен</th><th>Статистика товаров</th><th>Действия</th></tr>
            </thead>
            <tbody>
              {filteredSites.length === 0 ? (
                <tr><td colSpan="5" className="text-muted">{loading ? "Загрузка..." : "Нет подключенных сайтов"}</td></tr>
              ) : filteredSites.map((s) => (
                <tr key={siteKey(s)}>
                  <td>{s.id}</td>
                  <td><b>{s.name}</b><div className="small text-muted">CMS: {s.cms_type || "bitrix"}</div></td>
                  <td>{s.domain}</td>
                  <td>{renderSiteStats(s)}</td>
                  <td>
                    <div className="d-flex flex-wrap gap-1">
                      <button
                        id={`mysites-preview-${s.id}`}
                        className="btn btn-sm btn-outline-secondary"
                        data-dg-tooltip="Открыть предпросмотр товаров и окно синхронизации этого сайта"
                        onClick={() => fetchPreview(s)}
                      >
                        Товары+Синхр.
                      </button>
                      <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`mysites-preview-${s.id}`}>
                        Открыть предпросмотр товаров и окно синхронизации этого сайта
                      </UncontrolledTooltip>

                      <button
                        id={`mysites-verify-${s.id}`}
                        className="btn btn-sm btn-outline-secondary"
                        data-dg-tooltip="Сверить статистику источника с данными в Датагон"
                        onClick={() => onVerify(s)}
                      >
                        Проверить
                      </button>
                      <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`mysites-verify-${s.id}`}>
                        Сверить статистику источника с данными в Датагон
                      </UncontrolledTooltip>

                      <button
                        id={`mysites-edit-${s.id}`}
                        className="btn btn-sm btn-outline-secondary"
                        data-dg-tooltip="Редактировать параметры подключения сайта"
                        onClick={() => setEditingSite({ ...s })}
                      >
                        Изменить
                      </button>
                      <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`mysites-edit-${s.id}`}>
                        Редактировать параметры подключения сайта
                      </UncontrolledTooltip>

                      <button
                        id={`mysites-delete-${s.id}`}
                        className="btn btn-sm btn-outline-danger"
                        data-dg-tooltip="Удалить сайт и связанное подключение"
                        onClick={() => onDelete(s.id)}
                      >
                        Удалить
                      </button>
                      <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target={`mysites-delete-${s.id}`}>
                        Удалить сайт и связанное подключение
                      </UncontrolledTooltip>
                    </div>
                    {verifyMap[s.id]?.text ? <div className={`small mt-1 ${verifyMap[s.id]?.tone}`}>{verifyMap[s.id]?.text}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DatagonCard>

      {previewSite ? (
        <DatagonCard title={`Товары+Синхронизация: ${previewSite.name}`} hint={syncState.text ? <span className={`text-${syncState.tone}`}>{syncState.text}</span> : "Предпросмотр 100 товаров"}>
          <p className="small text-muted">
            Синхронизация идет пакетами по 500 строк: новые товары добавляются, существующие обновляются, исчезнувшие помечаются неактивными.
          </p>
          <div className="mb-2 d-flex gap-2">
            <button className="btn btn-outline-secondary" onClick={() => fetchPreview(previewSite)}>Обновить список</button>
            <button className="btn btn-outline-secondary" onClick={syncPreviewSite} disabled={syncState.running}>Синхронизировать в БД</button>
            <button className="btn btn-outline-danger" onClick={() => setPreviewSite(null)}>Закрыть</button>
          </div>
          <div className="table-responsive">
            <table className="table table-sm table-striped mb-0">
              <thead><tr><th>Название</th><th>Артикул</th><th>Цена</th><th>Валюта</th><th>Остаток</th></tr></thead>
              <tbody>
                {previewRows.length === 0 ? (
                  <tr><td colSpan="5" className="text-muted">Нет товаров</td></tr>
                ) : previewRows.map((p, idx) => (
                  <tr key={`${previewSite.id}-${idx}`}>
                    <td>{p.name || "-"}</td><td>{p.sku || "-"}</td><td>{p.price || 0}</td><td>{p.currency || "RUB"}</td><td>{p.stock || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DatagonCard>
      ) : null}
    </div>
  );
};

export default MySitesPage;

