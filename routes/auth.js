const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const AUTH_SESSION_COOKIE = 'dg_session';

function parseCookie(header) {
    const out = Object.create(null);
    if (!header || typeof header !== 'string') return out;
    for (const raw of header.split(';')) {
        const idx = raw.indexOf('=');
        if (idx <= 0) continue;
        const k = raw.slice(0, idx).trim();
        const v = raw.slice(idx + 1).trim();
        if (!k) continue;
        try {
            out[k] = decodeURIComponent(v);
        } catch {
            out[k] = v;
        }
    }
    return out;
}

module.exports = (db, appSettings = {}) => {
    let authSchemaReady = false;

    function sha256(value) {
        return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
    }

    function newSessionToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    async function ensureAuthSchema() {
        if (authSchemaReady) return;
        await db.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP NULL,
                expires_at TIMESTAMP NOT NULL,
                revoked TINYINT(1) NOT NULL DEFAULT 0,
                INDEX idx_auth_user (user_id),
                INDEX idx_auth_expires (expires_at)
            )
        `);
        const [manageUsersCols] = await db.query("SHOW COLUMNS FROM users LIKE 'can_manage_users'");
        if (!manageUsersCols.length) {
            await db.query('ALTER TABLE users ADD COLUMN can_manage_users TINYINT(1) NOT NULL DEFAULT 0 AFTER full_name');
        }
        await db.query(`
            UPDATE users
            SET can_manage_users = 1
            WHERE username = 'admin'
        `);
        authSchemaReady = true;
    }

    function getSessionPolicy() {
        const ttlDays = Math.max(1, Number(appSettings?.auth_session_ttl_days || 14));
        const userLimit = Math.max(1, Number(appSettings?.auth_session_user_limit || 1));
        return { ttlDays, userLimit };
    }

    function getBearerToken(req) {
        const cookies = parseCookie(req.headers.cookie);
        return String(req.headers['x-auth-token'] || cookies[AUTH_SESSION_COOKIE] || '').trim();
    }

    function attachSessionCookie(res, token) {
        const { ttlDays } = getSessionPolicy();
        res.cookie(AUTH_SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: ttlDays * 86400000
        });
    }

    async function resolveActorFromToken(token) {
        await ensureAuthSchema();
        const t = String(token || '').trim();
        if (!t) return null;
        const tokenHash = sha256(t);
        const [rows] = await db.query(`
            SELECT u.id, u.username, u.full_name, u.can_manage_users, s.id AS session_id
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
              AND s.revoked = 0
              AND s.expires_at > NOW()
            LIMIT 1
        `, [tokenHash]);
        if (!rows.length) return null;
        const actor = rows[0];
        db.query('UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = ?', [actor.session_id]).catch(() => {});
        return {
            id: actor.id,
            username: actor.username,
            full_name: actor.full_name,
            can_manage_users: Number(actor.can_manage_users || 0) === 1 || actor.username === 'admin'
        };
    }

    async function getActor(req) {
        return resolveActorFromToken(getBearerToken(req));
    }

    function safeDocTargetFilename(pathname) {
        const prefix = '/docs/';
        const pathOnly = String(pathname || '').split('?')[0];
        let tail = 'manual.html';
        if (pathOnly.startsWith(prefix)) {
            tail = pathOnly.slice(prefix.length) || 'manual.html';
        } else if (pathOnly === '/docs' || pathOnly === '/docs/') {
            tail = 'manual.html';
        }
        tail = String(tail).replace(/\/+$/, '') || 'manual.html';
        if (tail.includes('..') || tail.includes('/')) return 'manual.html';
        if (/^[a-zA-Z0-9._-]+\.html$/i.test(tail)) {
            if (tail.toLowerCase() === 'session-bridge.html') return 'manual.html';
            return tail;
        }
        // Docusaurus: /docs/search → tail "search" → bridge maps search.html → /docs/search/
        if (/^[a-zA-Z0-9_-]+$/.test(tail)) {
            return `${tail}.html`;
        }
        return 'manual.html';
    }

    function protectDocumentationRoutes(req, res, next) {
        const p = String(req.path || req.originalUrl || req.url || '').split('?')[0];
        if (!p.startsWith('/docs')) return next();
        if (p.endsWith('/session-bridge.html')) return next();
        const targetFile = safeDocTargetFilename(p);
        const redirectToBridge = () => {
            try {
                const host = req.headers.host || 'localhost';
                const incoming = new URL(req.originalUrl || req.url || '/', `http://${host}`);
                const dest = new URL('/docs/session-bridge.html', `http://${host}`);
                dest.searchParams.set('then', targetFile);
                incoming.searchParams.forEach((value, key) => {
                    if (key === 'then') return;
                    dest.searchParams.append(key, value);
                });
                res.redirect(302, dest.pathname + dest.search);
            } catch (_) {
                res.redirect(302, `/docs/session-bridge.html?then=${encodeURIComponent(targetFile)}`);
            }
        };
        const token = getBearerToken(req);
        if (!token) {
            redirectToBridge();
            return;
        }
        resolveActorFromToken(token)
            .then((actor) => {
                if (!actor) {
                    redirectToBridge();
                    return;
                }
                // Docusaurus has no public/docs/index.html (first doc is manual/). Avoid Express "Cannot GET /docs/".
                if (p === '/docs' || p === '/docs/') {
                    res.redirect(302, '/docs/manual/');
                    return;
                }
                next();
            })
            .catch(() => redirectToBridge());
    }

    async function isAdminActor(req) {
        const actor = await getActor(req);
        return actor && actor.username === 'admin';
    }

    async function canManageUsersActor(req) {
        const actor = await getActor(req);
        return actor && (actor.username === 'admin' || actor.can_manage_users === true);
    }

    router.get('/me', async (req, res) => {
        try {
            const actor = await getActor(req);
            if (!actor) return res.status(401).json({ error: 'Не авторизован' });
            return res.json({
                success: true,
                username: actor.username,
                full_name: actor.full_name || actor.username,
                isAdmin: actor.username === 'admin',
                canManageUsers: actor.username === 'admin' || actor.can_manage_users === true
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    /** Выставить dg_session по уже валидному x-auth-token (нужно для /docs/* после входа только в localStorage). */
    router.post('/sync-session-cookie', async (req, res) => {
        try {
            const actor = await getActor(req);
            if (!actor) return res.status(401).json({ success: false, error: 'Не авторизован' });
            const token = getBearerToken(req);
            if (!token) return res.status(401).json({ success: false, error: 'Нет токена' });
            attachSessionCookie(res, token);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/users', async (_req, res) => {
        try {
            const isAdmin = await isAdminActor(_req);
            if (!isAdmin) return res.status(403).json({ error: 'Только admin может просматривать пользователей' });
            await ensureAuthSchema();
            const [rows] = await db.query(`
                SELECT
                    u.id,
                    u.username,
                    u.full_name,
                    u.can_manage_users,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM auth_sessions s
                        WHERE s.user_id = u.id
                          AND s.revoked = 0
                          AND s.expires_at > NOW()
                    ), 0) AS active_sessions
                FROM users u
                ORDER BY u.username ASC
            `);
            return res.json({ data: rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/users', async (req, res) => {
        const canManageUsers = await canManageUsersActor(req);
        if (!canManageUsers) return res.status(403).json({ error: 'Недостаточно прав для создания пользователей' });

        const { username, full_name, password } = req.body || {};
        const cleanUsername = String(username || '').trim();
        const cleanFullName = String(full_name || '').trim();
        const rawPassword = String(password || '');

        if (!cleanUsername) {
            return res.status(400).json({ error: 'Логин обязателен' });
        }
        if (cleanUsername.length < 3) {
            return res.status(400).json({ error: 'Логин должен быть не короче 3 символов' });
        }
        if (!rawPassword || rawPassword.length < 15) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 15 символов' });
        }
        if (!cleanFullName) {
            return res.status(400).json({ error: 'Поле "Имя Фамилия" обязательно' });
        }
        if (cleanFullName.length < 3) {
            return res.status(400).json({ error: 'Имя Фамилия должно быть не короче 3 символов' });
        }

        try {
            const [exists] = await db.query('SELECT id FROM users WHERE username = ?', [cleanUsername]);
            if (exists.length > 0) {
                return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
            }
            const passwordHash = await bcrypt.hash(rawPassword, 10);
            await db.query(
                'INSERT INTO users (username, full_name, password_hash, can_manage_users) VALUES (?, ?, ?, 0)',
                [cleanUsername, cleanFullName, passwordHash]
            );
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.delete('/users/:id', async (req, res) => {
        const isAdmin = await isAdminActor(req);
        if (!isAdmin) return res.status(403).json({ error: 'Только admin может удалять пользователей' });

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: 'Некорректный id пользователя' });
        }
        try {
            const [rows] = await db.query('SELECT id, username, full_name FROM users WHERE id = ?', [id]);
            if (!rows.length) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            if (rows[0].username === 'admin') {
                return res.status(400).json({ error: 'Нельзя удалить встроенного пользователя admin' });
            }
            const [countRows] = await db.query('SELECT COUNT(*) AS cnt FROM users');
            const totalUsers = Number(countRows[0]?.cnt || 0);
            if (totalUsers <= 1) {
                return res.status(400).json({ error: 'Должен остаться хотя бы один пользователь' });
            }
            await db.query('DELETE FROM users WHERE id = ?', [id]);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.put('/users/:id', async (req, res) => {
        const isAdmin = await isAdminActor(req);
        if (!isAdmin) return res.status(403).json({ error: 'Только admin может редактировать пользователей' });

        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: 'Некорректный id пользователя' });
        }

        const { username, full_name } = req.body || {};
        const cleanUsername = String(username || '').trim();
        const cleanFullName = String(full_name || '').trim();
        if (!cleanUsername) return res.status(400).json({ error: 'Логин обязателен' });
        if (cleanUsername.length < 3) return res.status(400).json({ error: 'Логин должен быть не короче 3 символов' });
        if (!cleanFullName) return res.status(400).json({ error: 'Поле "Имя Фамилия" обязательно' });
        if (cleanFullName.length < 3) return res.status(400).json({ error: 'Имя Фамилия должно быть не короче 3 символов' });

        try {
            const [rows] = await db.query('SELECT id, username FROM users WHERE id = ?', [id]);
            if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
            const target = rows[0];
            if (target.username === 'admin' && cleanUsername !== 'admin') {
                return res.status(400).json({ error: 'Нельзя изменить логин встроенного пользователя admin' });
            }
            const [dups] = await db.query('SELECT id FROM users WHERE username = ? AND id <> ?', [cleanUsername, id]);
            if (dups.length) return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });

            await db.query('UPDATE users SET username = ?, full_name = ? WHERE id = ?', [cleanUsername, cleanFullName, id]);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.put('/users/:id/permissions', async (req, res) => {
        const isAdmin = await isAdminActor(req);
        if (!isAdmin) return res.status(403).json({ error: 'Только admin может менять права пользователей' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id пользователя' });
        const canManageUsers = Number(req.body?.can_manage_users || 0) === 1 ? 1 : 0;
        try {
            const [rows] = await db.query('SELECT id, username FROM users WHERE id = ?', [id]);
            if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
            if (rows[0].username === 'admin') {
                return res.status(400).json({ error: 'Для admin право создания пользователей всегда включено' });
            }
            await db.query('UPDATE users SET can_manage_users = ? WHERE id = ?', [canManageUsers, id]);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        try {
            await ensureAuthSchema();
            const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
            if (users.length === 0 || !(await bcrypt.compare(password, users[0].password_hash))) {
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            const user = users[0];
            const { ttlDays, userLimit } = getSessionPolicy();

            if (user.username !== 'admin') {
                // Keep only the newest sessions within configured limit.
                const [activeSessions] = await db.query(`
                    SELECT id
                    FROM auth_sessions
                    WHERE user_id = ?
                      AND revoked = 0
                      AND expires_at > NOW()
                    ORDER BY created_at DESC, id DESC
                `, [user.id]);
                if (activeSessions.length >= userLimit) {
                    const idsToRevoke = activeSessions.slice(userLimit - 1).map((s) => s.id).filter(Boolean);
                    if (idsToRevoke.length) {
                        await db.query(
                            `UPDATE auth_sessions
                             SET revoked = 1
                             WHERE id IN (${idsToRevoke.map(() => '?').join(',')})`,
                            idsToRevoke
                        );
                    }
                }
            }

            const token = newSessionToken();
            const tokenHash = sha256(token);
            await db.query(
                'INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
                [user.id, tokenHash, ttlDays]
            );
            attachSessionCookie(res, token);
            res.json({
                success: true,
                username: user.username,
                full_name: user.full_name || user.username,
                isAdmin: user.username === 'admin',
                canManageUsers: user.username === 'admin' || Number(user.can_manage_users || 0) === 1,
                auth_token: token
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/logout', async (req, res) => {
        try {
            await ensureAuthSchema();
            const token = getBearerToken(req);
            if (token) {
                const tokenHash = sha256(token);
                await db.query(
                    'UPDATE auth_sessions SET revoked = 1 WHERE token_hash = ? AND revoked = 0',
                    [tokenHash]
                );
            }
            res.clearCookie(AUTH_SESSION_COOKIE, { path: '/' });
            return res.json({ success: true });
        } catch (e) {
            res.clearCookie(AUTH_SESSION_COOKIE, { path: '/' });
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/change-password', async (req, res) => {
        const { username, newPassword } = req.body;

        if (!username || !newPassword) {
            return res.status(400).json({ error: 'Заполните логин и новый пароль' });
        }
        if (String(newPassword).length < 15) {
            return res.status(400).json({ error: 'Новый пароль должен быть не короче 15 символов' });
        }

        try {
            const actor = await getActor(req);
            if (!actor) {
                return res.status(401).json({ error: 'Не удалось определить текущего пользователя' });
            }

            const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
            if (users.length === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            const user = users[0];
            const isActorAdmin = actor.username === 'admin';
            const isTargetAdmin = user.username === 'admin';

            if (!isActorAdmin && actor.username !== user.username) {
                return res.status(403).json({ error: 'Можно менять пароль только своего пользователя' });
            }
            if (!isActorAdmin && isTargetAdmin) {
                return res.status(403).json({ error: 'Только admin может изменять пароль admin' });
            }

            const newHash = await bcrypt.hash(newPassword, 10);
            await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);
            await ensureAuthSchema();
            await db.query('UPDATE auth_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', [user.id]);

            res.clearCookie(AUTH_SESSION_COOKIE, { path: '/' });
            return res.json({ success: true, sessions_revoked: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/users/:id/revoke-sessions', async (req, res) => {
        const isAdmin = await isAdminActor(req);
        if (!isAdmin) return res.status(403).json({ error: 'Только admin может завершать сессии пользователей' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id пользователя' });
        try {
            await ensureAuthSchema();
            const [rows] = await db.query('SELECT id, username FROM users WHERE id = ?', [id]);
            if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
            await db.query('UPDATE auth_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', [id]);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    return { router, protectDocumentationRoutes };
};