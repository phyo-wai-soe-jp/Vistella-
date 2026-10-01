// planner.js — the 積み付け planner, ported from the iOS app's Swift
// (LoadPlanModel / LoadPlanChecks / LoadPlanner) so the same library and the
// same method produce the same plan in the browser and on the phone.
//
// Frame: origin at the field's front-left floor corner, x = width,
// y = depth from the front, z = up, everything in whole millimetres.
// No DOM here: app.js draws, this file decides.

export const PALETTE = [
  '#D92626', '#D97126', '#D9B526', '#9DD926', '#26D944', '#26D9BB', '#269DD9', '#2653D9', '#7126D9', '#D9269D',
  '#8B1D1D', '#8B4B1D', '#8B751D', '#668B1D', '#1D8B30', '#1D8B79', '#1D668B', '#1D398B', '#4B1D8B', '#8B1D66',
  '#EC7979', '#ECA979', '#ECD579', '#C6EC79', '#79EC8C', '#79ECD9', '#79C6EC', '#7996EC', '#A979EC', '#EC79C6',
];

export const LIMITS = {
  boxSideMM: [50, 2000],
  boxWeightKg: [0.1, 50],
  boxQuantity: [1, 999],
  boxNumber: [1, 9999],
  orderStop: [1, 99],
  fieldFloorSideMM: [100, 13000],
  fieldHeightMM: [100, 3000],
  goalWeight: [0, 10],
};

/** What one square metre of a box's base carries, in kg. */
export const STRENGTH_CAPACITY = { strong: 2000, normal: 800, weak: 200, fragile: 0 };
const STRENGTH_RANK = { strong: 3, normal: 2, weak: 1, fragile: 0 };
export const FACES = ['top', 'front', 'back', 'left', 'right'];
export const SEQUENCES = ['unloadOrder', 'unloadOrderLargestFirst', 'strongestFirst', 'largestFirst'];
const SEQUENCES_KEEPING_UNLOAD_ORDER = ['unloadOrder', 'unloadOrderLargestFirst'];

export const DEFAULT_RULES = { minimumSupportRatio: 0.8, centerOfGravityLimit: 0.15 };

export function rgbOf(index) {
  const hex = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function usesDarkText(index) {
  const linear = (channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
  const [red, green, blue] = rgbOf(index).map((value) => linear(value / 255));
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05);
}

/** The spec's "small, undense box" rule, used when Strength is left unset. */
export function automaticStrength(sizeMM, weightKg) {
  const volume = sizeMM[0] * sizeMM[1] * sizeMM[2];
  if (volume <= 0) return 'normal';
  const density = weightKg / (volume / 1e9);
  const smallBase = sizeMM[0] * sizeMM[1] < 200 * 200;
  return density < 100 && smallBase ? 'weak' : 'normal';
}

export function resolvedStrength(item) {
  return item.strength || automaticStrength(item.sizeMM, item.weightKg);
}

export function densityOf(sizeMM, weightKg) {
  const volume = sizeMM[0] * sizeMM[1] * sizeMM[2];
  return volume > 0 ? weightKg / (volume / 1e9) : 0;
}

/** The numbers a box row carries, capped so a bad value can't explode. */
export function numbersOf(item) {
  const count = Math.min(Math.max(item.quantity ?? 1, 0), LIMITS.boxQuantity[1]);
  return Array.from({ length: count }, (_, index) => item.number + index);
}

/** One physical box per copy, in library order, for the chosen orders. */
export function planBoxes(library, orderIds) {
  const chosen = new Set(orderIds);
  const boxes = [];
  for (const collection of library.collections) {
    for (const order of collection.orders) {
      if (!chosen.has(order.id)) continue;
      for (const item of order.boxes) {
        numbersOf(item).forEach((number, copy) => {
          boxes.push({
            id: `${item.id}#${copy}`,
            number,
            orderId: order.id,
            client: order.client,
            stop: order.stop,
            color: item.color ?? order.color,
            sizeMM: [...item.sizeMM],
            weightKg: item.weightKg,
            strength: resolvedStrength(item),
            turnAllowed: item.turnAllowed !== false,
            densityKgPerCubicMeter: densityOf(item.sizeMM, item.weightKg),
          });
        });
      }
    }
  }
  return boxes;
}

// ---------------------------------------------------------------- geometry

/** A box at its planned position; (x, y, z) is its front-left-bottom corner. */
export class Placed {
  constructor(box, x, y, z, turned) {
    this.box = box;
    this.x = x;
    this.y = y;
    this.z = z;
    this.turned = turned;
  }
  get lengthX() { return this.turned ? this.box.sizeMM[1] : this.box.sizeMM[0]; }
  get widthY() { return this.turned ? this.box.sizeMM[0] : this.box.sizeMM[1]; }
  get height() { return this.box.sizeMM[2]; }
  get maxX() { return this.x + this.lengthX; }
  get maxY() { return this.y + this.widthY; }
  get top() { return this.z + this.height; }
  get baseAreaMM2() { return this.lengthX * this.widthY; }
  /** What the box can carry on top, in kg: strength × base area. */
  get capacityKg() { return (STRENGTH_CAPACITY[this.box.strength] ?? 0) * this.baseAreaMM2 / 1e6; }
  overlaps(other) {
    return this.x < other.maxX && other.x < this.maxX
      && this.y < other.maxY && other.y < this.maxY
      && this.z < other.top && other.z < this.top;
  }
  moved(dx, dy) { return new Placed(this.box, this.x + dx, this.y + dy, this.z, this.turned); }
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Shared floor area of two boxes, 0 when they only touch. */
function sharedArea(a, b) {
  return overlap(a.x, a.maxX, b.x, b.maxX) * overlap(a.y, a.maxY, b.y, b.maxY);
}

export function loadRatio(loadKg, capacityKg) {
  if (capacityKg > 0) return loadKg / capacityKg;
  return loadKg > 0 ? Infinity : 0;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise, without collinear points. */
function hullOf(points) {
  const sorted = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()]
    .sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  if (sorted.length < 3) return sorted;
  const half = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function hullContains(hull, point) {
  if (hull.length < 3) return false;
  return hull.every((corner, index) => cross(corner, hull[(index + 1) % hull.length], point) >= 0);
}

/** Whether the candidate's center lies over what it rests on. */
function centerIsInside(candidate, contacts) {
  const corners = [];
  for (const rect of contacts) {
    corners.push([2 * rect.minX, 2 * rect.minY], [2 * rect.maxX, 2 * rect.minY],
                 [2 * rect.maxX, 2 * rect.maxY], [2 * rect.minX, 2 * rect.maxY]);
  }
  const center = [2 * candidate.x + candidate.lengthX, 2 * candidate.y + candidate.widthY];
  return hullContains(hullOf(corners), center);
}

// ------------------------------------------------------------------ stack

/** Boxes placed so far on one field, and the load each one carries. */
export class Stack {
  constructor(field, rules = DEFAULT_RULES) {
    this.field = field;
    this.rules = rules;
    this.placed = [];
    this.loadOnTopKg = [];
    this.totalWeightKg = 0;
    this.carriers = [];      // per placed box: [{ index, share }]
    this.topDownOrder = [];  // placed indices, highest bottom first
  }

  get heightUsedMM() { return this.placed.reduce((top, box) => Math.max(top, box.top), 0); }

  /** Where a box with this footprint comes to rest when lowered straight down. */
  restingZ(x, y, lengthX, widthY) {
    const footprint = { x, y, maxX: x + lengthX, maxY: y + widthY };
    let resting = 0;
    for (const box of this.placed) {
      if (sharedArea(box, footprint) > 0) resting = Math.max(resting, box.top);
    }
    return resting;
  }

  /** Placed boxes whose tops meet this candidate's base. */
  contacts(candidate) {
    if (candidate.z <= 0) return [];
    const found = [];
    this.placed.forEach((box, index) => {
      if (box.top !== candidate.z) return;
      const rect = {
        minX: Math.max(box.x, candidate.x), minY: Math.max(box.y, candidate.y),
        maxX: Math.min(box.maxX, candidate.maxX), maxY: Math.min(box.maxY, candidate.maxY),
      };
      if (rect.maxX > rect.minX && rect.maxY > rect.minY) {
        found.push({ index, rect, area: (rect.maxX - rect.minX) * (rect.maxY - rect.minY) });
      }
    });
    return found;
  }

  carriersFrom(contacts, candidate) {
    const total = contacts.reduce((sum, contact) => sum + contact.area, 0);
    if (candidate.z <= 0 || total <= 0) return [];
    return contacts.map((contact) => ({ index: contact.index, share: contact.area / total }));
  }

  /** How much more each placed box carries with `weightKg` added on `carriers`. */
  loadIncrease(weightKg, carriers) {
    const increase = new Array(this.placed.length).fill(0);
    for (const carrier of carriers) increase[carrier.index] += weightKg * carrier.share;
    for (const index of this.topDownOrder) {
      if (increase[index] <= 0) continue;
      for (const carrier of this.carriers[index]) increase[carrier.index] += increase[index] * carrier.share;
    }
    return increase;
  }

  /** The four checks, without placing anything. */
  evaluate(candidate) {
    const size = this.field.sizeMM;
    const totalWeightKg = this.totalWeightKg + candidate.box.weightKg;
    const stackHeightMM = Math.max(this.heightUsedMM, candidate.top);
    const refuse = (failure, supportRatio = 0, centered = false) => ({
      failure, supportRatio, centerInsideSupport: centered, worstLoad: null, stackHeightMM, totalWeightKg,
    });

    // 崩れにくいか
    if (candidate.x < 0 || candidate.y < 0 || candidate.z < 0 || candidate.maxX > size[0] || candidate.maxY > size[1]) {
      return refuse({ kind: 'outsideField', stage: 0, check: 'limits' });
    }
    if (candidate.top > size[2]) {
      return refuse({ kind: 'aboveHeightLimit', stage: 1, check: 'limits', topMM: candidate.top, limitMM: size[2] });
    }
    const hit = this.placed.find((box) => candidate.overlaps(box));
    if (hit) return refuse({ kind: 'overlaps', stage: 2, check: 'limits', boxNumber: hit.box.number });
    if (totalWeightKg > this.field.maxLoadKg + 1e-9) {
      return refuse({ kind: 'overMaxLoad', stage: 3, check: 'limits', totalKg: totalWeightKg, maxKg: this.field.maxLoadKg });
    }

    // 支えられるか
    const contacts = this.contacts(candidate);
    const contactArea = candidate.z === 0
      ? candidate.baseAreaMM2
      : contacts.reduce((sum, contact) => sum + contact.area, 0);
    const supportRatio = candidate.baseAreaMM2 > 0 ? contactArea / candidate.baseAreaMM2 : 0;
    if (contactArea < this.rules.minimumSupportRatio * candidate.baseAreaMM2 - 1e-6) {
      return refuse({ kind: 'weakSupport', stage: 4, check: 'support', ratio: supportRatio }, supportRatio);
    }

    // 重さが偏らないか
    const centered = candidate.z === 0 || centerIsInside(candidate, contacts.map((contact) => contact.rect));
    if (!centered) return refuse({ kind: 'offBalance', stage: 5, check: 'balance' }, supportRatio);

    // 下の箱が耐えられるか
    const increase = this.loadIncrease(candidate.box.weightKg, this.carriersFrom(contacts, candidate));
    let worst = null;
    this.placed.forEach((box, index) => {
      const load = this.loadOnTopKg[index] + increase[index];
      if (load <= 0) return;
      const reading = { boxID: box.box.id, boxNumber: box.box.number, loadKg: load, capacityKg: box.capacityKg };
      reading.ratio = loadRatio(reading.loadKg, reading.capacityKg);
      if (!worst || reading.ratio > worst.ratio) worst = reading;
    });
    if (worst && worst.loadKg > worst.capacityKg * (1 + 1e-9) + 1e-9) {
      return {
        failure: {
          kind: 'overload', stage: 6, check: 'load',
          boxNumber: worst.boxNumber, loadKg: worst.loadKg, capacityKg: worst.capacityKg,
        },
        supportRatio, centerInsideSupport: true, worstLoad: worst, stackHeightMM, totalWeightKg,
      };
    }
    return { failure: null, supportRatio, centerInsideSupport: true, worstLoad: worst, stackHeightMM, totalWeightKg };
  }

  /** Places a candidate that passes every check. */
  place(candidate) {
    const evaluation = this.evaluate(candidate);
    if (evaluation.failure) return evaluation;
    const carriers = this.carriersFrom(this.contacts(candidate), candidate);
    const increase = this.loadIncrease(candidate.box.weightKg, carriers);
    for (let index = 0; index < this.placed.length; index += 1) this.loadOnTopKg[index] += increase[index];

    const newIndex = this.placed.length;
    this.placed.push(candidate);
    this.loadOnTopKg.push(0);
    this.carriers.push(carriers);
    this.totalWeightKg += candidate.box.weightKg;
    const slot = this.topDownOrder.findIndex((index) => this.placed[index].z < candidate.z);
    this.topDownOrder.splice(slot < 0 ? this.topDownOrder.length : slot, 0, newIndex);
    return evaluation;
  }
}

// ---------------------------------------------------------------- planner

/** Whether `p` is in `q`'s way when q is taken out from `face`. */
export function isInTheWay(p, q, face) {
  const footprintsOverlap = p.x < q.maxX && q.x < p.maxX && p.y < q.maxY && q.y < p.maxY;
  if (footprintsOverlap && p.z >= q.top) return true;
  const heightsOverlap = p.z < q.top && q.z < p.top;
  const acrossX = p.x < q.maxX && q.x < p.maxX;
  const acrossY = p.y < q.maxY && q.y < p.maxY;
  switch (face) {
    case 'top': return false;
    case 'front': return heightsOverlap && acrossX && p.maxY <= q.y;
    case 'back': return heightsOverlap && acrossX && p.y >= q.maxY;
    case 'left': return heightsOverlap && acrossY && p.maxX <= q.x;
    default: return heightsOverlap && acrossY && p.x >= q.maxX;
  }
}

/** Placed boxes a later stop's box stands in the way of, by index. */
export function blockedIndices(placements, face) {
  return placements
    .map((_, index) => index)
    .filter((index) => placements.some((other) => other.box.stop > placements[index].box.stop
      && isInTheWay(other, placements[index], face)));
}

/**
 * The order boxes come out when unloading from `face`. Only a box with
 * nothing left in its way can come off, so nothing is ever pulled from under
 * another box; among those, the earliest stop goes first. A later stop's box
 * comes off early exactly when it stands in the way of one that goes before
 * it — the worker moves it aside (`movedAside`).
 */
export function unloadOrder(placements, face) {
  const comesFirst = (a, b) => {
    const p = placements[a], q = placements[b];
    switch (face) {
      case 'front': if (p.y !== q.y) return p.y - q.y; break;
      case 'back': if (p.maxY !== q.maxY) return q.maxY - p.maxY; break;
      case 'left': if (p.x !== q.x) return p.x - q.x; break;
      case 'right': if (p.maxX !== q.maxX) return q.maxX - p.maxX; break;
      default: break;
    }
    if (p.top !== q.top) return q.top - p.top;
    return b - a;
  };
  let remaining = placements.map((_, index) => index);
  const order = [];
  while (remaining.length) {
    const free = remaining.filter((index) => !remaining.some((other) => other !== index
      && isInTheWay(placements[other], placements[index], face)));
    // "In the way" never forms a cycle, so something is always free; the
    // fallback only keeps a surprising geometry from looping.
    const choices = free.length ? free : remaining;
    const stop = Math.min(...choices.map((index) => placements[index].box.stop));
    const next = choices.filter((index) => placements[index].box.stop === stop).sort(comesFirst)[0];
    order.push(next);
    remaining = remaining.filter((index) => index !== next);
  }
  return order;
}

/**
 * For each step of `unloadOrder`, whether that box comes off before its own
 * stop's turn because it stood in the way of an earlier one.
 */
export function movedAside(order, placements) {
  const remaining = new Set(placements.map((_, index) => index));
  return order.map((index) => {
    remaining.delete(index);
    const stops = [...remaining].map((other) => placements[other].box.stop);
    const earliest = stops.length ? Math.min(...stops) : placements[index].box.stop;
    return placements[index].box.stop > earliest;
  });
}

/** The face a run on `field` unloads from, and whether the method's own choice was closed. */
export function unloadFaceFor(method, field) {
  const open = field.openFaces?.length ? field.openFaces : ['top'];
  const fallback = FACES.find((face) => open.includes(face)) ?? 'top';
  const selected = method.unloadFaces?.find((face) => open.includes(face));
  if (selected) return { face: selected, fellBack: false };
  if (!method.unloadFrom || method.unloadFrom === 'auto') return { face: fallback, fellBack: false };
  return open.includes(method.unloadFrom)
    ? { face: method.unloadFrom, fellBack: false }
    : { face: fallback, fellBack: true };
}

function weighted(goals, weights) {
  const unload = Math.max(weights.unload, 0), damage = Math.max(weights.damage, 0);
  const space = Math.max(weights.space, 0), grouping = Math.max(weights.grouping, 0);
  const total = unload + damage + space + grouping;
  if (total <= 0) return (goals.unload + goals.damage + goals.space + goals.grouping) / 4;
  return (unload * goals.unload + damage * goals.damage + space * goals.space + grouping * goals.grouping) / total;
}

export function orderedBoxes(boxes, sequence) {
  const rank = new Map();
  for (const box of boxes) if (!rank.has(box.orderId)) rank.set(box.orderId, rank.size);
  const baseArea = (box) => box.sizeMM[0] * box.sizeMM[1];
  const stopKey = (a, b) => {
    if (a.stop !== b.stop) return b.stop - a.stop;
    const rankA = rank.get(a.orderId), rankB = rank.get(b.orderId);
    return rankA !== rankB ? rankA - rankB : null;
  };
  const strengthKey = (a, b) => {
    if (STRENGTH_RANK[a.strength] !== STRENGTH_RANK[b.strength]) return STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength];
    if (a.weightKg !== b.weightKg) return b.weightKg - a.weightKg;
    return baseArea(a) !== baseArea(b) ? baseArea(b) - baseArea(a) : null;
  };
  const sizeKey = (a, b) => {
    if (baseArea(a) !== baseArea(b)) return baseArea(b) - baseArea(a);
    if (a.sizeMM[2] !== b.sizeMM[2]) return b.sizeMM[2] - a.sizeMM[2];
    return a.weightKg !== b.weightKg ? b.weightKg - a.weightKg : null;
  };
  const keys = {
    unloadOrder: [stopKey, strengthKey],
    unloadOrderLargestFirst: [stopKey, sizeKey],
    strongestFirst: [strengthKey, stopKey],
    largestFirst: [sizeKey, stopKey],
  }[sequence];
  return [...boxes].sort((a, b) => {
    for (const key of keys) {
      const result = key(a, b);
      if (result !== null && result !== 0) return result;
    }
    return a.number !== b.number ? a.number - b.number : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export function metricsFor(placements, loadOnTopKg, selectedCount, field, face, rules = DEFAULT_RULES) {
  const size = field.sizeMM;
  const heightUsedMM = placements.reduce((top, box) => Math.max(top, box.top), 0);
  const volume = placements.reduce((sum, box) => sum + box.lengthX * box.widthY * box.height, 0);
  const usedSpace = size[0] * size[1] * heightUsedMM;
  const totalWeightKg = placements.reduce((sum, box) => sum + box.box.weightKg, 0);

  let worstLoad = null;
  placements.forEach((box, index) => {
    const load = loadOnTopKg[index];
    if (load <= 0) return;
    const reading = { boxID: box.box.id, boxNumber: box.box.number, loadKg: load, capacityKg: box.capacityKg };
    reading.ratio = loadRatio(reading.loadKg, reading.capacityKg);
    if (!worstLoad || reading.ratio > worstLoad.ratio) worstLoad = reading;
  });

  let centerOfGravityMM = null;
  let centerOfGravityOffset = 0;
  if (totalWeightKg > 0) {
    const mean = (pick) => placements.reduce((sum, box) => sum + box.box.weightKg * pick(box), 0) / totalWeightKg;
    centerOfGravityMM = {
      x: mean((box) => box.x + box.lengthX / 2),
      y: mean((box) => box.y + box.widthY / 2),
      z: mean((box) => box.z + box.height / 2),
    };
    centerOfGravityOffset = Math.max(
      Math.abs(centerOfGravityMM.x - size[0] / 2) / (size[0] / 2),
      Math.abs(centerOfGravityMM.y - size[1] / 2) / (size[1] / 2),
    );
  }

  const blocked = blockedIndices(placements, face);
  const orderIds = [];
  for (const box of placements) if (!orderIds.includes(box.box.orderId)) orderIds.push(box.box.orderId);
  const compactness = orderIds.map((orderId) => {
    const members = placements.filter((box) => box.box.orderId === orderId);
    const boxVolume = members.reduce((sum, box) => sum + box.lengthX * box.widthY * box.height, 0);
    const spanX = Math.max(...members.map((box) => box.maxX)) - Math.min(...members.map((box) => box.x));
    const spanY = Math.max(...members.map((box) => box.maxY)) - Math.min(...members.map((box) => box.y));
    const spanZ = Math.max(...members.map((box) => box.top)) - Math.min(...members.map((box) => box.z));
    return boxVolume / (spanX * spanY * spanZ);
  });

  return {
    placedCount: placements.length,
    selectedCount,
    fillRatio: usedSpace > 0 ? volume / usedSpace : 0,
    worstLoad,
    centerOfGravityMM,
    centerOfGravityOffset,
    centerOfGravityWithinLimit: centerOfGravityOffset <= rules.centerOfGravityLimit + 1e-12,
    blockedBoxNumbers: blocked.map((index) => placements[index].box.number),
    blockedBoxIDs: blocked.map((index) => placements[index].box.id),
    groupCompactness: compactness.length ? compactness.reduce((sum, value) => sum + value, 0) / compactness.length : 1,
    heightUsedMM,
    totalWeightKg,
  };
}

function planScore(metrics, weights) {
  return weighted({
    unload: metrics.placedCount > 0 ? 1 - metrics.blockedBoxNumbers.length / metrics.placedCount : 1,
    damage: 1 - Math.min(metrics.worstLoad?.ratio ?? 0, 1),
    space: metrics.fillRatio,
    grouping: metrics.groupCompactness,
  }, weights);
}

/** One loading order, run to the end. */
function runSequence(boxes, context) {
  const { field, rules, weights, face, strict, mirrorX, mirrorY, maxWeightKg, maxDensity, maxBaseMM2 } = context;
  const size = field.sizeMM;
  const stack = new Stack(field, rules);
  const points = [{ u: 0, v: 0 }];
  const known = new Set(['0,0']);
  const steps = [];
  const unplaced = [];
  const ordersStarted = new Set();

  const loadingCorner = (box) => [mirrorX ? size[0] - box.maxX : box.x, mirrorY ? size[1] - box.maxY : box.y];

  for (const box of boxes) {
    const feasible = [];
    let furthest = null;
    const turns = box.turnAllowed && box.sizeMM[0] !== box.sizeMM[1] ? [false, true] : [false];
    for (const turned of turns) {
      const lengthX = turned ? box.sizeMM[1] : box.sizeMM[0];
      const widthY = turned ? box.sizeMM[0] : box.sizeMM[1];
      for (const point of points) {
        if (point.u + lengthX > size[0] || point.v + widthY > size[1]) {
          if (!furthest) furthest = { kind: 'outsideField', stage: 0, check: 'limits' };
          continue;
        }
        const x = mirrorX ? size[0] - point.u - lengthX : point.u;
        const y = mirrorY ? size[1] - point.v - widthY : point.v;
        const z = stack.restingZ(x, y, lengthX, widthY);
        const candidate = new Placed(box, x, y, z, turned);
        const evaluation = stack.evaluate(candidate);
        let failure = evaluation.failure;
        let blocks = 0;
        if (!failure) {
          const crossings = stack.placed.filter((other) => (candidate.box.stop > other.box.stop && isInTheWay(candidate, other, face))
            || (other.box.stop > candidate.box.stop && isInTheWay(other, candidate, face)));
          blocks = crossings.length;
          if (strict && crossings.length) {
            failure = { kind: 'breaksUnloadOrder', stage: 7, check: 'unload', boxNumber: crossings[0].box.number };
          }
        }
        if (failure) {
          if (!furthest || failure.stage > furthest.stage) furthest = failure;
          continue;
        }
        feasible.push({ candidate, evaluation, blocks, point });
      }
    }

    let best = null;
    const zs = feasible.map((option) => option.candidate.z);
    const lowest = zs.length ? Math.min(...zs) : 0;
    const highest = zs.length ? Math.max(...zs) : 0;
    // Transport-safe packing is layer-first. A soft preference such as
    // same-order contact must not create a tower while a lower safe resting
    // place exists. On that layer, use the position with the fewest unload
    // crossings; preferred mode only accepts a crossing when all positions
    // at the safest height cause one.
    const lowestOptions = feasible.filter((option) => option.candidate.z === lowest);
    const preferredBlocks = lowestOptions.length
      ? Math.min(...lowestOptions.map((option) => option.blocks))
      : 0;
    const rankedOptions = lowestOptions.filter((option) => option.blocks === preferredBlocks);
    for (const option of rankedOptions) {
      const goals = scoreOption(option, {
        ...context, size, lowest, highest, placed: stack.placed,
        orderStarted: ordersStarted.has(box.orderId), maxWeightKg, maxDensity, maxBaseMM2,
      });
      const score = weighted(goals, weights);
      if (best && !isBetter(score, option, best.score, best.option)) continue;
      best = { option, goals, score };
    }
    if (!best) {
      unplaced.push({ box, failure: furthest ?? { kind: 'outsideField', stage: 0, check: 'limits' } });
      continue;
    }
    stack.place(best.option.candidate);
    ordersStarted.add(box.orderId);
    steps.push({ evaluation: best.option.evaluation, goals: best.goals });
    for (const point of newPoints(best.option.candidate, best.option.point, stack.placed, size, loadingCorner)) {
      const key = `${point.u},${point.v}`;
      if (!known.has(key)) {
        known.add(key);
        points.push(point);
      }
    }
  }
  return { steps, placements: centerLoad(stack.placed, field), loadOnTopKg: stack.loadOnTopKg, unplaced };
}

/** Higher score wins; a tie goes to the lower, then nearer the loading corner, then unturned. */
function isBetter(score, option, otherScore, other) {
  if (Math.abs(score - otherScore) > 1e-12) return score > otherScore;
  if (option.candidate.z !== other.candidate.z) return option.candidate.z < other.candidate.z;
  if (option.point.v !== other.point.v) return option.point.v < other.point.v;
  if (option.point.u !== other.point.u) return option.point.u < other.point.u;
  return !option.candidate.turned && other.candidate.turned;
}

function scoreOption({ candidate, evaluation, blocks }, context) {
  const { size, face, lowest, highest, placed, orderStarted, maxWeightKg, maxDensity, maxBaseMM2 } = context;
  const height = size[2];

  // Space: low first, then deep from the unload side, then snug.
  const low = highest > lowest ? 1 - (candidate.z - lowest) / (highest - lowest) : 1;
  const depth = (position, room) => (room > 0 ? position / room : 1);
  let deep;
  switch (face) {
    case 'top': deep = low; break;
    case 'front': deep = depth(candidate.y, size[1] - candidate.widthY); break;
    case 'back': deep = depth(size[1] - candidate.maxY, size[1] - candidate.widthY); break;
    case 'left': deep = depth(candidate.x, size[0] - candidate.lengthX); break;
    default: deep = depth(size[0] - candidate.maxX, size[0] - candidate.lengthX); break;
  }
  let sideContact = 0;
  let sameOrderContact = 0;
  for (const other of placed) {
    const heightOverlap = overlap(candidate.z, candidate.top, other.z, other.top);
    let area = 0;
    if (heightOverlap > 0) {
      if (other.maxX === candidate.x || other.x === candidate.maxX) {
        area += overlap(candidate.y, candidate.maxY, other.y, other.maxY) * heightOverlap;
      }
      if (other.maxY === candidate.y || other.y === candidate.maxY) {
        area += overlap(candidate.x, candidate.maxX, other.x, other.maxX) * heightOverlap;
      }
      sideContact += area;
    } else if (other.top === candidate.z) {
      area = sharedArea(other, candidate);
    }
    if (other.box.orderId === candidate.box.orderId) sameOrderContact += area;
  }
  if (candidate.x === 0) sideContact += candidate.widthY * candidate.height;
  if (candidate.maxX === size[0]) sideContact += candidate.widthY * candidate.height;
  if (candidate.y === 0) sideContact += candidate.lengthX * candidate.height;
  if (candidate.maxY === size[1]) sideContact += candidate.lengthX * candidate.height;
  const sideArea = 2 * (candidate.lengthX + candidate.widthY) * candidate.height;
  const snug = Math.min(sideContact / Math.max(sideArea, 1), 1);
  const space = 0.6 * low + 0.2 * Math.min(Math.max(deep, 0), 1) + 0.2 * snug;

  // Damage: stay under half capacity, and keep strong, heavy, dense,
  // large-base boxes low.
  const margin = 1 - Math.min(Math.max((evaluation.worstLoad?.ratio ?? 0) - 0.5, 0) / 0.5, 1);
  const box = candidate.box;
  const bottomness = (STRENGTH_RANK[box.strength] / 3 + box.weightKg / maxWeightKg
    + box.densityKgPerCubicMeter / Math.max(maxDensity, 1e-9)
    + (box.sizeMM[0] * box.sizeMM[1]) / maxBaseMM2) / 4;
  const tooHigh = Math.max(0, candidate.z / height - (1 - bottomness));
  const damage = 0.5 * margin + 0.5 * (1 - tooHigh);

  // Grouping: does the box touch its own order, beside or below?
  const grouping = !orderStarted || sameOrderContact > 0 ? 1 : 0;

  return { unload: 1 / (1 + blocks), damage, space, grouping };
}

/** Extreme points a new box creates, and each slid back toward the corner. */
function newPoints(box, point, placed, size, loadingCorner) {
  const right = { u: point.u + box.lengthX, v: point.v };
  const back = { u: point.u, v: point.v + box.widthY };
  const slabs = placed.filter((other) => other.z < box.top && box.z < other.top);
  const slideV = slabs.reduce((best, other) => {
    const [u0, v0] = loadingCorner(other);
    const reaches = u0 <= right.u && right.u < u0 + other.lengthX;
    const v1 = v0 + other.widthY;
    return reaches && v1 <= right.v ? Math.max(best, v1) : best;
  }, 0);
  const slideU = slabs.reduce((best, other) => {
    const [u0, v0] = loadingCorner(other);
    const reaches = v0 <= back.v && back.v < v0 + other.widthY;
    const u1 = u0 + other.lengthX;
    return reaches && u1 <= back.u ? Math.max(best, u1) : best;
  }, 0);
  return [right, { u: right.u, v: slideV }, back, { u: slideU, v: back.v }]
    .filter((candidate) => candidate.u < size[0] && candidate.v < size[1]);
}

/** Slides the whole load so its center of gravity sits nearest the middle. */
function centerLoad(placements, field) {
  const weight = placements.reduce((sum, box) => sum + box.box.weightKg, 0);
  if (!placements.length || weight <= 0) return placements;
  const shift = (low, high, centerOfGravity, size) => {
    const wanted = Math.round(size / 2 - centerOfGravity);
    return Math.min(Math.max(wanted, -low), size - high);
  };
  const centerX = placements.reduce((sum, box) => sum + box.box.weightKg * (box.x + box.lengthX / 2), 0) / weight;
  const centerY = placements.reduce((sum, box) => sum + box.box.weightKg * (box.y + box.widthY / 2), 0) / weight;
  const shiftX = shift(Math.min(...placements.map((box) => box.x)), Math.max(...placements.map((box) => box.maxX)),
                       centerX, field.sizeMM[0]);
  const shiftY = shift(Math.min(...placements.map((box) => box.y)), Math.max(...placements.map((box) => box.maxY)),
                       centerY, field.sizeMM[1]);
  return placements.map((box) => box.moved(shiftX, shiftY));
}

/**
 * Plans where every box goes. Tries each loading order this method allows and
 * keeps the plan with the most boxes placed, then the fewest unload
 * obstructions, then a centered load, then the best weighted goals.
 */
export function plan({ boxes, field, method, rules = DEFAULT_RULES }) {
  const { face, fellBack } = unloadFaceFor(method, field);
  const strict = method.unloadRule === 'strict';
  const context = {
    field, rules, weights: method.weights, face, strict,
    mirrorX: face === 'left',
    mirrorY: face === 'front',
    // Same fallbacks as the app: the largest value present, or 1 when there
    // are no boxes at all. Clamping these to 1 would change every score for
    // a load of light boxes.
    maxWeightKg: boxes.length ? Math.max(...boxes.map((box) => box.weightKg)) : 1,
    maxDensity: boxes.length ? Math.max(...boxes.map((box) => box.densityKgPerCubicMeter)) : 1,
    maxBaseMM2: boxes.length ? Math.max(...boxes.map((box) => box.sizeMM[0] * box.sizeMM[1])) : 1,
  };
  const sequences = strict ? SEQUENCES_KEEPING_UNLOAD_ORDER : SEQUENCES;

  let best = null;
  for (const sequence of sequences) {
    const attempt = runSequence(orderedBoxes(boxes, sequence), context);
    const metrics = metricsFor(attempt.placements, attempt.loadOnTopKg, boxes.length, field, face, rules);
    const score = planScore(metrics, method.weights);
    if (best) {
      // Accessibility is not traded for a small grouping or fill gain: a
      // blocked box must be handled twice and is unsafe during the next leg.
      const better = metrics.placedCount !== best.metrics.placedCount
        ? metrics.placedCount > best.metrics.placedCount
        : metrics.blockedAtUnload !== best.metrics.blockedAtUnload
          ? metrics.blockedAtUnload < best.metrics.blockedAtUnload
        : metrics.centerOfGravityWithinLimit !== best.metrics.centerOfGravityWithinLimit
          ? metrics.centerOfGravityWithinLimit
          : score > best.score + 1e-12;
      if (!better) continue;
    }
    best = { sequence, attempt, metrics, score };
  }

  const steps = best.attempt.steps.map((step, index) => ({
    placement: best.attempt.placements[index],
    evaluation: step.evaluation,
    goals: step.goals,
  }));
  return {
    field, method, unloadFace: face, unloadFaceFellBack: fellBack, sequence: best.sequence,
    steps, unplaced: best.attempt.unplaced, metrics: best.metrics,
    loadOnTopKg: best.attempt.loadOnTopKg,
  };
}

/** Load ÷ capacity for each placed box once `visible` of them are in. */
export function loadRatiosAt(result, visible) {
  const stack = new Stack(result.field);
  for (const step of result.steps.slice(0, visible)) stack.place(step.placement);
  return stack.placed.map((box, index) => loadRatio(stack.loadOnTopKg[index], box.capacityKg));
}

// ------------------------------------------------------------- validation

const inRange = (value, [low, high]) => value >= low && value <= high;

/** Values outside the spec's limits, as the editors show them. */
export function libraryIssues(library) {
  const issues = [];
  for (const collection of library.collections) {
    const seen = new Set();
    const reported = new Set();
    const colorCounts = new Map();
    for (const order of collection.orders) colorCounts.set(order.color, (colorCounts.get(order.color) ?? 0) + 1);
    for (const order of collection.orders) {
      if (!inRange(order.client.trim().length, [1, 40])) issues.push({ kind: 'clientName', itemId: order.id });
      if (!inRange(order.stop, LIMITS.orderStop)) issues.push({ kind: 'stop', itemId: order.id });
      if (!inRange(order.color, [0, PALETTE.length - 1])) issues.push({ kind: 'color', itemId: order.id });
      if ((colorCounts.get(order.color) ?? 0) > 1) issues.push({ kind: 'duplicateOrderColor', itemId: order.id });
      for (const item of order.boxes) {
        issues.push(...boxIssues(item));
        for (const number of numbersOf(item)) {
          const repeat = seen.has(number);
          seen.add(number);
          if (repeat && !reported.has(number)) {
            reported.add(number);
            issues.push({ kind: 'duplicateBoxNumber', number, itemId: item.id });
          }
        }
      }
    }
  }
  for (const field of library.fields) issues.push(...fieldIssues(field));
  for (const method of library.methods) {
    const weights = [method.weights.unload, method.weights.damage, method.weights.space, method.weights.grouping];
    if (!weights.every((weight) => inRange(weight, LIMITS.goalWeight))) issues.push({ kind: 'goalWeight', itemId: method.id });
  }
  return issues;
}

export function boxIssues(item) {
  const issues = [];
  if (!item.sizeMM.every((side) => inRange(side, LIMITS.boxSideMM))) issues.push({ kind: 'boxSize', itemId: item.id });
  if (!inRange(item.weightKg, LIMITS.boxWeightKg)) issues.push({ kind: 'boxWeight', itemId: item.id });
  if (!inRange(item.quantity, LIMITS.boxQuantity)) issues.push({ kind: 'boxQuantity', itemId: item.id });
  if (!inRange(item.number, LIMITS.boxNumber) || !inRange(item.number + Math.max(item.quantity, 1) - 1, LIMITS.boxNumber)) {
    issues.push({ kind: 'boxNumber', itemId: item.id });
  }
  if (item.color != null && !inRange(item.color, [0, PALETTE.length - 1])) issues.push({ kind: 'color', itemId: item.id });
  return issues;
}

export function fieldIssues(field) {
  const issues = [];
  const floorOK = inRange(field.sizeMM[0], LIMITS.fieldFloorSideMM) && inRange(field.sizeMM[1], LIMITS.fieldFloorSideMM);
  if (!floorOK || !inRange(field.sizeMM[2], LIMITS.fieldHeightMM)) issues.push({ kind: 'fieldSize', itemId: field.id });
  if (!(field.maxLoadKg > 0)) issues.push({ kind: 'fieldMaxLoad', itemId: field.id });
  if (!field.openFaces?.length) issues.push({ kind: 'fieldNoOpenFace', itemId: field.id });
  if (!inRange(field.floorColor, [0, PALETTE.length - 1])) issues.push({ kind: 'color', itemId: field.id });
  return issues;
}

/** Blocking issues stop a run; the rest are advisory, shown inline only. */
const ADVISORY = new Set(['duplicateOrderColor', 'clientName']);
export const isBlocking = (issue) => !ADVISORY.has(issue.kind);
