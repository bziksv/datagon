'use strict';

/**
 * «По словам v2» (`name_words_v2`). Режим v1 (`matchNameWords.js`) не меняется.
 *
 * Отличия от v1:
 *  1. Вес слова по редкости в прайсе конкурента (IDF): «насос» дёшев, «grundfos» дорог.
 *  2. Слова-пустышки (для, с, шт, набор…) не участвуют.
 *  3. Буквы и цифры разделяются (микротимп3 → микротимп 3, 25мм → 25 мм), единицы приводятся;
 *     дроби и десятичные — одно число (3/0, 6,2 = 6.2).
 *  4. Латиница ↔ кириллица: похожие буквы внутри слова и транслит (Grundfos ≈ Грундфос).
 *  5. Разные бренды латиницей (слово встречается в прайсе ≥ 3 раз) с обеих сторон → пары нет.
 *  6. Спорные пары: второй кандидат почти с тем же баллом → флаг ambiguous.
 *  7. details: какие слова совпали, каких не хватило.
 *  8. Синонимы / конфликты слов из подтверждённых и отклонённых пар.
 *
 * Цифры: пара отбрасывается, только если непарные числа есть с ОБЕИХ сторон (3 ↔ 2).
 * Лишние слова/числа только с одной стороны (бренд, страна, «75 см») — мягкий штраф;
 * замена слова (тупоконечные ↔ остроконечные) — полный вес.
 */

const NAME_WORDS_V2_THRESHOLD = 0.75;
/** Разница баллов, при которой второй кандидат считается «почти таким же». */
const AMBIGUOUS_DELTA = 0.03;
/** Потолок веса «лишнего» слова, когда у другой стороны лишних нет. */
const EXTRA_ONLY_WEIGHT_CAP = 1.5;
/** Латинское слово считается брендом, если встречается в прайсе конкурента не реже. */
const BRAND_MIN_DF = 3;

const STOP_WORDS = new Set([
    'для', 'с', 'и', 'в', 'на', 'по', 'из', 'от', 'к', 'без', 'под', 'над', 'при', 'или',
    'шт', 'штук', 'штуки', 'уп', 'упак', 'упаковка', 'упаковке',
    'набор', 'наборе', 'комплект', 'компл', 'комплекте',
    'the', 'for', 'with', 'and', 'of', 'in', 'to', 'pcs', 'pc', 'set', 'kit',
]);

const UNIT_CANON = new Map([
    ['mm', 'мм'], ['cm', 'см'], ['ml', 'мл'], ['kg', 'кг'], ['mg', 'мг'],
    ['гр', 'г'], ['грамм', 'г'], ['литр', 'л'], ['литра', 'л'], ['литров', 'л'],
    ['kw', 'квт'], ['hz', 'гц'], ['bar', 'бар'], ['mkm', 'мкм'],
]);

const ABBREV = new Map([
    ['нерж', 'нержавеющий'],
    ['диам', 'диаметр'],
    ['мод', 'модель'],
    ['арт', 'артикул'],
    ['стом', 'стоматологический'],
]);

/** Латинские слова, которые не считаются брендом. */
const LATIN_COMMON = new Set([
    'pro', 'mini', 'max', 'plus', 'new', 'led', 'usb', 'lcd', 'type', 'size', 'lite', 'light', 'ultra',
    'super', 'standard', 'classic', 'premium', 'basic', 'eco', 'smart', 'digital', 'compact', 'universal',
    'black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'silver', 'gold', 'old', 'usp',
]);

const LAT_TO_CYR_HOMO = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const CYR_TO_LAT_HOMO = { а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p', т: 't', х: 'x', у: 'y' };

const CYR_TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
    ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a',
};

const RE_CYR = /[а-я]/;
const RE_LAT = /[a-z]/;
const RE_DIGIT = /[0-9]/;
const RE_NUM_COMPOUND = /^[0-9]+(?:[./][0-9]+)+$/;

function scriptOf(word) {
    const c = RE_CYR.test(word);
    const l = RE_LAT.test(word);
    if (c && l) return 'mixed';
    if (c) return 'cyr';
    if (l) return 'lat';
    return 'none';
}

/** Слово с латиницей и кириллицей вперемешку → в преобладающий алфавит по похожим буквам. */
function fixHomoglyphs(word) {
    if (scriptOf(word) !== 'mixed') return word;
    let cyr = 0;
    let lat = 0;
    for (const ch of word) {
        if (RE_CYR.test(ch)) cyr += 1;
        else if (RE_LAT.test(ch)) lat += 1;
    }
    const map = cyr >= lat ? LAT_TO_CYR_HOMO : CYR_TO_LAT_HOMO;
    let out = '';
    for (const ch of word) out += map[ch] || ch;
    return out;
}

/** Латинский «скелет» слова для сравнения между алфавитами. */
function translitSkeleton(word) {
    let s = '';
    for (const ch of word) s += CYR_TRANSLIT[ch] !== undefined ? CYR_TRANSLIT[ch] : ch;
    return s
        .replace(/ph/g, 'f')
        .replace(/ck/g, 'k')
        .replace(/qu/g, 'kv')
        .replace(/q/g, 'k')
        .replace(/w/g, 'v')
        .replace(/x/g, 'ks')
        .replace(/c/g, 'k')
        .replace(/[yj]/g, 'i')
        .replace(/kh/g, 'h')
        .replace(/ts/g, 'k')
        .replace(/(.)\1+/g, '$1');
}

/** Разбить слово на буквенные/цифровые куски, если буквенная часть ≥ 2 символов (125b не трогаем). */
function splitLettersDigits(word) {
    if (!RE_DIGIT.test(word) || !/[a-zа-я]/.test(word)) return [word];
    const runs = word.match(/[0-9]+|[^0-9]+/g) || [word];
    for (let i = 0; i < runs.length; i += 1) {
        if (!RE_DIGIT.test(runs[i]) && runs[i].length < 2) return [word];
    }
    return runs;
}

function canonNumber(w) {
    return w
        .split(/([./])/)
        .map((p) => (/^[0-9]+$/.test(p) ? p.replace(/^0+(?=\d)/, '') : p))
        .join('');
}

function canonWord(w) {
    if (/^[0-9]+$/.test(w) || RE_NUM_COMPOUND.test(w)) return canonNumber(w);
    if (UNIT_CANON.has(w)) return UNIT_CANON.get(w);
    if (ABBREV.has(w)) return ABBREV.get(w);
    return w;
}

function makeToken(w, orig) {
    const digit = RE_DIGIT.test(w);
    const script = scriptOf(w);
    return {
        t: w,
        orig,
        digit,
        script,
        skel: script === 'cyr' || script === 'lat' ? translitSkeleton(w) : '',
        latinWord: !digit && script === 'lat' && w.length >= 3 && !LATIN_COMMON.has(w),
        brand: false,
    };
}

/**
 * @returns {{ t: string, orig: string, digit: boolean, script: string, skel: string, latinWord: boolean, brand: boolean }[]}
 */
function tokenizeV2(text) {
    if (!text) return [];
    const base = String(text)
        .toLowerCase()
        .replace(/ё/g, 'е')
        // 10x20 / 10х20 / 10*20 → 10 20
        .replace(/(\d)\s*[xх*×]\s*(?=\d)/g, '$1 ')
        // 6,2 → 6.2 ; 3 / 0 → 3/0
        .replace(/(\d),(?=\d)/g, '$1.')
        .replace(/(\d)\s*\/\s*(?=\d)/g, '$1/');
    const rawWords = base.split(/[^a-zа-я0-9./]+/);
    const out = [];
    for (let i = 0; i < rawWords.length; i += 1) {
        const rw0 = rawWords[i].replace(/^[./]+|[./]+$/g, '');
        if (!rw0) continue;
        const pieces = RE_NUM_COMPOUND.test(rw0) ? [rw0] : rw0.split(/[./]+/);
        for (let q = 0; q < pieces.length; q += 1) {
            const rw = pieces[q];
            if (!rw) continue;
            const parts = RE_NUM_COMPOUND.test(rw) ? [rw] : splitLettersDigits(fixHomoglyphs(rw));
            for (let p = 0; p < parts.length; p += 1) {
                const w = canonWord(parts[p]);
                if (!w) continue;
                if (!RE_DIGIT.test(w) && w.length < 2) continue;
                if (STOP_WORDS.has(w)) continue;
                out.push(makeToken(w, rw));
            }
        }
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
        let rowMin = row[0];
        for (let j = 1; j <= n; j += 1) {
            const tmp = row[j];
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prevDiag + cost);
            if (row[j] < rowMin) rowMin = row[j];
            prevDiag = tmp;
        }
        if (rowMin > maxDist) return maxDist + 1;
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

function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Окончания (как v1): общее начало ≥4 и короткий хвост. */
function morphScore(a, b) {
    const minL = a.length < b.length ? a.length : b.length;
    const maxL = a.length > b.length ? a.length : b.length;
    if (minL < 4 || maxL - minL > 3) return 0;
    if (a.charCodeAt(0) !== b.charCodeAt(0)) return 0;
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

const HOW_NONE = 0;
const HOW_EXACT = 1;
const HOW_ENDING = 2;
const HOW_TRANSLIT = 3;
const HOW_SYNONYM = 4;
const HOW_LABELS = ['', 'exact', 'ending', 'translit', 'synonym'];
let lastHow = HOW_NONE;

/** Балл пары слов 0…1; способ совпадения — в lastHow. */
function tokenPairScoreV2(a, b, learned) {
    lastHow = HOW_NONE;
    if (a.t === b.t) {
        lastHow = HOW_EXACT;
        return 1;
    }
    if (a.digit || b.digit) return 0;
    if (learned && learned.synonyms && learned.synonyms.size && learned.synonyms.has(pairKey(a.t, b.t))) {
        lastHow = HOW_SYNONYM;
        return 0.95;
    }
    if (a.script === b.script) {
        const s = morphScore(a.t, b.t);
        if (s > 0) lastHow = HOW_ENDING;
        return s;
    }
    if (a.skel && b.skel) {
        if (a.skel === b.skel) {
            lastHow = HOW_TRANSLIT;
            return 0.95;
        }
        if (
            a.skel.length >= 5 &&
            b.skel.length >= 5 &&
            Math.abs(a.skel.length - b.skel.length) <= 1 &&
            levenshteinBounded(a.skel, b.skel, 1) <= 1
        ) {
            lastHow = HOW_TRANSLIT;
            return 0.9;
        }
    }
    return 0;
}

const scratch = {
    s: new Float64Array(256),
    g: new Float64Array(256),
    i: new Int32Array(256),
    j: new Int32Array(256),
    h: new Uint8Array(256),
    order: new Int32Array(256),
};

function ensureScratch(n) {
    if (scratch.s.length >= n) return;
    const size = Math.max(n, scratch.s.length * 2);
    scratch.s = new Float64Array(size);
    scratch.g = new Float64Array(size);
    scratch.i = new Int32Array(size);
    scratch.j = new Int32Array(size);
    scratch.h = new Uint8Array(size);
    scratch.order = new Int32Array(size);
}

/** Сумма весов несопоставленных слов: k самых тяжёлых — полностью, остальные — с потолком. */
function cappedLeftoverWeight(w, used, k) {
    const left = [];
    for (let i = 0; i < w.length; i += 1) if (!used[i]) left.push(w[i]);
    if (k > 0) left.sort((x, y) => y - x);
    let sum = 0;
    for (let i = 0; i < left.length; i += 1) sum += i < k ? left[i] : Math.min(left[i], EXTRA_ONLY_WEIGHT_CAP);
    return sum;
}

/**
 * Взвешенный Дайс с жадным сопоставлением слов.
 * @param {boolean} [explain] — вернуть matched / missMy / missComp
 * @returns {{ score: number, reject?: string, matched?: Array, missMy?: string[], missComp?: string[] }}
 */
function scoreNameWordsV2(tokA, wA, tokB, wB, threshold, learned, explain) {
    const nA = tokA.length;
    const nB = tokB.length;
    if (!nA || !nB) return { score: 0 };
    ensureScratch(nA * nB);
    const S = scratch.s;
    const G = scratch.g;
    const I = scratch.i;
    const J = scratch.j;
    const H = scratch.h;
    let np = 0;
    for (let i = 0; i < nA; i += 1) {
        const a = tokA[i];
        for (let j = 0; j < nB; j += 1) {
            const s = tokenPairScoreV2(a, tokB[j], learned);
            if (s > 0) {
                S[np] = s;
                G[np] = s * (wA[i] + wB[j]);
                I[np] = i;
                J[np] = j;
                H[np] = lastHow;
                np += 1;
            }
        }
    }
    if (!np) return { score: 0 };
    const order = scratch.order;
    for (let k = 0; k < np; k += 1) order[k] = k;
    const ord = Array.prototype.slice.call(order.subarray(0, np));
    ord.sort((x, y) => G[y] - G[x]);

    const usedA = new Uint8Array(nA);
    const usedB = new Uint8Array(nB);
    let gain = 0;
    let matchedW = 0;
    const picked = explain ? [] : null;
    for (let k = 0; k < np; k += 1) {
        const p = ord[k];
        const i = I[p];
        const j = J[p];
        if (usedA[i] || usedB[j]) continue;
        usedA[i] = 1;
        usedB[j] = 1;
        gain += G[p];
        matchedW += wA[i] + wB[j];
        if (picked) picked.push(p);
    }

    let leftA = 0;
    let leftB = 0;
    let leftAW = 0;
    let leftBW = 0;
    let digitA = false;
    let digitB = false;
    let brandA = false;
    let brandB = false;
    for (let i = 0; i < nA; i += 1) {
        if (usedA[i]) continue;
        leftA += 1;
        leftAW += wA[i];
        if (tokA[i].digit) digitA = true;
        if (tokA[i].brand) brandA = true;
    }
    for (let j = 0; j < nB; j += 1) {
        if (usedB[j]) continue;
        leftB += 1;
        leftBW += wB[j];
        if (tokB[j].digit) digitB = true;
        if (tokB[j].brand) brandB = true;
    }

    // Замена слова (по одному с каждой стороны, k = min(leftA, leftB)) — полный вес;
    // остальные лишние — уточнение (бренд, страна, «75 см»), вес не выше EXTRA_ONLY_WEIGHT_CAP.
    if (leftA !== leftB) {
        const k = Math.min(leftA, leftB);
        leftAW = cappedLeftoverWeight(wA, usedA, k);
        leftBW = cappedLeftoverWeight(wB, usedB, k);
    }
    const denom = matchedW + leftAW + leftBW;
    const score = denom > 0 ? gain / denom : 0;
    if (score + 1e-12 < threshold) return { score };

    if (digitA && digitB) return { score: 0, reject: 'digits' };
    if (brandA && brandB) return { score: 0, reject: 'brand' };
    if (learned && learned.conflicts && learned.conflicts.size && leftA && leftB) {
        for (let i = 0; i < nA; i += 1) {
            if (usedA[i]) continue;
            for (let j = 0; j < nB; j += 1) {
                if (usedB[j]) continue;
                if (learned.conflicts.has(pairKey(tokA[i].t, tokB[j].t))) return { score: 0, reject: 'learned_conflict' };
            }
        }
    }

    if (!explain) return { score };
    const missMy = [];
    const missComp = [];
    for (let i = 0; i < nA; i += 1) if (!usedA[i]) missMy.push(tokA[i].t);
    for (let j = 0; j < nB; j += 1) if (!usedB[j]) missComp.push(tokB[j].t);
    return {
        score,
        matched: picked.map((p) => [tokA[I[p]].t, tokB[J[p]].t, HOW_LABELS[H[p]]]),
        missMy,
        missComp,
    };
}

/* ---------- индекс прайса конкурента ---------- */

function indexKeys(tok) {
    if (tok.digit) return [`d:${tok.t}`];
    const keys = [tok.t.length >= 4 ? `p:${tok.t.slice(0, 4)}` : `e:${tok.t}`];
    if (tok.skel.length >= 4) keys.push(`${tok.script === 'lat' ? 'L' : 'C'}:${tok.skel.slice(0, 4)}`);
    return keys;
}

/** Ключи поиска для моего товара: свои слова + транслит в другой алфавит; числа — только если нет слов. */
function queryKeys(tokens) {
    let hasWord = false;
    for (let i = 0; i < tokens.length; i += 1) {
        if (!tokens[i].digit) {
            hasWord = true;
            break;
        }
    }
    const keys = new Set();
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i];
        if (tok.digit) {
            if (!hasWord) keys.add(`d:${tok.t}`);
            continue;
        }
        keys.add(tok.t.length >= 4 ? `p:${tok.t.slice(0, 4)}` : `e:${tok.t}`);
        if (tok.skel.length >= 4) keys.add(`${tok.script === 'lat' ? 'C' : 'L'}:${tok.skel.slice(0, 4)}`);
    }
    return keys;
}

function createNameWordsV2Index(rowCount) {
    const n = Math.max(0, rowCount | 0);
    return {
        n,
        tokenLists: new Array(n),
        weightLists: new Array(n),
        postings: new Map(),
        df: new Map(),
        seenStamp: new Int32Array(n),
        stamp: 0,
        rowTotalW: new Float64Array(n),
        rowMaxW: new Float64Array(n),
        hitW: new Float64Array(n),
        hitCapped: new Float64Array(n),
        hitN: new Int32Array(n),
        tokMark: new Int32Array(n),
        tokCounter: 0,
    };
}

function indexNameWordsV2Row(index, rowIndex, rawName) {
    const tokens = tokenizeV2(rawName);
    index.tokenLists[rowIndex] = tokens;
    if (!tokens.length) return;
    const seenT = new Set();
    const seenK = new Set();
    for (let t = 0; t < tokens.length; t += 1) {
        const tok = tokens[t];
        if (!seenT.has(tok.t)) {
            seenT.add(tok.t);
            index.df.set(tok.t, (index.df.get(tok.t) || 0) + 1);
        }
        const keys = indexKeys(tok);
        for (let k = 0; k < keys.length; k += 1) {
            const key = keys[k];
            if (seenK.has(key)) continue;
            seenK.add(key);
            let arr = index.postings.get(key);
            if (!arr) {
                arr = [];
                index.postings.set(key, arr);
            }
            arr.push(rowIndex);
        }
    }
}

/** Вес 0.5…3.5: чем реже слово в прайсе, тем дороже совпадение. Числа — не дешевле 2. */
function tokenWeight(index, tok) {
    const df = index.df.get(tok.t) || 0;
    const idf = Math.log((index.n + 1) / (df + 1));
    let w = 0.5 + Math.min(idf, 6) / 2;
    if (tok.digit && w < 2) w = 2;
    return w;
}

/** Веса токенов + пометка бренда (латинское слово, частое в прайсе конкурента). */
function weightsFor(index, tokens) {
    const out = new Array(tokens.length);
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i];
        out[i] = tokenWeight(index, tok);
        tok.brand = tok.latinWord && (index.df.get(tok.t) || 0) >= BRAND_MIN_DF;
    }
    return out;
}

function finalizeNameWordsV2Index(index) {
    for (let r = 0; r < index.n; r += 1) {
        const toks = index.tokenLists[r];
        const w = toks && toks.length ? weightsFor(index, toks) : [];
        index.weightLists[r] = w;
        let sum = 0;
        let max = 0;
        for (let i = 0; i < w.length; i += 1) {
            sum += w[i];
            if (w[i] > max) max = w[i];
        }
        index.rowTotalW[r] = sum;
        index.rowMaxW[r] = max;
    }
}

function tokenKeysForHits(tok) {
    if (tok.digit) return [`d:${tok.t}`];
    const keys = [tok.t.length >= 4 ? `p:${tok.t.slice(0, 4)}` : `e:${tok.t}`];
    if (tok.skel.length >= 4) keys.push(`${tok.script === 'lat' ? 'C' : 'L'}:${tok.skel.slice(0, 4)}`);
    return keys;
}

function wordInLearned(learned, t) {
    if (!learned || !learned.synonymWords) return false;
    return learned.synonymWords.has(t);
}

/**
 * Строки прайса, где есть хотя бы одно общее слово / префикс / транслит,
 * и у которых верхняя оценка балла ≥ threshold (отсев без потери пар:
 * слово, не попавшее в ключи строки, сопоставиться с ней не может).
 */
function collectNameWordsV2Candidates(index, tokens, weights, threshold, learned) {
    if (!index || !tokens || !tokens.length) return [];
    let stamp = index.stamp + 1;
    if (stamp >= 0x7fffffff) {
        index.seenStamp.fill(0);
        stamp = 1;
    }
    index.stamp = stamp;
    const { seenStamp, postings, hitW, hitCapped, hitN, tokMark } = index;
    const out = [];
    for (const key of queryKeys(tokens)) {
        const arr = postings.get(key);
        if (!arr) continue;
        for (let j = 0; j < arr.length; j += 1) {
            const idx = arr[j];
            if (seenStamp[idx] === stamp) continue;
            seenStamp[idx] = stamp;
            hitW[idx] = 0;
            hitCapped[idx] = 0;
            hitN[idx] = 0;
            out.push(idx);
        }
    }
    if (!weights || !out.length) return out;

    let alwaysW = 0;
    let alwaysCapped = 0;
    let alwaysN = 0;
    let totalCapped = 0;
    for (let t = 0; t < tokens.length; t += 1) {
        const tok = tokens[t];
        const w = weights[t];
        const wc = Math.min(w, EXTRA_ONLY_WEIGHT_CAP);
        totalCapped += wc;
        if (wordInLearned(learned, tok.t)) {
            alwaysW += w;
            alwaysCapped += wc;
            alwaysN += 1;
            continue;
        }
        index.tokCounter = (index.tokCounter + 1) | 0;
        if (index.tokCounter === 0) {
            tokMark.fill(0);
            index.tokCounter = 1;
        }
        const mark = index.tokCounter;
        const keys = tokenKeysForHits(tok);
        for (let k = 0; k < keys.length; k += 1) {
            const arr = postings.get(keys[k]);
            if (!arr) continue;
            for (let j = 0; j < arr.length; j += 1) {
                const idx = arr[j];
                if (seenStamp[idx] !== stamp || tokMark[idx] === mark) continue;
                tokMark[idx] = mark;
                hitW[idx] += w;
                hitCapped[idx] += wc;
                hitN[idx] += 1;
            }
        }
    }

    const thr = Number(threshold) || 0;
    const kept = [];
    for (let c = 0; c < out.length; c += 1) {
        const idx = out[c];
        const a = hitW[idx] + alwaysW;
        const h = hitN[idx] + alwaysN;
        const bMax = Math.min(index.rowTotalW[idx], h * index.rowMaxW[idx]);
        const unhit = totalCapped - hitCapped[idx] - alwaysCapped;
        const top = a + bMax;
        const bound = top > 0 ? top / (top + Math.max(0, unhit)) : 0;
        if (bound + 1e-9 >= thr) kept.push(idx);
    }
    return kept;
}

/* ---------- обучение на подтверждённых / отклонённых парах ---------- */

/**
 * Пара отличается ровно одним словом с каждой стороны, остальное совпало →
 * confirmed: эти два слова — синонимы; rejected: эти два слова — конфликт.
 * Учитываем только повторившиеся ≥ 2 раз.
 * @param {{ my: string, comp: string, status: string }[]} rows
 */
function learnFromReviewedPairs(rows) {
    const synCount = new Map();
    const conCount = new Map();
    const list = Array.isArray(rows) ? rows : [];
    for (let r = 0; r < list.length; r += 1) {
        const row = list[r];
        const target = row.status === 'confirmed' ? synCount : row.status === 'rejected' ? conCount : null;
        if (!target) continue;
        const a = tokenizeV2(row.my);
        const b = tokenizeV2(row.comp);
        if (a.length < 2 || b.length < 2) continue;
        const usedA = new Uint8Array(a.length);
        const usedB = new Uint8Array(b.length);
        let matched = 0;
        for (let i = 0; i < a.length; i += 1) {
            for (let j = 0; j < b.length; j += 1) {
                if (usedB[j]) continue;
                if (tokenPairScoreV2(a[i], b[j], null) > 0) {
                    usedA[i] = 1;
                    usedB[j] = 1;
                    matched += 1;
                    break;
                }
            }
        }
        if (matched < 1) continue;
        const la = [];
        const lb = [];
        for (let i = 0; i < a.length; i += 1) if (!usedA[i]) la.push(a[i]);
        for (let j = 0; j < b.length; j += 1) if (!usedB[j]) lb.push(b[j]);
        if (la.length !== 1 || lb.length !== 1) continue;
        if (la[0].digit || lb[0].digit) continue;
        const key = pairKey(la[0].t, lb[0].t);
        target.set(key, (target.get(key) || 0) + 1);
    }
    const synonyms = new Set();
    const synonymWords = new Set();
    const conflicts = new Set();
    for (const [k, c] of synCount) {
        if (c < 2 || conCount.has(k)) continue;
        synonyms.add(k);
        const [x, y] = k.split('|');
        synonymWords.add(x);
        synonymWords.add(y);
    }
    for (const [k, c] of conCount) if (c >= 2 && !synCount.has(k)) conflicts.add(k);
    return { synonyms, synonymWords, conflicts };
}

module.exports = {
    NAME_WORDS_V2_THRESHOLD,
    AMBIGUOUS_DELTA,
    tokenizeV2,
    translitSkeleton,
    tokenPairScoreV2,
    scoreNameWordsV2,
    createNameWordsV2Index,
    indexNameWordsV2Row,
    finalizeNameWordsV2Index,
    weightsFor,
    collectNameWordsV2Candidates,
    learnFromReviewedPairs,
};
