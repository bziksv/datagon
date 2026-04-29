import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import DatagonCard from "./DatagonCard";

const emptyProject = {
  name: "",
  domain: "",
  selector_price: "",
  selector_name: "",
  selector_sku: "",
  selector_oos: "",
};

const sortArrow = (active, dir) => (active ? (dir === "asc" ? " ▲" : " ▼") : "");

const ProjectsPage = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState("id");
  const [sortDir, setSortDir] = useState("desc");
  const [smartSearch, setSmartSearch] = useState("");
  const [tableFilters, setTableFilters] = useState({
    id: "",
    name: "",
    domain: "",
    pages_min: "",
    pages_max: "",
  });
  const filtersCollapsedKey = "datagon_projects_filters_collapsed_v1";
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(filtersCollapsedKey) === "1";
    } catch (_) {
      return false;
    }
  });
  const [createForm, setCreateForm] = useState(emptyProject);
  const [editProject, setEditProject] = useState(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ sort_by: sortBy, sort_dir: sortDir });
      const res = await fetch(`/api/projects?${qs.toString()}`);
      const json = await res.json().catch(() => []);
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить проекты");
      setProjects(Array.isArray(json) ? json : []);
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки проектов");
    } finally {
      setLoading(false);
    }
  }, [sortBy, sortDir]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const setSort = (field) => {
    if (sortBy === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("asc");
    }
  };

  const createProject = async () => {
    if (!createForm.name.trim() || !createForm.selector_price.trim()) {
      toast.error("Заполните название и селектор цены");
      return;
    }
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось создать проект");
      toast.success("Проект создан");
      setCreateForm(emptyProject);
      loadProjects();
    } catch (e) {
      toast.error(e.message || "Ошибка создания проекта");
    }
  };

  const deleteProject = async (p) => {
    if (!window.confirm(`Удалить проект "${p.name}" и связанные страницы?`)) return;
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось удалить проект");
      toast.success("Проект удален");
      loadProjects();
    } catch (e) {
      toast.error(e.message || "Ошибка удаления проекта");
    }
  };

  const saveEdit = async () => {
    if (!editProject) return;
    try {
      const res = await fetch(`/api/projects/${editProject.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editProject.name || "",
          domain: editProject.domain || "",
          selector_price: editProject.selector_price || "",
          selector_name: editProject.selector_name || "",
          selector_sku: editProject.selector_sku || "",
          selector_oos: editProject.selector_oos || "",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить изменения");
      toast.success("Изменения сохранены");
      setEditProject(null);
      loadProjects();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const rows = useMemo(() => {
    const needle = String(smartSearch || "").trim().toLowerCase();
    return projects
      .map((p) => {
        const pending = Number(p.pending_count || 0);
        const processing = Number(p.processing_count || 0);
        const done = Number(p.done_count || 0);
        const error = Number(p.error_count || 0);
        return {
          ...p,
          queueInfo: `⏳ ${pending} | ⚙️ ${processing} | ✅ ${done} | ❌ ${error}`,
        };
      })
      .filter((p) => {
        if (!needle) return true;
        const haystack = `${p.id || ""} ${p.name || ""} ${p.domain || ""}`.toLowerCase();
        return haystack.includes(needle);
      });
  }, [projects, smartSearch]);
  const filteredRows = useMemo(() => {
    return rows.filter((p) => {
      if (tableFilters.id && !String(p.id || "").includes(String(tableFilters.id).trim())) return false;
      if (tableFilters.name && !String(p.name || "").toLowerCase().includes(String(tableFilters.name).trim().toLowerCase())) return false;
      if (tableFilters.domain && !String(p.domain || "").toLowerCase().includes(String(tableFilters.domain).trim().toLowerCase())) return false;
      const pages = Number(p.pages_count || 0);
      const min = Number(tableFilters.pages_min || "");
      const max = Number(tableFilters.pages_max || "");
      if (Number.isFinite(min) && String(tableFilters.pages_min).trim() !== "" && pages < min) return false;
      if (Number.isFinite(max) && String(tableFilters.pages_max).trim() !== "" && pages > max) return false;
      return true;
    });
  }, [rows, tableFilters]);
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
              <i className="pe-7s-portfolio icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Проекты конкурентов
              <div className="page-title-subheading">Создание и управление проектами парсинга по конкурентным сайтам.</div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard title="Новый проект (Конкурент)">
        <div className="row g-2">
          <div className="col-md-4"><label className="form-label">Название</label><input className="form-control" value={createForm.name} onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))} placeholder="Сайт А" /></div>
          <div className="col-md-4"><label className="form-label">Домен</label><input className="form-control" value={createForm.domain} onChange={(e) => setCreateForm((p) => ({ ...p, domain: e.target.value }))} placeholder="site.ru" /></div>
          <div className="col-md-4"><label className="form-label">Селектор ЦЕНЫ</label><input className="form-control" value={createForm.selector_price} onChange={(e) => setCreateForm((p) => ({ ...p, selector_price: e.target.value }))} placeholder=".price" /></div>
          <div className="col-md-4"><label className="form-label">Селектор НАЗВАНИЯ</label><input className="form-control" value={createForm.selector_name} onChange={(e) => setCreateForm((p) => ({ ...p, selector_name: e.target.value }))} placeholder="h1" /></div>
          <div className="col-md-4"><label className="form-label">Селектор SKU</label><input className="form-control" value={createForm.selector_sku} onChange={(e) => setCreateForm((p) => ({ ...p, selector_sku: e.target.value }))} placeholder=".sku" /></div>
          <div className="col-md-4"><label className="form-label">Селектор ПОД ЗАКАЗ</label><input className="form-control" value={createForm.selector_oos} onChange={(e) => setCreateForm((p) => ({ ...p, selector_oos: e.target.value }))} placeholder=".out-of-stock" /></div>
        </div>
        <div className="mt-3">
          <button className="btn btn-success" onClick={createProject}>➕ Создать проект</button>
        </div>
      </DatagonCard>

      <DatagonCard
        title="Фильтры и действия"
        actions={<button className="btn btn-sm btn-outline-secondary" onClick={toggleFiltersCollapsed}>{filtersCollapsed ? "Развернуть" : "Свернуть"}</button>}
      >
        {!filtersCollapsed ? (
        <div className="row g-2">
          <div className="col-md-4">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={smartSearch}
              onChange={(e) => setSmartSearch(e.target.value)}
              placeholder='id:12 name:"project" или просто текст'
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">ID</label>
            <input className="form-control" value={tableFilters.id} onChange={(e) => setTableFilters((p) => ({ ...p, id: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Имя проекта</label>
            <input className="form-control" value={tableFilters.name} onChange={(e) => setTableFilters((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Домен</label>
            <input className="form-control" value={tableFilters.domain} onChange={(e) => setTableFilters((p) => ({ ...p, domain: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Страниц от</label>
            <input className="form-control" type="number" value={tableFilters.pages_min} onChange={(e) => setTableFilters((p) => ({ ...p, pages_min: e.target.value }))} />
          </div>
          <div className="col-md-1">
            <label className="form-label">Страниц до</label>
            <input className="form-control" type="number" value={tableFilters.pages_max} onChange={(e) => setTableFilters((p) => ({ ...p, pages_max: e.target.value }))} />
          </div>
          <div className="col-md-3">
            <label className="form-label">Сортировать по</label>
            <select className="form-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="id">ID</option>
              <option value="name">Имя</option>
              <option value="domain">Домен</option>
              <option value="pages_count">Страниц</option>
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label">Направление</label>
            <select className="form-select" value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
              <option value="asc">По возрастанию</option>
              <option value="desc">По убыванию</option>
            </select>
          </div>
          <div className="col-md-2 d-flex align-items-end">
            <button className="btn btn-sm btn-outline-primary w-100" onClick={loadProjects}>Обновить</button>
          </div>
        </div>
        ) : null}
      </DatagonCard>

      <DatagonCard title="Список проектов">
        <div className="table-responsive">
          <table className="table table-striped table-hover mb-0">
            <thead>
              <tr>
                <th role="button" onClick={() => setSort("id")}>ID{sortArrow(sortBy === "id", sortDir)}</th>
                <th role="button" onClick={() => setSort("name")}>Имя{sortArrow(sortBy === "name", sortDir)}</th>
                <th role="button" onClick={() => setSort("domain")}>Домен{sortArrow(sortBy === "domain", sortDir)}</th>
                <th role="button" onClick={() => setSort("pages_count")}>Страниц{sortArrow(sortBy === "pages_count", sortDir)}</th>
                <th>Очередь</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan="6" className="text-muted">{loading ? "Загрузка..." : "Нет проектов"}</td></tr>
              ) : filteredRows.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td><b>{p.name}</b><div className="small text-muted">{p.domain}</div></td>
                  <td>{p.domain}</td>
                  <td>{Number(p.pages_count || 0)}</td>
                  <td><small>{p.queueInfo}</small></td>
                  <td className="text-nowrap">
                    <button className="btn btn-warning btn-sm me-1 mb-1" onClick={() => setEditProject({ ...p })}>✏️ Изменить</button>
                    <button className="btn btn-danger btn-sm mb-1" onClick={() => deleteProject(p)}>🗑️ Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DatagonCard>

      {editProject ? (
        <DatagonCard title={`Редактировать проект #${editProject.id}`}>
          <div className="row g-2">
            <div className="col-md-4"><label className="form-label">Название</label><input className="form-control" value={editProject.name || ""} onChange={(e) => setEditProject((p) => ({ ...p, name: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Домен</label><input className="form-control" value={editProject.domain || ""} onChange={(e) => setEditProject((p) => ({ ...p, domain: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Селектор ЦЕНЫ</label><input className="form-control" value={editProject.selector_price || ""} onChange={(e) => setEditProject((p) => ({ ...p, selector_price: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Селектор НАЗВАНИЯ</label><input className="form-control" value={editProject.selector_name || ""} onChange={(e) => setEditProject((p) => ({ ...p, selector_name: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Селектор SKU</label><input className="form-control" value={editProject.selector_sku || ""} onChange={(e) => setEditProject((p) => ({ ...p, selector_sku: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Селектор ПОД ЗАКАЗ</label><input className="form-control" value={editProject.selector_oos || ""} onChange={(e) => setEditProject((p) => ({ ...p, selector_oos: e.target.value }))} /></div>
          </div>
          <div className="mt-3 d-flex gap-2">
            <button className="btn btn-success" onClick={saveEdit}>💾 Сохранить изменения</button>
            <button className="btn btn-outline-secondary" onClick={() => setEditProject(null)}>Отмена</button>
          </div>
        </DatagonCard>
      ) : null}
    </div>
  );
};

export default ProjectsPage;

