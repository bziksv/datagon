'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('./datagonProductAnalysisPlaybook');

const TODAY = '2026-11-17';

test('suggest never_sold when lifetime and period are empty', () => {
    assert.equal(
        pb.suggestScenario({
            lifetimeSales: false,
            periodSalesQty: 0,
            stockQty: 10,
            salesQty90: 0,
            expiryDate: null,
            today: TODAY,
        }),
        'never_sold',
    );
});

test('suggest had_sales when period is empty but lifetime exists', () => {
    assert.equal(
        pb.suggestScenario({
            lifetimeSales: true,
            periodSalesQty: 0,
            stockQty: 4,
            salesQty90: 0,
            expiryDate: null,
            today: TODAY,
        }),
        'had_sales',
    );
});

test('suggest slow when 90d sales cover at least 4 months of stock', () => {
    assert.equal(
        pb.suggestScenario({
            lifetimeSales: true,
            periodSalesQty: 3,
            stockQty: 12,
            salesQty90: 3,
            expiryDate: null,
            today: TODAY,
        }),
        'slow',
    );
});

test('expiry within 180 days wins over sales', () => {
    assert.equal(
        pb.suggestScenario({
            lifetimeSales: false,
            periodSalesQty: 0,
            stockQty: 1,
            salesQty90: 0,
            expiryDate: '2027-04-01',
            today: TODAY,
        }),
        'expiry',
    );
});

test('no highlight when sales are healthy', () => {
    assert.equal(
        pb.suggestScenario({
            lifetimeSales: true,
            periodSalesQty: 30,
            stockQty: 5,
            salesQty90: 30,
            expiryDate: null,
            today: TODAY,
        }),
        null,
    );
});

test('complete_step with 14 days waits', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY);
    const priced = pb.applyPlaybookAction(started.state, { action: 'complete_step' }, TODAY);
    const card = pb.applyPlaybookAction(priced.state, { action: 'complete_step' }, TODAY);
    assert.equal(card.ok, true);
    assert.equal(card.state.step_index, 1);
    assert.equal(card.state.steps[1].status, 'done');
    assert.equal(card.state.review_due, '2026-12-01');
    const early = pb.applyPlaybookAction(card.state, { action: 'advance_after_review' }, TODAY);
    assert.equal(early.ok, false);
    const forced = pb.applyPlaybookAction(card.state, {
        action: 'advance_after_review',
        force: true,
    }, TODAY);
    assert.equal(forced.state.step_index, 2);
    assert.equal(forced.state.review_due, null);
});

test('skip does not set review_due', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY);
    const skipped = pb.applyPlaybookAction(started.state, { action: 'skip_step' }, TODAY);
    assert.equal(skipped.state.step_index, 1);
    assert.equal(skipped.state.steps[0].status, 'skipped');
    assert.equal(skipped.state.review_due, null);
});

test('never_sold start asks to lock purchasing', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'never_sold',
    }, TODAY);
    assert.deepEqual(started.effects, ['lock_new_sku']);
});

test('slow freeze step asks do_not_order', () => {
    let state = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'slow',
    }, TODAY).state;
    state = pb.applyPlaybookAction(state, { action: 'complete_step' }, TODAY).state;
    const freeze = pb.applyPlaybookAction(state, { action: 'complete_step' }, TODAY);
    assert.deepEqual(freeze.effects, ['freeze_orders']);
    assert.equal(freeze.state.step_index, 2);
});

test('reset keeps no flags in the playbook result and clears steps', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY);
    const reset = pb.applyPlaybookAction(started.state, { action: 'reset' }, TODAY);
    assert.equal(reset.state.scenario, null);
    assert.deepEqual(reset.effects, []);
});

test('expiry blocks steps beyond 180 days and rejects steps without a date', () => {
    const noDate = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'expiry',
    }, TODAY);
    assert.equal(noDate.ok, false);
    assert.match(noDate.error, /годен/);
    const early = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'expiry',
        expiry_date: '2027-11-17',
    }, TODAY);
    assert.equal(early.ok, true);
    assert.equal(early.state.phase, 'too_early');
    const stepped = pb.applyPlaybookAction(early.state, { action: 'complete_step' }, TODAY);
    assert.equal(stepped.ok, false);
});

test('expiry within 92 days exposes the exit step', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'expiry',
        expiry_date: '2027-01-17',
    }, TODAY);
    assert.equal(started.state.early_exit, true);
    const jumped = pb.applyPlaybookAction(started.state, { action: 'open_expiry_exit' }, TODAY);
    assert.equal(jumped.state.step_index, 6);
});

test('cell is red on the review day', () => {
    let state = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY).state;
    state = pb.applyPlaybookAction(state, { action: 'complete_step' }, TODAY).state;
    state = pb.applyPlaybookAction(state, { action: 'complete_step' }, TODAY).state;
    const cell = pb.cellModel(state, '2026-12-01');
    assert.equal(cell.tone, 'danger');
    assert.match(cell.text, /Пора проверить · \d{4}-\d{2}-\d{2}/);
});

test('last had_sales step finishes the scenario', () => {
    let state = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY).state;
    for (let i = 0; i < 12 && state.status === 'active'; i += 1) {
        if (state.phase === 'wait') {
            const advanced = pb.applyPlaybookAction(state, { action: 'advance_after_review', force: true }, TODAY);
            assert.equal(advanced.ok, true, advanced.error);
            state = advanced.state;
        }
        if (state.status !== 'active') break;
        const next = pb.applyPlaybookAction(state, { action: 'complete_step' }, TODAY);
        assert.equal(next.ok, true, next.error);
        state = next.state;
    }
    assert.equal(state.status, 'done');
    assert.equal(pb.cellModel(state, TODAY).tone, 'success');
});

test('handle start never_sold persists and locks purchasing', async () => {
    const calls = [];
    const store = new Map();
    const db = {
        async query(sql, params) {
            calls.push(String(sql));
            if (/CREATE TABLE/i.test(sql)) return [[], []];
            if (/SELECT/i.test(sql) && params && store.has(params[0])) return [[store.get(params[0])], []];
            if (/SELECT/i.test(sql)) return [[], []];
            if (/INSERT INTO dg_product_analysis_playbook/i.test(sql)) {
                store.set(params[0], {
                    scenario: params[1],
                    status: params[2],
                    step_index: params[3],
                    steps_json: params[4],
                    review_due: params[5],
                    expiry_date: params[6],
                });
                return [{ affectedRows: 1 }, []];
            }
            if (/INSERT INTO dg_product_analysis_decisions_log/i.test(sql)) return [{ affectedRows: 1 }, []];
            return [[], []];
        },
    };
    const patches = [];
    const result = await pb.handlePlaybookAction(db, '34369', {
        action: 'start',
        scenario: 'never_sold',
    }, { id: 1, name: 'Анна' }, {
        today: () => '2026-11-17',
        lifetimeSales: async () => false,
        salesWindows: async () => ({ d30: 0, d60: 0, d90: 0 }),
        stockQty: async () => 4,
        upsertProductDecision: async (_db, code, patch) => {
            patches.push({ code, patch });
            return { changes: [] };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.payload.state.scenario, 'never_sold');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].patch.do_not_order, true);
    assert.equal(patches[0].patch.lock_proposed_min_stock, true);
    assert.equal(store.get('34369').scenario, 'never_sold');
});

test('step note stays on the step after it is done', () => {
    const started = pb.applyPlaybookAction(pb.emptyPlaybookState(), {
        action: 'start',
        scenario: 'had_sales',
    }, TODAY);
    const noted = pb.applyPlaybookAction(started.state, {
        action: 'set_step_note',
        note: '  цена выше конкурента  ',
    }, TODAY);
    assert.equal(noted.ok, true);
    assert.equal(noted.state.steps[0].note, 'цена выше конкурента');
    const done = pb.applyPlaybookAction(noted.state, { action: 'complete_step' }, TODAY);
    assert.equal(done.state.steps[0].note, 'цена выше конкурента');
    assert.equal(done.state.step_index, 1);
    const back = pb.applyPlaybookAction(done.state, { action: 'back_step' }, TODAY);
    assert.equal(back.ok, true);
    assert.equal(back.state.step_index, 0);
    assert.equal(back.state.steps[0].note, 'цена выше конкурента');
    const named = pb.applyPlaybookAction(back.state, {
        action: 'set_step_note',
        note: 'проверила карточку',
    }, TODAY, { full_name: 'Катерина Лычковская', username: 'kate' });
    assert.equal(named.state.steps[0].note_by, 'Катерина Лычковская');
    assert.match(named.state.steps[0].note_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('sales window sql is one query for a single code', () => {
    const sql = pb.salesWindowsSql();
    assert.match(sql, /INTERVAL 30 DAY/);
    assert.match(sql, /INTERVAL 60 DAY/);
    assert.match(sql, /INTERVAL 90 DAY/);
    assert.match(sql, /e\.code = \?/);
    assert.equal((sql.match(/FROM ms_demand_position/g) || []).length, 1);
});
