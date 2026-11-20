'use strict';

const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const tasks = require('./ozonCategoryTasks');

const TOKEN = 'a'.repeat(32);

function fakeDb(pinHash) {
    return {
        async query() {
            return [
                [
                    { setting_key: 'ozon_category_tasks_token', setting_value: TOKEN },
                    { setting_key: 'ozon_category_tasks_pin_secret', setting_value: pinHash },
                ],
            ];
        },
    };
}

function req({ token, pin, cookie, ip = '1.1.1.1' } = {}) {
    return {
        query: token ? { token } : {},
        headers: cookie ? { cookie } : {},
        ip,
        get(name) {
            return name.toLowerCase() === 'x-datagon-pin' ? pin || '' : '';
        },
    };
}

test('token and pin gate', async () => {
    tasks._resetForTests();
    const db = fakeDb(await bcrypt.hash('4321', 4));

    assert.strictEqual((await tasks.checkAccess(db, req({}))).status, 404);
    assert.strictEqual((await tasks.checkAccess(db, req({ token: 'wrong' }))).status, 404);
    assert.strictEqual((await tasks.checkAccess(db, req({ token: TOKEN }))).code, 'PIN_REQUIRED');
    assert.strictEqual((await tasks.checkAccess(db, req({ token: TOKEN, pin: '0000' }))).code, 'PIN_INVALID');

    const ok = await tasks.checkAccess(db, req({ token: TOKEN, pin: '4321' }));
    assert.ok(ok.ok && ok.pinAccepted);

    const cookie = tasks.buildSessionCookie(ok.settings, false).split(';')[0];
    const viaCookie = await tasks.checkAccess(db, req({ token: TOKEN, cookie }));
    assert.ok(viaCookie.ok);
    assert.strictEqual((await tasks.checkAccess(db, req({ cookie }))).status, 404);
});

test('pin brute force blocks ip, cookie dies on pin change', async () => {
    tasks._resetForTests();
    const db = fakeDb(await bcrypt.hash('4321', 4));
    for (let i = 0; i < 5; i += 1) {
        await tasks.checkAccess(db, req({ token: TOKEN, pin: 'bad', ip: '2.2.2.2' }));
    }
    const blocked = await tasks.checkAccess(db, req({ token: TOKEN, pin: '4321', ip: '2.2.2.2' }));
    assert.strictEqual(blocked.code, 'PIN_BLOCKED');
    assert.ok((await tasks.checkAccess(db, req({ token: TOKEN, pin: '4321', ip: '3.3.3.3' }))).ok);

    const ok = await tasks.checkAccess(db, req({ token: TOKEN, pin: '4321', ip: '3.3.3.3' }));
    const cookie = tasks.buildSessionCookie(ok.settings, false).split(';')[0];
    tasks._resetForTests();
    const db2 = fakeDb(await bcrypt.hash('9999', 4));
    assert.strictEqual((await tasks.checkAccess(db2, req({ token: TOKEN, cookie, ip: '3.3.3.3' }))).code, 'PIN_REQUIRED');
});

test('nameStems drops short and stop words', () => {
    const s = tasks.nameStems('Набор катетеров: Катетер ректальный INEKTA CH18 5 шт., трубка газоотводная');
    assert.ok(s.has('катете'));
    assert.ok(s.has('ректал'));
    assert.ok(s.has('газоот'));
    assert.ok(!s.has('набор'));
    assert.ok(!s.has('шт'));
});
