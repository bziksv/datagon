/**
 * WORK API — CRUD сущностей из work.prime-ltd.su.
 */
const express = require('express');
const { ensureWorkPrimeSchema } = require('../lib/datagonWorkPrimeSchema');
const { getWorkEntity, listWorkEntities } = require('../lib/datagonWorkPrimeEntities');
const {
    getSeoPayoutSettings,
    saveSeoPayoutSettings,
    recalcAllSeoSummaZp,
} = require('../lib/datagonWorkSeoPayout');

function actorOf(req) {
    return req.datagonActor || req.user || {};
}

function normalizeName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeEmail(s) {
    return String(s || '')
        .toLowerCase()
        .trim();
}

function parseWorkDate(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    // dd.mm.yyyy | yyyy-mm-dd | dd-mm-yyyy
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function daysLeftFromEnd(endVal) {
    // Как HomeController::projectSeo: end = дд/мм/гггг; если сегодня >= end → 0.
    const end = parseWorkDate(endVal);
    if (!end) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    if (today.getTime() >= end.getTime()) return 0;
    return Math.round((end.getTime() - today.getTime()) / 86400000);
}

function parseMoney(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

/** Ключ сопоставления проект ↔ пароль: домен/имя без схемы и www. */
function normalizeProjectMatchKey(name) {
    let s = String(name || '')
        .toLowerCase()
        .trim();
    if (!s) return '';
    s = s.replace(/^https?:\/\//i, '');
    s = s.split('/')[0].split(/\s+/)[0];
    s = s.replace(/^www\./, '');
    s = s.replace(/\.+$/, '');
    return s;
}

function pickBestMatch(list) {
    if (!list || !list.length) return null;
    const active = list.find((x) => Number(x.status) === 1);
    return active || list[0];
}

function indexByMatchKey(rows) {
    const map = new Map();
    for (const p of rows || []) {
        const k = normalizeProjectMatchKey(p.name_project);
        if (!k) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(p);
    }
    return map;
}

function applyPasswordSideMatch(out, projectsByKey) {
    for (const r of out) {
        const k = normalizeProjectMatchKey(r.name_project);
        const best = pickBestMatch(projectsByKey.get(k));
        if (best && Number(best.status) === 1) {
            r.project_match = 'active';
            r.matched_project_id = Number(best.id);
            r.matched_project_name = best.name_project;
            r.archive_candidate = false;
        } else if (best) {
            r.project_match = 'archived';
            r.matched_project_id = Number(best.id);
            r.matched_project_name = best.name_project;
            r.archive_candidate = Number(r.status) === 1;
        } else {
            r.project_match = 'none';
            r.matched_project_id = null;
            r.matched_project_name = '';
            r.archive_candidate = Number(r.status) === 1;
        }
    }
}

function applyProjectSideMatch(out, passwordsByKey, field, idField, nameField) {
    for (const r of out) {
        const k = normalizeProjectMatchKey(r.name_project);
        const best = pickBestMatch(passwordsByKey.get(k));
        if (best && Number(best.status) === 1) {
            r[field] = 'active';
            r[idField] = Number(best.id);
            r[nameField] = best.name_project;
        } else if (best) {
            r[field] = 'archived';
            r[idField] = Number(best.id);
            r[nameField] = best.name_project;
        } else {
            r[field] = 'none';
            r[idField] = null;
            r[nameField] = '';
        }
    }
}

/**
 * Сопоставление проект ↔ пароль по нормализованному имени.
 * Пароли: archive_candidate = активный пароль без активного проекта.
 * DEV-пароли сопоставляются с проектами SEO (отдельной таблицы проектов DEV нет).
 */
async function enrichWorkCrossMatch(db, ent, out) {
    if (!out.length) return;
    const slug = ent.slug;

    if (slug === 'context-passwords' || slug === 'context-projects') {
        const [projects] = await db.query(
            `SELECT id, name_project, status FROM work_context_projects`
        );
        const [passwords] = await db.query(
            `SELECT id, name_project, status FROM work_context_passwords`
        );
        if (slug === 'context-passwords') {
            applyPasswordSideMatch(out, indexByMatchKey(projects));
        } else {
            applyProjectSideMatch(
                out,
                indexByMatchKey(passwords),
                'password_match',
                'matched_password_id',
                'matched_password_name'
            );
        }
        return;
    }

    if (slug === 'seo-passwords' || slug === 'seo-projects' || slug === 'dev-passwords') {
        const [projects] = await db.query(
            `SELECT id, name_project, status FROM work_seo_projects`
        );
        const projectsByKey = indexByMatchKey(projects);

        if (slug === 'seo-passwords' || slug === 'dev-passwords') {
            applyPasswordSideMatch(out, projectsByKey);
            return;
        }

        const [seoPw] = await db.query(
            `SELECT id, name_project, status FROM work_seo_passwords`
        );
        const [devPw] = await db.query(
            `SELECT id, name_project, status FROM work_dev_passwords`
        );
        applyProjectSideMatch(
            out,
            indexByMatchKey(seoPw),
            'password_match',
            'matched_password_id',
            'matched_password_name'
        );
        applyProjectSideMatch(
            out,
            indexByMatchKey(devPw),
            'dev_password_match',
            'matched_dev_password_id',
            'matched_dev_password_name'
        );
    }
}

/**
 * Специалисты (sorts), days_left, sum_zp, счётчики проектов у staff.
 */
async function enrichWorkListRows(db, ent, rows) {
    if (!rows || !rows.length) return rows || [];
    const out = rows.map((r) => ({ ...r }));
    if (ent.assigneeType) {
        const ids = out.map((r) => r.id).filter(Boolean);
        if (ids.length) {
            const ph = ids.map(() => '?').join(',');
            // Имя: сначала Datagon (после сопоставления), иначе legacy ФИО из WORK.
            const legacyIds = out.map((r) => Number(r.legacy_id)).filter(Boolean);
            const [asg] = await db.query(
                `SELECT a.entity_id, a.entity_legacy_id, a.legacy_user_id,
                        COALESCE(
                          NULLIF(TRIM(u.full_name), ''),
                          NULLIF(TRIM(u.username), ''),
                          NULLIF(TRIM(s.name), ''),
                          CONCAT('user#', a.legacy_user_id)
                        ) AS staff_name
                 FROM work_assignees a
                 LEFT JOIN work_seo_staff s ON s.legacy_user_id = a.legacy_user_id
                 LEFT JOIN users u ON u.id = s.datagon_user_id
                 WHERE a.entity_type = ?
                   AND (
                     a.entity_id IN (${ph})
                     ${legacyIds.length ? `OR a.entity_legacy_id IN (${legacyIds.map(() => '?').join(',')})` : ''}
                   )
                 ORDER BY a.id ASC`,
                legacyIds.length
                    ? [ent.assigneeType, ...ids, ...legacyIds]
                    : [ent.assigneeType, ...ids]
            );
            const map = new Map();
            const idByLegacy = new Map(out.map((r) => [Number(r.legacy_id), Number(r.id)]));
            for (const a of asg || []) {
                let eid = Number(a.entity_id) || 0;
                if (!eid && a.entity_legacy_id != null) {
                    eid = idByLegacy.get(Number(a.entity_legacy_id)) || 0;
                }
                if (!eid) continue;
                if (!map.has(eid)) map.set(eid, []);
                const name = String(a.staff_name || '').trim();
                const lid = Number(a.legacy_user_id) || 0;
                if (!name || !lid) continue;
                const list = map.get(eid);
                if (list.some((x) => x.legacy_user_id === lid)) continue;
                list.push({ name, legacy_user_id: lid });
            }
            for (const r of out) {
                const headId = Number(r.id_glavn_user) || 0;
                const list = (map.get(Number(r.id)) || []).map((x) => ({
                    name: x.name,
                    legacy_user_id: x.legacy_user_id,
                    is_head: headId > 0 && x.legacy_user_id === headId,
                }));
                r.specialists_list = list;
                r.specialists = list.map((x) => x.name).join(', ');
                r.assignee_legacy_ids = list.map((x) => x.legacy_user_id);
            }
        } else {
            for (const r of out) {
                r.specialists = '';
                r.specialists_list = [];
            }
        }
    }
    if (ent.listCols.some((c) => c.key === 'days_left')) {
        for (const r of out) {
            r.days_left = daysLeftFromEnd(r.end);
        }
    }
    if (ent.slug === 'context-projects') {
        for (const r of out) {
            const sum =
                parseMoney(r.ya_direct) + parseMoney(r.go_advords) + parseMoney(r.MyTarget);
            const pct = parseMoney(r.procent_seo);
            r.sum_zp = Math.round((sum * pct) / 100 * 100) / 100;
        }
    }
    await enrichWorkCrossMatch(db, ent, out);
    if (ent.isStaff) {
        // Как HomeController@personal: бонусы по проектам, где сотрудник = id_glavn_user (legacy).
        await enrichStaffPayroll(db, out);
    }
    return out;
}

/**
 * Бонусы персонала (personal.blade / HomeController@personal):
 * - SEO: сумма summa_zp активных проектов, где id_glavn_user = legacy_user_id
 * - Контекст: сумма (ya+go+mt)*procent/100 по активным, где главный = legacy
 * - Сумма на зп = SEO + контекст; Итог = оклад + эта сумма
 * - Счётчики проектов — тоже только как главный (не assignees).
 */
async function enrichStaffPayroll(db, rows) {
    if (!rows || !rows.length) return;
    const [seoRows] = await db.query(
        `SELECT id_glavn_user, summa_zp FROM work_seo_projects WHERE status = 1`
    );
    const [ctxRows] = await db.query(
        `SELECT id_glavn_user, ya_direct, go_advords, MyTarget, procent_seo
         FROM work_context_projects WHERE status = 1`
    );
    const seoByHead = new Map();
    const seoCnt = new Map();
    for (const p of seoRows || []) {
        const head = Number(p.id_glavn_user) || 0;
        if (!head) continue;
        seoCnt.set(head, (seoCnt.get(head) || 0) + 1);
        const raw = String(p.summa_zp == null ? '' : p.summa_zp).trim();
        if (!raw) continue;
        const neg = raw.includes('-');
        const n = Math.abs(parseMoney(raw.replace(/-/g, '')));
        if (!Number.isFinite(n)) continue;
        const cur = seoByHead.get(head) || { plus: 0, minus: 0 };
        if (neg) cur.minus += n;
        else cur.plus += n;
        seoByHead.set(head, cur);
    }
    const ctxByHead = new Map();
    const ctxCnt = new Map();
    for (const p of ctxRows || []) {
        const head = Number(p.id_glavn_user) || 0;
        if (!head) continue;
        ctxCnt.set(head, (ctxCnt.get(head) || 0) + 1);
        const ya = parseMoney(p.ya_direct);
        const go = parseMoney(p.go_advords);
        const mt = parseMoney(p.MyTarget);
        const pct = parseMoney(p.procent_seo);
        const bonus = ((ya + go + mt) * pct) / 100;
        ctxByHead.set(head, (ctxByHead.get(head) || 0) + bonus);
    }
    for (const r of rows) {
        const lid = Number(r.legacy_user_id) || 0;
        const seo = seoByHead.get(lid) || { plus: 0, minus: 0 };
        const seoItog = seo.plus - seo.minus;
        const ctxItog = ctxByHead.get(lid) || 0;
        const okladRaw = String(r.sum_many_first == null ? '' : r.sum_many_first).trim();
        const oklad = /^\d/.test(okladRaw.replace(/\s/g, '')) ? parseMoney(okladRaw) : 0;
        r.seo_projects_count = seoCnt.get(lid) || 0;
        r.context_projects_count = ctxCnt.get(lid) || 0;
        r.procent_seo_itog = Math.round(seoItog * 100) / 100;
        r.context_bonus_itog = Math.round(ctxItog * 100) / 100;
        r.procent_context_itog = Math.round((seoItog + ctxItog) * 100) / 100;
        r.itog = Math.round((oklad + seoItog + ctxItog) * 100) / 100;
        if (!r.datagon_user_name) {
            r.datagon_user_name = r.name || '';
        }
    }
}

function workSortValue(row, key) {
    if (key === 'specialists') {
        return String(row.specialists || '')
            .toLowerCase()
            .trim();
    }
    if (key === 'favicon') {
        return String(row.name_project || '')
            .toLowerCase()
            .trim();
    }
    const v = row[key];
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
    if (s !== '' && Number.isFinite(n) && /^-?\d/.test(s.replace(/\s/g, ''))) return n;
    // даты дд/мм/гггг → unix для сравнения
    const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) {
        const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        if (!Number.isNaN(t)) return t;
    }
    return s.toLowerCase();
}

function sortWorkRows(rows, sortKey, sortDir) {
    if (!sortKey || !rows || !rows.length) return rows || [];
    const dir = sortDir === 'desc' ? -1 : 1;
    const copy = rows.slice();
    copy.sort((a, b) => {
        const av = workSortValue(a, sortKey);
        const bv = workSortValue(b, sortKey);
        if (av == null && bv == null) return (Number(a.id) || 0) - (Number(b.id) || 0);
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') {
            if (av === bv) return (Number(a.id) || 0) - (Number(b.id) || 0);
            return av < bv ? -dir : dir;
        }
        const cmp = String(av).localeCompare(String(bv), 'ru', { numeric: true, sensitivity: 'base' });
        if (cmp === 0) return (Number(a.id) || 0) - (Number(b.id) || 0);
        return cmp * dir;
    });
    return copy;
}

/**
 * Как в WORK: admin видит всё; обычный пользователь — только свои назначения / себя в персонале.
 * Admin Datagon: username=admin или can_manage_users.
 */
function isWorkUnscopedAdmin(actor) {
    if (!actor) return false;
    if (actor.username === 'admin') return true;
    if (actor.can_manage_users === true || Number(actor.can_manage_users) === 1) return true;
    return false;
}

async function resolveWorkActorScope(db, actor) {
    if (isWorkUnscopedAdmin(actor)) {
        return { unscoped: true, legacyUserId: null, datagonUserId: null };
    }
    const datagonUserId = actor && actor.id != null ? Number(actor.id) : 0;
    if (!datagonUserId) {
        return { unscoped: false, legacyUserId: null, datagonUserId: null };
    }
    const [st] = await db.query(
        `SELECT legacy_user_id FROM work_seo_staff WHERE datagon_user_id = ? LIMIT 1`,
        [datagonUserId]
    );
    const legacyUserId = st[0] ? Number(st[0].legacy_user_id) || null : null;
    return { unscoped: false, legacyUserId, datagonUserId };
}

/** SQL-условие «запись доступна актору» (для list / get / mutate). */
function appendWorkActorScopeSql(ent, scope, sql, params) {
    if (!scope || scope.unscoped) return { sql, params };
    if (ent.isStaff) {
        if (!scope.datagonUserId) {
            sql += ` AND 1=0`;
            return { sql, params };
        }
        sql += ` AND t.datagon_user_id = ?`;
        params.push(scope.datagonUserId);
        return { sql, params };
    }
    if (!ent.assigneeType) {
        sql += ` AND 1=0`;
        return { sql, params };
    }
    if (!scope.legacyUserId && !scope.datagonUserId) {
        sql += ` AND 1=0`;
        return { sql, params };
    }
    const lid = Number(scope.legacyUserId) || 0;
    const did = Number(scope.datagonUserId) || 0;
    const hasGlavn = ent.table !== 'work_services';
    // sorts parity: пользователь в assignees ИЛИ главный (id_glavn_user = legacy)
    if (hasGlavn) {
        sql += ` AND (
            ( ? > 0 AND CAST(IFNULL(t.id_glavn_user, '0') AS UNSIGNED) = ? )
            OR EXISTS (
              SELECT 1 FROM work_assignees a
              WHERE a.entity_type = ?
                AND (
                  a.entity_id = t.id
                  OR (t.legacy_id IS NOT NULL AND a.entity_legacy_id = t.legacy_id)
                )
                AND (
                  ( ? > 0 AND a.legacy_user_id = ? )
                  OR ( ? > 0 AND a.datagon_user_id = ? )
                )
            )
        )`;
        params.push(lid, lid, ent.assigneeType, lid, lid, did, did);
    } else {
        sql += ` AND EXISTS (
          SELECT 1 FROM work_assignees a
          WHERE a.entity_type = ?
            AND (
              a.entity_id = t.id
              OR (t.legacy_id IS NOT NULL AND a.entity_legacy_id = t.legacy_id)
            )
            AND (
              ( ? > 0 AND a.legacy_user_id = ? )
              OR ( ? > 0 AND a.datagon_user_id = ? )
            )
        )`;
        params.push(ent.assigneeType, lid, lid, did, did);
    }
    return { sql, params };
}

async function actorCanAccessWorkRow(db, ent, row, scope) {
    if (!scope || scope.unscoped) return true;
    if (!row) return false;
    if (ent.isStaff) {
        return Number(row.datagon_user_id) === Number(scope.datagonUserId);
    }
    if (!ent.assigneeType) return false;
    const lid = Number(scope.legacyUserId) || 0;
    const head = Number(row.id_glavn_user) || 0;
    if (lid && head === lid) return true;
    const did = Number(scope.datagonUserId) || 0;
    const [asg] = await db.query(
        `SELECT id FROM work_assignees
         WHERE entity_type = ?
           AND (
             entity_id = ?
             OR ( ? IS NOT NULL AND entity_legacy_id = ? )
           )
           AND (
             ( ? > 0 AND legacy_user_id = ? )
             OR ( ? > 0 AND datagon_user_id = ? )
           )
         LIMIT 1`,
        [
            ent.assigneeType,
            row.id,
            row.legacy_id != null ? row.legacy_id : null,
            row.legacy_id != null ? row.legacy_id : null,
            lid,
            lid,
            did,
            did,
        ]
    );
    return !!(asg && asg[0]);
}

async function buildWorkSummary(db, ent, scope) {
    if (!ent.summaryKind) return null;
    if (ent.summaryKind === 'seo') {
        let sql = `SELECT t.status, t.our_project, t.budget, t.osvoeno, t.id_glavn_user, t.id, t.legacy_id
                   FROM work_seo_projects t WHERE 1=1`;
        const params = [];
        // Сводка у не-админа — только проекты где он главный (как WORK).
        if (scope && !scope.unscoped) {
            const lid = Number(scope.legacyUserId) || 0;
            if (!lid) {
                return {
                    kind: 'seo',
                    active: 0,
                    archive: 0,
                    client: 0,
                    our: 0,
                    budget: 0,
                    osvoeno: 0,
                    budget_client: 0,
                    osvoeno_client: 0,
                    budget_our: 0,
                    osvoeno_our: 0,
                };
            }
            sql += ` AND CAST(IFNULL(t.id_glavn_user, '0') AS UNSIGNED) = ?`;
            params.push(lid);
        }
        const [rows] = await db.query(sql, params);
        let active = 0;
        let archive = 0;
        let client = 0;
        let our = 0;
        let budget = 0;
        let osvoeno = 0;
        let budgetClient = 0;
        let osvoenoClient = 0;
        let budgetOur = 0;
        let osvoenoOur = 0;
        for (const r of rows || []) {
            const st = Number(r.status) === 1 ? 1 : 0;
            if (!st) {
                archive += 1;
                continue;
            }
            active += 1;
            const b = parseMoney(r.budget);
            const o = parseMoney(r.osvoeno);
            const oUse = b <= o ? b : o;
            budget += b;
            osvoeno += oUse;
            if (Number(r.our_project) === 1) {
                our += 1;
                budgetOur += b;
                osvoenoOur += oUse;
            } else {
                client += 1;
                budgetClient += b;
                osvoenoClient += oUse;
            }
        }
        return {
            kind: 'seo',
            active,
            archive,
            client,
            our,
            budget,
            osvoeno,
            budget_client: budgetClient,
            osvoeno_client: osvoenoClient,
            budget_our: budgetOur,
            osvoeno_our: osvoenoOur,
        };
    }
    if (ent.summaryKind === 'context') {
        let sql = `SELECT t.status, t.our_project, t.ya_direct, t.go_advords, t.MyTarget
                   FROM work_context_projects t WHERE 1=1`;
        const params = [];
        if (scope && !scope.unscoped) {
            const lid = Number(scope.legacyUserId) || 0;
            if (!lid) {
                return {
                    kind: 'context',
                    active: 0,
                    archive: 0,
                    client: 0,
                    our: 0,
                    budget: 0,
                    budget_client: 0,
                    budget_our: 0,
                };
            }
            sql += ` AND CAST(IFNULL(t.id_glavn_user, '0') AS UNSIGNED) = ?`;
            params.push(lid);
        }
        const [rows] = await db.query(sql, params);
        let active = 0;
        let archive = 0;
        let client = 0;
        let our = 0;
        let budget = 0;
        let budgetClient = 0;
        let budgetOur = 0;
        for (const r of rows || []) {
            const st = Number(r.status) === 1 ? 1 : 0;
            if (!st) {
                archive += 1;
                continue;
            }
            active += 1;
            const sum =
                parseMoney(r.ya_direct) + parseMoney(r.go_advords) + parseMoney(r.MyTarget);
            budget += sum;
            if (Number(r.our_project) === 1) {
                our += 1;
                budgetOur += sum;
            } else {
                client += 1;
                budgetClient += sum;
            }
        }
        return {
            kind: 'context',
            active,
            archive,
            client,
            our,
            budget,
            budget_client: budgetClient,
            budget_our: budgetOur,
        };
    }
    if (ent.summaryKind === 'staff') {
        let sql = `SELECT legacy_user_id, sum_many_first, status, datagon_user_id
                   FROM work_seo_staff WHERE status = 1`;
        const params = [];
        if (scope && !scope.unscoped) {
            if (!scope.datagonUserId) {
                return { kind: 'staff', active: 0, itog_sum: 0 };
            }
            sql += ` AND datagon_user_id = ?`;
            params.push(scope.datagonUserId);
        }
        const [rows] = await db.query(sql, params);
        const active = rows || [];
        await enrichStaffPayroll(db, active);
        let itogSum = 0;
        for (const r of active) itogSum += parseMoney(r.itog);
        return {
            kind: 'staff',
            active: active.length,
            itog_sum: Math.round(itogSum * 100) / 100,
        };
    }
    return null;
}

function parseAssigneeLegacyIds(body) {
    const raw = body && body.assignee_legacy_ids;
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const ids = [];
    for (const x of arr) {
        const n = Number(x);
        if (n > 0 && !ids.includes(n)) ids.push(n);
    }
    return ids;
}

async function loadAssigneesForEntity(db, ent, entityId) {
    if (!ent.assigneeType || !entityId) return [];
    const [rows] = await db.query(
        `SELECT legacy_user_id FROM work_assignees
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY id ASC`,
        [ent.assigneeType, entityId]
    );
    return (rows || []).map((r) => Number(r.legacy_user_id)).filter(Boolean);
}

async function syncEntityAssignees(db, ent, entityId, legacyUserIds, headLegacyId) {
    if (!ent.assigneeType || !entityId) return;
    const ids = Array.isArray(legacyUserIds) ? legacyUserIds.map(Number).filter((n) => n > 0) : [];
    const [proj] = await db.query(`SELECT legacy_id FROM ${ent.table} WHERE id = ? LIMIT 1`, [entityId]);
    const entityLegacyId = proj[0] ? Number(proj[0].legacy_id) || entityId : entityId;
    await db.query(`DELETE FROM work_assignees WHERE entity_type = ? AND entity_id = ?`, [
        ent.assigneeType,
        entityId,
    ]);
    for (const lid of ids) {
        const [st] = await db.query(
            `SELECT datagon_user_id FROM work_seo_staff WHERE legacy_user_id = ? LIMIT 1`,
            [lid]
        );
        const datagonUserId = st[0] && st[0].datagon_user_id ? Number(st[0].datagon_user_id) : null;
        await db.query(
            `INSERT INTO work_assignees
              (entity_type, entity_legacy_id, entity_id, legacy_user_id, datagon_user_id, created_at, updated_at)
             VALUES (?,?,?,?,?,NOW(),NOW())`,
            [ent.assigneeType, entityLegacyId, entityId, lid, datagonUserId]
        );
    }
    let head = headLegacyId != null && headLegacyId !== '' ? Number(headLegacyId) : 0;
    if (head && !ids.includes(head)) head = ids[0] || 0;
    if (!head && ids.length) head = ids[0];
    try {
        await db.query(`UPDATE ${ent.table} SET id_glavn_user = ?, updated_at = NOW() WHERE id = ?`, [
            head ? String(head) : '',
            entityId,
        ]);
    } catch (_) {
        /* services: нет id_glavn_user */
    }
}

async function matchStaffToUsers(db) {
    const [users] = await db.query(
        `SELECT id, username, full_name FROM users WHERE COALESCE(is_archived, 0) = 0`
    );
    const byName = new Map();
    const byUser = new Map();
    for (const u of users || []) {
        const n = normalizeName(u.full_name);
        if (n) {
            if (!byName.has(n)) byName.set(n, []);
            byName.get(n).push(u);
        }
        const un = normalizeName(u.username);
        if (un) byUser.set(un, u);
    }
    const [staff] = await db.query(`SELECT id, name, email, datagon_user_id FROM work_seo_staff`);
    let matched = 0;
    let ambiguous = 0;
    let skipped = 0;
    for (const s of staff || []) {
        if (s.datagon_user_id) {
            skipped += 1;
            continue;
        }
        const email = normalizeEmail(s.email);
        let hit = null;
        let note = null;
        if (email) {
            const byMail = (users || []).find(
                (u) =>
                    normalizeEmail(u.username) === email ||
                    normalizeName(u.full_name).includes(email.split('@')[0])
            );
            // username often equals login; try email local-part vs username
            const local = email.split('@')[0];
            hit =
                (users || []).find((u) => normalizeEmail(u.username) === email) ||
                (local ? byUser.get(normalizeName(local)) : null) ||
                byMail ||
                null;
            if (hit) note = 'email/username';
        }
        if (!hit) {
            const n = normalizeName(s.name);
            const list = n ? byName.get(n) || [] : [];
            if (list.length === 1) {
                hit = list[0];
                note = 'full_name';
            } else if (list.length > 1) {
                ambiguous += 1;
                await db.query(`UPDATE work_seo_staff SET match_note=?, updated_at=NOW() WHERE id=?`, [
                    'ambiguous_name',
                    s.id,
                ]);
                continue;
            }
        }
        if (hit) {
            await db.query(
                `UPDATE work_seo_staff SET datagon_user_id=?, match_note=?, updated_at=NOW() WHERE id=?`,
                [hit.id, note || 'auto', s.id]
            );
            matched += 1;
        }
    }
    return { matched, ambiguous, skipped, total: (staff || []).length };
}

module.exports = (db) => {
    const router = express.Router();
    let schemaReady = false;

    async function ready() {
        if (schemaReady) return;
        await ensureWorkPrimeSchema(db);
        schemaReady = true;
    }

    router.use(async (req, res, next) => {
        try {
            await ready();
            next();
        } catch (e) {
            next(e);
        }
    });

    router.get('/meta/entities', (req, res) => {
        res.json({
            success: true,
            entities: listWorkEntities().map((e) => ({
                slug: e.slug,
                pageKey: e.pageKey,
                title: e.title,
                subtitle: e.subtitle,
                listCols: e.listCols,
                formFields: e.formFields,
                isStaff: !!e.isStaff,
            })),
        });
    });

    router.get('/meta/users', async (req, res, next) => {
        try {
            const [rows] = await db.query(
                `SELECT id, username, full_name FROM users WHERE COALESCE(is_archived, 0) = 0 ORDER BY full_name`
            );
            res.json({ success: true, rows: rows || [] });
        } catch (e) {
            next(e);
        }
    });

    router.get('/meta/staff', async (req, res, next) => {
        try {
            const scope = await resolveWorkActorScope(db, actorOf(req));
            let sql = `SELECT s.id, s.legacy_user_id, s.name AS legacy_name, s.datagon_user_id, s.status,
                        u.full_name AS datagon_user_name, u.username AS datagon_username
                 FROM work_seo_staff s
                 LEFT JOIN users u ON u.id = s.datagon_user_id
                 WHERE COALESCE(s.status, 1) = 1`;
            const params = [];
            if (!scope.unscoped) {
                if (!scope.datagonUserId) {
                    return res.json({ success: true, rows: [] });
                }
                sql += ` AND s.datagon_user_id = ?`;
                params.push(scope.datagonUserId);
            }
            sql += ` ORDER BY COALESCE(NULLIF(TRIM(u.full_name), ''), s.name) ASC`;
            const [rows] = await db.query(sql, params);
            res.json({
                success: true,
                rows: (rows || []).map((r) => ({
                    legacy_user_id: Number(r.legacy_user_id) || 0,
                    name:
                        (r.datagon_user_name && String(r.datagon_user_name).trim()) ||
                        (r.datagon_username && String(r.datagon_username).trim()) ||
                        r.legacy_name ||
                        `user#${r.legacy_user_id}`,
                    datagon_user_id: r.datagon_user_id ? Number(r.datagon_user_id) : null,
                })),
            });
        } catch (e) {
            next(e);
        }
    });

    router.post('/seo-staff/rematch', async (req, res, next) => {
        try {
            const scope = await resolveWorkActorScope(db, actorOf(req));
            if (!scope.unscoped) {
                return res.status(403).json({
                    success: false,
                    error: 'Сопоставление сотрудников — только администратор',
                    code: 'FORBIDDEN',
                });
            }
            const stats = await matchStaffToUsers(db);
            res.json({ success: true, ...stats });
        } catch (e) {
            next(e);
        }
    });

    function requireSeoProjectsFull(req, res, next) {
        const a = req.datagonActor;
        if (!a) {
            return res.status(401).json({ success: false, error: 'Не авторизован', code: 'AUTH_REQUIRED' });
        }
        if (a.username === 'admin') return next();
        const mode = a.page_modes && a.page_modes['work-seo-projects'];
        if (mode === 'full') return next();
        return res.status(403).json({
            success: false,
            error: 'Нужен полный доступ к «Проекты SEO»',
            code: 'FORBIDDEN',
        });
    }

    /** Настройки выплат / массовый пересчёт — только admin WORK (как setting_payouts). */
    async function requireWorkAdmin(req, res, next) {
        try {
            const scope = await resolveWorkActorScope(db, actorOf(req));
            if (!scope.unscoped) {
                return res.status(403).json({
                    success: false,
                    error: 'Только администратор WORK',
                    code: 'FORBIDDEN',
                });
            }
            return next();
        } catch (e) {
            return next(e);
        }
    }

    router.get('/seo-payout-settings', requireSeoProjectsFull, requireWorkAdmin, async (req, res, next) => {
        try {
            const settings = await getSeoPayoutSettings(db);
            res.json({
                success: true,
                settings: {
                    procent_bonus: Number(settings.procent_bonus) || 0,
                    count_day_fine: Number(settings.count_day_fine) || 0,
                    procent_fine: Number(settings.procent_fine) || 0,
                    procent_for_fine: Number(settings.procent_for_fine) || 0,
                    bonus_add: Number(settings.bonus_add) || 0,
                    procent_seo: Number(settings.procent_seo) || 0,
                },
            });
        } catch (e) {
            next(e);
        }
    });

    router.put('/seo-payout-settings', requireSeoProjectsFull, requireWorkAdmin, async (req, res, next) => {
        try {
            const settings = await saveSeoPayoutSettings(db, req.body || {});
            res.json({
                success: true,
                settings: {
                    procent_bonus: Number(settings.procent_bonus) || 0,
                    count_day_fine: Number(settings.count_day_fine) || 0,
                    procent_fine: Number(settings.procent_fine) || 0,
                    procent_for_fine: Number(settings.procent_for_fine) || 0,
                    bonus_add: Number(settings.bonus_add) || 0,
                    procent_seo: Number(settings.procent_seo) || 0,
                },
            });
        } catch (e) {
            next(e);
        }
    });

    router.post('/seo-payout-recalc', requireSeoProjectsFull, requireWorkAdmin, async (req, res, next) => {
        try {
            const result = await recalcAllSeoSummaZp(db);
            res.json({ success: true, ...result });
        } catch (e) {
            next(e);
        }
    });

    router.get('/:slug', async (req, res, next) => {
        try {
            const ent = getWorkEntity(req.params.slug);
            if (!ent) return res.status(404).json({ success: false, error: 'unknown entity' });
            const scope = await resolveWorkActorScope(db, actorOf(req));
            const status = req.query.status != null && req.query.status !== '' ? Number(req.query.status) : null;
            const q = String(req.query.q || '').trim();
            const specialistLegacyId =
                req.query.specialist != null && String(req.query.specialist).trim() !== ''
                    ? Number(req.query.specialist)
                    : 0;
            const page = Math.max(1, Number(req.query.page) || 1);
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
            const offset = (page - 1) * limit;
            const sortableKeys = new Set(
                (ent.listCols || [])
                    .map((c) => c.key)
                    .filter((k) => k && k !== 'favicon')
            );
            let sortKey = String(req.query.sort || '').trim();
            if (sortKey && !sortableKeys.has(sortKey)) sortKey = '';
            let sortDir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

            let sql = `SELECT t.*`;
            if (ent.isStaff) {
                sql += `, u.full_name AS datagon_user_name, u.username AS datagon_username`;
            }
            sql += ` FROM ${ent.table} t`;
            if (ent.isStaff) {
                sql += ` LEFT JOIN users u ON u.id = t.datagon_user_id`;
            }
            sql += ` WHERE 1=1`;
            let params = [];
            if (status === 0 || status === 1) {
                sql += ` AND t.status = ?`;
                params.push(status);
            }
            ({ sql, params } = appendWorkActorScopeSql(ent, scope, sql, params));
            if (specialistLegacyId > 0 && ent.assigneeType && !ent.isStaff) {
                const hasGlavn = ent.table !== 'work_services';
                if (hasGlavn) {
                    sql += ` AND (
                        CAST(IFNULL(t.id_glavn_user, '0') AS UNSIGNED) = ?
                        OR EXISTS (
                          SELECT 1 FROM work_assignees a
                          WHERE a.entity_type = ?
                            AND (
                              a.entity_id = t.id
                              OR (t.legacy_id IS NOT NULL AND a.entity_legacy_id = t.legacy_id)
                            )
                            AND a.legacy_user_id = ?
                        )
                    )`;
                    params.push(specialistLegacyId, ent.assigneeType, specialistLegacyId);
                } else {
                    sql += ` AND EXISTS (
                      SELECT 1 FROM work_assignees a
                      WHERE a.entity_type = ?
                        AND (
                          a.entity_id = t.id
                          OR (t.legacy_id IS NOT NULL AND a.entity_legacy_id = t.legacy_id)
                        )
                        AND a.legacy_user_id = ?
                    )`;
                    params.push(ent.assigneeType, specialistLegacyId);
                }
            }
            if (q) {
                if (ent.isStaff) {
                    sql += ` AND (t.name LIKE ? OR t.email LIKE ? OR t.specialism LIKE ? OR u.full_name LIKE ?)`;
                    const like = `%${q}%`;
                    params.push(like, like, like, like);
                } else {
                    sql += ` AND (t.name_project LIKE ? OR CAST(t.id AS CHAR) LIKE ?)`;
                    const like = `%${q}%`;
                    params.push(like, like);
                }
            }
            // Полная выборка (наборы WORK небольшие) → enrich → sort → page.
            sql += ` ORDER BY t.positions ASC, t.id DESC`;
            const [rows] = await db.query(sql, params);
            let enriched = await enrichWorkListRows(db, ent, rows || []);
            if (sortKey) enriched = sortWorkRows(enriched, sortKey, sortDir);
            const total = enriched.length;
            const pageRows = enriched.slice(offset, offset + limit);
            const summary = await buildWorkSummary(db, ent, scope);
            res.json({
                success: true,
                entity: {
                    slug: ent.slug,
                    title: ent.title,
                    listCols: ent.listCols,
                    formFields: ent.formFields,
                    isStaff: !!ent.isStaff,
                    showFavicon: !!ent.showFavicon,
                    summaryKind: ent.summaryKind || null,
                },
                summary,
                scope: scope.unscoped ? 'all' : 'self',
                rows: pageRows,
                total,
                page,
                limit,
                sort: sortKey || null,
                dir: sortKey ? sortDir : null,
            });
        } catch (e) {
            next(e);
        }
    });

    router.get('/:slug/:id', async (req, res, next) => {
        try {
            const ent = getWorkEntity(req.params.slug);
            if (!ent) return res.status(404).json({ success: false, error: 'unknown entity' });
            const scope = await resolveWorkActorScope(db, actorOf(req));
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ success: false, error: 'bad id' });
            let sql = `SELECT t.*`;
            if (ent.isStaff) sql += `, u.full_name AS datagon_user_name`;
            sql += ` FROM ${ent.table} t`;
            if (ent.isStaff) sql += ` LEFT JOIN users u ON u.id = t.datagon_user_id`;
            sql += ` WHERE t.id = ? LIMIT 1`;
            const [rows] = await db.query(sql, [id]);
            if (!rows[0]) return res.status(404).json({ success: false, error: 'not found' });
            const row = rows[0];
            if (!(await actorCanAccessWorkRow(db, ent, row, scope))) {
                return res.status(403).json({ success: false, error: 'Нет доступа к этой записи', code: 'FORBIDDEN' });
            }
            if (ent.assigneeType) {
                row.assignee_legacy_ids = await loadAssigneesForEntity(db, ent, id);
            }
            res.json({ success: true, row });
        } catch (e) {
            next(e);
        }
    });

    function pickFields(ent, body) {
        const out = {};
        for (const f of ent.formFields) {
            if (f.type === 'staff-multi' || f.key === 'assignee_legacy_ids') continue;
            if (Object.prototype.hasOwnProperty.call(body, f.key)) {
                let v = body[f.key];
                if (f.type === 'checkbox' || f.type === 'select-status') {
                    out[f.key] = Number(v) === 1 ? 1 : 0;
                } else if (f.type === 'number' || f.key === 'datagon_user_id') {
                    if (v === '' || v === null || v === undefined) {
                        out[f.key] = f.key === 'datagon_user_id' ? null : 0;
                    } else {
                        out[f.key] = Number(v);
                    }
                } else if (f.type === 'staff-head') {
                    out[f.key] = v == null || v === '' ? '' : String(v);
                } else {
                    out[f.key] = v == null ? '' : String(v);
                }
            }
        }
        return out;
    }

    router.post('/:slug', async (req, res, next) => {
        try {
            const ent = getWorkEntity(req.params.slug);
            if (!ent) return res.status(404).json({ success: false, error: 'unknown entity' });
            const scope = await resolveWorkActorScope(db, actorOf(req));
            if (!scope.unscoped) {
                return res.status(403).json({
                    success: false,
                    error: 'Создание записей WORK — только для администратора',
                    code: 'FORBIDDEN',
                });
            }
            const body = req.body || {};
            const data = pickFields(ent, body);
            if (!ent.isStaff && !data.name_project) {
                return res.status(400).json({ success: false, error: 'name_project required' });
            }
            if (ent.isStaff && !data.name && !data.datagon_user_id) {
                return res.status(400).json({ success: false, error: 'name or datagon_user_id required' });
            }
            if (data.status == null) data.status = 1;
            // id_glavn_user пишем через syncEntityAssignees
            const assigneeIds = parseAssigneeLegacyIds(body);
            const headId = body.id_glavn_user;
            if (ent.assigneeType && Object.prototype.hasOwnProperty.call(data, 'id_glavn_user')) {
                delete data.id_glavn_user;
            }
            const keys = Object.keys(data);
            const cols = keys.concat(['created_at', 'updated_at']);
            const placeholders = keys.map(() => '?').concat(['NOW()', 'NOW()']);
            const vals = keys.map((k) => data[k]);
            const [r] = await db.query(
                `INSERT INTO \`${ent.table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${placeholders.join(',')})`,
                vals
            );
            if (ent.assigneeType && assigneeIds) {
                await syncEntityAssignees(db, ent, r.insertId, assigneeIds, headId);
            }
            res.json({ success: true, id: r.insertId });
        } catch (e) {
            next(e);
        }
    });

    router.put('/:slug/:id', async (req, res, next) => {
        try {
            const ent = getWorkEntity(req.params.slug);
            if (!ent) return res.status(404).json({ success: false, error: 'unknown entity' });
            const scope = await resolveWorkActorScope(db, actorOf(req));
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ success: false, error: 'bad id' });
            const [existRows] = await db.query(`SELECT * FROM ${ent.table} WHERE id = ? LIMIT 1`, [id]);
            if (!existRows[0]) return res.status(404).json({ success: false, error: 'not found' });
            if (!(await actorCanAccessWorkRow(db, ent, existRows[0], scope))) {
                return res.status(403).json({ success: false, error: 'Нет доступа к этой записи', code: 'FORBIDDEN' });
            }
            const body = req.body || {};
            const data = pickFields(ent, body);
            const assigneeIds = parseAssigneeLegacyIds(body);
            const headId = Object.prototype.hasOwnProperty.call(body, 'id_glavn_user')
                ? body.id_glavn_user
                : undefined;
            if (ent.assigneeType && Object.prototype.hasOwnProperty.call(data, 'id_glavn_user')) {
                delete data.id_glavn_user;
            }
            if (!Object.keys(data).length && assigneeIds == null) {
                return res.status(400).json({ success: false, error: 'no fields' });
            }
            if (Object.keys(data).length) {
                const sets = Object.keys(data)
                    .map((k) => `\`${k}\`=?`)
                    .concat(['updated_at=NOW()']);
                const vals = Object.keys(data)
                    .map((k) => data[k])
                    .concat([id]);
                await db.query(`UPDATE \`${ent.table}\` SET ${sets.join(', ')} WHERE id=?`, vals);
            }
            if (ent.assigneeType && assigneeIds != null) {
                await syncEntityAssignees(db, ent, id, assigneeIds, headId);
            }
            res.json({ success: true, id });
        } catch (e) {
            next(e);
        }
    });

    /** Soft-archive: status=0; hard delete if ?hard=1 */
    router.delete('/:slug/:id', async (req, res, next) => {
        try {
            const ent = getWorkEntity(req.params.slug);
            if (!ent) return res.status(404).json({ success: false, error: 'unknown entity' });
            const scope = await resolveWorkActorScope(db, actorOf(req));
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ success: false, error: 'bad id' });
            const [existRows] = await db.query(`SELECT * FROM ${ent.table} WHERE id = ? LIMIT 1`, [id]);
            if (!existRows[0]) return res.status(404).json({ success: false, error: 'not found' });
            if (!(await actorCanAccessWorkRow(db, ent, existRows[0], scope))) {
                return res.status(403).json({ success: false, error: 'Нет доступа к этой записи', code: 'FORBIDDEN' });
            }
            if (String(req.query.hard || '') === '1') {
                if (!scope.unscoped) {
                    return res.status(403).json({
                        success: false,
                        error: 'Жёсткое удаление — только администратор',
                        code: 'FORBIDDEN',
                    });
                }
                await db.query(`DELETE FROM ${ent.table} WHERE id=?`, [id]);
            } else {
                await db.query(`UPDATE ${ent.table} SET status=0, updated_at=NOW() WHERE id=?`, [id]);
            }
            res.json({ success: true });
        } catch (e) {
            next(e);
        }
    });

    return router;
};

module.exports.ensureWorkPrimeSchema = ensureWorkPrimeSchema;
module.exports.matchStaffToUsers = matchStaffToUsers;
