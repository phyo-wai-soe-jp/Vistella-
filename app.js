// app.js — the 積み付けシミュレータ web planner: the same screen as the
// iOS tab (settings bar, Create rail, 3D stage, Simulate bar), drawn on a
// canvas and driven by planner.js.

import {
  PALETTE, LIMITS, FACES, STRENGTH_CAPACITY, Placed, planBoxes, unloadOrder, movedAside, blockedIndices,
  libraryIssues, boxIssues, fieldIssues, isBlocking, automaticStrength, resolvedStrength,
  densityOf, numbersOf, rgbOf, usesDarkText, loadRatiosAt, unloadFaceFor,
} from './planner.js';
import { sampleLibrary } from './samples.js';
import { randomCollection, RECIPE_RANGES } from './random.js';
import { parseLibrary, serializeLibrary, serializePlan, ExchangeError } from './exchange.js';
import * as engine from './engine.js';

const STORAGE_KEY = 'vistella.loadplan.v1';
const DEFAULT_COLLECTION_VERSION = 1;
const DEFAULT_SPEED_VERSION = 1;

const state = {
  language: 'ja',
  library: sampleLibrary('ja'),
  selectedOrderIds: [],
  selectedFieldId: null,
  selectedMethodId: null,
  display: {
    numbers: 'box', colors: 'order', units: 'mm', speed: 10,
    animateRun: false, showsCenterOfGravity: true,
  },
  editor: null,          // { kind, orderId?, boxId?, fieldId?, methodId? }
  recipe: { orders: 3, boxesPerOrder: 8, seed: 1 + Math.floor(Math.random() * 9999) },
  engineProblem: null,
  run: null,
  visible: 0,
  playing: false,
  motion: null,          // { index, progress } while a box travels from pile to destination
  unload: null,          // { order: [...], removed: 0, playing: bool }
  viewMode: 'before',    // collection piles before planning, or the optimized result
  camera: { yaw: 0.6, pitch: 0.52, distance: 3, target: [0, 0.4, 0] },
};

const t = (ja, en) => (state.language === 'ja' ? ja : en);
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);

const FACE_TITLE = {
  top: () => t('上', 'Top'), front: () => t('前', 'Front'), back: () => t('後ろ', 'Back'),
  left: () => t('左', 'Left'), right: () => t('右', 'Right'),
};
const STRENGTH_TITLE = {
  strong: () => t('強い', 'Strong'), normal: () => t('普通', 'Normal'),
  weak: () => t('弱い', 'Weak'), fragile: () => t('壊れもの', 'Fragile'),
};
const SEQUENCE_TITLE = {
  unloadOrder: () => t('降ろし順の逆', 'Reverse unload order'),
  unloadOrderLargestFirst: () => t('降ろし順の逆(大きい箱から)', 'Reverse unload order, largest first'),
  strongestFirst: () => t('強い箱から', 'Strongest first'),
  largestFirst: () => t('大きい箱から', 'Largest first'),
};
const CHECK_TITLE = {
  support: () => t('支えられるか', 'Support'), balance: () => t('重さが偏らないか', 'Balance'),
  load: () => t('下の箱が耐えられるか', 'Load'), limits: () => t('崩れにくいか', 'Limits'),
  unload: () => t('取り出しやすさ', 'Unload order'),
};

const METHOD_PROFILES = {
  balanced: {
    title: () => t('実運用バランス', 'Real-world balanced'),
    detail: () => t('通常配送。安定・積載量・荷下ろしを均衡', 'General delivery: balances stability, capacity and unloading'),
    unloadRule: 'preferred', weights: { unload: 6, damage: 8, space: 7, grouping: 5 },
    engineRules: { minSupportPct: 80, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
  },
  multiStop: {
    title: () => t('複数配送先', 'Multi-stop delivery'),
    detail: () => t('配送順を優先し、積み替えを最小化', 'Protects stop order and minimizes rehandling'),
    unloadRule: 'strict', weights: { unload: 10, damage: 8, space: 5, grouping: 8 },
    engineRules: { minSupportPct: 85, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
  },
  capacity: {
    title: () => t('安全最大積載', 'Maximum safe capacity'),
    detail: () => t('安全条件内で上方空間も使用', 'Uses vertical space while retaining calculated support'),
    unloadRule: 'preferred', weights: { unload: 3, damage: 7, space: 10, grouping: 3 },
    engineRules: { minSupportPct: 75, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: true },
  },
  fragile: {
    title: () => t('壊れ物・精密品', 'Fragile cargo'),
    detail: () => t('広い支持と低い積み高さを優先', 'Prioritizes broad support, low height and low compression'),
    unloadRule: 'preferred', weights: { unload: 5, damage: 10, space: 4, grouping: 6 },
    engineRules: { minSupportPct: 95, requireCenterSupport: true, requireSideContact: true, allowHeightGrowth: false },
  },
};

function applyProfile(method, profile) {
  const preset = METHOD_PROFILES[profile] ?? METHOD_PROFILES.balanced;
  method.profile = profile in METHOD_PROFILES ? profile : 'balanced';
  method.name = preset.title();
  method.unloadRule = preset.unloadRule;
  method.weights = { ...preset.weights };
  method.engineRules = { ...preset.engineRules };
}

function normalizeDirections(method) {
  const legacyUnload = method.unloadFrom && method.unloadFrom !== 'auto' ? [method.unloadFrom] : ['front'];
  method.unloadFaces = FACES.filter((face) => (method.unloadFaces ?? legacyUnload).includes(face));
  method.loadingFrom = FACES.filter((face) => (method.loadingFrom ?? method.unloadFaces).includes(face));
  if (!method.unloadFaces.length) method.unloadFaces = ['front'];
  if (!method.loadingFrom.length) method.loadingFrom = [...method.unloadFaces];
  // Keep the old single-face field for phone/library compatibility. It is
  // the primary face used to orient the coarse stop blocks.
  method.unloadFrom = method.unloadFaces[0];
}

function upgradeMethods(library) {
  const legacyProfile = (method) => method.unloadRule === 'strict'
    ? 'multiStop'
    : method.weights?.space > Math.max(method.weights?.unload ?? 0, method.weights?.damage ?? 0)
      ? 'capacity'
      : 'balanced';
  for (const method of library.methods) {
    if (!method.profile || !METHOD_PROFILES[method.profile]) {
      const profile = legacyProfile(method);
      applyProfile(method, profile);
    } else {
      method.engineRules = { ...METHOD_PROFILES[method.profile].engineRules, ...(method.engineRules ?? {}) };
    }
    normalizeDirections(method);
  }
  if (!library.methods.some((method) => method.profile === 'fragile')) {
    const method = { id: uid(), unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'] };
    applyProfile(method, 'fragile');
    library.methods.push(method);
  }
}

function issueMessage(issue) {
  switch (issue.kind) {
    case 'boxSize': return t('各辺は 50〜2000 mm', 'Each side must be 50–2000 mm');
    case 'boxWeight': return t('重さは 0.1〜50 kg', 'Weight must be 0.1–50 kg');
    case 'boxQuantity': return t('数量は 1〜999', 'Quantity must be 1–999');
    case 'boxNumber': return t('番号は 1〜9999', 'Numbers must be 1–9999');
    case 'duplicateBoxNumber': return t(`番号 ${issue.number} が重複しています`, `Number ${issue.number} is used twice`);
    case 'color': return t('色は 30 色から選んでください', 'Pick one of the 30 colors');
    case 'clientName': return t('顧客名は 1〜40 文字', 'Client name must be 1–40 characters');
    case 'stop': return t('降ろし順は 1〜99', 'Unload stop must be 1–99');
    case 'duplicateOrderColor': return t('同じ色の注文が他にもあります', 'Another order uses this color');
    case 'fieldSize': return t('床は各辺 100〜13000 mm、高さは 100〜3000 mm', 'Floor sides 100–13000 mm, height 100–3000 mm');
    case 'fieldMaxLoad': return t('最大荷重は 0 より大きく', 'Max load must be above 0');
    case 'fieldNoOpenFace': return t('取り出せる面を 1 つ以上選んでください', 'Choose at least one open face');
    default: return t('重みは 0〜10', 'Weights must be 0–10');
  }
}

function failureMessage(failure) {
  const kg = (value) => value.toFixed(1);
  switch (failure.kind) {
    case 'outsideField': return t('フィールドからはみ出す', 'Sticks out of the field');
    case 'aboveHeightLimit':
      return t(`高さ ${failure.topMM} mm が上限 ${failure.limitMM} mm を超える`,
               `Height ${failure.topMM} mm is over the ${failure.limitMM} mm limit`);
    case 'overlaps': return t(`箱 ${failure.boxNumber} と重なる`, `Overlaps box ${failure.boxNumber}`);
    case 'overMaxLoad':
      return t(`合計 ${kg(failure.totalKg)} kg が最大荷重 ${kg(failure.maxKg)} kg を超える`,
               `Total ${kg(failure.totalKg)} kg is over the ${kg(failure.maxKg)} kg max load`);
    case 'weakSupport':
      return t(`底面の ${Math.floor(failure.ratio * 100)}% しか支えられていない`,
               `Only ${Math.floor(failure.ratio * 100)}% of its base is supported`);
    case 'offBalance': return t('重心が支えの外にある', 'Its center is outside its support');
    case 'overload':
      return t(`下の箱 ${failure.boxNumber} に ${kg(failure.loadKg)} kg かかる(耐えられるのは ${kg(failure.capacityKg)} kg)`,
               `Box ${failure.boxNumber} below would carry ${kg(failure.loadKg)} kg and holds ${kg(failure.capacityKg)} kg`);
    default: return t(`箱 ${failure.boxNumber} との荷下ろし順が崩れる`, `Breaks the unloading order with box ${failure.boxNumber}`);
  }
}

// ------------------------------------------------------------ formatting

const trimmed = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const kg = (value) => `${trimmed(value)} kg`;
const percent = (ratio) => (Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '∞');

function length(mm) {
  return state.display.units === 'mm' ? `${mm} mm` : `${trimmed(mm / 10)} cm`;
}

function sizeText(sizeMM) {
  return state.display.units === 'mm'
    ? `${sizeMM[0]} × ${sizeMM[1]} × ${sizeMM[2]} mm`
    : `${sizeMM.map((value) => trimmed(value / 10)).join(' × ')} cm`;
}

// ------------------------------------------------------------- selection

const allOrders = () => state.library.collections.flatMap((collection) => collection.orders);
const selectedField = () => state.library.fields.find((field) => field.id === state.selectedFieldId) ?? null;
const selectedMethod = () => state.library.methods.find((method) => method.id === state.selectedMethodId) ?? null;
const selectedBoxes = () => planBoxes(state.library, state.selectedOrderIds);
const boxCountOf = (order) => order.boxes.reduce((count, item) => count + numbersOf(item).length, 0);

function runIssues() {
  const ids = new Set(state.selectedOrderIds);
  for (const order of allOrders()) {
    if (ids.has(order.id)) for (const item of order.boxes) ids.add(item.id);
  }
  if (state.selectedFieldId) ids.add(state.selectedFieldId);
  if (state.selectedMethodId) ids.add(state.selectedMethodId);
  return libraryIssues(state.library).filter((issue) => ids.has(issue.itemId) && isBlocking(issue));
}

const canRun = () => selectedField() && selectedMethod() && selectedBoxes().length > 0 && runIssues().length === 0;

function normalizeSelection() {
  const orderIds = new Set(allOrders().map((order) => order.id));
  state.selectedOrderIds = state.selectedOrderIds.filter((id) => orderIds.has(id));
  if (!selectedField()) state.selectedFieldId = state.library.fields[0]?.id ?? null;
  if (!selectedMethod()) state.selectedMethodId = state.library.methods[0]?.id ?? null;
}

/** Any library edit clears the run: the 3D view never shows a stale plan. */
function libraryChanged() {
  normalizeSelection();
  clearRun();
  save();
  render();
}

function clearRun() {
  state.run = null;
  state.visible = 0;
  state.playing = false;
  state.motion = null;
  state.unload = null;
  state.viewMode = 'before';
}

// ------------------------------------------------------------- persistence

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      language: state.language,
      library: state.library,
      selectedOrderIds: state.selectedOrderIds,
      selectedFieldId: state.selectedFieldId,
      selectedMethodId: state.selectedMethodId,
      display: state.display,
      defaultCollectionVersion: DEFAULT_COLLECTION_VERSION,
      defaultSpeedVersion: DEFAULT_SPEED_VERSION,
    }));
  } catch (error) { /* private windows and blocked storage just don't remember */ }
}

function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch (error) { saved = null; }
  if (saved?.library?.collections) {
    state.language = saved.language === 'en' ? 'en' : 'ja';
    state.library = saved.library;
    state.selectedOrderIds = saved.selectedOrderIds ?? [];
    state.selectedFieldId = saved.selectedFieldId ?? null;
    state.selectedMethodId = saved.selectedMethodId ?? null;
    state.display = { ...state.display, ...(saved.display ?? {}) };
    if (![1, 2, 5, 10, 20].includes(state.display.speed)) state.display.speed = 1;
  } else {
    state.language = (navigator.language ?? 'ja').startsWith('ja') ? 'ja' : 'en';
    state.library = sampleLibrary(state.language);
  }
  // One-time migration for existing browsers (especially phones that kept
  // an older selection in localStorage). Afterwards normal user choices are
  // preserved because save() records this version.
  if (saved?.defaultCollectionVersion !== DEFAULT_COLLECTION_VERSION) {
    let preferred = state.library.collections.find((collection) => /#\s*2910\b/.test(collection.name));
    if (!preferred) {
      preferred = randomCollection({ orders: 12, boxesPerOrder: 11, seed: 2910 }, null, state.language);
      state.library.collections.unshift(preferred);
    }
    state.selectedOrderIds = preferred.orders.map((order) => order.id);
  }
  if (saved?.defaultSpeedVersion !== DEFAULT_SPEED_VERSION) state.display.speed = 10;
  upgradeMethods(state.library);
  normalizeSelection();
  save();
}

// ------------------------------------------------------------------- run

function runPlan({ animate = state.display.animateRun === true } = {}) {
  if (!canRun()) return;
  clearRun();
  const boxes = selectedBoxes();
  const field = selectedField();
  const method = selectedMethod();
  if (!engine.isReady()) {
    engine.ready().then(() => {
      state.engineProblem = null;
      runPlan({ animate });
    }).catch((problem) => {
      state.engineProblem = problem.message;
      render();
    });
    return;
  }
  const { face, fellBack } = unloadFaceFor(method, field);
  let result;
  try {
    result = engine.planWith(boxes, field, method, face, fellBack);
    state.engineProblem = null;
  } catch (problem) {
    state.engineProblem = problem.message;
    render();
    return;
  }
  state.run = result;
  state.viewMode = 'after';
  state.visible = animate ? 0 : result.steps.length;
  frameField(true);
  render();
  if (animate) play();
}

function play() {
  if (!state.run || !state.run.steps.length) return;
  state.unload = null;
  if (state.visible >= state.run.steps.length) state.visible = 0;
  state.playing = true;
  state.motion = null;
  render();
  step();
}

function step() {
  if (!state.playing || !state.run || state.visible >= state.run.steps.length) return;
  const index = state.visible;
  const duration = 650 / state.display.speed;
  const began = performance.now();
  state.motion = { index, progress: 0 };
  const frame = (now) => {
    if (!state.playing || !state.run || state.visible !== index) {
      state.motion = null;
      drawScene();
      return;
    }
    const raw = Math.min((now - began) / duration, 1);
    // Smooth start and finish, like a box being picked up and set down.
    state.motion.progress = raw * raw * (3 - 2 * raw);
    drawScene();
    if (raw < 1) {
      requestAnimationFrame(frame);
      return;
    }
    state.motion = null;
    state.visible += 1;
    if (state.visible >= state.run.steps.length) state.playing = false;
    render();
    if (state.playing) step();
  };
  requestAnimationFrame(frame);
}

function pause() {
  state.playing = false;
  state.motion = null;
  render();
}

function startUnloadReplay() {
  if (!state.run?.steps.length) return;
  state.playing = false;
  state.motion = null;
  state.visible = state.run.steps.length;
  const placements = state.run.steps.map((entry) => entry.placement);
  const order = unloadOrder(placements, state.run.unloadFace);
  const staging = beforePlacementView();
  const sequenceIds = order.map((index) => state.run.steps[index].placement.box.id);
  const pile = staging?.pile;
  const targets = pile
    ? orderPileLayout(selectedBoxes(), pile.pileWidth, pile.heightLimit, pile.gap, pile.groupGap, sequenceIds).targets
    : new Map();
  state.unload = {
    order,
    movedAside: movedAside(order, placements),
    targets,
    removed: 0,
    playing: true,
    motion: null,
  };
  render();
  unloadStep();
}

function unloadStep() {
  if (!state.unload?.playing) return;
  const at = state.unload.removed;
  const index = state.unload.order[at];
  const duration = 650 / state.display.speed;
  const began = performance.now();
  state.unload.motion = { index, progress: 0 };
  const frame = (now) => {
    if (!state.unload?.playing || state.unload.removed !== at) return;
    const raw = Math.min((now - began) / duration, 1);
    state.unload.motion.progress = raw * raw * (3 - 2 * raw);
    drawScene();
    if (raw < 1) {
      requestAnimationFrame(frame);
      return;
    }
    state.unload.motion = null;
    state.unload.removed += 1;
    if (state.unload.removed >= state.unload.order.length) state.unload.playing = false;
    render();
    if (state.unload?.playing) unloadStep();
  };
  requestAnimationFrame(frame);
}

function endUnloadReplay() {
  state.unload = null;
  render();
}

// ------------------------------------------------------------ 3D drawing

const canvas = $('scene');
const ctx = canvas.getContext('2d');
let canvasSize = { width: 0, height: 0 };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const length3 = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length3, a[1] / length3, a[2] / length3];
};

/** Planner millimetres to scene metres: x right, z up, front toward +z. */
function scenePoint(field, x, y, z) {
  return [(x - field.sizeMM[0] / 2) / 1000, z / 1000, (field.sizeMM[1] / 2 - y) / 1000];
}

function cameraBasis() {
  const { yaw, pitch, distance, target } = state.camera;
  const eye = [
    target[0] + distance * Math.cos(pitch) * Math.sin(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * Math.cos(pitch) * Math.cos(yaw),
  ];
  const forward = norm(sub(target, eye));
  const right = norm(cross3(forward, [0, 1, 0]));
  return { eye, forward, right, up: cross3(right, forward) };
}

function project(point, basis) {
  const view = sub(point, basis.eye);
  const depth = dot(view, basis.forward);
  // The field of view spans the narrower side, so a tall phone screen shows
  // as much of the load as a wide one.
  const focal = (Math.min(canvasSize.width, canvasSize.height) / 2) / Math.tan((52 * Math.PI) / 360);
  const scale = focal / Math.max(depth, 0.05);
  return {
    x: canvasSize.width / 2 + dot(view, basis.right) * scale,
    y: canvasSize.height / 2 - dot(view, basis.up) * scale,
    depth,
  };
}

function boxColorIndex(placement, index, ratios) {
  if (state.display.colors === 'strength') {
    return { strong: 17, normal: 5, weak: 22, fragile: 0 }[placement.box.strength] ?? 5;
  }
  if (state.display.colors === 'load') return null;   // continuous, handled below
  return placement.box.color;
}

function loadColor(ratio) {
  const stepped = Math.min((Number.isFinite(ratio) ? ratio : 1) * 10, 10) / 10;
  const mix = (a, b, amount) => a.map((value, index) => value + (b[index] - value) * amount);
  const green = [38, 184, 77], yellow = [235, 194, 38], red = [217, 38, 38];
  const rgb = stepped <= 0.5 ? mix(green, yellow, stepped / 0.5) : mix(yellow, red, (stepped - 0.5) / 0.5);
  return rgb.map(Math.round);
}

function seededRandom(text) {
  let state = 2166136261;
  for (const character of text) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function orderPileLayout(boxes, pileWidth, heightLimit, gap, groupGap, sequenceIds = []) {
  const rank = new Map(sequenceIds.map((id, at) => [id, at]));
  const orders = new Map();
  for (const box of boxes) {
    if (!orders.has(box.orderId)) orders.set(box.orderId, []);
    orders.get(box.orderId).push(box);
  }
  const targets = new Map();
  let groupY = gap + 160;
  for (const orderBoxes of [...orders.values()].sort((a, b) => a[0].stop - b[0].stop || a[0].client.localeCompare(b[0].client))) {
    const byType = new Map();
    for (const box of orderBoxes) {
      const type = box.id.split('#')[0];
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(box);
    }
    const stacks = [];
    for (const sameType of byType.values()) {
      sameType.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      let at = 0;
      while (at < sameType.length) {
        const box = sameType[at];
        const count = Math.min(sameType.length - at, 4, Math.max(1, Math.floor(heightLimit / box.sizeMM[2])));
        stacks.push({ boxes: sameType.slice(at, at + count), turned: box.turnAllowed && (at / count) % 2 === 1 });
        at += count;
      }
    }
    let x = gap;
    let y = groupY;
    let rowDepth = 0;
    let bottom = groupY;
    for (const stack of stacks) {
      const box = stack.boxes[0];
      const width = stack.turned ? box.sizeMM[1] : box.sizeMM[0];
      const depth = stack.turned ? box.sizeMM[0] : box.sizeMM[1];
      if (x > gap && x + width > pileWidth) {
        x = gap;
        y += rowDepth + gap;
        rowDepth = 0;
      }
      let z = 0;
      for (const one of stack.boxes) {
        targets.set(one.id, new Placed(one, x, y, z, stack.turned));
        z += one.sizeMM[2];
      }
      x += width + gap;
      rowDepth = Math.max(rowDepth, depth);
      bottom = Math.max(bottom, y + depth);
    }
    groupY = bottom + groupGap;
  }
  return { targets, depth: groupY };
}

/** Warehouse staging before loading. Collections stay separate beside an
 * empty destination. Repeated identical cartons form fully-supported
 * columns; deterministic variation in turns, stack heights and spacing
 * keeps the scene natural without boxes jumping whenever the view redraws. */
function beforePlacementView() {
  const sourceField = selectedField();
  if (!sourceField) return null;
  const all = selectedBoxes();
  const selected = new Set(state.selectedOrderIds);
  const groups = state.library.collections.map((collection) => ({
    name: collection.name,
    boxes: all.filter((box) => collection.orders.some((order) => selected.has(order.id) && order.id === box.orderId)),
  })).filter((group) => group.boxes.length);
  if (!groups.length) return null;

  const gap = 140;
  const groupGap = 360;
  const pileWidth = Math.max(2200, Math.min(sourceField.sizeMM[1] * 0.7, 5200));
  const heightLimit = Math.max(900, Math.min(sourceField.sizeMM[2] * 0.75, 1900));
  const placements = [];
  const labels = [];
  let groupY = gap + 160;
  let sceneHeight = 0;

  for (const group of groups) {
    const random = seededRandom(`${group.name}:${group.boxes.map((box) => box.id).join('|')}`);
    const byType = new Map();
    for (const box of group.boxes) {
      const type = box.id.split('#')[0];
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(box);
    }
    const columns = [];
    const types = [...byType.values()].sort((a, b) =>
      b[0].weightKg - a[0].weightKg
      || b[0].sizeMM[0] * b[0].sizeMM[1] - a[0].sizeMM[0] * a[0].sizeMM[1]);
    for (const sameType of types) {
      let at = 0;
      while (at < sameType.length) {
        const box = sameType[at];
        const physicalLimit = Math.max(1, Math.floor(heightLimit / box.sizeMM[2]));
        const naturalLimit = 2 + Math.floor(random() * 4);
        const count = Math.min(sameType.length - at, physicalLimit, naturalLimit);
        columns.push({ boxes: sameType.slice(at, at + count), turned: box.turnAllowed && random() > 0.52 });
        at += count;
      }
    }

    // Put the stacks on ground-level shelves. Positive random gaps make the
    // staging look informal while the shelf bounds guarantee no overlap.
    let x = gap + Math.round(random() * 100);
    let y = groupY;
    let rowDepth = 0;
    let groupBottom = groupY;
    for (const stack of columns) {
      const box = stack.boxes[0];
      const width = stack.turned ? box.sizeMM[1] : box.sizeMM[0];
      const depth = stack.turned ? box.sizeMM[0] : box.sizeMM[1];
      if (x > gap && x + width > pileWidth) {
        x = gap + Math.round(random() * 100);
        y += rowDepth + gap + Math.round(random() * 100);
        rowDepth = 0;
      }
      let z = 0;
      for (const one of stack.boxes) {
        placements.push(new Placed(one, x, y, z, stack.turned));
        z += one.sizeMM[2];
      }
      sceneHeight = Math.max(sceneHeight, z);
      x += width + gap + Math.round(random() * 140);
      rowDepth = Math.max(rowDepth, depth);
      groupBottom = Math.max(groupBottom, y + depth);
    }
    labels.push({ name: group.name, x: pileWidth / 2, y: groupY - 100 });
    groupY = groupBottom + groupGap;
  }

  const containerGap = 700;
  const container = {
    pos: [pileWidth + containerGap, gap, 0],
    size: [...sourceField.sizeMM],
    name: sourceField.name,
  };
  const sceneWidth = container.pos[0] + container.size[0] + gap;
  const orderPiles = orderPileLayout(all, pileWidth, heightLimit, gap, groupGap);
  const sceneDepth = Math.max(groupY, orderPiles.depth, container.pos[1] + container.size[1] + gap);

  return {
    field: {
      ...sourceField,
      type: 'surface',
      sizeMM: [sceneWidth, sceneDepth, Math.max(sceneHeight + gap, container.size[2])],
    },
    container,
    pile: { pileWidth, heightLimit, gap, groupGap },
    placements,
    labels,
    groups: groups.length,
  };
}

const shade = (rgb, amount) => `rgb(${rgb.map((value) => Math.round(clamp(value * amount, 0, 255))).join(',')})`;

function drawScene() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  canvasSize = { width, height };
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  ctx.fillStyle = styles.getPropertyValue('--canvas').trim() || '#ccd4de';
  ctx.fillRect(0, 0, width, height);

  // Before and After deliberately share this composite warehouse scene.
  // Only the boxes move; the ground, destination and camera stay fixed.
  const staging = beforePlacementView();
  const field = staging?.field ?? state.run?.field ?? selectedField();
  if (!field) return;
  const basis = cameraBasis();
  const lineColor = styles.getPropertyValue('--canvas-line').trim() || '#7a8b9c';
  const accent = styles.getPropertyValue('--accent').trim() || '#0b8f79';

  // Floor plate.
  const floor = [[0, 0], [field.sizeMM[0], 0], [field.sizeMM[0], field.sizeMM[1]], [0, field.sizeMM[1]]]
    .map(([x, y]) => project(scenePoint(field, x, y, 0), basis));
  if (floor.every((point) => point.depth > 0.05)) {
    ctx.beginPath();
    floor.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    const [r, g, b] = rgbOf(field.floorColor);
    ctx.fillStyle = staging ? `rgba(${r}, ${g}, ${b}, 0.18)` : `rgba(${r}, ${g}, ${b}, 0.85)`;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // In the staging view the large rectangle is warehouse floor; the real
  // destination remains empty beside the collection piles.
  if (staging) {
    const low = staging.container.pos;
    const high = low.map((value, axis) => value + staging.container.size[axis]);
    const destinationFloor = [
      [low[0], low[1]], [high[0], low[1]], [high[0], high[1]], [low[0], high[1]],
    ].map(([x, y]) => project(scenePoint(field, x, y, 1), basis));
    ctx.beginPath();
    destinationFloor.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    const [r, g, b] = rgbOf(selectedField().floorColor);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    strokeBoxEdges(field, low, high, basis, lineColor, 1.4);
  } else {
    // The space the load may use: the container, or a surface's stack limit.
    strokeBoxEdges(field, [0, 0, 0], [field.sizeMM[0], field.sizeMM[1], field.sizeMM[2]], basis, lineColor, 1);
  }

  const unloadFace = state.run?.unloadFace ?? unloadFaceFor(selectedMethod() ?? { unloadFrom: 'auto' }, field).face;
  if (!staging) drawUnloadArrow(field, unloadFace, basis, accent);

  if (staging) {
    const sourceById = new Map(staging.placements.map((placement) => [placement.box.id, placement]));
    const destination = (placement) => new Placed(
      placement.box,
      staging.container.pos[0] + placement.x,
      staging.container.pos[1] + placement.y,
      placement.z,
      placement.turned,
    );
    const entries = [];
    const ratios = state.run && state.display.colors === 'load' ? loadRatiosAt(state.run, state.visible) : [];
    const removed = new Set((state.unload?.order ?? []).slice(0, state.unload?.removed ?? 0));
    const plannedById = new Map((state.run?.steps ?? []).map((entry, index) => [entry.placement.box.id, index]));

    if (state.viewMode === 'before' || !state.run) {
      staging.placements.forEach((placement, index) => entries.push({ placement, index, staged: true }));
    } else {
      // Boxes not yet loaded remain in their exact piles. Boxes the engine
      // could not place also remain outside after the run.
      for (const source of staging.placements) {
        const index = plannedById.get(source.box.id);
        if (index == null || (index >= state.visible && index !== state.motion?.index)) {
          entries.push({ placement: source, index: index ?? -1, staged: true });
        }
      }
      state.run.steps.forEach((entry, index) => {
        if (index >= state.visible || removed.has(index) || index === state.unload?.motion?.index) return;
        entries.push({ placement: destination(entry.placement), index, staged: false });
      });

      // Unloaded cartons remain visible in stable, order-specific piles.
      for (let at = 0; at < (state.unload?.removed ?? 0); at += 1) {
        const index = state.unload.order[at];
        const box = state.run.steps[index].placement.box;
        const target = state.unload.targets.get(box.id);
        if (target) entries.push({ placement: target, index, staged: true });
      }

      if (state.unload?.motion) {
        const { index, progress } = state.unload.motion;
        const entry = state.run.steps[index];
        const source = destination(entry.placement);
        const target = state.unload.targets.get(entry.placement.box.id);
        if (target) {
          const sourceX = source.x + source.lengthX / 2 - target.lengthX / 2;
          const sourceY = source.y + source.widthY / 2 - target.widthY / 2;
          const travel = (from, to) => from + (to - from) * progress;
          const lift = Math.sin(Math.PI * progress) * Math.max(350, entry.placement.height * 1.2);
          entries.push({
            placement: new Placed(
              source.box,
              travel(sourceX, target.x),
              travel(sourceY, target.y),
              travel(source.z, target.z) + lift,
              target.turned,
            ),
            index,
            staged: false,
            moving: true,
          });
        }
      }

      // The active carton follows a lifted arc from its pile to its exact
      // engine destination. Its destination orientation is used during the
      // carry, avoiding impossible twisting through neighbouring piles.
      if (state.motion && !state.unload) {
        const entry = state.run.steps[state.motion.index];
        const source = sourceById.get(entry.placement.box.id);
        if (entry && source) {
          const target = destination(entry.placement);
          const progress = state.motion.progress;
          const sourceX = source.x + source.lengthX / 2 - target.lengthX / 2;
          const sourceY = source.y + source.widthY / 2 - target.widthY / 2;
          const travel = (from, to) => from + (to - from) * progress;
          const lift = Math.sin(Math.PI * progress) * Math.max(350, entry.placement.height * 1.2);
          entries.push({
            placement: new Placed(
              target.box,
              travel(sourceX, target.x),
              travel(sourceY, target.y),
              travel(source.z, target.z) + lift,
              target.turned,
            ),
            index: state.motion.index,
            staged: false,
            moving: true,
          });
        }
      }
    }

    const drawable = entries.map((entry) => {
      const { placement } = entry;
      const center = scenePoint(field, placement.x + placement.lengthX / 2,
                                placement.y + placement.widthY / 2, placement.z + placement.height / 2);
      return { ...entry, distance: Math.hypot(...sub(center, basis.eye)) };
    }).sort((a, b) => b.distance - a.distance);
    for (const item of drawable) {
      const colorIndex = item.index >= 0
        ? boxColorIndex(item.placement, item.index, ratios)
        : item.placement.box.color;
      const color = state.display.colors === 'load' && item.index >= 0 && !item.staged
        ? loadColor(ratios[item.index] ?? 0)
        : rgbOf(colorIndex ?? item.placement.box.color);
      drawBox(field, item.placement, basis, color, {
        label: state.display.numbers === 'step' && item.index >= 0 ? item.index + 1 : item.placement.box.number,
        outline: item.moving ? accent : null,
        darkText: state.display.colors === 'load' && item.index >= 0 && !item.staged
          ? color.reduce((sum, value) => sum + value, 0) > 420
          : usesDarkText(colorIndex ?? item.placement.box.color),
      });
    }
    if (state.run && state.viewMode === 'after' && state.display.showsCenterOfGravity) {
      drawCenterOfGravity(field, basis, removed, staging.container.pos, state.run.field);
    }
    return;
  }

  if (!state.run) return;
  const removed = new Set((state.unload?.order ?? []).slice(0, state.unload?.removed ?? 0));
  const ratios = state.display.colors === 'load' ? loadRatiosAt(state.run, state.visible) : [];
  const blocked = state.unload ? new Set(blockedIndices(state.run.steps.map((entry) => entry.placement), state.run.unloadFace)) : new Set();

  const drawable = [];
  state.run.steps.forEach((entry, index) => {
    if (index >= state.visible || removed.has(index)) return;
    const placement = entry.placement;
    const center = scenePoint(field, placement.x + placement.lengthX / 2,
                              placement.y + placement.widthY / 2, placement.z + placement.height / 2);
    drawable.push({ index, placement, distance: Math.hypot(...sub(center, basis.eye)) });
  });
  drawable.sort((a, b) => b.distance - a.distance);

  for (const item of drawable) {
    const rgb = state.display.colors === 'load'
      ? loadColor(ratios[item.index] ?? 0)
      : rgbOf(boxColorIndex(item.placement, item.index, ratios));
    drawBox(field, item.placement, basis, rgb, {
      label: state.display.numbers === 'step' ? item.index + 1 : item.placement.box.number,
      outline: item.index === state.visible - 1 && !state.unload ? accent : (blocked.has(item.index) ? '#e0483a' : null),
      darkText: state.display.colors === 'load'
        ? loadColor(ratios[item.index] ?? 0).reduce((sum, value) => sum + value, 0) > 420
        : usesDarkText(boxColorIndex(item.placement, item.index, ratios)),
    });
  }

  // The next box waits as a ghost where it will go.
  const next = state.run.steps[state.visible];
  if (next && !state.unload) {
    const placement = next.placement;
    strokeBoxEdges(field, [placement.x, placement.y, placement.z],
                   [placement.x + placement.lengthX, placement.y + placement.widthY, placement.top],
                   basis, accent, 1.5, [6, 5]);
  }

  if (state.display.showsCenterOfGravity) drawCenterOfGravity(field, basis, removed);
}

function drawBox(field, placement, basis, rgb, { label, outline, darkText }) {
  // Corner bits: 1 = far x, 2 = far y, 4 = top.
  const scene = [];
  const screen = [];
  for (let index = 0; index < 8; index += 1) {
    const point = scenePoint(field,
      index & 1 ? placement.maxX : placement.x,
      index & 2 ? placement.maxY : placement.y,
      index & 4 ? placement.top : placement.z);
    scene.push(point);
    screen.push(project(point, basis));
  }
  if (screen.some((point) => point.depth <= 0.05)) return;
  // Outward normals in scene space (y up, planner +y is scene −z), with how
  // brightly each face catches the light.
  const faces = [
    { corners: [4, 5, 7, 6], normal: [0, 1, 0], shade: 1.0 },
    { corners: [0, 2, 3, 1], normal: [0, -1, 0], shade: 0.5 },
    { corners: [0, 1, 5, 4], normal: [0, 0, 1], shade: 0.86 },
    { corners: [2, 6, 7, 3], normal: [0, 0, -1], shade: 0.68 },
    { corners: [0, 4, 6, 2], normal: [-1, 0, 0], shade: 0.62 },
    { corners: [1, 3, 7, 5], normal: [1, 0, 0], shade: 0.78 },
  ];
  for (const face of faces) {
    const center = face.corners.reduce((sum, index) => [
      sum[0] + scene[index][0] / 4, sum[1] + scene[index][1] / 4, sum[2] + scene[index][2] / 4,
    ], [0, 0, 0]);
    // Only the faces turned toward the camera.
    if (dot(face.normal, sub(basis.eye, center)) <= 0) continue;
    const points = face.corners.map((index) => screen[index]);
    ctx.beginPath();
    points.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    ctx.fillStyle = shade(rgb, face.shade);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const area = Math.abs(polygonArea(points));
    if (area > 1400) {
      const middle = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
      // Canvas fonts take no CSS variables, so the family is spelled out.
      ctx.font = `700 ${clamp(Math.sqrt(area) / 3.1, 9, 32)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = darkText ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
      ctx.fillText(String(label), middle.x, middle.y);
    }
  }
  if (outline) {
    strokeBoxEdges(field, [placement.x, placement.y, placement.z],
                   [placement.maxX, placement.maxY, placement.top], basis, outline, 2);
  }
}

function polygonArea(points) {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[(index + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function strokeBoxEdges(field, low, high, basis, color, width, dash = null) {
  const corners = [];
  for (let index = 0; index < 8; index += 1) {
    corners.push(project(scenePoint(field,
      index & 1 ? high[0] : low[0], index & 2 ? high[1] : low[1], index & 4 ? high[2] : low[2]), basis));
  }
  if (corners.some((point) => point.depth <= 0.05)) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  for (let index = 0; index < 8; index += 1) {
    for (const bit of [1, 2, 4]) {
      if (index & bit) continue;
      ctx.moveTo(corners[index].x, corners[index].y);
      ctx.lineTo(corners[index | bit].x, corners[index | bit].y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawUnloadArrow(field, face, basis, color) {
  const [width, depth, height] = field.sizeMM;
  const gap = 140;
  const bases = {
    top: [width / 2, depth / 2, height + gap / 2],
    front: [width / 2, -gap, height * 0.3],
    back: [width / 2, depth + gap, height * 0.3],
    left: [-gap, depth / 2, height * 0.3],
    right: [width + gap, depth / 2, height * 0.3],
  };
  const tips = {
    top: [0, 0, gap], front: [0, -gap, 0], back: [0, gap, 0], left: [-gap, 0, 0], right: [gap, 0, 0],
  };
  const start = bases[face];
  const tip = start.map((value, index) => value + tips[face][index]);
  const a = project(scenePoint(field, start[0], start[1], start[2]), basis);
  const b = project(scenePoint(field, tip[0], tip[1], tip[2]), basis);
  if (a.depth <= 0.05 || b.depth <= 0.05) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - 11 * Math.cos(angle - 0.4), b.y - 11 * Math.sin(angle - 0.4));
  ctx.lineTo(b.x - 11 * Math.cos(angle + 0.4), b.y - 11 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The load's center of gravity, and the zone on the floor it should stay over. */
function drawCenterOfGravity(field, basis, removed, offset = [0, 0, 0], loadField = field) {
  const shown = state.run.steps.slice(0, state.visible)
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !removed.has(index))
    .map(({ entry }) => entry.placement);
  const weight = shown.reduce((sum, placement) => sum + placement.box.weightKg, 0);
  if (weight <= 0) return;
  const mean = (pick) => shown.reduce((sum, placement) => sum + placement.box.weightKg * pick(placement), 0) / weight;
  const localX = mean((placement) => placement.x + placement.lengthX / 2);
  const localY = mean((placement) => placement.y + placement.widthY / 2);
  const x = offset[0] + localX;
  const y = offset[1] + localY;
  const z = mean((placement) => placement.z + placement.height / 2);
  const limit = 0.15;
  const inside = Math.abs(localX - loadField.sizeMM[0] / 2) <= limit * loadField.sizeMM[0] / 2
    && Math.abs(localY - loadField.sizeMM[1] / 2) <= limit * loadField.sizeMM[1] / 2;
  const color = inside ? '#2fae6b' : '#e39b2f';

  const zone = [
    [offset[0] + loadField.sizeMM[0] * (0.5 - limit / 2), offset[1] + loadField.sizeMM[1] * (0.5 - limit / 2)],
    [offset[0] + loadField.sizeMM[0] * (0.5 + limit / 2), offset[1] + loadField.sizeMM[1] * (0.5 - limit / 2)],
    [offset[0] + loadField.sizeMM[0] * (0.5 + limit / 2), offset[1] + loadField.sizeMM[1] * (0.5 + limit / 2)],
    [offset[0] + loadField.sizeMM[0] * (0.5 - limit / 2), offset[1] + loadField.sizeMM[1] * (0.5 + limit / 2)],
  ].map(([zx, zy]) => project(scenePoint(field, zx, zy, 3), basis));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  zone.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  const top = project(scenePoint(field, x, y, z), basis);
  const foot = project(scenePoint(field, x, y, 3), basis);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(foot.x, foot.y);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(top.x, top.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------ camera work

const VIEWS = {
  top: [0, 1.5], front: [0, 0.21], back: [Math.PI, 0.21],
  left: [-Math.PI / 2, 0.21], right: [Math.PI / 2, 0.21], iso: [0.61, 0.52],
};

function frameField(keepAngles = false) {
  const field = beforePlacementView()?.field ?? state.run?.field ?? selectedField();
  if (!field) return;
  const radius = Math.hypot(...field.sizeMM) / 2000;
  state.camera.distance = Math.max(radius / Math.sin((52 * Math.PI) / 360) * 1.15, 0.5);
  state.camera.target = [0, (field.sizeMM[2] / 1000) * 0.3, 0];
  if (!keepAngles) [state.camera.yaw, state.camera.pitch] = VIEWS.iso;
}

function setView(name) {
  if (name === 'fit') {
    frameField(true);
  } else {
    [state.camera.yaw, state.camera.pitch] = VIEWS[name];
    frameField(true);
  }
  drawScene();
}

function bindCanvas() {
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1) {
      state.camera.yaw -= (event.clientX - previous[0]) * 0.008;
      // Never below the floor: the plan is always seen from above.
      state.camera.pitch = clamp(state.camera.pitch + (event.clientY - previous[1]) * 0.008, 0.09, 1.53);
      drawScene();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const spread = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) state.camera.distance = clamp(state.camera.distance * (pinch / spread), 0.4, 60);
      pinch = spread;
      drawScene();
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => {
      pointers.delete(event.pointerId);
      pinch = 0;
    });
  }
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.camera.distance = clamp(state.camera.distance * Math.exp(event.deltaY * 0.001), 0.4, 60);
    drawScene();
  }, { passive: false });
  new ResizeObserver(() => drawScene()).observe(canvas);
}

// ------------------------------------------------------------------ views

function render() {
  renderBar();
  renderRail();
  renderEditor();
  renderStage();
  renderSimulateBar();
  drawScene();
}

function renderBar() {
  $('language').textContent = state.language === 'ja' ? 'EN' : '日本語';
  $('brand-name').textContent = t('積み付けシミュレータ', 'Load planner');
  $('numbers-label').textContent = t('番号', 'Numbers');
  $('colors-label').textContent = t('色', 'Colors');
  $('units-label').textContent = t('単位', 'Units');
  $('speed-label').textContent = t('速さ', 'Speed');
  const options = {
    numbers: [['box', t('箱の番号', 'Box number')], ['step', t('置く順番', 'Step number')]],
    colors: [['order', t('注文ごと', 'By order')], ['strength', t('強さ', 'By strength')], ['load', t('かかる重さ', 'By load')]],
    units: [['mm', 'mm'], ['cm', 'cm']],
    speed: [['1', '1×'], ['2', '2×'], ['5', '5×'], ['10', '10×'], ['20', '20×']],
  };
  for (const [key, list] of Object.entries(options)) {
    const select = $(key);
    const current = key === 'speed' ? String(state.display.speed) : state.display[key === 'numbers' ? 'numbers' : key];
    select.replaceChildren(...list.map(([value, label]) => {
      const option = el('option', null, label);
      option.value = value;
      option.selected = value === current;
      return option;
    }));
  }
  $('cog').setAttribute('aria-pressed', String(state.display.showsCenterOfGravity));
  $('cog-label').textContent = t('重心', 'Center');
  $('animate-run').setAttribute('aria-pressed', String(state.display.animateRun === true));
  $('animate-run-label').textContent = t('実行時アニメ', 'Animate run');
  $('animate-run').title = t(
    'オンにすると、実行後に箱を順番に表示します',
    'When enabled, Run shows boxes being placed one by one',
  );
  $('file-label').textContent = t('ファイル', 'File');
}

function renderRail() {
  const orders = allOrders().length;
  const entries = [
    ['boxes', t('箱', 'Boxes'), t(`${state.library.collections.length} まとまり・${orders} 注文`,
                                 `${state.library.collections.length} collections · ${orders} orders`)],
    ['fields', t('置き場', 'Field'), t(`${state.library.fields.length} 件`, `${state.library.fields.length} fields`)],
    ['methods', t('置き方', 'Method'), t(`${state.library.methods.length} 件`, `${state.library.methods.length} methods`)],
  ];
  $('rail-title').textContent = t('作成', 'Create');
  for (const [kind, title, detail] of entries) {
    const button = $(`rail-${kind}`);
    button.querySelector('strong').textContent = title;
    button.querySelector('.rail-detail').textContent = detail;
    button.setAttribute('aria-expanded', String(state.editor?.kind === kind));
  }
}

function renderStage() {
  const field = state.run?.field ?? selectedField();
  const showingBefore = state.viewMode === 'before' && Boolean(beforePlacementView());
  const face = state.run?.unloadFace ?? (field ? unloadFaceFor(selectedMethod() ?? { unloadFrom: 'auto' }, field).face : 'top');
  $('field-chip').textContent = field
    ? `${field.name} · ${t(`${FACE_TITLE[face]()}から降ろす`, `Unload: ${FACE_TITLE[face]()}`)}`
    : t('置き場がありません', 'No field');
  const unplaced = state.run?.unplaced.length ?? 0;
  $('unplaced-chip').hidden = unplaced === 0;
  $('unplaced-chip').textContent = t(`${unplaced} 個 置けません`, `${unplaced} not placed`);

  const blocking = runIssues();
  const hint = $('stage-hint');
  hint.hidden = Boolean(state.run) || showingBefore;
  if (!state.run && !showingBefore) {
    hint.querySelector('span').textContent = blocking.length
      ? issueMessage(blocking[0])
      : (canRun() ? t('下のバーで選んで「実行」', 'Choose below, then Run')
                  : t('箱・置き場・置き方を選んでください', 'Choose boxes, a field and a method'));
  }

  const total = state.run?.steps.length ?? 0;
  $('playback').hidden = !state.run || state.viewMode === 'before';
  $('unload-caption').hidden = !state.unload;

  if (state.run) {
    $('play').textContent = state.playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', state.playing ? t('一時停止', 'Pause') : t('再生', 'Play'));
    const slider = $('step-slider');
    slider.max = String(Math.max(total, 1));
    slider.value = String(state.visible);
    $('step-count').textContent = state.unload
      ? `${state.unload.removed}/${state.unload.order.length}`
      : `${state.visible}/${total}`;
    $('replay').setAttribute('aria-label', state.unload ? t('荷下ろしをやめる', 'Stop unloading') : t('荷下ろしを再生', 'Replay unloading'));
    $('replay').textContent = state.unload ? '✕' : '↩';
  }
  if (state.run && state.unload) renderUnloadCaption();
}

function renderUnloadCaption() {
  const caption = $('unload-caption');
  const removed = state.unload.removed;
  caption.replaceChildren();
  if (removed === 0) {
    caption.append(el('span', null, t(`${FACE_TITLE[state.run.unloadFace]()}から降ろします`,
                                      `Unloading from the ${FACE_TITLE[state.run.unloadFace]().toLowerCase()}`)));
    return;
  }
  const placement = state.run.steps[state.unload.order[removed - 1]].placement;
  const aside = state.unload.movedAside[removed - 1];
  // By id, not number: two collections in one run can repeat numbers.
  const blocked = state.run.metrics.blockedBoxIDs.includes(placement.box.id);
  caption.append(el('span', null, t(`降ろし順 ${placement.box.stop} · ${placement.box.client} · #${placement.box.number}`,
                                    `Stop ${placement.box.stop} · ${placement.box.client} · #${placement.box.number}`)));
  if (aside) caption.append(el('b', 'aside', t('よけた', 'moved aside')));
  else if (blocked) caption.append(el('b', 'danger', t('塞がれていた', 'was blocked')));
}

function renderSimulateBar() {
  const boxes = selectedBoxes();
  $('boxes-label').textContent = t('箱', 'Boxes');
  $('field-label').textContent = t('置き場', 'Field');
  $('method-label').textContent = t('置き方', 'Method');
  $('boxes-value').textContent = t(`${state.selectedOrderIds.length} 注文・${boxes.length} 箱`,
                                   `${state.selectedOrderIds.length} orders · ${boxes.length}`);
  $('field-value').textContent = selectedField()?.name ?? t('なし', 'None');
  $('method-value').textContent = selectedMethod()?.name ?? t('なし', 'None');
  $('run-label').textContent = t('実行', 'Run');
  $('run').disabled = !canRun();
  $('view-before').textContent = t('積付前', 'Before');
  $('view-after').textContent = t('積付後', 'After');
  $('view-before').setAttribute('aria-pressed', String(state.viewMode === 'before'));
  $('view-after').setAttribute('aria-pressed', String(state.viewMode === 'after'));
  $('view-after').disabled = !state.run;

  const boxesMenu = $('boxes-menu');
  boxesMenu.replaceChildren();
  for (const collection of state.library.collections) {
    boxesMenu.append(el('h4', null, collection.name));
    const ids = collection.orders.map((order) => order.id);
    const allChosen = ids.length > 0 && ids.every((id) => state.selectedOrderIds.includes(id));
    const toggleAll = el('button', 'option');
    toggleAll.append(el('span', 'link', allChosen ? t('すべて外す', 'Clear all') : t('すべて選ぶ', 'Choose all')));
    toggleAll.addEventListener('click', () => {
      state.selectedOrderIds = allChosen
        ? state.selectedOrderIds.filter((id) => !ids.includes(id))
        : [...new Set([...state.selectedOrderIds, ...ids])];
      clearRun();
      save();
      render();
    });
    boxesMenu.append(toggleAll);
    for (const order of collection.orders) {
      const chosen = state.selectedOrderIds.includes(order.id);
      const option = el('button', 'option');
      option.setAttribute('role', 'menuitemcheckbox');
      option.setAttribute('aria-checked', String(chosen));
      const swatch = el('span', 'swatch');
      swatch.style.background = PALETTE[order.color % PALETTE.length];
      option.append(el('span', null, chosen ? '☑' : '☐'), swatch,
                    el('span', null, order.client),
                    el('span', 'meta', t(`降ろし順 ${order.stop} · ${boxCountOf(order)} 箱`,
                                         `stop ${order.stop} · ${boxCountOf(order)}`)));
      option.addEventListener('click', () => {
        state.selectedOrderIds = chosen
          ? state.selectedOrderIds.filter((id) => id !== order.id)
          : [...state.selectedOrderIds, order.id];
        clearRun();
        save();
        render();
      });
      boxesMenu.append(option);
    }
  }

  fillChoiceMenu($('field-menu'), state.library.fields, state.selectedFieldId, (field) => {
    state.selectedFieldId = field.id;
    clearRun();
    frameField();
    save();
    render();
    $('field-picker').open = false;
  }, (field) => `${field.type === 'surface' ? t('平面', 'Surface') : t('コンテナ', 'Container')} · ${sizeText(field.sizeMM)}`);

  fillChoiceMenu($('method-menu'), state.library.methods, state.selectedMethodId, (method) => {
    state.selectedMethodId = method.id;
    clearRun();
    save();
    render();
    $('method-picker').open = false;
  }, (method) => `${method.unloadRule === 'strict' ? t('必ず守る', 'Strict') : t('優先する', 'Preferred')}`);
}

function fillChoiceMenu(menu, items, selectedId, onPick, detail) {
  menu.replaceChildren();
  for (const item of items) {
    const option = el('button', 'option');
    option.setAttribute('role', 'menuitemradio');
    option.setAttribute('aria-selected', String(item.id === selectedId));
    option.append(el('span', null, item.id === selectedId ? '●' : '○'), el('span', null, item.name),
                  el('span', 'meta', detail(item)));
    option.addEventListener('click', () => onPick(item));
    menu.append(option);
  }
}

// ---------------------------------------------------------------- editors

function openEditor(kind) {
  state.editor = state.editor?.kind === kind ? null : { kind };
  render();
}

function renderEditor() {
  const panel = $('editor');
  const workspace = $('workspace');
  panel.hidden = !state.editor;
  workspace.classList.toggle('with-editor', Boolean(state.editor));
  if (!state.editor) return;

  const titles = {
    boxes: t('箱の作成', 'Box creation'),
    fields: t('置き場の作成', 'Field creation'),
    methods: t('置き方', 'Placement method'),
  };
  const body = $('editor-body');
  body.replaceChildren();
  const path = state.editor;
  const backTo = (patch) => () => {
    state.editor = { ...path, ...patch };
    render();
  };

  if (path.kind === 'boxes' && path.boxId) {
    $('editor-title').textContent = `#${findBox(path.boxId)?.item.number ?? ''}`;
    $('editor-back').hidden = false;
    $('editor-back').onclick = backTo({ boxId: null });
    renderBoxForm(body, path.boxId);
  } else if (path.kind === 'boxes' && path.orderId) {
    $('editor-title').textContent = findOrder(path.orderId)?.order.client ?? '';
    $('editor-back').hidden = false;
    $('editor-back').onclick = backTo({ orderId: null });
    renderOrderForm(body, path.orderId);
  } else if (path.kind === 'fields' && path.fieldId) {
    $('editor-title').textContent = state.library.fields.find((field) => field.id === path.fieldId)?.name ?? '';
    $('editor-back').hidden = false;
    $('editor-back').onclick = backTo({ fieldId: null });
    renderFieldForm(body, path.fieldId);
  } else if (path.kind === 'methods' && path.methodId) {
    $('editor-title').textContent = state.library.methods.find((method) => method.id === path.methodId)?.name ?? '';
    $('editor-back').hidden = false;
    $('editor-back').onclick = backTo({ methodId: null });
    renderMethodForm(body, path.methodId);
  } else {
    $('editor-title').textContent = titles[path.kind];
    $('editor-back').hidden = true;
    if (path.kind === 'boxes') renderBoxLibrary(body);
    if (path.kind === 'fields') renderFieldLibrary(body);
    if (path.kind === 'methods') renderMethodLibrary(body);
  }
}

const findOrder = (orderId) => {
  for (const collection of state.library.collections) {
    const order = collection.orders.find((entry) => entry.id === orderId);
    if (order) return { collection, order };
  }
  return null;
};

const findBox = (boxId) => {
  for (const collection of state.library.collections) {
    for (const order of collection.orders) {
      const item = order.boxes.find((entry) => entry.id === boxId);
      if (item) return { collection, order, item };
    }
  }
  return null;
};

function group(parent, title) {
  const box = el('div', 'group');
  if (title) box.append(el('h3', null, title));
  parent.append(box);
  return box;
}

function textRow(parent, label, value, onChange) {
  const row = el('div', 'row');
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.id = `field-${Math.random().toString(36).slice(2, 8)}`;
  const tag = el('label', null, label);
  tag.htmlFor = input.id;
  input.addEventListener('change', () => onChange(input.value));
  row.append(tag, input);
  parent.append(row);
  return input;
}

function numberRow(parent, label, value, onChange, { unit = '', min, max, step = 1 } = {}) {
  const row = el('div', 'row');
  const input = el('input');
  input.type = 'number';
  input.value = String(value);
  input.step = String(step);
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  input.id = `field-${Math.random().toString(36).slice(2, 8)}`;
  const tag = el('label', null, label);
  tag.htmlFor = input.id;
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  row.append(tag, input);
  if (unit) row.append(el('span', 'unit', unit));
  parent.append(row);
  return input;
}

function lengthRow(parent, label, millimetres, onChange) {
  const factor = state.display.units === 'mm' ? 1 : 0.1;
  return numberRow(parent, label, Math.round(millimetres * factor * 10) / 10,
                   (value) => onChange(Math.round(value / factor)),
                   { unit: state.display.units, step: state.display.units === 'mm' ? 10 : 1 });
}

function palette(parent, selected, onPick) {
  const grid = el('div', 'palette');
  PALETTE.forEach((color, index) => {
    const button = el('button');
    button.type = 'button';
    button.style.background = color;
    button.setAttribute('aria-pressed', String(index === selected));
    button.setAttribute('aria-label', t(`色 ${index + 1}`, `Color ${index + 1}`));
    if (index === selected) button.textContent = '✓';
    button.style.color = usesDarkText(index) ? '#000' : '#fff';
    button.addEventListener('click', () => onPick(index));
    grid.append(button);
  });
  parent.append(grid);
}

function issueList(parent, issues) {
  for (const issue of issues) {
    const row = el('div', 'issue');
    row.append(el('span', null, '⚠'), el('span', null, issueMessage(issue)));
    parent.append(row);
  }
}

function actionButton(parent, label, onClick, className = 'link') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  parent.append(button);
  return button;
}

function renderBoxLibrary(body) {
  const maker = group(body, t('ランダム', 'Random'));
  numberRow(maker, t('注文の数', 'Orders'), state.recipe.orders, (value) => {
    state.recipe.orders = Math.round(value);
    render();
  }, { min: RECIPE_RANGES.orders[0], max: RECIPE_RANGES.orders[1] });
  numberRow(maker, t('1注文の箱数', 'Boxes per order'), state.recipe.boxesPerOrder, (value) => {
    state.recipe.boxesPerOrder = Math.round(value);
    render();
  }, { min: RECIPE_RANGES.boxesPerOrder[0], max: RECIPE_RANGES.boxesPerOrder[1] });
  const seedRow = el('div', 'row');
  const seedInput = el('input');
  seedInput.type = 'number';
  seedInput.min = String(RECIPE_RANGES.seed[0]);
  seedInput.max = String(RECIPE_RANGES.seed[1]);
  seedInput.value = String(state.recipe.seed);
  seedInput.id = 'recipe-seed';
  const seedLabel = el('label', null, t('種', 'Seed'));
  seedLabel.htmlFor = seedInput.id;
  seedInput.addEventListener('change', () => {
    const parsed = Number(seedInput.value);
    if (Number.isFinite(parsed)) state.recipe.seed = Math.round(parsed);
  });
  const roll = el('button', 'tool', '🎲');
  roll.type = 'button';
  roll.setAttribute('aria-label', t('種を変える', 'New seed'));
  roll.addEventListener('click', () => {
    state.recipe.seed = RECIPE_RANGES.seed[0] + Math.floor(Math.random() * RECIPE_RANGES.seed[1]);
    render();
  });
  seedRow.append(seedLabel, seedInput, roll);
  maker.append(seedRow);
  actionButton(maker, t('ランダムに作る', 'Make a random collection'), () => {
    const collection = randomCollection(state.recipe, null, state.language);
    // At the top, right under the maker, so what you just made is in sight.
    state.library.collections.unshift(collection);
    // Chosen straight away, so a method can be tried on it at once.
    state.selectedOrderIds = collection.orders.map((order) => order.id);
    clearRun();
    save();
    render();
  });
  maker.append(el('p', 'hint-text', t('同じ種なら同じ箱ができます。作ったまとまりはそのまま実行できます。',
                                      'The same seed always makes the same boxes. The new collection is chosen for the next run.')));

  for (const collection of state.library.collections) {
    const section = group(body, t('まとまり', 'Collection'));
    textRow(section, t('名前', 'Name'), collection.name, (value) => {
      collection.name = value;
      libraryChanged();
    });
    for (const order of collection.orders) {
      const item = el('button', 'list-item');
      const swatch = el('span', 'swatch');
      swatch.style.background = PALETTE[order.color % PALETTE.length];
      const text = el('div');
      text.append(el('div', null, order.client),
                  el('div', 'meta', t(`降ろし順 ${order.stop} · ${boxCountOf(order)} 箱`,
                                      `Stop ${order.stop} · ${boxCountOf(order)} boxes`)));
      item.append(swatch, text);
      item.addEventListener('click', () => {
        state.editor = { kind: 'boxes', orderId: order.id };
        render();
      });
      section.append(item);
    }
    actionButton(section, t('＋ 注文を追加', '+ Add order'), () => {
      const stop = Math.min(Math.max(0, ...collection.orders.map((order) => order.stop)) + 1, LIMITS.orderStop[1]);
      const used = collection.orders.map((order) => order.color);
      const color = PALETTE.findIndex((_, index) => !used.includes(index));
      const number = Math.max(0, ...collection.orders.flatMap((order) => order.boxes.flatMap(numbersOf))) + 1;
      const order = {
        id: uid(), client: t(`顧客 ${collection.orders.length + 1}`, `Client ${collection.orders.length + 1}`),
        stop, color: color < 0 ? 0 : color,
        boxes: [{ id: uid(), number, sizeMM: [400, 300, 250], weightKg: 5, quantity: 1, color: null, strength: null, turnAllowed: true }],
      };
      collection.orders.push(order);
      state.selectedOrderIds = [...state.selectedOrderIds, order.id];
      libraryChanged();
    });
    actionButton(section, t('このまとまりを削除', 'Delete this collection'), () => {
      state.library.collections = state.library.collections.filter((entry) => entry.id !== collection.id);
      libraryChanged();
    }, 'link danger');
  }
  const add = group(body);
  actionButton(add, t('＋ まとまりを追加', '+ Add collection'), () => {
    state.library.collections.push({
      id: uid(),
      name: t(`まとまり ${state.library.collections.length + 1}`, `Collection ${state.library.collections.length + 1}`),
      orders: [],
    });
    libraryChanged();
  });
  add.append(el('p', 'hint-text', t('まとまりは1回分の荷物(例:トラック1台分)です。注文ごとに色と降ろし順を決めます。',
                                    'A collection is one load, such as one truck run. Each order has its own color and unload stop.')));
}

function renderOrderForm(body, orderId) {
  const found = findOrder(orderId);
  if (!found) return;
  const { collection, order } = found;
  const details = group(body);
  textRow(details, t('顧客名', 'Client'), order.client, (value) => {
    order.client = value;
    libraryChanged();
  });
  numberRow(details, t('降ろし順', 'Unload stop'), order.stop, (value) => {
    order.stop = Math.round(value);
    libraryChanged();
  }, { min: LIMITS.orderStop[0], max: LIMITS.orderStop[1] });
  details.append(el('p', 'hint-text', t('1 がいちばん先に降ろす注文です。', 'Stop 1 is unloaded first.')));

  const colors = group(body, t('色', 'Color'));
  palette(colors, order.color, (index) => {
    order.color = index;
    libraryChanged();
  });

  const boxes = group(body, t('箱', 'Boxes'));
  for (const item of order.boxes) {
    const row = el('button', 'list-item');
    const swatch = el('span', 'swatch');
    swatch.style.background = PALETTE[(item.color ?? order.color) % PALETTE.length];
    const numbers = numbersOf(item);
    const text = el('div');
    text.append(el('div', null, numbers.length > 1 ? `#${numbers[0]}–${numbers[numbers.length - 1]}` : `#${item.number}`),
                el('div', 'meta', `${sizeText(item.sizeMM)} · ${kg(item.weightKg)} · ${STRENGTH_TITLE[resolvedStrength(item)]()}`));
    row.append(swatch, text);
    row.addEventListener('click', () => {
      state.editor = { kind: 'boxes', orderId, boxId: item.id };
      render();
    });
    boxes.append(row);
  }
  actionButton(boxes, t('＋ 箱を追加', '+ Add box'), () => {
    const last = order.boxes[order.boxes.length - 1];
    const number = Math.max(0, ...collection.orders.flatMap((entry) => entry.boxes.flatMap(numbersOf))) + 1;
    order.boxes.push({
      id: uid(), number, sizeMM: [...(last?.sizeMM ?? [400, 300, 250])], weightKg: last?.weightKg ?? 5,
      quantity: 1, color: null, strength: null, turnAllowed: true,
    });
    libraryChanged();
  });

  const problems = libraryIssues(state.library)
    .filter((issue) => issue.itemId === orderId || order.boxes.some((item) => item.id === issue.itemId));
  if (problems.length) issueList(group(body), problems);

  const remove = group(body);
  actionButton(remove, t('この注文を削除', 'Delete this order'), () => {
    collection.orders = collection.orders.filter((entry) => entry.id !== orderId);
    state.editor = { kind: 'boxes' };
    libraryChanged();
  }, 'link danger');
}

function renderBoxForm(body, boxId) {
  const found = findBox(boxId);
  if (!found) return;
  const { collection, order, item } = found;
  const numbers = numbersOf(item);

  const identity = group(body);
  numberRow(identity, t('番号', 'Number'), item.number, (value) => {
    item.number = Math.round(value);
    libraryChanged();
  }, { min: LIMITS.boxNumber[0], max: LIMITS.boxNumber[1] });
  numberRow(identity, t('数量', 'Quantity'), item.quantity, (value) => {
    item.quantity = Math.round(value);
    libraryChanged();
  }, { min: LIMITS.boxQuantity[0], max: LIMITS.boxQuantity[1] });
  identity.append(el('p', 'hint-text', numbers.length > 1
    ? t(`${numbers[0]}〜${numbers[numbers.length - 1]} の番号が1箱ずつ付きます。`,
        `The boxes are numbered ${numbers[0]} to ${numbers[numbers.length - 1]}.`)
    : t(`箱の各面に ${item.number} と書かれます。`, `Each face shows ${item.number}.`)));

  const size = group(body, t('大きさ', 'Size'));
  const labels = [t('長さ (x)', 'Length (x)'), t('幅 (y)', 'Width (y)'), t('高さ (z)', 'Height (z)')];
  labels.forEach((label, axis) => lengthRow(size, label, item.sizeMM[axis], (value) => {
    item.sizeMM[axis] = value;
    libraryChanged();
  }));
  size.append(el('p', 'hint-text', t('各辺 50〜2000 mm(最大 2 × 2 × 2 m)', 'Each side 50–2000 mm (at most 2 × 2 × 2 m)')));

  const weight = group(body, t('重さ', 'Weight'));
  numberRow(weight, t('重さ', 'Weight'), item.weightKg, (value) => {
    item.weightKg = value;
    libraryChanged();
  }, { unit: 'kg', step: 0.1, min: 0 });
  weight.append(el('p', 'hint-text',
    `${t('密度', 'Density')} ${Math.round(densityOf(item.sizeMM, item.weightKg))} kg/m³ · ${t('0.1〜50 kg', '0.1–50 kg')}`));

  const colors = group(body, t('色', 'Color'));
  const useOrderColor = el('div', 'row');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = item.color == null;
  toggle.id = `use-order-color-${item.id}`;
  const toggleLabel = el('label', null, t('注文の色を使う', "Use the order's color"));
  toggleLabel.htmlFor = toggle.id;
  toggle.addEventListener('change', () => {
    item.color = toggle.checked ? null : order.color;
    libraryChanged();
  });
  useOrderColor.append(toggleLabel, toggle);
  colors.append(useOrderColor);
  if (item.color != null) {
    palette(colors, item.color, (index) => {
      item.color = index;
      libraryChanged();
    });
  }

  const strength = group(body, t('強さ', 'Strength'));
  const row = el('div', 'row');
  const select = el('select');
  const automatic = automaticStrength(item.sizeMM, item.weightKg);
  const options = [
    ['', t(`自動(${STRENGTH_TITLE[automatic]()})`, `Automatic (${STRENGTH_TITLE[automatic]()})`)],
    ...Object.keys(STRENGTH_CAPACITY).map((key) => [key, STRENGTH_TITLE[key]()]),
  ];
  select.replaceChildren(...options.map(([value, label]) => {
    const option = el('option', null, label);
    option.value = value;
    option.selected = (item.strength ?? '') === value;
    return option;
  }));
  select.addEventListener('change', () => {
    item.strength = select.value || null;
    libraryChanged();
  });
  select.id = `strength-${item.id}`;
  const selectLabel = el('label', null, t('強さ', 'Strength'));
  selectLabel.htmlFor = select.id;
  row.append(selectLabel, select);
  strength.append(row);

  const turn = el('div', 'row');
  const turnBox = el('input');
  turnBox.type = 'checkbox';
  turnBox.checked = item.turnAllowed;
  turnBox.id = `turn-${item.id}`;
  const turnLabel = el('label', null, t('90° 回してよい', 'May turn 90°'));
  turnLabel.htmlFor = turnBox.id;
  turnBox.addEventListener('change', () => {
    item.turnAllowed = turnBox.checked;
    libraryChanged();
  });
  turn.append(turnLabel, turnBox);
  strength.append(turn);
  strength.append(el('p', 'hint-text',
    t('上に載せられる重さ = 強さ × 底面積。強い 2000・普通 800・弱い 200 kg/m²、壊れものは何も載せません。',
      'What a box can carry = strength × base area: strong 2000, normal 800, weak 200 kg/m²; nothing goes on a fragile box.')));

  const problems = [...boxIssues(item), ...libraryIssues(state.library).filter((issue) => issue.itemId === item.id && issue.kind === 'duplicateBoxNumber')];
  if (problems.length) issueList(group(body), problems);

  const remove = group(body);
  actionButton(remove, t('この箱を削除', 'Delete this box'), () => {
    order.boxes = order.boxes.filter((entry) => entry.id !== item.id);
    state.editor = { kind: 'boxes', orderId: order.id };
    libraryChanged();
  }, 'link danger');
}

function renderFieldLibrary(body) {
  const list = group(body);
  for (const field of state.library.fields) {
    const row = el('button', 'list-item');
    const swatch = el('span', 'swatch');
    swatch.style.background = PALETTE[field.floorColor % PALETTE.length];
    const text = el('div');
    text.append(el('div', null, field.name),
                el('div', 'meta', `${field.type === 'surface' ? t('平面', 'Surface') : t('コンテナ', 'Container')} · ${sizeText(field.sizeMM)}`));
    row.append(swatch, text);
    row.addEventListener('click', () => {
      state.editor = { kind: 'fields', fieldId: field.id };
      render();
    });
    list.append(row);
  }
  const add = group(body);
  const presets = [
    [t('JIS T11 パレット', 'JIS T11 pallet'), { type: 'surface', sizeMM: [1100, 1100, 1500], maxLoadKg: 1000, openFaces: [...FACES], floorColor: 11 }],
    [t('20ft コンテナ(内寸)', '20 ft container (inside)'), { type: 'container', sizeMM: [2352, 5898, 2393], maxLoadKg: 20000, openFaces: ['front'], floorColor: 16 }],
    [t('空の平面', 'Blank surface'), { type: 'surface', sizeMM: [1000, 1000, 1500], maxLoadKg: 500, openFaces: [...FACES], floorColor: 12 }],
    [t('空のコンテナ', 'Blank container'), { type: 'container', sizeMM: [2000, 4000, 2000], maxLoadKg: 2000, openFaces: ['front'], floorColor: 16 }],
  ];
  for (const [name, preset] of presets) {
    actionButton(add, `＋ ${name}`, () => {
      state.library.fields.push({ id: uid(), name, ...preset, sizeMM: [...preset.sizeMM], openFaces: [...preset.openFaces] });
      libraryChanged();
    });
  }
  add.append(el('p', 'hint-text', t('トラックの荷台やカゴ車は車種ごとに違うので、測った大きさで作ってください。',
                                    'Truck beds and roll cages vary by model, so measure yours and enter its size.')));
}

function renderFieldForm(body, fieldId) {
  const field = state.library.fields.find((entry) => entry.id === fieldId);
  if (!field) return;
  const details = group(body);
  textRow(details, t('名前', 'Name'), field.name, (value) => {
    field.name = value;
    libraryChanged();
  });
  const kindRow = el('div', 'row');
  const select = el('select');
  select.id = `kind-${field.id}`;
  select.replaceChildren(...[['surface', t('平面', '2D surface')], ['container', t('コンテナ', '3D container')]]
    .map(([value, label]) => {
      const option = el('option', null, label);
      option.value = value;
      option.selected = field.type === value;
      return option;
    }));
  select.addEventListener('change', () => {
    field.type = select.value;
    field.openFaces = field.type === 'surface' ? [...FACES] : ['front'];
    libraryChanged();
  });
  const kindLabel = el('label', null, t('種類', 'Type'));
  kindLabel.htmlFor = select.id;
  kindRow.append(kindLabel, select);
  details.append(kindRow);

  const size = group(body, t('大きさ', 'Size'));
  lengthRow(size, t('幅 (x)', 'Width (x)'), field.sizeMM[0], (value) => {
    field.sizeMM[0] = value;
    libraryChanged();
  });
  lengthRow(size, t('奥行き (y)', 'Depth (y)'), field.sizeMM[1], (value) => {
    field.sizeMM[1] = value;
    libraryChanged();
  });
  lengthRow(size, field.type === 'surface' ? t('積める高さ', 'Stack limit') : t('高さ (z)', 'Height (z)'),
            field.sizeMM[2], (value) => {
              field.sizeMM[2] = value;
              libraryChanged();
            });
  numberRow(size, t('最大荷重', 'Max load'), field.maxLoadKg, (value) => {
    field.maxLoadKg = value;
    libraryChanged();
  }, { unit: 'kg', step: 10, min: 0 });
  size.append(el('p', 'hint-text', t('床は各辺 100〜13000 mm、高さは 100〜3000 mm。',
                                     'Floor sides 100–13000 mm, height 100–3000 mm.')));

  const faces = group(body, t('取り出せる面', 'Open faces'));
  for (const face of FACES) {
    const row = el('div', 'row');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = field.openFaces.includes(face);
    checkbox.id = `face-${field.id}-${face}`;
    const label = el('label', null, FACE_TITLE[face]());
    label.htmlFor = checkbox.id;
    checkbox.addEventListener('change', () => {
      const chosen = new Set(field.openFaces);
      if (checkbox.checked) chosen.add(face); else chosen.delete(face);
      field.openFaces = FACES.filter((entry) => chosen.has(entry));
      libraryChanged();
    });
    row.append(label, checkbox);
    faces.append(row);
  }
  faces.append(el('p', 'hint-text', t('前は y = 0 の面です。底面からは取り出せません。',
                                      'Front is the y = 0 side. Nothing comes out through the bottom.')));

  const colors = group(body, t('床の色', 'Floor color'));
  palette(colors, field.floorColor, (index) => {
    field.floorColor = index;
    libraryChanged();
  });

  const problems = fieldIssues(field);
  if (problems.length) issueList(group(body), problems);

  const remove = group(body);
  actionButton(remove, t('この置き場を削除', 'Delete this field'), () => {
    state.library.fields = state.library.fields.filter((entry) => entry.id !== fieldId);
    state.editor = { kind: 'fields' };
    libraryChanged();
  }, 'link danger');
}

function renderMethodLibrary(body) {
  const list = group(body);
  for (const method of state.library.methods) {
    const row = el('button', 'list-item');
    const text = el('div');
    const weights = [method.weights.unload, method.weights.damage, method.weights.space, method.weights.grouping];
    text.append(el('div', null, method.name),
                el('div', 'meta', `${METHOD_PROFILES[method.profile]?.detail() ?? ''} · ${weights.join(' / ')}`));
    row.append(text);
    row.addEventListener('click', () => {
      state.editor = { kind: 'methods', methodId: method.id };
      render();
    });
    list.append(row);
  }
  const add = group(body);
  for (const [profile, preset] of Object.entries(METHOD_PROFILES)) {
    actionButton(add, `＋ ${preset.title()}`, () => {
      const method = { id: uid(), unloadFrom: 'front', unloadFaces: ['front'], loadingFrom: ['front'] };
      applyProfile(method, profile);
      state.library.methods.push(method);
      libraryChanged();
    });
  }
}

function renderMethodForm(body, methodId) {
  const method = state.library.methods.find((entry) => entry.id === methodId);
  if (!method) return;
  const details = group(body);
  const profileRow = el('div', 'row');
  const profileSelect = el('select');
  profileSelect.id = `profile-${method.id}`;
  profileSelect.replaceChildren(...Object.entries(METHOD_PROFILES).map(([value, preset]) => {
    const option = el('option', null, preset.title());
    option.value = value;
    option.selected = method.profile === value;
    return option;
  }));
  profileSelect.addEventListener('change', () => {
    applyProfile(method, profileSelect.value);
    libraryChanged();
  });
  const profileLabel = el('label', null, t('実運用プロファイル', 'Operating profile'));
  profileLabel.htmlFor = profileSelect.id;
  profileRow.append(profileLabel, profileSelect);
  details.append(profileRow, el('p', 'hint-text', METHOD_PROFILES[method.profile]?.detail() ?? ''));
  textRow(details, t('名前', 'Name'), method.name, (value) => {
    method.name = value;
    libraryChanged();
  });

  normalizeDirections(method);
  const directionChoices = (title, key) => {
    const section = group(body, title);
    for (const face of FACES) {
      const row = el('div', 'row');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.id = `${key}-${method.id}-${face}`;
      checkbox.checked = method[key].includes(face);
      const label = el('label', null, FACE_TITLE[face]());
      label.htmlFor = checkbox.id;
      checkbox.addEventListener('change', () => {
        const chosen = new Set(method[key]);
        if (checkbox.checked) chosen.add(face); else chosen.delete(face);
        if (!chosen.size) {
          checkbox.checked = true;
          return;
        }
        method[key] = FACES.filter((entry) => chosen.has(entry));
        if (key === 'unloadFaces') method.unloadFrom = method.unloadFaces[0];
        libraryChanged();
      });
      row.append(label, checkbox);
      section.append(row);
    }
    return section;
  };

  const loading = directionChoices(t('積み込み方向（複数選択可）', 'Loading access (choose one or more)'), 'loadingFrom');
  loading.append(el('p', 'hint-text', t(
    '選んだいずれかの面から実際に積める順番で、配置手順を作ります。',
    'Placement steps are sequenced so every box can be loaded through at least one selected face.',
  )));

  const unloading = directionChoices(t('荷下ろし方向（複数選択可）', 'Unloading access (choose one or more)'), 'unloadFaces');

  const ruleRow = el('div', 'row');
  const ruleSelect = el('select');
  ruleSelect.id = `rule-${method.id}`;
  ruleSelect.replaceChildren(...[['preferred', t('優先する', 'Preferred')], ['strict', t('必ず守る', 'Strict')]]
    .map(([value, label]) => {
      const option = el('option', null, label);
      option.value = value;
      option.selected = method.unloadRule === value;
      return option;
    }));
  ruleSelect.addEventListener('change', () => {
    method.unloadRule = ruleSelect.value;
    libraryChanged();
  });
  const ruleLabel = el('label', null, t('ルール', 'Rule'));
  ruleLabel.htmlFor = ruleSelect.id;
  ruleRow.append(ruleLabel, ruleSelect);
  unloading.append(ruleRow);
  unloading.append(el('p', 'hint-text',
    t('選んだ面のどれかから取り出せればアクセス可能です。「必ず守る」は全方向で荷下ろし順を妨げる位置を使いません。',
      'A box is accessible when any selected face works. Strict rejects positions that block the unload order through every selected face.')));

  const physical = group(body, t('現場の安全条件', 'Physical safety rules'));
  const rules = method.engineRules ?? METHOD_PROFILES.balanced.engineRules;
  physical.append(
    el('p', 'hint-text', t(
      `底面支持 ${rules.minSupportPct}%以上 · 重心を支持 · 同じ高さの隣接支持${rules.allowHeightGrowth ? ' · 上方空間を使用' : ' · 低い積み高さ'}`,
      `${rules.minSupportPct}% minimum base support · center supported · same-level restraint${rules.allowHeightGrowth ? ' · vertical space enabled' : ' · low-height envelope'}`,
    )),
  );

  const goals = group(body, t('目標の重み(0〜10)', 'Goal weights (0–10)'));
  const sliders = [
    ['unload', t('取り出しやすさ', 'Unload side'), t('先に降ろす注文を上や扉の近くに', 'Earlier stops on top or nearest the door')],
    ['damage', t('壊れにくさ', 'Damage'), t('強く重い箱を下に、限界の半分まで', 'Strong, heavy boxes low; loads under half capacity')],
    ['space', t('空間効率', 'Space'), t('低く、奥から、すき間なく', 'Low first, then deep, then snug')],
    ['grouping', t('注文ごとにまとめる', 'Group by order'), t('同じ注文の箱を触れ合わせる', 'Each box touches its own order')],
  ];
  for (const [key, title, detail] of sliders) {
    const row = el('div', 'slider-row');
    const label = el('span', null, title);
    const value = el('span', 'value', String(method.weights[key]));
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '10';
    slider.step = '1';
    slider.value = String(method.weights[key]);
    slider.setAttribute('aria-label', title);
    slider.addEventListener('input', () => {
      value.textContent = slider.value;
    });
    slider.addEventListener('change', () => {
      method.weights[key] = Number(slider.value);
      libraryChanged();
    });
    row.append(label, value, slider, el('span', 'hint-text', detail));
    goals.append(row);
  }
  goals.append(el('p', 'hint-text', t('安全の4つのチェックは常に守ります。重みは、安全な位置の中から選ぶときだけに使います。',
                                      'The four safety checks always hold. Weights only choose among safe positions.')));

  const remove = group(body);
  actionButton(remove, t('この置き方を削除', 'Delete this method'), () => {
    state.library.methods = state.library.methods.filter((entry) => entry.id !== methodId);
    state.editor = { kind: 'methods' };
    libraryChanged();
  }, 'link danger');
}

// ---------------------------------------------------------------- results

function showResults() {
  if (!state.run) return;
  const metrics = state.run.metrics;
  const body = $('results-body');
  body.replaceChildren();
  const row = (name, value, ok, note) => {
    const line = el('div', 'result-row');
    line.append(el('span', 'name', name), el('span', 'value', value));
    if (ok != null) line.append(el('span', `badge ${ok ? 'ok' : 'off'}`, ok ? 'OK' : '!'));
    if (note) line.append(el('span', 'note', note));
    body.append(line);
  };
  row(t('置けた箱', 'Placed'), `${metrics.placedCount} / ${metrics.selectedCount}`,
      metrics.placedCount === metrics.selectedCount);
  row(t('充填率', 'Fill'), percent(metrics.fillRatio), null,
      t('箱の体積 ÷(床面積 × 使った高さ)', 'Box volume ÷ (floor area × height used)'));
  row(t('いちばん重い負担', 'Worst load'),
      metrics.worstLoad ? `${percent(metrics.worstLoad.ratio)} · #${metrics.worstLoad.boxNumber}` : '0%',
      (metrics.worstLoad?.ratio ?? 0) <= 1,
      t('上にかかる重さ ÷ 耐えられる重さ', 'Load on top ÷ what the box can carry'));
  row(t('重心のずれ', 'Center of gravity'), percent(metrics.centerOfGravityOffset), metrics.centerOfGravityWithinLimit,
      t('中心からのずれ。15% 以内が目安。', 'Offset from the center; aim for 15% or less.'));
  row(t('荷下ろしで塞がれる箱', 'Blocked at unload'),
      metrics.blockedBoxNumbers.length ? `${metrics.blockedBoxNumbers.length} · ${metrics.blockedBoxNumbers.map((n) => `#${n}`).join(', ')}` : '0',
      metrics.blockedBoxNumbers.length === 0,
      t('後で降ろす箱が上や手前にある箱', "Boxes with a later stop's box in their way"));
  row(t('注文のまとまり', 'Group compactness'), metrics.groupCompactness.toFixed(2), null,
      t('1.00 = 注文ごとに1つのかたまり', '1.00 = each order is one solid block'));
  row(t('高さ', 'Height used'), length(metrics.heightUsedMM), metrics.heightUsedMM <= state.run.field.sizeMM[2]);
  row(t('合計の重さ', 'Total weight'), `${kg(metrics.totalWeightKg)} / ${kg(state.run.field.maxLoadKg)}`,
      metrics.totalWeightKg <= state.run.field.maxLoadKg);
  row(t('積む順番', 'Loading order'), SEQUENCE_TITLE[state.run.sequence]());
  row(t('降ろす面', 'Unload side'), FACE_TITLE[state.run.unloadFace]());

  if (state.run.unplaced.length) {
    body.append(el('h3', null, t('置けなかった箱', 'Not placed')));
    for (const entry of state.run.unplaced) {
      const line = el('div', 'result-row');
      line.append(el('span', 'name', `#${entry.box.number} · ${entry.box.client}`),
                  el('span', 'note', `${CHECK_TITLE[entry.failure.check]()}: ${failureMessage(entry.failure)}`));
      body.append(line);
    }
  }
  $('results-title').textContent = t('結果', 'Results');
  $('results-dialog').showModal();
}

// ------------------------------------------------------------------ files

function showText(title, text, filename) {
  $('text-title').textContent = title;
  $('text-area').value = text;
  // A download the page starts itself only works outside the artifact
  // viewer, so the button is built when it can actually save a file.
  $('text-download')?.remove();
  if (!window.claude) {
    const download = el('a', 'tool', t('ダウンロード', 'Download'));
    download.id = 'text-download';
    download.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    download.download = filename;
    $('text-actions').append(download);
  }
  $('text-copy').textContent = t('コピー', 'Copy');
  $('text-dialog').showModal();
}

function saveLibrary() {
  try {
    showText(t('ライブラリを保存', 'Save library'), serializeLibrary(state.library), 'vistella-library.json');
  } catch (error) {
    alert(error instanceof ExchangeError ? error.message : String(error));
  }
}

function exportPlan() {
  if (!state.run) return;
  showText(t('計画JSON', 'Plan JSON'), serializePlan(state.run), 'vistella-plan.json');
}

async function openLibraryFile(file) {
  try {
    const library = parseLibrary(await file.text());
    state.library = library;
    state.selectedOrderIds = library.collections[0]?.orders.map((order) => order.id) ?? [];
    state.selectedFieldId = library.fields[0]?.id ?? null;
    state.selectedMethodId = library.methods[0]?.id ?? null;
    clearRun();
    frameField();
    save();
    render();
  } catch (error) {
    alert(error instanceof ExchangeError
      ? error.message
      : t('このファイルは読み込めません。', "This file can't be read."));
  }
}

// ------------------------------------------------------------------- wiring

function bind() {
  $('language').addEventListener('click', () => {
    state.language = state.language === 'ja' ? 'en' : 'ja';
    document.documentElement.lang = state.language;
    save();
    render();
  });
  for (const key of ['numbers', 'colors', 'units', 'speed']) {
    $(key).addEventListener('change', (event) => {
      const value = event.target.value;
      if (key === 'speed') state.display.speed = Number(value);
      else state.display[key] = value;
      save();
      render();
    });
  }
  $('cog').addEventListener('click', () => {
    state.display.showsCenterOfGravity = !state.display.showsCenterOfGravity;
    save();
    render();
  });
  $('animate-run').addEventListener('click', () => {
    state.display.animateRun = !state.display.animateRun;
    save();
    render();
  });
  for (const kind of ['boxes', 'fields', 'methods']) {
    $(`rail-${kind}`).addEventListener('click', () => openEditor(kind));
  }
  $('editor-close').addEventListener('click', () => {
    state.editor = null;
    render();
  });
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }
  $('run').addEventListener('click', () => runPlan());
  $('view-before').addEventListener('click', () => {
    state.viewMode = 'before';
    state.playing = false;
    state.motion = null;
    state.unload = null;
    frameField(true);
    render();
  });
  $('view-after').addEventListener('click', () => {
    if (!state.run) return;
    state.viewMode = 'after';
    state.motion = null;
    frameField(true);
    render();
  });
  $('play').addEventListener('click', () => (state.playing ? pause() : play()));
  $('step-slider').addEventListener('input', (event) => {
    state.playing = false;
    state.motion = null;
    state.unload = null;
    state.visible = Number(event.target.value);
    render();
  });
  $('replay').addEventListener('click', () => (state.unload ? endUnloadReplay() : startUnloadReplay()));
  $('results-button').addEventListener('click', showResults);
  $('results-close').addEventListener('click', () => $('results-dialog').close());
  $('text-close').addEventListener('click', () => $('text-dialog').close());
  $('text-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('text-area').value);
      $('text-copy').textContent = t('コピーしました', 'Copied');
    } catch (error) {
      $('text-area').select();
    }
  });
  $('file-new').addEventListener('click', () => {
    if (!confirm(t('現在のライブラリを空にしますか?', 'Replace the current library with an empty one?'))) return;
    state.library = { schemaVersion: 1, collections: [], fields: [], methods: [] };
    state.selectedOrderIds = [];
    libraryChanged();
  });
  $('file-sample').addEventListener('click', () => {
    state.library = sampleLibrary(state.language);
    state.selectedOrderIds = state.library.collections[0].orders.map((order) => order.id);
    state.selectedFieldId = state.library.fields[0].id;
    state.selectedMethodId = state.library.methods[0].id;
    clearRun();
    frameField();
    save();
    render();
  });
  $('file-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    if (file) openLibraryFile(file);
    event.target.value = '';
  });
  $('file-save').addEventListener('click', saveLibrary);
  $('file-export').addEventListener('click', exportPlan);
  document.addEventListener('click', (event) => {
    for (const details of document.querySelectorAll('details.picker, details.menu')) {
      if (details.open && !details.contains(event.target)) details.open = false;
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.editor = null;
      render();
    }
  });
}

load();
// A link can open an editor straight away: #boxes, #fields or #methods.
const deepLink = location.hash.replace('#', '');
if (['boxes', 'fields', 'methods'].includes(deepLink)) state.editor = { kind: deepLink };
document.documentElement.lang = state.language;
bind();
bindCanvas();
frameField();
// Start with the selected field empty. Planning begins only when the user
// presses Run, which keeps the initial screen calm and makes that action
// explicit on both desktop and mobile.
render();
