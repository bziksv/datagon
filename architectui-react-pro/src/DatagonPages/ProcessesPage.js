import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import DatagonCard from "./DatagonCard";

const fmtNum = (v) => Number(v || 0).toLocaleString("ru-RU");
const fmtDateTime = (v) => {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.toLocaleDateString("ru-RU")} ${d.toLocaleTimeString("ru-RU")}`;
};

const ProcessesPage = () => {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [smartSearch, setSmartSearch] = useState("");
  const filtersCollapsedKey = "datagon_processes_filters_collapsed_v1";
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });

  const loadOverview = useCallback(async (preferredSiteId) => {
    setLoading(true);
    try {
      const selected = preferredSiteId ?? siteId;
      const qs = selected ? `?my_site_id=${encodeURIComponent(selected)}` : "";
      const res = await fetch(`/api/processes/overview${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить сводку процессов");
      setOverview(json);
      const matchesSites = Array.isArray(json.matchesSites) ? json.matchesSites : [];
      const responseSiteId = json.matches?.mySiteId ? String(json.matches.mySiteId) : "";
      if (responseSiteId) setSiteId(responseSiteId);
      else if (!selected && matchesSites.length) setSiteId(String(matchesSites[0].id));
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки процессов");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    const timer = setInterval(() => loadOverview(), 3000);
    return () => clearInterval(timer);
  }, [loadOverview]);

  const stopMsSync = async () => {
    try {
      const res = await fetch("/api/ms/stop", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось остановить синхронизацию");
      toast.success("Синхронизация МойСклад остановлена");
      loadOverview();
    } catch (e) {
      toast.error(e.message || "Ошибка остановки");
    }
  };

  const matchesSites = useMemo(() => (Array.isArray(overview?.matchesSites) ? overview.matchesSites : []), [overview]);
  const globalSync = overview?.globalSync || {};
  const moysklad = overview?.moysklad || {};
  const autoSync = overview?.autoSync || {};
  const autoSyncRuns = Array.isArray(overview?.autoSyncRuns) ? overview.autoSyncRuns : [];
  const discovery = Array.isArray(overview?.discovery) ? overview.discovery : [];
  const queue = overview?.queue || {};
  const matches = overview?.matches || {};
  const logNeedle = String(smartSearch || "").trim().toLowerCase();
  const filteredMoyskladLogs = (Array.isArray(moysklad.logs) ? moysklad.logs : [])
    .filter((line) => (!logNeedle ? true : String(line || "").toLowerCase().includes(logNeedle)))
    .slice(0, 20);
  const filteredAutoSyncRuns = autoSyncRuns.filter((r) => {
    if (!logNeedle) return true;
    const hay = `${r.task_type || ""} ${r.status || ""} ${r.message || ""}`.toLowerCase();
    return hay.includes(logNeedle);
  });
  const filteredDiscovery = discovery.filter((r) => {
    if (!logNeedle) return true;
    const hay = `${r.project_id || ""} ${r.message || ""}`.toLowerCase();
    return hay.includes(logNeedle);
  });
  const filteredMatchesLogs = (Array.isArray(matches.logs) ? matches.logs : [])
    .filter((line) => (!logNeedle ? true : String(line || "").toLowerCase().includes(logNeedle)))
    .slice(0, 8);
  const toggleFiltersCollapsed = () => {
    setFiltersCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(filtersCollapsedKey, next ? "1" : "0");
      } catch (_) {}
      return next;
    });
  };

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-timer icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Логи и процессы
              <div className="page-title-subheading">Сводка фоновых задач и очередей в одном месте.</div>
            </div>
          </div>
          <div className="page-title-actions">
            <button className="btn btn-info" onClick={() => loadOverview()}>🔄 Обновить сейчас</button>
          </div>
        </div>
      </div>

      <DatagonCard
        title="Фильтры и действия"
        actions={<button className="btn btn-sm btn-outline-secondary" onClick={toggleFiltersCollapsed}>{filtersCollapsed ? "Развернуть" : "Свернуть"}</button>}
      >
        {!filtersCollapsed ? (
        <div className="row g-2">
          <div className="col-md-5">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={smartSearch}
              onChange={(e) => setSmartSearch(e.target.value)}
              placeholder='task:error status:failed или просто текст'
            />
          </div>
          <div className="col-md-4">
            <label className="form-label">Мой сайт (сопоставление)</label>
            <select
              className="form-select"
              value={siteId}
              onChange={(e) => {
                setSiteId(e.target.value);
                loadOverview(e.target.value);
              }}
            >
              {matchesSites.length ? matchesSites.map((s) => <option key={s.id} value={String(s.id)}>{s.name || `Сайт #${s.id}`}</option>) : <option value="">Нет сайтов</option>}
            </select>
          </div>
          <div className="col-md-3 d-flex align-items-end">
            <button className="btn btn-sm btn-outline-primary w-100" onClick={() => loadOverview()}>Обновить сейчас</button>
          </div>
        </div>
        ) : null}
      </DatagonCard>

      <DatagonCard title="Глобальная синхронизация товаров">
        <div><b>Статус:</b> {globalSync.active ? "В процессе" : "Не активен"}</div>
        <div><b>Сообщение:</b> {globalSync.message || "-"}</div>
        <div><b>Прогресс:</b> {fmtNum(globalSync.processed)}/{fmtNum(globalSync.total)}</div>
      </DatagonCard>

      <DatagonCard title="Синхронизация МойСклад" actions={<button className="btn btn-warning btn-sm" onClick={stopMsSync}>⏹ Остановить</button>}>
        <div><b>Статус:</b> {moysklad.active ? "В процессе" : (moysklad.done ? "Завершен" : "Ожидание")}</div>
        <div><b>Сообщение:</b> {moysklad.message || "-"}</div>
        <div><b>Прогресс:</b> {fmtNum(moysklad.processed)}/{fmtNum(moysklad.total)}</div>
        <div className="small text-muted mt-2">
          {filteredMoyskladLogs.map((line, idx) => <div key={idx}>• {line}</div>)}
        </div>
      </DatagonCard>

      <DatagonCard title="Автосинхронизация по расписанию">
        <div><b>Сейчас (МСК):</b> {(autoSync.now_moscow_date || "-")} {(autoSync.now_moscow_time || "-")}</div>
        <div><b>Продукты:</b> {autoSync.config?.myproducts_enabled ? "включено" : "выключено"} ({autoSync.config?.myproducts_time || "-"})</div>
        <div><b>МойСклад:</b> {autoSync.config?.moysklad_enabled ? "включено" : "выключено"} ({autoSync.config?.moysklad_time || "-"})</div>
        <div><b>Исполнитель:</b> {autoSync.runner_active ? "выполняется" : "ожидание"}</div>
        <div><b>Очередь задач:</b> {Array.isArray(autoSync.queue) && autoSync.queue.length ? autoSync.queue.join(" → ") : "пусто"}</div>
        <div className="small text-muted mt-2">
          <div><b>Последние автозапуски:</b></div>
          {filteredAutoSyncRuns.length ? filteredAutoSyncRuns.map((r) => (
            <div key={r.id}>• {r.task_type || "-"} — {r.status || "-"} | старт: {fmtDateTime(r.started_at)} | финиш: {fmtDateTime(r.finished_at)}{r.message ? ` | ${r.message}` : ""}</div>
          )) : <div>История автозапусков пока пуста</div>}
        </div>
      </DatagonCard>

      <DatagonCard title="Автообход URL (robots/sitemap)">
        <div className="small text-muted">
          {filteredDiscovery.length ? filteredDiscovery.map((r, idx) => (
            <div key={`${r.project_id}-${idx}`}>
              • <b>Проект #{r.project_id}</b> — {r.active ? "выполняется" : "завершен"}{r.cancel_requested ? " (остановка запрошена)" : ""} | старт: {fmtDateTime(r.started_at)} | финиш: {fmtDateTime(r.finished_at)} | найдено: {fmtNum(r.discovered)} | новых: {fmtNum(r.added)} | {r.message || "-"}
            </div>
          )) : <div>Запусков автообхода пока не было</div>}
        </div>
      </DatagonCard>

      <DatagonCard title="Очередь парсинга страниц">
        <div><b>Всего:</b> {fmtNum(queue.total)}</div>
        <div><b>pending:</b> {fmtNum(queue.pending)} | <b>processing:</b> {fmtNum(queue.processing)} | <b>done:</b> {fmtNum(queue.done)} | <b>error:</b> {fmtNum(queue.error)}</div>
      </DatagonCard>

      <DatagonCard
        title="Сопоставление товаров"
      >
        <div><b>Статус:</b> {matches.active ? "В процессе" : (matches.status || "Ожидание")}</div>
        <div><b>Сообщение:</b> {matches.message || "-"}</div>
        <div><b>Прогресс:</b> {fmtNum(matches.processed)}/{fmtNum(matches.total)}, найдено: {fmtNum(matches.found)}</div>
        <div><b>SKU:</b> {fmtNum(matches.foundSku)} | <b>Name:</b> {fmtNum(matches.foundName)}</div>
        <div className="small text-muted mt-2">
          {filteredMatchesLogs.map((line, idx) => <div key={idx}>• {line}</div>)}
        </div>
      </DatagonCard>

      {loading && !overview ? <div className="small text-muted">Загрузка...</div> : null}
    </div>
  );
};

export default ProcessesPage;

