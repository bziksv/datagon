'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actorMayWriteOzonMergeDirect } = require('./datagonMpWriteApprovals');

test('marketplace manager specialty writes an Ozon merge without a second confirmation', () => {
    assert.equal(
        actorMayWriteOzonMergeDirect({ username: 'yana_yartseva', specialty_name: 'Менеджер маркетплейсов' }),
        true
    );
});

test('admin writes an Ozon merge directly', () => {
    assert.equal(actorMayWriteOzonMergeDirect({ username: 'admin', specialty_name: '' }), true);
});

test('another specialty still needs a second confirmation', () => {
    assert.equal(
        actorMayWriteOzonMergeDirect({ username: 'someone', specialty_name: 'Менеджер по продажам' }),
        false
    );
    assert.equal(actorMayWriteOzonMergeDirect({ username: 'someone', specialty_name: 'Полный доступ' }), false);
    assert.equal(actorMayWriteOzonMergeDirect(null), false);
});
