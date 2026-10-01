// engine.js — the Rust load planning engine, compiled to WebAssembly.
//
// The engine decides where every box goes, looking at the whole load at
// once rather than one box at a time. Everything the screen needs after
// that — the per-step checks, the results card, the unload replay — is
// worked out by planner.js from the positions it returns, so only the
// deciding moved and the display did not.

import { Placed, Stack, metricsFor, STRENGTH_CAPACITY, DEFAULT_RULES } from './planner.js';

let loading = null;
let engine = null;

/** Load the WebAssembly once, and remember the failure if it will not. */
export async function ready() {
  if (engine) return engine;
  if (!loading) {
    loading = import('./engine/vistella_engine.js')
      .then(async (module) => {
        await module.default({ module_or_path: new URL('./engine/vistella_engine_bg.wasm', import.meta.url) });
        engine = module;
        return module;
      })
      .catch((problem) => {
        loading = null;
        throw problem;
      });
  }
  return loading;
}

export function isReady() {
  return engine !== null;
}

const FACE_FOR = { top: 'top', front: 'front', back: 'back', left: 'left', right: 'right' };

/** Grams, because the engine works in whole numbers only. */
const grams = (kg) => Math.max(0, Math.round(kg * 1000));

function requestFor(boxes, field, method, face) {
  // A container has walls to wedge the load against; a pallet is a bare
  // surface where only the boxes themselves hold anything in place. Its
  // third dimension is how high the load may be stacked, not a ceiling.
  const walled = field.type === 'container';
  const height = field.sizeMM[2];
  // The engine counts orders as numbers, so give each one an index in the
  // order its boxes first appear.
  const orderIndex = new Map();
  for (const box of boxes) {
    if (!orderIndex.has(box.orderId)) orderIndex.set(box.orderId, orderIndex.size);
  }
  const open = field.openFaces?.length ? field.openFaces : ['top'];
  const selectedFaces = (chosen, fallback) => {
    const valid = (chosen ?? []).filter((entry) => FACE_FOR[entry] && open.includes(entry));
    return valid.length ? valid : [fallback];
  };
  const unloading = selectedFaces(method.unloadFaces, face);
  const loading = selectedFaces(method.loadingFrom, unloading[0]);
  return {
    boxes: boxes.map((box, id) => ({
      id,
      number: box.number,
      size: box.sizeMM,
      weightG: grams(box.weightKg),
      strengthGM2: grams(STRENGTH_CAPACITY[box.strength] ?? 0),
      turnAllowed: box.turnAllowed !== false,
      order: orderIndex.get(box.orderId) ?? 0,
      stop: box.stop ?? 1,
    })),
    field: { size: [field.sizeMM[0], field.sizeMM[1], height], walled },
    method: {
      door: FACE_FOR[unloading[0]] ?? 'front',
      loadingDoors: loading.map((entry) => FACE_FOR[entry]),
      unloadingDoors: unloading.map((entry) => FACE_FOR[entry]),
      strictUnload: method.unloadRule === 'strict',
      minSupportPct: method.engineRules?.minSupportPct ?? 80,
      requireCenterSupport: method.engineRules?.requireCenterSupport !== false,
      requireSideContact: method.engineRules?.requireSideContact !== false,
      allowHeightGrowth: method.engineRules?.allowHeightGrowth === true,
      weights: {
        unload: Math.round((method.weights?.unload ?? 0.5) * 100),
        damage: Math.round((method.weights?.damage ?? 0.5) * 100),
        space: Math.round((method.weights?.space ?? 0.5) * 100),
        grouping: Math.round((method.weights?.grouping ?? 0.5) * 100),
      },
      effort: 0,
      seed: 1,
    },
  };
}

/**
 * Plan a load with the engine, returning the same shape planner.js does so
 * nothing downstream has to know which planner ran.
 */
export function planWith(boxes, field, method, face, fellBack) {
  if (!engine) throw new Error('the engine is not loaded yet');
  const answer = JSON.parse(engine.plan(JSON.stringify(requestFor(boxes, field, method, face))));
  if (answer.error) throw new Error(answer.error);

  // The engine returns positions. Replaying them through the same Stack the
  // JS planner uses gives the per-step checks and the load on each box, so
  // the results card and the 3D view read exactly as they always have.
  const stack = new Stack(field);
  const steps = [];
  for (const placement of answer.placements) {
    const box = boxes[placement.boxId];
    const placed = new Placed(box, placement.pos[0], placement.pos[1], placement.pos[2], placement.turned);
    const evaluation = stack.evaluate(placed);
    stack.place(placed);
    steps.push({ placement: placed, evaluation, goals: { unload: 0, damage: 0, space: 0, grouping: 0 } });
  }

  const unplaced = answer.unplaced.map((entry) => ({
    box: boxes[entry.boxId],
    failure: { kind: entry.reason === 'tooTall' ? 'tooTall' : 'noRoom' },
  }));

  return {
    field,
    method,
    unloadFace: face,
    unloadFaceFellBack: fellBack,
    sequence: 'engine',
    steps,
    unplaced,
    metrics: metricsFor(stack.placed, stack.loadOnTopKg, boxes.length, field, face, DEFAULT_RULES),
    loadOnTopKg: stack.loadOnTopKg,
    engineReport: answer.report,
  };
}
