'use strict';

/**
 * Режим сопоставления sku_v2 («По SKU v2»).
 *
 * Уровни совпадения (от сильного к слабому):
 *   exact     — артикул совпал как строка (trim + регистр);
 *   norm      — совпал после нормализации: «Арт.», пробелы, тире, точки, кириллица↔латиница
 *               в похожих буквах (L-5524М = L-5524M), ведущие нули в числах;
 *   part      — совпала часть составного артикула: «9006LED (9006LED-D-127)», «7271-930 / ПЗ(S)»;
 *   comp_name — наш артикул записан в названии конкурента («тонометр 1453-130 Big Ben», «(арт. AP3010S)»);
 *   my_name   — артикул конкурента записан в нашем названии.
 *
 * Берётся самый сильный уровень, внутри него — карточка с лучшим совпадением названия
 * (вес слов как в «По словам v2»), остальные карточки — альтернативы для окна «спорно».
 * Название никогда не отклоняет пару (подтверждённые пары с разными названиями — норма),
 * но помечает «спорно», если названия явно расходятся или карточек несколько.
 */

const LEVELS = ['exact', 'norm', 'part', 'comp_name', 'my_name'];
const LEVEL_SCORE = { exact: 1, norm: 0.99, part: 0.97, comp_name: 0.95, my_name: 0.93 };
/** Ниже этого балла названий пара по артикулу помечается «спорно». */
const NAME_DOUBT_BELOW = 0.35;
/** Ключ, встречающийся в стольких карточках, слишком общий — не используется. */
const MAX_POSTING = 25;

const HOMOGLYPH_TO_LAT = {
    А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y',
};

function skuKeyV2(raw) {
    if (raw == null) return '';
    let s = String(raw).normalize('NFKC').toUpperCase().replace(/Ё/g, 'Е').trim();
    s = s.replace(/^(АРТИКУЛ|АРТ|ART|SKU|КОД)\s*[.:№#]*\s*/, '');
    s = s.replace(/[АВЕКМНОРСТХУ]/g, (c) => HOMOGLYPH_TO_LAT[c]);
    s = s.replace(/[^A-ZА-Я0-9]+/g, ' ').trim();
    s = s
        .split(' ')
        .map((p) => (/^[0-9]+$/.test(p) ? p.replace(/^0+(?=\d)/, '') : p))
        .join('');
    return s;
}

function strictKey(raw) {
    return String(raw || '').trim().toUpperCase();
}

/** Ключ годится как артикул: есть цифра и не слишком короткий. */
function usableKey(k) {
    return k.length >= 3 && /[0-9]/.test(k);
}

/** Части составного артикула «A (B)», «A / B», «A; B». */
function skuPartKeys(raw) {
    const full = skuKeyV2(raw);
    const out = [];
    const pieces = String(raw || '').split(/[()[\]/;|]+|,\s+|\s{2,}/);
    if (pieces.length < 2) return out;
    for (const p of pieces) {
        const k = skuKeyV2(p);
        if (k && k !== full && usableKey(k) && k.length >= 4) out.push(k);
    }
    return out;
}

/** Похожие на артикул слова из названия: «1453-130», «AP3010S», «4C-0,7x30-3/0-PGA», «(арт. Н-28)». */
function nameSkuKeys(name) {
    const out = new Set();
    const s = String(name || '')
        .normalize('NFKC')
        .replace(/\b(арт(икул)?|art|код)\s*[.:№#]*\s*/gi, ' ');
    for (let w of s.split(/[\s()«»"'“”;[\]]+/)) {
        w = w.replace(/^[,.:]+|[,.:]+$/g, '');
        if (!w) continue;
        if (!/[0-9]/.test(w)) continue;
        const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(w);
        const k = skuKeyV2(w);
        if (!k) continue;
        // чистые числа — только длинные (коды каталога), иначе «200 мм», «2024» дают мусор
        if (!hasLetter && k.length < 6) continue;
        if (hasLetter && k.length < 5) continue;
        // размеры/единицы вида 13X100, 6МЛ, 75СМ — не артикул
        if (/^[0-9]+(X[0-9]+)+$/.test(k) || /^[0-9]+(MM|CM|ML|MЛ|KG|KГ|G|Г|L|Л|MKM|MKЛ|ШT)$/.test(k)) continue;
        out.add(k);
    }
    return [...out];
}

function pushPosting(map, key, idx) {
    let arr = map.get(key);
    if (!arr) {
        arr = [];
        map.set(key, arr);
    }
    if (arr.length && arr[arr.length - 1] === idx) return;
    arr.push(idx);
}

function createSkuV2Index(compPrices) {
    const index = {
        strict: new Map(),
        full: new Map(),
        part: new Map(),
        inName: new Map(),
        n: compPrices.length,
    };
    for (let i = 0; i < compPrices.length; i += 1) indexSkuV2Row(index, i, compPrices[i]);
    return index;
}

function indexSkuV2Row(index, i, row) {
    const sku = row && row.sku;
    if (sku) {
        const sk = strictKey(sku);
        if (sk) pushPosting(index.strict, sk, i);
        const fk = skuKeyV2(sku);
        if (fk && usableKey(fk)) pushPosting(index.full, fk, i);
        for (const pk of skuPartKeys(sku)) pushPosting(index.part, pk, i);
    }
    for (const nk of nameSkuKeys(row && row.product_name)) pushPosting(index.inName, nk, i);
}

function lookup(map, key) {
    const arr = map.get(key);
    if (!arr || !arr.length || arr.length > MAX_POSTING) return null;
    return arr;
}

/**
 * Кандидаты по уровням для нашего товара.
 * @returns {{ level: string, idx: number[] }[]} — уровни в порядке силы, только непустые
 */
function collectSkuV2Candidates(index, mySku, myName) {
    const res = [];
    const seen = new Set();
    function add(level, arr) {
        if (!arr) return;
        const fresh = arr.filter((i) => !seen.has(i));
        if (!fresh.length) return;
        fresh.forEach((i) => seen.add(i));
        res.push({ level, idx: fresh });
    }
    const sk = strictKey(mySku);
    const fk = skuKeyV2(mySku);
    const fkOk = fk && usableKey(fk);
    if (sk) add('exact', index.strict.get(sk) && index.strict.get(sk).length <= MAX_POSTING ? index.strict.get(sk) : null);
    if (fkOk) add('norm', lookup(index.full, fk));
    const myParts = skuPartKeys(mySku);
    if (fkOk || myParts.length) {
        const partHits = [];
        if (fkOk) {
            const a = lookup(index.part, fk);
            if (a) partHits.push(...a);
        }
        for (const pk of myParts) {
            const a = lookup(index.full, pk);
            if (a) partHits.push(...a);
            const b = lookup(index.part, pk);
            if (b) partHits.push(...b);
        }
        add('part', partHits.length ? partHits : null);
    }
    const inNameKeys = [];
    if (fkOk && fk.length >= 5) inNameKeys.push(fk);
    for (const pk of myParts) if (pk.length >= 5) inNameKeys.push(pk);
    const nameHits = [];
    for (const k of inNameKeys) {
        const a = lookup(index.inName, k);
        if (a) nameHits.push(...a);
    }
    add('comp_name', nameHits.length ? nameHits : null);
    const myNameHits = [];
    for (const k of nameSkuKeys(myName)) {
        if (k === fk) continue;
        const a = lookup(index.full, k);
        if (a) myNameHits.push(...a);
    }
    add('my_name', myNameHits.length ? myNameHits : null);
    return res;
}

const STRONG_LEVELS = new Set(['exact', 'norm']);
/** У точного артикула «названия расходятся» — только при явном расхождении. */
const STRONG_NAME_DOUBT_BELOW = 0.2;
const CLOSE_DELTA = 0.03;

/**
 * Выбор карточки: самый сильный уровень, внутри — лучшее название.
 * Слабые уровни (part / comp_name / my_name) без похожего названия отбрасываются.
 * @param {(idx: number) => { score: number, reject?: string }} nameScore
 * @param {number} topN
 */
function pickSkuV2(levels, nameScore, topN) {
    const all = [];
    let best = null;
    for (const lv of levels) {
        const strong = STRONG_LEVELS.has(lv.level);
        const scored = lv.idx
            .map((i) => {
                const r = nameScore(i) || { score: 0 };
                return { i, level: lv.level, name: r.reject ? 0 : Number(r.score) || 0, reject: r.reject || null };
            })
            .filter((c) => strong || c.name >= NAME_DOUBT_BELOW)
            .sort((a, b) => b.name - a.name);
        if (!scored.length) continue;
        if (!best) best = scored;
        all.push(...scored);
    }
    if (!best) return null;
    const top = best[0];
    const strong = STRONG_LEVELS.has(top.level);
    const sameLevelClose = best.length > 1 && top.name - best[1].name < CLOSE_DELTA;
    const nameDoubt = strong ? top.name < STRONG_NAME_DOUBT_BELOW : false;
    const cands = all.filter((c) => c !== top).slice(0, Math.max(0, (topN || 6) - 1));
    return {
        best: top,
        cands,
        sameSkuCards: best.length,
        ambiguous: sameLevelClose,
        nameDoubt,
    };
}

module.exports = {
    pickSkuV2,
    SKU_V2_LEVELS: LEVELS,
    SKU_V2_LEVEL_SCORE: LEVEL_SCORE,
    SKU_V2_NAME_DOUBT_BELOW: NAME_DOUBT_BELOW,
    skuKeyV2,
    skuPartKeys,
    nameSkuKeys,
    createSkuV2Index,
    collectSkuV2Candidates,
};
