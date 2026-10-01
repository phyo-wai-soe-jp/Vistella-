// samples.js — the library the web planner opens with, matching the iOS
// app's LoadPlanSamples so both start from the same example.

let counter = 0;
const id = (prefix) => `${prefix}-${(counter += 1)}`;

const box = (number, sizeMM, weightKg, extra = {}) => ({
  id: id('box'), number, sizeMM, weightKg, quantity: 1, color: null, strength: null, turnAllowed: true, ...extra,
});

export function sampleLibrary(language = 'ja') {
  counter = 0;
  const name = (ja, en) => (language === 'ja' ? ja : en);
  return {
    schemaVersion: 1,
    collections: [
      {
        id: id('collection'),
        name: name('火曜の配送', 'Tuesday delivery'),
        orders: [
          {
            id: id('order'), client: name('店舗A', 'Store A'), stop: 1, color: 0,
            boxes: [
              box(1, [400, 300, 250], 8.5, { quantity: 6 }),
              box(7, [300, 200, 200], 4, { quantity: 4 }),
            ],
          },
          {
            id: id('order'), client: name('店舗B', 'Store B'), stop: 2, color: 1,
            boxes: [
              box(11, [600, 400, 300], 18, { quantity: 2, strength: 'strong' }),
              box(13, [400, 300, 250], 9, { quantity: 4 }),
            ],
          },
          {
            id: id('order'), client: name('店舗C', 'Store C'), stop: 3, color: 6,
            boxes: [
              // Light and small: the automatic strength makes these weak.
              box(17, [180, 180, 180], 0.4, { quantity: 4 }),
              box(21, [500, 300, 150], 3, { quantity: 2, strength: 'fragile' }),
            ],
          },
        ],
      },
      {
        id: id('collection'),
        name: name('倉庫の補充', 'Warehouse restock'),
        orders: [
          {
            id: id('order'), client: name('第1倉庫', 'Warehouse 1'), stop: 1, color: 3,
            boxes: [box(1, [600, 400, 400], 22, { quantity: 6 })],
          },
          {
            id: id('order'), client: name('第2倉庫', 'Warehouse 2'), stop: 2, color: 8,
            boxes: [
              box(7, [400, 400, 300], 12, { quantity: 4 }),
              box(11, [300, 300, 600], 15, { quantity: 2 }),
            ],
          },
        ],
      },
    ],
    fields: [
      {
        id: id('field'), name: name('JIS T11 パレット', 'JIS T11 pallet'), type: 'surface',
        sizeMM: [1100, 1100, 1500], maxLoadKg: 1000, openFaces: ['top', 'front', 'back', 'left', 'right'], floorColor: 11,
      },
      {
        id: id('field'), name: name('20ft コンテナ(内寸)', '20 ft container (inside)'), type: 'container',
        sizeMM: [2352, 5898, 2393], maxLoadKg: 20000, openFaces: ['front'], floorColor: 16,
      },
      {
        id: id('field'), name: name('カゴ車(例)', 'Roll cage (example)'), type: 'container',
        sizeMM: [800, 600, 1500], maxLoadKg: 500, openFaces: ['front'], floorColor: 12,
      },
    ],
    methods: [
      {
        id: id('method'), name: name('実運用バランス', 'Real-world balanced'), profile: 'balanced',
        unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'], unloadRule: 'preferred',
        weights: { unload: 6, damage: 8, space: 7, grouping: 5 },
        engineRules: { minSupportPct: 80, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
      },
      {
        id: id('method'), name: name('複数配送先', 'Multi-stop delivery'), profile: 'multiStop',
        unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'], unloadRule: 'strict',
        weights: { unload: 10, damage: 8, space: 5, grouping: 8 },
        engineRules: { minSupportPct: 85, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
      },
      {
        id: id('method'), name: name('安全最大積載', 'Maximum safe capacity'), profile: 'capacity',
        unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'], unloadRule: 'preferred',
        weights: { unload: 3, damage: 7, space: 10, grouping: 3 },
        engineRules: { minSupportPct: 75, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: true },
      },
      {
        id: id('method'), name: name('壊れ物・精密品', 'Fragile cargo'), profile: 'fragile',
        unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'], unloadRule: 'preferred',
        weights: { unload: 5, damage: 10, space: 4, grouping: 6 },
        engineRules: { minSupportPct: 95, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
      },
    ],
  };
}
