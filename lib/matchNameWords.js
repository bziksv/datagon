'use strict';

/**
 * Сопоставление названий без учёта порядка слов.
 * Счёт — мягкий коэффициент Дайса по токенам, не Левенштейн всей строки.
 * Окончания: общее начало и короткий хвост (насос ≈ насоса, циркуляционный ≈ циркуляционного).
 * Токены короче 4 символов (числа, «мм», «25») совпадают только целиком.
 */

/** Порог режима name_words: 75% уже сохраняется. Остальные режимы — 85%. */
const NAME_WORDS_THRESHOLD = 0.75;

function normalizeMatchText(text) {
    if (!text) return '';
    return String(text)
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeNameWords(text) {
    const norm = normalizeMatchText(text);
    if (!norm) return [];
    const parts = norm.split(' ');
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].length >= 2) out.push(parts[i]);
    }
    return out;
}

function levenshteinBounded(a, b, maxDist) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n <= maxDist ? n : maxDist + 1;
    if (n === 0) return m <= maxDist ? m : maxDist + 1;
    if (Math.abs(m - n) > maxDist) return maxDist + 1;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j += 1) row[j] = j;
    for (let i = 1; i <= m; i += 1) {
        let prevDiag = row[0];
        row[0] = i;
        for (let j = 1; j <= n; j += 1) {
            const tmp = row[j];
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prevDiag + cost);
            prevDiag = tmp;
        }
    }
    const d = row[n];
    return d > maxDist ? maxDist + 1 : d;
}

function sharedPrefixLen(a, b) {
    const n = a.length < b.length ? a.length : b.length;
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
    return i;
}

/**
 * 1 — то же слово.
 * 0.96 / 0.92 / 0.88 — то же слово с другим окончанием.
 * Короткие слова: не больше 2 правок. Длинные (от 8 букв): до 3, если расходится только хвост
 * («циркуляционный» / «циркуляционного»).
 */
function tokenPairScore(a, b) {
    if (a === b) return 1;
    const minL = a.length < b.length ? a.length : b.length;
    const maxL = a.length > b.length ? a.length : b.length;
    if (minL < 4) return 0;
    if (maxL - minL > 3) return 0;
    const prefix = sharedPrefixLen(a, b);
    if (prefix < 4) return 0;
    const maxDist = minL >= 8 && prefix + 3 >= minL ? 3 : 2;
    if (maxL - prefix > maxDist) return 0;
    const d = levenshteinBounded(a, b, maxDist);
    if (d === 0) return 1;
    if (d > maxDist) return 0;
    if (d === 1) return 0.96;
    if (d === 2) return 0.92;
    return 0.88;
}

function retrievalKey(token) {
    if (token.length >= 4) return `p:${token.slice(0, 4)}`;
    return `e:${token}`;
}

/**
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @param {number} threshold
 * @param {number} [bestScore]
 * @returns {number} 0..1
 */
function nameWordsSimilarity(tokensA, tokensB, threshold, bestScore) {
    const nA = tokensA ? tokensA.length : 0;
    const nB = tokensB ? tokensB.length : 0;
    if (!nA || !nB) return 0;
    const bar = Math.max(Number(threshold) || 0, Number(bestScore) || 0);
    const maxPossible = (2 * Math.min(nA, nB)) / (nA + nB);
    if (maxPossible + 1e-12 < bar) return 0;
    if (nA === nB) {
        let same = true;
        const sortedA = tokensA.slice().sort();
        const sortedB = tokensB.slice().sort();
        for (let i = 0; i < nA; i += 1) {
            if (sortedA[i] !== sortedB[i]) {
                same = false;
                break;
            }
        }
        if (same) return 1;
    }
    const pairs = [];
    for (let i = 0; i < nA; i += 1) {
        for (let j = 0; j < nB; j += 1) {
            const s = tokenPairScore(tokensA[i], tokensB[j]);
            if (s > 0) pairs.push(s, i, j);
        }
    }
    if (!pairs.length) return 0;
    const order = [];
    for (let p = 0; p < pairs.length; p += 3) order.push(p);
    order.sort((ia, ib) => pairs[ib] - pairs[ia]);
    const usedA = new Uint8Array(nA);
    const usedB = new Uint8Array(nB);
    let sum = 0;
    let matched = 0;
    const limit = Math.min(nA, nB);
    for (let k = 0; k < order.length; k += 1) {
        const p = order[k];
        const i = pairs[p + 1];
        const j = pairs[p + 2];
        if (usedA[i] || usedB[j]) continue;
        usedA[i] = 1;
        usedB[j] = 1;
        sum += pairs[p];
        matched += 1;
        if (matched === limit) break;
    }
    return (2 * sum) / (nA + nB);
}

function createNameWordsIndex(rowCount) {
    const n = Math.max(0, rowCount | 0);
    return {
        tokenLists: new Array(n),
        postings: new Map(),
        seenStamp: n ? new Int32Array(n) : new Int32Array(0),
        stamp: 0,
    };
}

function indexNameWordsRow(index, rowIndex, rawName) {
    const tokens = tokenizeNameWords(rawName);
    index.tokenLists[rowIndex] = tokens;
    if (!tokens.length) return;
    const seen = new Set();
    const { postings } = index;
    for (let t = 0; t < tokens.length; t += 1) {
        const key = retrievalKey(tokens[t]);
        if (seen.has(key)) continue;
        seen.add(key);
        let arr = postings.get(key);
        if (!arr) {
            arr = [];
            postings.set(key, arr);
        }
        arr.push(rowIndex);
    }
}

function collectNameWordCandidates(index, tokens) {
    if (!index || !tokens || !tokens.length) return [];
    let stamp = index.stamp + 1;
    if (stamp >= 0x7fffffff) {
        index.seenStamp.fill(0);
        stamp = 1;
    }
    index.stamp = stamp;
    const seenStamp = index.seenStamp;
    let hasLong = false;
    for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].length >= 4) {
            hasLong = true;
            break;
        }
    }
    const keys = [];
    const seenK = new Set();
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (hasLong && token.length < 4) continue;
        const key = retrievalKey(token);
        if (seenK.has(key)) continue;
        seenK.add(key);
        keys.push(key);
    }
    const out = [];
    const { postings } = index;
    for (let i = 0; i < keys.length; i += 1) {
        const arr = postings.get(keys[i]);
        if (!arr) continue;
        for (let j = 0; j < arr.length; j += 1) {
            const idx = arr[j];
            if (seenStamp[idx] === stamp) continue;
            seenStamp[idx] = stamp;
            out.push(idx);
        }
    }
    return out;
}

module.exports = {
    NAME_WORDS_THRESHOLD,
    normalizeMatchText,
    tokenizeNameWords,
    tokenPairScore,
    nameWordsSimilarity,
    createNameWordsIndex,
    indexNameWordsRow,
    collectNameWordCandidates,
};
