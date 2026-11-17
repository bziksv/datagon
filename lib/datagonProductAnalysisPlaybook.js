'use strict';

const { salesJoinSql, salesQtyExprSql } = require('./datagonSupplierAnalysisSql');
const { sqlProductAnalysisCatalogWhere } = require('./datagonSuppliersSql');

const SCENARIO_ORDER = ['had_sales', 'never_sold', 'slow', 'expiry'];

const SCENARIOS = {
    had_sales: {
        key: 'had_sales',
        title: 'Раньше продавался',
        short: 'Были продажи',
        blurb: 'Сейчас продаж нет, раньше были',
        steps: [
            { id: 'had_price', title: 'Проверить закупочную цену', hint: 'Сравните с ценой продажи и с ценой конкурента.', reviewDays: 0 },
            { id: 'had_card', title: 'Проверить карточку', hint: 'Название (Вордстат и как у конкурентов), инфографика, RICH, характеристики.', reviewDays: 14 },
            { id: 'had_series', title: 'Объединить похожие в серию', hint: 'Если похожих нет — пропустите шаг.', reviewDays: 0 },
            { id: 'had_comp', title: 'Посмотреть цены конкурентов', hint: 'Запишите, чем наша цена отличается.', reviewDays: 0 },
            { id: 'had_huckster', title: 'Поставить минимальную цену в Хакстере', hint: 'Проверьте, пошли ли продажи.', reviewDays: 30 },
            { id: 'had_promo', title: 'Сделать акцию или рекламу', hint: 'Буст или акция на этот товар.', reviewDays: 0 },
            { id: 'had_exit', title: 'Продать в ноль или в минус', hint: 'На этом сценарий заканчивается.', reviewDays: 0 },
        ],
    },
    never_sold: {
        key: 'never_sold',
        title: 'Никогда не продавался',
        short: 'Не продавался',
        blurb: 'Продаж не было вообще. Новые закупки по этому коду остановим, чтобы не копить остаток.',
        steps: [
            { id: 'nv_stock', title: 'Посмотреть остаток и цену конкурента', hint: 'Сколько лежит и насколько наша цена выше.', reviewDays: 0 },
            { id: 'nv_card', title: 'Проверить карточку', hint: 'Характеристики, инфографика, название, ключевые слова.', reviewDays: 0 },
            { id: 'nv_card_fix', title: 'Доработать карточку, если надо', hint: 'Если править нечего — пропустите.', reviewDays: 14 },
            { id: 'nv_series', title: 'Объединить похожие в серию', hint: 'Если похожих нет — пропустите шаг.', reviewDays: 0 },
            { id: 'nv_huckster', title: 'Поставить конкурентную цену и включить в Хакстер', hint: 'Проверьте, пошли ли продажи.', reviewDays: 30 },
            { id: 'nv_promo', title: 'Сделать акцию или рекламу', hint: 'Если Хакстер не помог.', reviewDays: 0 },
            { id: 'nv_exit', title: 'Продать в ноль или в минус', hint: 'На этом сценарий заканчивается.', reviewDays: 0 },
        ],
    },
    slow: {
        key: 'slow',
        title: 'Продаётся медленно',
        short: 'Медленно',
        blurb: 'Продажи есть, остаток тает очень долго',
        steps: [
            { id: 'slow_windows', title: 'Посмотреть продажи за 30, 60 и 90 дней', hint: 'Цифры ниже. Средние за месяц = продажи за 90 дней / 3.', reviewDays: 0 },
            { id: 'slow_freeze', title: 'Остановить закупки', hint: 'После этого новые заказы по коду ставиться не будут.', reviewDays: 0, effect: 'freeze_orders' },
            { id: 'slow_card', title: 'Проверить и доработать карточку', hint: 'Характеристики, инфографика, название, ключевые слова.', reviewDays: 14 },
            { id: 'slow_series', title: 'Объединить похожие в серию', hint: 'Если похожих нет — пропустите шаг.', reviewDays: 0 },
            { id: 'slow_huckster', title: 'Цены конкурентов и Хакстер', hint: 'Включайте Хакстер, только если цена мешает.', reviewDays: 30 },
            { id: 'slow_promo', title: 'Дополнительная реклама', hint: 'Буст на эту позицию.', reviewDays: 0 },
            { id: 'slow_exit', title: 'Продать в ноль или в минус', hint: 'На этом сценарий заканчивается.', reviewDays: 0 },
        ],
    },
    expiry: {
        key: 'expiry',
        title: 'Срок годности',
        short: 'Срок',
        blurb: 'Сначала дата «годен до», потом шаги',
        steps: [
            { id: 'ex_card', title: 'Проверить карточку и поправить', hint: 'Когда до конца срока 6 месяцев или меньше.', reviewDays: 0 },
            { id: 'ex_series', title: 'Объединить похожие в серию', hint: 'Если похожих нет — пропустите шаг.', reviewDays: 0 },
            { id: 'ex_huckster', title: 'Цены конкурентов и Хакстер', hint: 'Обычная стратегия, если она ещё уместна.', reviewDays: 30 },
            { id: 'ex_m5', title: 'Калькулятор «Срок годности», маржа 5–6%', hint: 'Отдельный калькулятор в Хакстере.', reviewDays: 30 },
            { id: 'ex_m2', title: 'Снизить маржу примерно до 2%', hint: 'Снова проверьте через месяц.', reviewDays: 30 },
            { id: 'ex_decide', title: 'Продажи пошли — выберите, что дальше', hint: 'Допродать и больше не работать, либо вернуть прежнюю маржу.', reviewDays: 0 },
            { id: 'ex_exit', title: 'Продать в ноль или в минус', hint: 'До конца 3 месяца или меньше, продаж нет.', reviewDays: 0 },
        ],
    },
};

function todayYmdMoscow(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}

function addDays(ymd, n) {
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(n || 0));
    return dt.toISOString().slice(0, 10);
}

function daysUntil(expiry, today) {
    if (!expiry) return null;
    const [y1, m1, d1] = String(today).slice(0, 10).split('-').map(Number);
    const [y2, m2, d2] = String(expiry).slice(0, 10).split('-').map(Number);
    const a = Date.UTC(y1, m1 - 1, d1);
    const b = Date.UTC(y2, m2 - 1, d2);
    return Math.round((b - a) / 86400000);
}

function emptyPlaybookState() {
    return {
        scenario: null,
        status: null,
        step_index: 0,
        steps: [],
        review_due: null,
        expiry_date: null,
        phase: 'pick',
        early_exit: false,
    };
}

function cloneState(state) {
    const base = state && typeof state === 'object' ? state : emptyPlaybookState();
    return {
        scenario: base.scenario || null,
        status: base.status || null,
        step_index: Number(base.step_index) || 0,
        steps: (base.steps || []).map((s) => ({
            id: s.id,
            status: s.status || 'pending',
            done_at: s.done_at || null,
            done_by: s.done_by ? String(s.done_by).slice(0, 255) : null,
            note: s.note ? String(s.note).slice(0, 1000) : null,
            note_by: s.note_by ? String(s.note_by).slice(0, 255) : null,
            note_at: s.note_at || null,
        })),
        review_due: base.review_due ? String(base.review_due).slice(0, 10) : null,
        expiry_date: base.expiry_date ? String(base.expiry_date).slice(0, 10) : null,
        phase: 'step',
        early_exit: false,
    };
}

function freshSteps(scenarioKey) {
    return SCENARIOS[scenarioKey].steps.map((s) => ({
        id: s.id,
        status: 'pending',
        done_at: null,
    }));
}

function withPhase(state, today) {
    const next = cloneState(state);
    if (!next.scenario || !next.status) {
        next.phase = 'pick';
        return next;
    }
    if (next.status !== 'active') {
        next.phase = next.status;
        return next;
    }
    if (next.scenario === 'expiry') {
        const until = daysUntil(next.expiry_date, today);
        next.early_exit = until != null && until <= 92;
        if (!next.expiry_date || (until != null && until > 180)) {
            next.phase = 'too_early';
            return next;
        }
    } else {
        next.early_exit = false;
    }
    const step = next.steps[next.step_index];
    if (step && step.status === 'done' && next.review_due) next.phase = 'wait';
    else next.phase = 'step';
    return next;
}

function fail(error) {
    return { ok: false, error, state: null, effects: [] };
}

function ok(state, today, effects) {
    return { ok: true, state: withPhase(state, today), effects: effects || [] };
}

function currentDef(state) {
    const cat = SCENARIOS[state.scenario];
    if (!cat) return null;
    return cat.steps[state.step_index] || null;
}

function actorName(actor) {
    if (!actor) return null;
    const raw = actor.full_name || actor.name || actor.username || '';
    const name = String(raw).trim();
    return name ? name.slice(0, 255) : null;
}

function nowStamp(now = new Date()) {
    const formatted = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(now);
    return formatted.replace(' ', 'T').slice(0, 16);
}

function writeStepNote(state, body, actor) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'note')) return;
    const step = state.steps[state.step_index];
    if (!step) return;
    const note = String(body.note || '').trim().slice(0, 1000);
    step.note = note || null;
    if (step.note) {
        step.note_by = actorName(actor);
        step.note_at = nowStamp();
    } else {
        step.note_by = null;
        step.note_at = null;
    }
}

function markStepClosed(step, actor) {
    step.done_by = actorName(actor);
    step.done_at = nowStamp();
}

function applyPlaybookAction(raw, body, today, actor) {
    const action = body && body.action;
    const todayY = String(today || '').slice(0, 10);
    let state = cloneState(raw);

    if (action === 'reset') {
        return ok(emptyPlaybookState(), todayY, []);
    }

    if (action === 'start') {
        const key = body.scenario;
        if (!SCENARIOS[key]) return fail('Неизвестный сценарий');
        if (key === 'expiry' && !body.expiry_date) {
            return fail('Сначала укажите, до какой даты годен');
        }
        state = {
            scenario: key,
            status: 'active',
            step_index: 0,
            steps: freshSteps(key),
            review_due: null,
            expiry_date: key === 'expiry' ? String(body.expiry_date).slice(0, 10) : null,
        };
        const effects = key === 'never_sold' ? ['lock_new_sku'] : [];
        return ok(state, todayY, effects);
    }

    if (!state.scenario || state.status !== 'active') return fail('Сначала выберите сценарий');

    if (action === 'set_expiry') {
        if (state.scenario !== 'expiry') return fail('Дата нужна только для срока годности');
        if (!body.expiry_date) return fail('Сначала укажите, до какой даты годен');
        state.expiry_date = String(body.expiry_date).slice(0, 10);
        return ok(state, todayY, []);
    }

    if (action === 'close_sales') {
        writeStepNote(state, body, actor);
        state.status = 'closed_sales';
        state.review_due = null;
        return ok(state, todayY, []);
    }

    if (action === 'finish_done') {
        const def = currentDef(state);
        if (!def || def.id !== 'ex_decide') return fail('Это решение только на шаге «продажи пошли»');
        state.steps[state.step_index].status = 'done';
        markStepClosed(state.steps[state.step_index], actor);
        state.status = 'done';
        state.review_due = null;
        return ok(state, todayY, []);
    }

    if (action === 'open_expiry_exit') {
        const phased = withPhase(state, todayY);
        if (!phased.early_exit) return fail('До срока ещё больше трёх месяцев');
        state.step_index = SCENARIOS.expiry.steps.length - 1;
        state.review_due = null;
        state.steps[state.step_index].status = 'pending';
        state.steps[state.step_index].done_at = null;
        return ok(state, todayY, []);
    }

    const phased = withPhase(state, todayY);
    if (phased.phase === 'too_early') {
        return fail('До срока ещё больше полугода. Сценарий срока годности рано начинать');
    }

    if (action === 'set_step_note') {
        writeStepNote(state, body, actor);
        return ok(state, todayY, []);
    }

    if (action === 'back_step') {
        if ((Number(state.step_index) || 0) <= 0) return fail('Это первый шаг');
        writeStepNote(state, body, actor);
        state.review_due = null;
        state.status = 'active';
        state.step_index -= 1;
        const prev = state.steps[state.step_index];
        if (prev && (prev.status === 'done' || prev.status === 'skipped')) {
            prev.status = 'pending';
        }
        return ok(state, todayY, []);
    }

    if (action === 'advance_after_review') {
        if (phased.phase !== 'wait') return fail('Сейчас нечего переводить дальше');
        if (!body.force && state.review_due > todayY) return fail('Дата проверки ещё не наступила');
        state.step_index += 1;
        state.review_due = null;
        if (state.step_index >= state.steps.length) {
            state.status = 'done';
            state.step_index = state.steps.length - 1;
        }
        return ok(state, todayY, []);
    }

    if (action === 'skip_step') {
        if (phased.phase === 'wait') return fail('Сначала дождитесь проверки или нажмите «Не ждать»');
        const def = currentDef(state);
        if (def && def.id === 'ex_decide') return fail('Здесь нужно выбрать одну из двух кнопок');
        writeStepNote(state, body, actor);
        state.steps[state.step_index].status = 'skipped';
        markStepClosed(state.steps[state.step_index], actor);
        state.review_due = null;
        state.step_index += 1;
        if (state.step_index >= state.steps.length) {
            state.status = 'done';
            state.step_index = state.steps.length - 1;
        }
        return ok(state, todayY, []);
    }

    if (action === 'complete_step') {
        if (phased.phase === 'wait') return fail('Сначала дождитесь проверки или нажмите «Не ждать»');
        const def = currentDef(state);
        if (!def) return fail('Шаг не найден');
        if (def.id === 'ex_decide') return fail('Здесь нужно выбрать одну из двух кнопок');
        writeStepNote(state, body, actor);
        state.steps[state.step_index].status = 'done';
        markStepClosed(state.steps[state.step_index], actor);
        const effects = def.effect ? [def.effect] : [];
        if (def.reviewDays > 0) {
            state.review_due = addDays(todayY, def.reviewDays);
            return ok(state, todayY, effects);
        }
        state.review_due = null;
        const isLast = state.step_index >= state.steps.length - 1;
        if (isLast) {
            state.status = 'done';
            return ok(state, todayY, effects);
        }
        state.step_index += 1;
        return ok(state, todayY, effects);
    }

    return fail('Неизвестное действие');
}

function suggestScenario(input) {
    const today = String((input && input.today) || '').slice(0, 10);
    const expiry = input && input.expiryDate ? String(input.expiryDate).slice(0, 10) : null;
    if (expiry && daysUntil(expiry, today) != null && daysUntil(expiry, today) <= 180) return 'expiry';
    const period = Number(input && input.periodSalesQty) || 0;
    const life = Boolean(input && input.lifetimeSales);
    if (period <= 0 && !life) return 'never_sold';
    if (period <= 0 && life) return 'had_sales';
    const qty90 = Number(input && input.salesQty90) || 0;
    const stock = Number(input && input.stockQty) || 0;
    if (qty90 > 0 && stock / (qty90 / 3) >= 4) return 'slow';
    return null;
}

function cellModel(raw, today) {
    const state = withPhase(raw, today);
    if (!state.scenario || state.phase === 'pick') return { text: 'Нет сценария', tone: 'muted' };
    const short = SCENARIOS[state.scenario].short;
    const n = state.step_index + 1;
    const m = state.steps.length;
    if (state.status === 'done') return { text: 'Готово · ' + short, tone: 'success' };
    if (state.status === 'closed_sales') return { text: 'Закрыто · продажи пошли', tone: 'success' };
    if (state.phase === 'too_early') return { text: short + ' · ещё рано', tone: 'info' };
    if (state.phase === 'wait' && state.review_due && state.review_due <= String(today).slice(0, 10)) {
        return { text: 'Пора проверить · шаг ' + n + ' из ' + m, tone: 'danger' };
    }
    if (state.phase === 'wait') {
        return { text: short + ' · шаг ' + n + ' из ' + m + ' · проверить ' + state.review_due, tone: 'info' };
    }
    return { text: short + ' · шаг ' + n + ' из ' + m, tone: 'info' };
}

function playbookMeta() {
    return {
        scenarios: SCENARIO_ORDER.map((key) => {
            const s = SCENARIOS[key];
            return {
                key: s.key,
                title: s.title,
                short: s.short,
                blurb: s.blurb,
                steps: s.steps.map((st) => ({
                    id: st.id,
                    title: st.title,
                    hint: st.hint,
                    reviewDays: st.reviewDays,
                })),
            };
        }),
    };
}

function salesWindowsSql() {
    const qty = salesQtyExprSql();
    return `
        SELECT
            SUM(CASE WHEN d.moment >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN ${qty} ELSE 0 END) AS d30,
            SUM(CASE WHEN d.moment >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN ${qty} ELSE 0 END) AS d60,
            SUM(CASE WHEN d.moment >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN ${qty} ELSE 0 END) AS d90
        ${salesJoinSql('e', '', undefined, sqlProductAnalysisCatalogWhere)}
          AND e.code = ?
          AND d.moment >= DATE_SUB(NOW(), INTERVAL 90 DAY)`;
}

function lifetimeSalesSql() {
    return `
        SELECT 1 AS n
        ${salesJoinSql('e', '', undefined, sqlProductAnalysisCatalogWhere)}
          AND e.code = ?
        LIMIT 1`;
}

function periodSalesSql() {
    const qty = salesQtyExprSql();
    return `
        SELECT SUM(${qty}) AS qty
        ${salesJoinSql('e', '', undefined, sqlProductAnalysisCatalogWhere)}
          AND e.code = ?
          AND d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)`;
}

let playbookSchemaReady = false;

async function ensurePlaybookSchema(db) {
    if (playbookSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_analysis_playbook (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            scenario VARCHAR(32) NOT NULL,
            status VARCHAR(16) NOT NULL,
            step_index INT NOT NULL DEFAULT 0,
            steps_json JSON NOT NULL,
            review_due DATE NULL,
            expiry_date DATE NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by_user_id INT NULL,
            updated_by_name VARCHAR(255) NULL,
            INDEX idx_pap_due (status, review_due)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    playbookSchemaReady = true;
}

function rowToState(row) {
    if (!row) return emptyPlaybookState();
    let steps = [];
    try {
        steps = typeof row.steps_json === 'string' ? JSON.parse(row.steps_json) : row.steps_json || [];
    } catch (_e) {
        steps = [];
    }
    return {
        scenario: row.scenario || null,
        status: row.status || null,
        step_index: Number(row.step_index) || 0,
        steps,
        review_due: row.review_due ? String(row.review_due).slice(0, 10) : null,
        expiry_date: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
    };
}

async function loadPlaybook(db, code) {
    await ensurePlaybookSchema(db);
    const [rows] = await db.query(
        `SELECT scenario, status, step_index, steps_json, review_due, expiry_date
           FROM dg_product_analysis_playbook WHERE code = ? LIMIT 1`,
        [code],
    );
    return rowToState(rows && rows[0]);
}

async function savePlaybook(db, code, state, actor) {
    await ensurePlaybookSchema(db);
    if (!state.scenario) {
        await db.query(`DELETE FROM dg_product_analysis_playbook WHERE code = ?`, [code]);
        return;
    }
    const name = actorName(actor);
    const userId = actor && Number(actor.id) > 0 ? Number(actor.id) : null;
    await db.query(
        `INSERT INTO dg_product_analysis_playbook
            (code, scenario, status, step_index, steps_json, review_due, expiry_date, updated_by_user_id, updated_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            scenario = VALUES(scenario),
            status = VALUES(status),
            step_index = VALUES(step_index),
            steps_json = VALUES(steps_json),
            review_due = VALUES(review_due),
            expiry_date = VALUES(expiry_date),
            updated_by_user_id = VALUES(updated_by_user_id),
            updated_by_name = VALUES(updated_by_name)`,
        [
            code,
            state.scenario,
            state.status,
            state.step_index,
            JSON.stringify(state.steps || []),
            state.review_due,
            state.expiry_date,
            userId,
            name,
        ],
    );
}

function stepNotesSig(state) {
    return (state && state.steps ? state.steps : [])
        .filter((s) => s && s.note)
        .map((s) => `${s.id}: ${s.note_by || '—'} — ${s.note}`)
        .join(' | ')
        .slice(0, 255);
}

async function writePlaybookLog(db, code, before, after, actor) {
    const pairs = [
        ['playbook_scenario', before.scenario, after.scenario],
        ['playbook_step', String(before.step_index || 0), String(after.step_index || 0)],
        ['playbook_status', before.status, after.status],
        ['playbook_note', stepNotesSig(before), stepNotesSig(after)],
    ];
    const name = actorName(actor);
    const userId = actor && Number(actor.id) > 0 ? Number(actor.id) : null;
    for (const [field, oldV, newV] of pairs) {
        if (String(oldV || '') === String(newV || '')) continue;
        await db.query(
            `INSERT INTO dg_product_analysis_decisions_log
                (code, field, old_value, new_value, source, changed_by_user_id, changed_by_name)
             VALUES (?, ?, ?, ?, 'playbook', ?, ?)`,
            [code, field, oldV == null ? null : String(oldV).slice(0, 255), newV == null ? null : String(newV).slice(0, 255), userId, name],
        );
    }
}

async function handlePlaybookAction(db, codeRaw, body, actor, deps) {
    const code = String(codeRaw || '').trim();
    if (!code) return { ok: false, status: 400, error: 'Нет кода' };
    const today = deps.today();
    const before = await loadPlaybook(db, code);
    const applied = applyPlaybookAction(before, body || {}, today, actor);
    if (!applied.ok) return { ok: false, status: 400, error: applied.error };
    if (applied.effects.includes('lock_new_sku')) {
        await deps.upsertProductDecision(db, code, {
            do_not_order: true,
            lock_proposed_min_stock: true,
        }, actor, { source: 'playbook' });
    }
    if (applied.effects.includes('freeze_orders')) {
        await deps.upsertProductDecision(db, code, { do_not_order: true }, actor, { source: 'playbook' });
    }
    await savePlaybook(db, code, applied.state, actor);
    await writePlaybookLog(db, code, before, applied.state, actor);
    return {
        ok: true,
        status: 200,
        payload: { success: true, state: applied.state, cell: cellModel(applied.state, today) },
    };
}

module.exports = {
    SCENARIOS,
    todayYmdMoscow,
    addDays,
    daysUntil,
    suggestScenario,
    applyPlaybookAction,
    cellModel,
    playbookMeta,
    emptyPlaybookState,
    withPhase,
    ensurePlaybookSchema,
    loadPlaybook,
    savePlaybook,
    handlePlaybookAction,
    rowToState,
    salesWindowsSql,
    lifetimeSalesSql,
    periodSalesSql,
};
