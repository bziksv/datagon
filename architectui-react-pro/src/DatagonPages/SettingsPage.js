import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import DatagonCard from "./DatagonCard";

const defaults = {
  default_limit: 100,
  parse_batch_size: 50,
  page_delay_ms: 0,
  results_retention_days: 120,
  discover_max_sitemaps: 200,
  discover_max_urls: 50000,
  discover_crawl_max_pages: 500,
  discover_request_delay_ms: 100,
  auth_session_ttl_days: 14,
  auth_session_user_limit: 1,
  sync_batch_size: 500,
  sync_delay_ms: 2000,
  sync_mode: "always",
  ms_sync_page_limit: 1000,
  ms_sync_delay_ms: 0,
  auto_sync_myproducts_enabled: 0,
  auto_sync_myproducts_time: "03:00",
  auto_sync_moysklad_enabled: 0,
  auto_sync_moysklad_time: "04:00",
  log_retention_days: 7,
};

const buildUsernameFromFullName = (fullName) => {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const source = String(fullName || "").trim().toLowerCase();
  let out = "";
  for (const ch of source) out += map[ch] !== undefined ? map[ch] : ch;
  return out
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const randomPassword = (length = 18) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";
  const randomBytes = new Uint32Array(length);
  crypto.getRandomValues(randomBytes);
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[randomBytes[i] % chars.length];
  return out;
};

const SettingsPage = () => {
  const [settings, setSettings] = useState(defaults);
  const [logsInfo, setLogsInfo] = useState("Загрузка информации о логах...");
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState({ full_name: "", username: "", password: "" });
  const [editUser, setEditUser] = useState(null);
  const [passwordForm, setPasswordForm] = useState({ username: "admin", newPassword: "", length: 15 });
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersSmartSearch, setUsersSmartSearch] = useState("");
  const [usersTableFilters, setUsersTableFilters] = useState({
    can_manage_users: "all",
    sessions_min: "",
    sessions_max: "",
  });

  const currentUser = window.localStorage.getItem("currentUser") || "admin";
  const isAdmin = window.localStorage.getItem("isAdmin") === "true" || currentUser === "admin";
  const canManageUsers = isAdmin || window.localStorage.getItem("canManageUsers") === "true";

  const authHeaders = useCallback((withJson = false) => {
    const headers = {};
    const username = window.localStorage.getItem("currentUser");
    const token = window.localStorage.getItem("authToken");
    if (username) headers["x-auth-username"] = username;
    if (token) headers["x-auth-token"] = token;
    if (withJson) headers["Content-Type"] = "application/json";
    return headers;
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить настройки");
      setSettings((prev) => ({ ...prev, ...json }));
      if (!isAdmin) setPasswordForm((p) => ({ ...p, username: currentUser }));
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки настроек");
    }
  }, [currentUser, isAdmin]);

  const loadLogsInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/logs-info");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось получить информацию о логах");
      const rows = Array.isArray(json.data) ? json.data : [];
      if (!rows.length) {
        setLogsInfo("Логи не найдены");
        return;
      }
      setLogsInfo(rows.map((r) => {
        const mb = (Number(r.size_bytes || 0) / (1024 * 1024)).toFixed(2);
        const mtime = r.modified_at ? new Date(r.modified_at).toLocaleString("ru-RU") : "нет файла";
        return `${r.name}: ${mb} MB (обновлен: ${mtime})`;
      }).join("\n"));
    } catch (e) {
      setLogsInfo(`Ошибка чтения логов: ${e.message}`);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/auth/users", { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить пользователей");
      setUsers(Array.isArray(json.data) ? json.data : []);
    } catch (e) {
      toast.error(e.message || "Ошибка загрузки пользователей");
    } finally {
      setLoadingUsers(false);
    }
  }, [authHeaders, isAdmin]);

  useEffect(() => {
    loadSettings();
    loadLogsInfo();
    loadUsers();
  }, [loadSettings, loadLogsInfo, loadUsers]);

  const upsertSettings = async (payload, okText) => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить");
      toast.success(okText);
      loadSettings();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const saveGeneral = () => upsertSettings({
    default_limit: settings.default_limit,
    parse_batch_size: settings.parse_batch_size,
    page_delay_ms: settings.page_delay_ms,
    results_retention_days: settings.results_retention_days,
    auth_session_ttl_days: settings.auth_session_ttl_days,
    auth_session_user_limit: settings.auth_session_user_limit,
    discover_max_sitemaps: settings.discover_max_sitemaps,
    discover_max_urls: settings.discover_max_urls,
    discover_crawl_max_pages: settings.discover_crawl_max_pages,
    discover_request_delay_ms: settings.discover_request_delay_ms,
    log_retention_days: settings.log_retention_days,
  }, "Общие настройки сохранены");

  const saveMyProductsSync = async () => {
    try {
      const res = await fetch("/api/settings/sync-myproducts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sync_batch_size: settings.sync_batch_size,
          sync_delay_ms: settings.sync_delay_ms,
          sync_mode: settings.sync_mode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить");
      toast.success("Настройки синхронизации продуктов сохранены");
      loadSettings();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const saveMoyskladSync = async () => {
    try {
      const res = await fetch("/api/settings/sync-moysklad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ms_sync_page_limit: settings.ms_sync_page_limit,
          ms_sync_delay_ms: settings.ms_sync_delay_ms,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить");
      toast.success("Настройки синхронизации МойСклад сохранены");
      loadSettings();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения");
    }
  };

  const saveAutoSync = () => upsertSettings({
    auto_sync_myproducts_enabled: Number(settings.auto_sync_myproducts_enabled) === 1,
    auto_sync_myproducts_time: settings.auto_sync_myproducts_time || "03:00",
    auto_sync_moysklad_enabled: Number(settings.auto_sync_moysklad_enabled) === 1,
    auto_sync_moysklad_time: settings.auto_sync_moysklad_time || "04:00",
  }, "Расписание автосинхронизации сохранено");

  const clearLogsNow = async () => {
    if (!window.confirm("Очистить server.log и worker.log прямо сейчас?")) return;
    try {
      const res = await fetch("/api/settings/logs-clear", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось очистить логи");
      toast.success("Логи очищены");
      loadLogsInfo();
    } catch (e) {
      toast.error(e.message || "Ошибка очистки логов");
    }
  };

  const createUser = async () => {
    if (!canManageUsers) return toast.error("Недостаточно прав");
    if (!newUser.full_name.trim()) return toast.error("Введите Имя Фамилия");
    if (!newUser.username.trim()) return toast.error("Введите логин");
    if ((newUser.password || "").length < 15) return toast.error("Пароль должен быть не короче 15 символов");
    try {
      const res = await fetch("/api/auth/users", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(newUser),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось создать пользователя");
      toast.success("Пользователь добавлен");
      setNewUser({ full_name: "", username: "", password: "" });
      loadUsers();
    } catch (e) {
      toast.error(e.message || "Ошибка создания пользователя");
    }
  };

  const updatePermission = async (user, enabled) => {
    try {
      const res = await fetch(`/api/auth/users/${user.id}/permissions`, {
        method: "PUT",
        headers: authHeaders(true),
        body: JSON.stringify({ can_manage_users: enabled ? 1 : 0 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось изменить право");
      loadUsers();
    } catch (e) {
      toast.error(e.message || "Ошибка изменения прав");
    }
  };

  const revokeSessions = async (user) => {
    if (!window.confirm(`Завершить все активные сессии пользователя "${user.username}"?`)) return;
    try {
      const res = await fetch(`/api/auth/users/${user.id}/revoke-sessions`, { method: "POST", headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось завершить сессии");
      toast.success("Сессии завершены");
      loadUsers();
    } catch (e) {
      toast.error(e.message || "Ошибка завершения сессий");
    }
  };

  const deleteUser = async (user) => {
    if (!window.confirm(`Удалить пользователя "${user.username}"?`)) return;
    try {
      const res = await fetch(`/api/auth/users/${user.id}`, { method: "DELETE", headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось удалить пользователя");
      toast.success("Пользователь удален");
      loadUsers();
    } catch (e) {
      toast.error(e.message || "Ошибка удаления");
    }
  };

  const saveEditedUser = async () => {
    if (!editUser) return;
    if (!editUser.full_name || editUser.full_name.trim().length < 3) return toast.error("Имя должно быть не короче 3 символов");
    if (!editUser.username || editUser.username.trim().length < 3) return toast.error("Логин должен быть не короче 3 символов");
    try {
      const res = await fetch(`/api/auth/users/${editUser.id}`, {
        method: "PUT",
        headers: authHeaders(true),
        body: JSON.stringify({ username: editUser.username.trim(), full_name: editUser.full_name.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сохранить");
      toast.success("Пользователь обновлен");
      setEditUser(null);
      loadUsers();
    } catch (e) {
      toast.error(e.message || "Ошибка сохранения пользователя");
    }
  };

  const loginAsUser = async (username) => {
    if (!isAdmin) {
      toast.error("Только admin может переключаться на других пользователей");
      return;
    }
    const password = window.prompt(`Введите пароль пользователя "${username}" для входа:`);
    if (password === null) return;
    if (!password) {
      toast.error("Пароль не введен");
      return;
    }
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось войти");
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("currentUser", json.username || username);
      window.localStorage.setItem("currentUserDisplayName", json.full_name || json.username || username);
      window.localStorage.setItem("isAdmin", json.isAdmin ? "true" : "false");
      window.localStorage.setItem("canManageUsers", json.canManageUsers ? "true" : "false");
      if (json.auth_token) window.localStorage.setItem("authToken", json.auth_token);
      toast.success(`Вы вошли как ${json.username || username}`);
      window.location.reload();
    } catch (e) {
      toast.error(e.message || "Ошибка входа");
    }
  };

  const changePassword = async () => {
    if (!passwordForm.username.trim()) return toast.error("Введите логин");
    if ((passwordForm.newPassword || "").length < 15) return toast.error("Пароль должен быть не короче 15 символов");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ username: passwordForm.username.trim(), newPassword: passwordForm.newPassword }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "Не удалось сменить пароль");
      toast.success("Пароль успешно изменен");
      setPasswordForm((p) => ({ ...p, newPassword: "" }));
    } catch (e) {
      toast.error(e.message || "Ошибка смены пароля");
    }
  };

  const logsInfoRows = useMemo(() => String(logsInfo || "").split("\n"), [logsInfo]);
  const filteredUsers = useMemo(() => {
    const needle = String(usersSmartSearch || "").trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) => {
      const haystack = `${u.id || ""} ${u.full_name || ""} ${u.username || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
      const canManage = (u.username === "admin" || Number(u.can_manage_users || 0) === 1) ? "1" : "0";
      if (usersTableFilters.can_manage_users !== "all" && canManage !== usersTableFilters.can_manage_users) return false;
      const activeSessions = Number(u.active_sessions || 0);
      const min = Number(usersTableFilters.sessions_min || "");
      const max = Number(usersTableFilters.sessions_max || "");
      if (Number.isFinite(min) && String(usersTableFilters.sessions_min).trim() !== "" && activeSessions < min) return false;
      if (Number.isFinite(max) && String(usersTableFilters.sessions_max).trim() !== "" && activeSessions > max) return false;
      return true;
    });
  }, [users, usersSmartSearch, usersTableFilters]);

  return (
    <div className="datagon-settings-page">
      <div className="app-page-title">
        <div className="page-title-wrapper">
          <div className="page-title-heading">
            <div className="page-title-icon">
              <i className="pe-7s-config icon-gradient bg-happy-fisher" />
            </div>
            <div>
              Настройки
              <div className="page-title-subheading">Управление параметрами парсинга, синхронизаций, безопасностью и пользователями.</div>
            </div>
          </div>
        </div>
      </div>

      <DatagonCard title="Пользователи системы" hint={isAdmin ? "Admin может управлять списком пользователей" : "Список пользователей доступен только admin"}>
        <div className="datagon-users-panel">
        <p className="small text-muted">Admin может выдавать отдельное право: создание новых пользователей.</p>
        <div className="row g-2 mb-2">
          <div className="col-md-6">
            <label className="form-label">Умный поиск</label>
            <input
              className="form-control"
              value={usersSmartSearch}
              onChange={(e) => setUsersSmartSearch(e.target.value)}
              placeholder='id:12 username:admin или просто текст'
              disabled={!isAdmin}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label">Право создавать</label>
            <select className="form-select" value={usersTableFilters.can_manage_users} onChange={(e) => setUsersTableFilters((p) => ({ ...p, can_manage_users: e.target.value }))} disabled={!isAdmin}>
              <option value="all">Все</option>
              <option value="1">Разрешено</option>
              <option value="0">Запрещено</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label">Сессий от</label>
            <input className="form-control" type="number" min="0" value={usersTableFilters.sessions_min} onChange={(e) => setUsersTableFilters((p) => ({ ...p, sessions_min: e.target.value }))} disabled={!isAdmin} />
          </div>
          <div className="col-md-2">
            <label className="form-label">Сессий до</label>
            <input className="form-control" type="number" min="0" value={usersTableFilters.sessions_max} onChange={(e) => setUsersTableFilters((p) => ({ ...p, sessions_max: e.target.value }))} disabled={!isAdmin} />
          </div>
        </div>
        <div className="row g-2 align-items-end datagon-users-create-grid">
          <div className="col-md-4 col-lg-4">
            <label className="form-label">Имя Фамилия нового пользователя</label>
            <input className="form-control" value={newUser.full_name} disabled={!canManageUsers} onChange={(e) => {
              const full_name = e.target.value;
              setNewUser((p) => ({ ...p, full_name, username: buildUsernameFromFullName(full_name) }));
            }} />
          </div>
          <div className="col-md-3 col-lg-3">
            <label className="form-label">Логин нового пользователя</label>
            <input className="form-control" value={newUser.username} disabled={!canManageUsers} onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))} />
          </div>
          <div className="col-md-5 col-lg-5">
            <label className="form-label">Пароль (15+ символов)</label>
            <div className="d-flex gap-2 datagon-users-password-row">
              <input className="form-control" type={showNewUserPassword ? "text" : "password"} value={newUser.password} disabled={!canManageUsers} onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))} />
              <button className="btn btn-outline-secondary" onClick={() => setShowNewUserPassword((v) => !v)} disabled={!canManageUsers}>👁</button>
              <button className="btn btn-outline-secondary" onClick={async () => { try { await navigator.clipboard.writeText(newUser.password || ""); toast.success("Пароль скопирован"); } catch (_) {} }} disabled={!canManageUsers || !newUser.password}>📋</button>
            </div>
          </div>
        </div>
        <div className="mt-2 d-flex gap-2 flex-wrap datagon-users-actions">
          <button className="btn btn-primary" onClick={() => setNewUser((p) => ({ ...p, password: randomPassword(18) }))} disabled={!canManageUsers}>🎲 Сгенерировать пароль</button>
          <button className="btn btn-success" onClick={createUser} disabled={!canManageUsers}>➕ Добавить пользователя</button>
          <button className="btn btn-info" onClick={loadUsers} disabled={!isAdmin}>🔄 Обновить список</button>
        </div>

        <div className="table-responsive mt-3">
          <table className="table table-striped table-hover mb-0 datagon-users-table">
            <thead><tr><th>ID</th><th>Имя Фамилия</th><th>Логин</th><th>Создание пользователей</th><th>Активных сессий</th><th>Действия</th></tr></thead>
            <tbody>
              {!isAdmin ? (
                <tr><td colSpan="6" className="text-muted">Список пользователей доступен только admin</td></tr>
              ) : filteredUsers.length === 0 ? (
                <tr><td colSpan="6" className="text-muted">{loadingUsers ? "Загрузка..." : "Пользователи не найдены"}</td></tr>
              ) : filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td><b>{u.full_name || u.username}</b></td>
                  <td><b>{u.username}</b>{u.username === "admin" ? " " : null}{u.username === "admin" ? <span className="small text-muted">(встроенный)</span> : null}</td>
                  <td>
                    <label className="d-flex align-items-center gap-2">
                      <input type="checkbox" checked={u.username === "admin" || Number(u.can_manage_users || 0) === 1} disabled={u.username === "admin"} onChange={(e) => updatePermission(u, e.target.checked)} />
                      <span className="small text-muted">{u.username === "admin" ? "всегда включено" : "разрешено"}</span>
                    </label>
                  </td>
                  <td>{Number(u.active_sessions || 0)}</td>
                  <td className="text-nowrap datagon-users-row-actions">
                    <button className="btn btn-info btn-sm me-1 mb-1" onClick={() => loginAsUser(u.username)}>🔐 Войти как</button>
                    <button className="btn btn-secondary btn-sm me-1 mb-1" onClick={() => setEditUser({ id: u.id, username: u.username, full_name: u.full_name || "" })}>✏️ Редактировать</button>
                    <button className="btn btn-warning btn-sm me-1 mb-1" onClick={() => revokeSessions(u)}>⛔ Сбросить сессии</button>
                    {u.username !== "admin" ? <button className="btn btn-danger btn-sm mb-1" onClick={() => deleteUser(u)}>🗑️ Удалить</button> : <span className="small text-muted">Удаление отключено</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      </DatagonCard>

      {editUser ? (
        <DatagonCard title="Редактировать пользователя">
          <div className="row g-2">
            <div className="col-md-5"><label className="form-label">Имя Фамилия</label><input className="form-control" value={editUser.full_name} onChange={(e) => setEditUser((p) => ({ ...p, full_name: e.target.value }))} /></div>
            <div className="col-md-4"><label className="form-label">Логин</label><input className="form-control" readOnly={editUser.username === "admin"} value={editUser.username} onChange={(e) => setEditUser((p) => ({ ...p, username: e.target.value }))} /></div>
            <div className="col-md-3 d-flex align-items-end gap-2"><button className="btn btn-success" onClick={saveEditedUser}>Сохранить</button><button className="btn btn-outline-secondary" onClick={() => setEditUser(null)}>Отмена</button></div>
          </div>
        </DatagonCard>
      ) : null}

      <DatagonCard title="Общие настройки (Парсер конкурентов)">
        <p className="small text-muted">Параметры отображения и работы основного парсера.</p>
        <div className="row g-2">
          <div className="col-md-3"><label className="form-label">Результатов на странице</label><input className="form-control" type="number" value={settings.default_limit} onChange={(e) => setSettings((p) => ({ ...p, default_limit: Number(e.target.value || 100) }))} /></div>
          <div className="col-md-3"><label className="form-label">Размер пакета парсинга</label><input className="form-control" type="number" value={settings.parse_batch_size} onChange={(e) => setSettings((p) => ({ ...p, parse_batch_size: Number(e.target.value || 50) }))} /></div>
          <div className="col-md-3"><label className="form-label">Задержка между страницами (мс)</label><input className="form-control" type="number" value={settings.page_delay_ms} onChange={(e) => setSettings((p) => ({ ...p, page_delay_ms: Number(e.target.value || 0) }))} /></div>
          <div className="col-md-3"><label className="form-label">Хранение результатов (дней)</label><input className="form-control" type="number" value={settings.results_retention_days} onChange={(e) => setSettings((p) => ({ ...p, results_retention_days: Number(e.target.value || 120) }))} /></div>
          <div className="col-md-3"><label className="form-label">Сессия TTL (дней)</label><input className="form-control" type="number" value={settings.auth_session_ttl_days} onChange={(e) => setSettings((p) => ({ ...p, auth_session_ttl_days: Number(e.target.value || 14) }))} /></div>
          <div className="col-md-3"><label className="form-label">Лимит сессий на пользователя</label><input className="form-control" type="number" value={settings.auth_session_user_limit} onChange={(e) => setSettings((p) => ({ ...p, auth_session_user_limit: Number(e.target.value || 1) }))} /></div>
          <div className="col-md-3"><label className="form-label">Автообход: max sitemap</label><input className="form-control" type="number" value={settings.discover_max_sitemaps} onChange={(e) => setSettings((p) => ({ ...p, discover_max_sitemaps: Number(e.target.value || 200) }))} /></div>
          <div className="col-md-3"><label className="form-label">Автообход: max URL</label><input className="form-control" type="number" value={settings.discover_max_urls} onChange={(e) => setSettings((p) => ({ ...p, discover_max_urls: Number(e.target.value || 50000) }))} /></div>
          <div className="col-md-3"><label className="form-label">Fallback crawl pages</label><input className="form-control" type="number" value={settings.discover_crawl_max_pages} onChange={(e) => setSettings((p) => ({ ...p, discover_crawl_max_pages: Number(e.target.value || 500) }))} /></div>
          <div className="col-md-3"><label className="form-label">Автообход delay (мс)</label><input className="form-control" type="number" value={settings.discover_request_delay_ms} onChange={(e) => setSettings((p) => ({ ...p, discover_request_delay_ms: Number(e.target.value || 100) }))} /></div>
        </div>
        <div className="mt-3"><button className="btn btn-success" onClick={saveGeneral}>💾 Сохранить общие настройки</button></div>
      </DatagonCard>

      <DatagonCard title="Синхронизация продуктов (Мои сайты)">
        <p className="small text-muted">Настройки обновления цен и остатков из вашей базы (Bitrix/Webasyst).</p>
        <div className="row g-2">
          <div className="col-md-4"><label className="form-label">Размер пакета</label><input className="form-control" type="number" value={settings.sync_batch_size} onChange={(e) => setSettings((p) => ({ ...p, sync_batch_size: Number(e.target.value || 500) }))} /></div>
          <div className="col-md-4"><label className="form-label">Пауза между пакетами (мс)</label><input className="form-control" type="number" value={settings.sync_delay_ms} onChange={(e) => setSettings((p) => ({ ...p, sync_delay_ms: Number(e.target.value || 2000) }))} /></div>
          <div className="col-md-4"><label className="form-label">Режим обновления цен</label><select className="form-select" value={settings.sync_mode} onChange={(e) => setSettings((p) => ({ ...p, sync_mode: e.target.value }))}><option value="always">Постоянное обновление</option><option value="once">Разовая выгрузка</option></select></div>
        </div>
        <div className="mt-3"><button className="btn btn-success" onClick={saveMyProductsSync}>💾 Сохранить настройки синхронизации продуктов</button></div>
      </DatagonCard>

      <DatagonCard title="Синхронизация МойСклад">
        <p className="small text-muted">Отдельные настройки лимитов и задержек API для синка МойСклад.</p>
        <div className="row g-2">
          <div className="col-md-4"><label className="form-label">Лимит страницы API</label><input className="form-control" type="number" value={settings.ms_sync_page_limit} onChange={(e) => setSettings((p) => ({ ...p, ms_sync_page_limit: Number(e.target.value || 1000) }))} /></div>
          <div className="col-md-4"><label className="form-label">Пауза между запросами (мс)</label><input className="form-control" type="number" value={settings.ms_sync_delay_ms} onChange={(e) => setSettings((p) => ({ ...p, ms_sync_delay_ms: Number(e.target.value || 0) }))} /></div>
        </div>
        <div className="mt-3"><button className="btn btn-success" onClick={saveMoyskladSync}>💾 Сохранить настройки синхронизации МойСклад</button></div>
      </DatagonCard>

      <DatagonCard title="Автосинхронизация по расписанию">
        <div className="row g-2">
          <div className="col-md-6">
            <label className="form-label">Продукты: время запуска (МСК)</label>
            <div className="d-flex gap-2 align-items-center">
              <input type="checkbox" checked={Number(settings.auto_sync_myproducts_enabled) === 1} onChange={(e) => setSettings((p) => ({ ...p, auto_sync_myproducts_enabled: e.target.checked ? 1 : 0 }))} />
              <span>Включить</span>
              <input type="time" className="form-control" style={{ maxWidth: 140 }} value={settings.auto_sync_myproducts_time || "03:00"} onChange={(e) => setSettings((p) => ({ ...p, auto_sync_myproducts_time: e.target.value }))} />
            </div>
          </div>
          <div className="col-md-6">
            <label className="form-label">МойСклад: время запуска (МСК)</label>
            <div className="d-flex gap-2 align-items-center">
              <input type="checkbox" checked={Number(settings.auto_sync_moysklad_enabled) === 1} onChange={(e) => setSettings((p) => ({ ...p, auto_sync_moysklad_enabled: e.target.checked ? 1 : 0 }))} />
              <span>Включить</span>
              <input type="time" className="form-control" style={{ maxWidth: 140 }} value={settings.auto_sync_moysklad_time || "04:00"} onChange={(e) => setSettings((p) => ({ ...p, auto_sync_moysklad_time: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="mt-3"><button className="btn btn-success" onClick={saveAutoSync}>💾 Сохранить расписание автосинхронизации</button></div>
      </DatagonCard>

      <DatagonCard title="Логи сервера">
        <p className="small text-muted">Управление лог-файлами server.log и worker.log.</p>
        <div className="row g-2">
          <div className="col-md-4"><label className="form-label">Автоочистка логов (дней)</label><input className="form-control" type="number" value={settings.log_retention_days} onChange={(e) => setSettings((p) => ({ ...p, log_retention_days: Number(e.target.value || 7) }))} /></div>
        </div>
        <div className="small text-muted mt-2">{logsInfoRows.map((line, idx) => <div key={idx}>{line}</div>)}</div>
        <div className="mt-3 d-flex gap-2">
          <button className="btn btn-info" onClick={loadLogsInfo}>🔄 Обновить информацию о логах</button>
          <button className="btn btn-warning" onClick={clearLogsNow}>🧹 Очистить логи сейчас</button>
        </div>
      </DatagonCard>

      <DatagonCard title="Смена пароля" hint="Минимальная длина: 15 символов">
        <p className="small text-muted">Измените пароль пользователя. Для не-admin доступна смена только своего пароля.</p>
        <div className="row g-2">
          <div className="col-md-3"><label className="form-label">Логин</label><input className="form-control" readOnly={!isAdmin} value={passwordForm.username} onChange={(e) => setPasswordForm((p) => ({ ...p, username: e.target.value }))} /></div>
          <div className="col-md-5">
            <label className="form-label">Новый пароль</label>
            <div className="d-flex gap-2">
              <input className="form-control" type={showPasswordChange ? "text" : "password"} value={passwordForm.newPassword} onChange={(e) => setPasswordForm((p) => ({ ...p, newPassword: e.target.value }))} />
              <button className="btn btn-outline-secondary" onClick={() => setShowPasswordChange((v) => !v)}>👁</button>
              <button className="btn btn-outline-secondary" onClick={async () => { try { await navigator.clipboard.writeText(passwordForm.newPassword || ""); toast.success("Пароль скопирован"); } catch (_) {} }} disabled={!passwordForm.newPassword}>📋</button>
            </div>
          </div>
          <div className="col-md-2"><label className="form-label">Длина</label><input className="form-control" type="number" min={15} value={passwordForm.length} onChange={(e) => setPasswordForm((p) => ({ ...p, length: Math.max(15, Number(e.target.value || 15)) }))} /></div>
          <div className="col-md-2 d-flex align-items-end gap-2">
            <button className="btn btn-primary" onClick={() => setPasswordForm((p) => ({ ...p, newPassword: randomPassword(p.length) }))}>🎲 Сгенерировать пароль</button>
            <button className="btn btn-success" onClick={changePassword}>🔐 Сменить пароль</button>
          </div>
        </div>
      </DatagonCard>
    </div>
  );
};

export default SettingsPage;

