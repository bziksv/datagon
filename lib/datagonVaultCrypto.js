'use strict';

/**
 * At-rest encryption для WORK vault (F-WORK-01).
 * Формат: enc:v1:<iv_b64>:<tag_b64>:<ct_b64> (AES-256-GCM).
 * Ключ: DATAGON_VAULT_KEY — 64 hex-символа или base64 на 32 байта.
 * Без ключа: plaintext читается как есть; запись секретов остаётся plaintext
 * (одноразовый warn), decrypt encrypted → ошибка.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

let warnedNoKey = false;

function parseVaultKey(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
        return Buffer.from(s, 'hex');
    }
    try {
        const buf = Buffer.from(s, 'base64');
        if (buf.length === KEY_LEN) return buf;
    } catch (_) {
        /* fallthrough */
    }
    const err = new Error(
        'DATAGON_VAULT_KEY: ожидали 64 hex или base64(32 байта)'
    );
    err.code = 'BAD_VAULT_KEY';
    throw err;
}

function getVaultKey() {
    try {
        return parseVaultKey(process.env.DATAGON_VAULT_KEY);
    } catch (e) {
        if (e && e.code === 'BAD_VAULT_KEY') throw e;
        return null;
    }
}

function isVaultKeyConfigured() {
    try {
        return !!getVaultKey();
    } catch (_) {
        return false;
    }
}

function isEncryptedVaultValue(raw) {
    return String(raw == null ? '' : raw).startsWith(PREFIX);
}

function warnNoKeyOnce() {
    if (warnedNoKey) return;
    warnedNoKey = true;
    console.warn(
        '[vault] DATAGON_VAULT_KEY не задан — WORK-секреты пишутся plaintext. Задайте ключ для encrypt-at-rest.'
    );
}

/**
 * Шифрует plaintext. Пустая строка → ''.
 * Без ключа возвращает plaintext (legacy).
 */
function encryptVaultValue(plain) {
    const text = plain == null ? '' : String(plain);
    if (!text) return '';
    if (isEncryptedVaultValue(text)) return text;
    let key;
    try {
        key = getVaultKey();
    } catch (e) {
        throw e;
    }
    if (!key) {
        warnNoKeyOnce();
        return text;
    }
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (
        PREFIX +
        iv.toString('base64') +
        ':' +
        tag.toString('base64') +
        ':' +
        enc.toString('base64')
    );
}

/**
 * Расшифровывает значение из БД. Legacy plaintext → как есть.
 */
function decryptVaultValue(stored) {
    const raw = stored == null ? '' : String(stored);
    if (!raw) return '';
    if (!isEncryptedVaultValue(raw)) return raw;
    const key = getVaultKey();
    if (!key) {
        const err = new Error(
            'Секрет зашифрован, но DATAGON_VAULT_KEY не задан — reveal невозможен'
        );
        err.code = 'VAULT_KEY_MISSING';
        throw err;
    }
    const body = raw.slice(PREFIX.length);
    const parts = body.split(':');
    if (parts.length !== 3) {
        const err = new Error('Повреждённый ciphertext vault');
        err.code = 'VAULT_BAD_CIPHER';
        throw err;
    }
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString('utf8');
}

/** Есть ли непустое значение (plaintext или ciphertext). */
function isVaultSecretSet(raw) {
    return String(raw == null ? '' : raw).length > 0;
}

/**
 * Маска для UI без утечки длины ciphertext / plaintext.
 */
function maskVaultPresence(raw) {
    return isVaultSecretSet(raw) ? '•••• (скрыто)' : '';
}

/**
 * Шифрует sensitive-поля объекта перед записью в БД (мутирует копию).
 */
function encryptWorkSecretsInPlace(data, isSensitiveKeyFn) {
    if (!data || typeof data !== 'object') return data;
    const check = typeof isSensitiveKeyFn === 'function' ? isSensitiveKeyFn : () => false;
    for (const k of Object.keys(data)) {
        if (!check(k)) continue;
        data[k] = encryptVaultValue(data[k]);
    }
    return data;
}

module.exports = {
    PREFIX,
    parseVaultKey,
    getVaultKey,
    isVaultKeyConfigured,
    isEncryptedVaultValue,
    encryptVaultValue,
    decryptVaultValue,
    isVaultSecretSet,
    maskVaultPresence,
    encryptWorkSecretsInPlace,
};
