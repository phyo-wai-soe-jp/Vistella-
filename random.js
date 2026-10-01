// random.js — makes up a collection of orders and boxes, for trying a
// method out without typing a load in first. The same seed always gives the
// same boxes, and the app's LoadPlanRandom.swift follows these steps
// exactly, so a seed makes the same collection on the phone and here.

import { LIMITS, PALETTE } from './planner.js';

export const RECIPE_RANGES = {
  orders: [1, 12],
  boxesPerOrder: [1, 60],
  seed: [1, 9999],
};

/** Densities a box's contents might have, in kg/m³. */
const DENSITIES = [60, 120, 250, 450];

/**
 * A plain linear congruential generator, so both planners match. It runs in
 * 32 bits through Math.imul: a plain multiply here would pass 2^53 and lose
 * precision, and the app's Swift would then drift away from it.
 */
function numbers(seed) {
  let state = Math.abs(Math.trunc(seed)) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  return {
    next,
    int: ([low, high]) => low + Math.floor(next() * (high - low + 1)),
    pick: (options) => options[Math.floor(next() * options.length)],
  };
}

const clamp = (value, [low, high]) => Math.min(Math.max(value, low), high);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);

export function randomCollection({ orders = 3, boxesPerOrder = 8, seed = 1 } = {}, name, language = 'ja') {
  const random = numbers(seed);
  const orderCount = clamp(orders, RECIPE_RANGES.orders);
  const perOrder = clamp(boxesPerOrder, RECIPE_RANGES.boxesPerOrder);
  let number = LIMITS.boxNumber[0];
  const made = [];

  for (let index = 0; index < orderCount; index += 1) {
    const boxes = [];
    let remaining = perOrder;
    while (remaining > 0 && number + 1 <= LIMITS.boxNumber[1]) {
      const quantity = Math.min(remaining, random.int([1, 4]));
      // Sizes in 50 mm steps, within the spec's 50–2000 mm.
      const sizeMM = [random.int([4, 16]) * 50, random.int([3, 12]) * 50, random.int([2, 10]) * 50];
      const volume = (sizeMM[0] * sizeMM[1] * sizeMM[2]) / 1e9;
      const weightKg = clamp(Math.round(random.pick(DENSITIES) * volume * 10) / 10, LIMITS.boxWeightKg);
      const roll = random.next();
      const strength = roll < 0.08 ? 'fragile' : roll < 0.2 ? 'strong' : null;
      const turnAllowed = random.next() > 0.15;
      boxes.push({ id: uid(), number, sizeMM, weightKg, quantity, color: null, strength, turnAllowed });
      number += quantity;
      remaining -= quantity;
    }
    made.push({
      id: uid(),
      client: language === 'ja' ? `店舗${index + 1}` : `Store ${index + 1}`,
      stop: index + 1,
      color: index % PALETTE.length,
      boxes,
    });
  }

  return {
    id: uid(),
    name: name ?? (language === 'ja' ? `ランダム #${seed}` : `Random #${seed}`),
    orders: made,
  };
}
