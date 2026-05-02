const express = require('express');
const router = express.Router();
const {
    ensureActivityTable,
    normalizeActivitySectionKey,
    maybePruneActivityEvents,
    ACTIVITY_RETENTION_DAYS,
} = require('../lib/datagonActivity');

const UI_KINDS = new Set(['page_view', 'click', 'ui']);

/** Полный список разделов приложения (для фильтра + подписей); объединяется с фактическими ключами из БД. */
const PAGE_REGISTRY = [
    { value: 'dashboard', label: 'Дашборд' },
    { value: 'my-sites', label: 'Мои сайты' },
    { value: 'my-products', label: 'Мои товары' },
    { value: 'moysklad', label: 'МойСклад' },
    { value: 'projects', label: 'Конкуренты' },
    { value: 'queue', label: 'Очередь парсинга' },
    { value: 'results', label: 'Результаты' },
    { value: 'matches', label: 'Сопоставление' },
    { value: 'processes', label: 'Активность и процессы' },
    { value: 'settings', label: 'Настройки' },
    { value: 'sections', label: 'Статические экраны' },
    { value: 'architectui-demo', label: 'ArchitectUI меню' },
    { value: 'auth', label: 'Вход и сессия' },
    { value: 'login', label: 'Страница входа' },
    { value: 'app', label: 'Прочее' },
];

function labelForSectionKey(key) {
    const hit = PAGE_REGISTRY.find((p) => p.value === key);
    return hit ? hit.label : key;
}

function mergePageOptions(dbSections) {
    const map = new Map();
    PAGE_REGISTRY.forEach((p) => map.set(p.value, p.label));
    (dbSections || []).forEach((raw) => {
        const k = normalizeActivitySectionKey(raw);
        if (!map.has(k)) map.set(k, labelForSectionKey(k));
    });
    return [...map.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

function actorCanViewActivity(actor) {
    return Boolean(actor && (actor.username === 'admin' || actor.can_manage_users === true));
}

/** datetime-local / ISO → сравнение с TIMESTAMP в БД (локаль процесса Node) */
function parseActivityBound(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = (db) => {
    router.get('/events', async (req, res) => {
        try {
            const actor = req.datagonActor;
            if (!actorCanViewActivity(actor)) {
                return res.status(403).json({ error: 'Недостаточно прав для просмотра журнала активности' });
            }
            await ensureActivityTable(db);
            await maybePruneActivityEvents(db);
            const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '40'), 10) || 40));
            const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
            const userIdRaw = req.query.user_id;
            const kindRaw = String(req.query.kind || '').trim().toLowerCase();
            const sectionExact = String(req.query.section || '').trim();
            const fromTs = parseActivityBound(req.query.from_ts);
            const toTs = parseActivityBound(req.query.to_ts);
            const wh = ['1=1'];
            const params = [];
            if (userIdRaw !== undefined && userIdRaw !== null && String(userIdRaw).trim() !== '') {
                const uid = parseInt(String(userIdRaw), 10);
                if (Number.isFinite(uid) && uid > 0) {
                    wh.push('e.user_id = ?');
                    params.push(uid);
                }
            }
            if (kindRaw) {
                wh.push('e.kind = ?');
                params.push(kindRaw.slice(0, 32));
            }
            if (sectionExact) {
                wh.push('e.section = ?');
                params.push(normalizeActivitySectionKey(sectionExact));
            }
            if (fromTs) {
                wh.push('e.created_at >= ?');
                params.push(fromTs);
            }
            if (toTs) {
                wh.push('e.created_at <= ?');
                params.push(toTs);
            }
            const whereSql = wh.join(' AND ');
            const [users] = await db.query(
                'SELECT id, username, full_name FROM users ORDER BY username ASC'
            );
            const [sectionRows] = await db.query(
                `SELECT DISTINCT e.section AS section
                 FROM dg_activity_events e
                 WHERE e.section IS NOT NULL AND TRIM(e.section) <> ''
                 ORDER BY e.section ASC
                 LIMIT 500`
            );
            const dbSecs = sectionRows.map((r) => r.section).filter(Boolean);
            const pageOptions = mergePageOptions(dbSecs);
            const [cntRows] = await db.query(
                `SELECT COUNT(*) AS c FROM dg_activity_events e WHERE ${whereSql}`,
                params
            );
            const total = Number(cntRows[0]?.c) || 0;
            const [rows] = await db.query(
                `SELECT e.id, e.user_id, e.kind, e.section, e.label, e.detail, e.created_at,
                        u.username, u.full_name
                 FROM dg_activity_events e
                 JOIN users u ON u.id = e.user_id
                 WHERE ${whereSql}
                 ORDER BY e.id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            return res.json({
                rows,
                total,
                users,
                pageOptions,
                retentionDays: ACTIVITY_RETENTION_DAYS,
            });
        } catch (e) {
            console.error('[activity] GET /events', e);
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/track', async (req, res) => {
        try {
            const actor = req.datagonActor;
            if (!actor) return res.status(401).json({ error: 'Не авторизован' });
            await ensureActivityTable(db);
            const raw = Array.isArray(req.body?.events) ? req.body.events : [];
            const events = raw.slice(0, 25);
            if (!events.length) return res.json({ ok: true, inserted: 0 });
            const values = [];
            const flat = [];
            for (const ev of events) {
                const kind = String(ev?.kind || '').trim().toLowerCase().slice(0, 32);
                if (!UI_KINDS.has(kind)) continue;
                const sectionRaw = ev?.section;
                const section =
                    sectionRaw == null || String(sectionRaw).trim() === ''
                        ? null
                        : normalizeActivitySectionKey(sectionRaw);
                const label = String(ev?.label || '').trim().slice(0, 512);
                if (!label) continue;
                const detail = ev?.detail != null ? String(ev.detail).slice(0, 8000) : null;
                values.push('(?,?,?,?,?)');
                flat.push(actor.id, kind, section, label, detail);
            }
            if (!values.length) return res.json({ ok: true, inserted: 0 });
            await db.query(
                `INSERT INTO dg_activity_events (user_id, kind, section, label, detail) VALUES ${values.join(',')}`,
                flat
            );
            return res.json({ ok: true, inserted: values.length });
        } catch (e) {
            console.error('[activity] POST /track', e);
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};
