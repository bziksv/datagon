import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { UncontrolledTooltip } from "reactstrap";
import DatagonCard from "./DatagonCard";

const num = (v) => Number(v || 0).toLocaleString("ru-RU");
const fmtDate = (v) => {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ru-RU");
};
const pct = (part, total) => {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((p / t) * 100)));
};
const fmtMb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;

const DashboardPage = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/processes/overview");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ошибка загрузки дашборда");
      setData(json);
      setRefreshedAt(json.refreshedAt || new Date().toISOString());
    } catch (e) {
      toast.error(e.message || "Не удалось загрузить dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    const timer = setInterval(loadDashboard, 15000);
    return () => clearInterval(timer);
  }, [loadDashboard]);

  const startGlobalSync = async () => {
    try {
      const res = await fetch("/api/sync-all-start", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || json.message || "Не удалось запустить синхронизацию");
      toast.success(json.message || "Синхронизация запущена");
      loadDashboard();
    } catch (e) {
      toast.error(e.message || "Ошибка запуска синхронизации");
    }
  };

  const queue = data?.queue || {};
  const globalSync = data?.globalSync || {};
  const moysklad = data?.moysklad || {};
  const matches = data?.matches || {};
  const runtime = data?.runtime || {};
  const memory = runtime.memory || {};
  const discovery = Array.isArray(data?.discovery) ? data.discovery.filter((x) => x.active) : [];

  const health = useMemo(() => {
    const hasQueueErrors = Number(queue.error || 0) > 0;
    const hasRunning = Boolean(globalSync.active) || Boolean(moysklad.active) || discovery.length > 0;
    if (hasQueueErrors) return { label: "Есть проблемы", tone: "danger" };
    if (hasRunning) return { label: "Рабочая активность", tone: "warning" };
    return { label: "Стабильно", tone: "success" };
  }, [queue.error, globalSync.active, moysklad.active, discovery.length]);

  const loadState = useMemo(() => {
    const activeWorkers = (globalSync.active ? 1 : 0) + (moysklad.active ? 1 : 0) + discovery.length + (Number(queue.processing || 0) > 0 ? 1 : 0);
    const cpu = Number(runtime.cpuPercent || 0);
    const rssPercent = Number(memory.rssPercentOfSystem || 0);
    const score = (cpu >= 75 ? 2 : cpu >= 40 ? 1 : 0) + (rssPercent >= 40 ? 2 : rssPercent >= 20 ? 1 : 0) + (activeWorkers >= 3 ? 1 : 0);
    if (score >= 4) return { label: "Высокая", tone: "danger", score };
    if (score >= 2) return { label: "Средняя", tone: "warning", score };
    return { label: "Низкая", tone: "success", score };
  }, [globalSync.active, moysklad.active, discovery.length, queue.processing, runtime.cpuPercent, memory.rssPercentOfSystem]);

  const autoRuns = Array.isArray(data?.autoSyncRuns) ? data.autoSyncRuns.slice(0, 8) : [];

  return (
    <div>
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-rocket icon-gradient bg-mean-fruit"> </i>
            </div>
            <div>
              Датагон Dashboard
              <div className="page-title-subheading">
                Оперативный обзор очередей, синхронизаций и состояния системы.
              </div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard title="Сводка" hint={`Обновлено: ${fmtDate(refreshedAt)}${loading ? " (загрузка...)" : ""}`}>
        <div className="row">
          <div className="col-md-3">
            <div className="card card-body mb-2">
              <div className="text-muted"><i className="pe-7s-note2 me-1" />Очередь: всего</div>
              <h4 className="mb-0">{num(queue.total)}</h4>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card card-body mb-2">
              <div className="text-muted"><i className="pe-7s-check me-1" />Очередь: готово</div>
              <h4 className="mb-0">{num(queue.done)} ({pct(queue.done, queue.total)}%)</h4>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card card-body mb-2">
              <div className="text-muted"><i className="pe-7s-attention me-1" />Очередь: ошибки</div>
              <h4 className="mb-0">{num(queue.error)}</h4>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card card-body mb-2">
              <div className="text-muted"><i className="pe-7s-shield me-1" />Здоровье</div>
              <h4 className="mb-0"><span className={`badge bg-${health.tone}`}>{health.label}</span></h4>
            </div>
          </div>
        </div>
      </DatagonCard>

      <div className="row">
        <div className="col-md-6">
          <DatagonCard title="Глобальная синхронизация" hint={globalSync.active ? "Выполняется" : "Ожидание"}>
            <div>Прогресс: <b>{num(globalSync.processed)}/{num(globalSync.total)}</b> ({pct(globalSync.processed, globalSync.total)}%)</div>
            <div className="text-muted">Сообщение: {globalSync.message || "-"}</div>
          </DatagonCard>
        </div>
        <div className="col-md-6">
          <DatagonCard title="МойСклад" hint={moysklad.active ? "Синхронизация идет" : "Ожидание"}>
            <div>Прогресс: <b>{num(moysklad.processed)}/{num(moysklad.total)}</b> ({pct(moysklad.processed, moysklad.total)}%)</div>
            <div className="text-muted">Обновлено: {fmtDate(moysklad.updatedAt)}</div>
            <div className="text-muted">Сообщение: {moysklad.message || "-"}</div>
          </DatagonCard>
        </div>
      </div>

      <div className="row">
        <div className="col-md-6">
          <DatagonCard title="Сопоставление" hint={matches.status || "idle"}>
            <div>Сайт: <b>{num(matches.mySiteId)}</b></div>
            <div>Прогресс: <b>{num(matches.processed)}/{num(matches.total)}</b></div>
            <div>Найдено SKU/Название: <b>{num(matches.foundSku)}/{num(matches.foundName)}</b></div>
          </DatagonCard>
        </div>
        <div className="col-md-6">
          <DatagonCard title="Нагрузка" hint={<span className={`badge bg-${loadState.tone}`}>{loadState.label}</span>}>
            <div>CPU процесса: <b>{Number(runtime.cpuPercent || 0).toFixed(1)}%</b></div>
            <div>RAM процесса (RSS): <b>{fmtMb(memory.rssBytes)} ({Number(memory.rssPercentOfSystem || 0).toFixed(1)}%)</b></div>
            <div>Uptime: <b>{num(runtime.uptimeSec)} сек</b></div>
            <div className="text-muted">Оценка: {loadState.score}/5</div>
          </DatagonCard>
        </div>
      </div>

      <DatagonCard title="Последние автозапуски" hint={`Записей: ${autoRuns.length}`}>
        {autoRuns.length === 0 ? (
          <div className="text-muted">История пока пустая</div>
        ) : (
          <ul className="mb-0">
            {autoRuns.map((r) => (
              <li key={`${r.id || ""}-${r.started_at || ""}`}>
                <b>{r.task_type || "-"}</b> · {r.status || "-"} · старт: {fmtDate(r.started_at)} · финиш: {fmtDate(r.finished_at)}
              </li>
            ))}
          </ul>
        )}
      </DatagonCard>

      <DatagonCard title="Быстрые действия" hint="Операции управления процессами">
        <div className="d-flex flex-wrap gap-2">
          <button id="dashboard-sync-all" className="btn btn-primary" onClick={startGlobalSync}><i className="pe-7s-repeat me-1" />Запустить синхронизацию всех сайтов</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="dashboard-sync-all">Запустить глобальную синхронизацию товаров по всем сайтам</UncontrolledTooltip>
          <button id="dashboard-refresh" className="btn btn-outline-primary" onClick={loadDashboard}><i className="pe-7s-refresh me-1" />Обновить дашборд</button>
          <UncontrolledTooltip delay={{ show: 80, hide: 0 }} placement="top" target="dashboard-refresh">Обновить метрики дашборда вручную</UncontrolledTooltip>
          <a className="btn btn-outline-secondary" href="/my-products?ms_linked=0&limit=50"><i className="pe-7s-box2 me-1" />Товары без связи с МС</a>
          <a className="btn btn-outline-secondary" href="/moysklad?archived=active&stock_position=yes&limit=100"><i className="pe-7s-shopbag me-1" />МойСклад: активные складские</a>
          <a className="btn btn-outline-secondary" href="/matches?status=pending&mode=all"><i className="pe-7s-link me-1" />Сопоставление: pending</a>
        </div>
      </DatagonCard>
    </div>
  );
};

export default DashboardPage;
