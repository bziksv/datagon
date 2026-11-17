'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pf = require('./opsSheetPlanfix');

const managers = [
    { id: 45, full_name: 'Дмитрий Чижевский', username: 'dmitriy_chizhevskiy' },
    { id: 50, full_name: 'Дмитрий Власов', username: 'dmitriy_vlasov' },
    { id: 12, full_name: 'Екатерина Киланьян', username: 'ekaterina' },
];

test('short first name does not pick between two Dmitrys', () => {
    assert.equal(pf.matchManagerByAssigner('Дмитрий', managers), null);
});

test('planfix user id stays bound after the surname is removed', () => {
    const map = pf.learnAssignerIdMap(
        [
            { assigner_id: 74, assigner_name: 'Дмитрий Чижевский' },
            { assigner_id: 74, assigner_name: 'Дмитрий' },
            { assigner_id: 5305436, assigner_name: 'Дмитрий' },
        ],
        managers
    );
    assert.equal(map[74], 45);
    assert.equal(map[5305436], undefined);
    const hit = pf.resolveManagerByAssigner(74, 'Дмитрий', managers, map);
    assert.equal(hit && hit.id, 45);
    assert.equal(pf.resolveManagerByAssigner(5305436, 'Дмитрий', managers, map), null);
});

test('two different full names on one id are not bound', () => {
    const map = pf.learnAssignerIdMap(
        [
            { assigner_id: 9, assigner_name: 'Дмитрий Чижевский' },
            { assigner_id: 9, assigner_name: 'Екатерина Киланьян' },
        ],
        managers
    );
    assert.equal(map[9], undefined);
});
