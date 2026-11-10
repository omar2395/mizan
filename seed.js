// seed.js — deterministic synthetic data for Baraka Markets (5-branch food retailer)
// Generates 180 days of per-store, per-SKU daily sales plus current stock levels.
// Pure functions, seeded RNG — same data on every server start so every run is reproducible.
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STORES = [
  { id: 'OLY', name: 'Olaya Flagship',  city: 'Riyadh', weight: 0.28 },
  { id: 'MLZ', name: 'Al Malaz',        city: 'Riyadh', weight: 0.20 },
  { id: 'COR', name: 'Corniche',        city: 'Jeddah', weight: 0.22 },
  { id: 'RWD', name: 'Al Rawda',        city: 'Jeddah', weight: 0.14 },
  { id: 'DMM', name: 'Dammam Central',  city: 'Dammam', weight: 0.16 },
];

// base: chain-wide avg daily units. trend: fraction of base gained/lost per day.
// weekend: multiplier lift on Fri/Sat (KSA weekend). vol: noise sigma as fraction of demand.
const SKU_DEFS = [
  ['Wadi Fresh Milk 2L',            'Dairy',      'Wadi',        6.5, 11.5, 3, 24, 310, +0.0006, 1.35, 0.10],
  ['Rawdah Greek Yogurt 150g',      'Dairy',      'Rawdah',      2.1,  4.5, 3, 24, 240, +0.0022, 1.20, 0.14],
  ['Safa Farms Labneh 400g',            'Dairy',      'Safa Farms',      5.8,  9.8, 3, 12, 120, -0.0004, 1.25, 0.12],
  ['Creamline Cream Cheese 500g',         'Dairy',      'Creamline',         8.9, 14.5, 4, 12,  85, -0.0018, 1.15, 0.13],
  ['Sahm Cake Bars 5-pack',         'Bakery',     'Sahm',        4.2,  7.9, 5, 20, 150, +0.0009, 1.30, 0.15],
  ['Furn Sliced Bread 600g', 'Bakery',     'Furn', 3.1,  5.5, 2, 10, 275, +0.0002, 1.18, 0.09],
  ['Sabah Croissant Chocolate',     'Bakery',     'Sabah',       1.6,  3.0, 5, 36, 195, -0.0011, 1.28, 0.16],
  ['Najd Tea 100 Bags',            'Beverages',  'Najd',       9.4, 15.9, 7, 12,  95, +0.0004, 1.12, 0.11],
  ['Hail Cardamom Tea 200g',        'Beverages',  'Hail',       11.2, 18.5, 7, 12,  70, +0.0016, 1.15, 0.13],
  ['Malti Malt Pomegranate 6pk',  'Beverages',  'Malti',    10.8, 17.4, 6, 8, 130, +0.0028, 1.45, 0.17],
  ['Nabaa Water 1.5L 6-pack',     'Beverages',  'Nabaa',     7.2, 11.0, 4, 6, 340, +0.0011, 1.40, 0.10],
  ['Rawdah Orange Juice 1.4L',      'Beverages',  'Rawdah',      8.1, 13.8, 3, 12, 165, -0.0007, 1.32, 0.12],
  ['Nakhla Maamoul Dates 12pc',      'Snacks',     'Nakhla',       7.6, 13.5, 6, 16, 105, -0.0024, 1.30, 0.18],
  ['Qarmash Chili Lemon 155g',    'Snacks',     'Qarmash',   3.4,  6.5, 5, 24, 230, +0.0013, 1.55, 0.15],
  ['Sukkar Halva Pistachio 450g',   'Snacks',     'Sukkar',     12.3, 19.9, 8, 12,  55, -0.0015, 1.10, 0.14],
  ['Lulua Jewels 650g Tin',         'Snacks',     'Lulua',      24.5, 38.0, 8, 6,  60, +0.0019, 1.42, 0.19],
  ['Dana Frozen Sambousek 20pc', 'Frozen',     'Dana',    13.8, 22.5, 9, 10,  90, +0.0031, 1.38, 0.16],
  ['Majd Chicken Nuggets 750g', 'Frozen',     'Majd',   16.2, 26.9, 9, 10, 115, +0.0008, 1.35, 0.13],
  ['Rif Whole Chicken 1100g',      'Frozen',     'Rif',       14.9, 23.5, 7, 10, 185, -0.0002, 1.30, 0.11],
  ['Hamra Tomato Paste 130g x8',  'Pantry',     'Hamra',     8.7, 13.9, 10, 12, 140, +0.0003, 1.08, 0.09],
  ['Zahra Sunflower Oil 2.9L',        'Pantry',     'Zahra',        21.4, 32.9, 10, 6, 125, -0.0009, 1.14, 0.10],
  ['Sunbul Basmati Rice 10kg',     'Pantry',     'Sunbul',    54.0, 79.0, 12, 2,  75, +0.0006, 1.20, 0.12],
  ['Qishta Custard 300g','Pantry',    'Qishta', 4.1, 7.2, 10, 24, 65, -0.0027, 1.16, 0.15],
  ['Safwa Original 6kg',              'Household',  'Safwa',        31.5, 47.5, 11, 4,  50, -0.0005, 1.05, 0.11],
];

const SUPPLIERS = {
  Dairy: 'Gulf Fresh Distribution Co.', Bakery: 'Manara Foods Trading',
  Beverages: 'Manara Foods Trading', Snacks: 'Riyadh Wholesale Alliance',
  Frozen: 'Arctic Line Logistics', Pantry: 'Riyadh Wholesale Alliance',
  Household: 'Gulf Fresh Distribution Co.',
};

const HISTORY_DAYS = 180;

function buildDataset(seed = 20260703) {
  const rnd = mulberry32(seed);
  const gauss = () => { // Box–Muller
    const u = Math.max(rnd(), 1e-9), v = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const today = new Date('2026-07-03T00:00:00Z');
  const dates = [];
  for (let i = HISTORY_DAYS; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const skus = SKU_DEFS.map((def, idx) => {
    const [name, category, brand, unitCost, price, leadTimeDays, caseSize, base, trend, weekend, vol] = def;
    return {
      id: 'SKU-' + String(1001 + idx),
      name, category, brand, unitCost, price, leadTimeDays, caseSize,
      supplier: SUPPLIERS[category],
      _base: base, _trend: trend, _weekend: weekend, _vol: vol,
    };
  });

  // Per-SKU promo windows (a couple of 5-day promos in the past create realistic spikes)
  const promoWindows = skus.map(() => {
    const n = rnd() < 0.55 ? 2 : 1;
    const wins = [];
    for (let k = 0; k < n; k++) {
      const start = 15 + Math.floor(rnd() * (HISTORY_DAYS - 40));
      wins.push([start, start + 4, 1.5 + rnd() * 0.9]);
    }
    return wins;
  });

  // sales[skuIdx][storeIdx] = Int array of daily units (length HISTORY_DAYS)
  const sales = skus.map((sku, si) => {
    const perStore = STORES.map(() => new Array(HISTORY_DAYS));
    for (let t = 0; t < HISTORY_DAYS; t++) {
      const dow = new Date(dates[t] + 'T00:00:00Z').getUTCDay(); // 5=Fri, 6=Sat
      const wk = (dow === 5 || dow === 6) ? sku._weekend : (dow === 0 ? 1.05 : 1.0);
      let promo = 1;
      for (const [a, b, m] of promoWindows[si]) if (t >= a && t <= b) promo = m;
      const level = sku._base * (1 + sku._trend * (t - HISTORY_DAYS / 2)) * wk * promo;
      const chain = Math.max(0, level * (1 + gauss() * sku._vol));
      for (let st = 0; st < STORES.length; st++) {
        const share = STORES[st].weight * (1 + gauss() * 0.12);
        perStore[st][t] = Math.max(0, Math.round(chain * share));
      }
    }
    return perStore;
  });

  // Current on-hand stock per SKU per store — engineered so the risk board has a story:
  // some SKUs critically short, some ballooning overstock, most healthy.
  const stock = skus.map((sku, si) => {
    const recent = [];
    for (let t = HISTORY_DAYS - 28; t < HISTORY_DAYS; t++) {
      let s = 0;
      for (let st = 0; st < STORES.length; st++) s += sales[si][st][t];
      recent.push(s);
    }
    const dailyRate = recent.reduce((a, b) => a + b, 0) / recent.length;
    // Cover profile: index-based so it's deterministic and varied.
    const profile = [3, 55, 18, 70, 12, 25, 62, 20, 6, 4, 16, 30, 75, 9, 58, 7, 5, 22, 14, 28, 40, 10, 66, 35][si];
    const chainOnHand = Math.round(dailyRate * profile * (0.9 + rnd() * 0.2));
    return STORES.map((s2) => Math.max(0, Math.round(chainOnHand * s2.weight * (0.85 + rnd() * 0.3))));
  });

  // On-order units already in transit (some SKUs have pending POs)
  const onOrder = skus.map((sku, si) => (si % 5 === 2 ? sku.caseSize * (4 + Math.floor(rnd() * 6)) : 0));

  return {
    retailer: { name: 'Baraka Markets', currency: 'SAR', asOf: dates[HISTORY_DAYS - 1] },
    stores: STORES.map(({ id, name, city }) => ({ id, name, city })),
    dates,
    skus: skus.map(({ _base, _trend, _weekend, _vol, ...pub }) => pub),
    sales,   // [sku][store][day] units
    stock,   // [sku][store] on-hand units
    onOrder, // [sku] units in transit
  };
}

module.exports = { buildDataset };
