'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isOzonAutoSplitMergeKey,
    categoryIsColorOnlyAspect,
    shouldLinkAsSimilarProducts,
    buildPosterSimilarGroupValue,
    assignPosterSwitchColors,
} = require('./ozonProductMerge');

const posterAttrs = [
    { id: 10096, name: 'Цвет товара', is_aspect: true },
    { id: 22390, name: 'Объединить в похожие товары', is_aspect: false },
    { id: 9048, name: 'Название модели (для объединения в одну карточку)', is_aspect: false },
    { id: 21807, name: 'Формат', is_aspect: false },
];

test('Ozon split key is the group code plus the offer id', () => {
    assert.equal(
        isOzonAutoSplitMergeKey('плакат А2+_12407s52195', '12407s52195'),
        true
    );
    assert.equal(isOzonAutoSplitMergeKey('12407s52195_плакат', '12407s52195'), true);
    assert.equal(isOzonAutoSplitMergeKey('плакат А2+', '12407'), false);
});

test('posters with the same color go to similar products, not one card', () => {
    assert.equal(categoryIsColorOnlyAspect(posterAttrs), true);
    assert.equal(shouldLinkAsSimilarProducts(posterAttrs, ['белый', 'белый', 'белый', 'белый']), true);
    assert.equal(shouldLinkAsSimilarProducts(posterAttrs, ['белый', 'коричневый', 'белый', 'белый']), true);
    assert.equal(shouldLinkAsSimilarProducts(posterAttrs, ['белый', 'коричневый']), false);
});

test('a category with a real size aspect is not forced into similar products', () => {
    const attrs = posterAttrs.concat([{ id: 4295, name: 'Размер', is_aspect: true }]);
    assert.equal(shouldLinkAsSimilarProducts(attrs, ['белый', 'белый']), false);
});

test('duplicate white posters get distinct switch colors, the main card stays white', () => {
    const assigned = assignPosterSwitchColors([
        { offerId: '12397s52003', color: 'белый', isMain: false },
        { offerId: '12397', color: 'белый', isMain: true },
        { offerId: '12397s16075', color: 'белый', isMain: false },
        { offerId: '12397s52002', color: 'белый', isMain: false },
    ]);
    const byId = Object.fromEntries(assigned.map((c) => [c.offerId, c.value]));
    assert.equal(byId['12397'], 'белый');
    assert.deepEqual(
        [byId['12397s16075'], byId['12397s52002'], byId['12397s52003']].sort(),
        ['бежевый', 'коричневый', 'серый']
    );
});

test('similar group name is the quoted poster title', () => {
    assert.equal(
        buildPosterSimilarGroupValue(
            ['Обучающий плакат "Нервы носовой полости", размер А2+, глянцевая фотобумага'],
            '12407'
        ),
        'плакат: Нервы носовой полости'
    );
});
