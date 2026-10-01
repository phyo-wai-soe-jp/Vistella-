// exchange.js — the JSON the phone, this page and any other tool share
// (VisTella's LoadPlanExchange format). A library file carries the boxes,
// fields and methods; a plan file carries one finished plan.
//
// A 2D surface writes its floor as `sizeMM: [x, y]` with the stack height in
// `stackLimitMM`; a 3D container writes `sizeMM: [x, y, z]`. Inside this app
// both are one `sizeMM: [x, y, z]`, where z is the stack limit or the ceiling.

import { PALETTE, resolvedStrength, loadRatio } from './planner.js';

const SCHEMA_VERSION = 1;

export class ExchangeError extends Error {}

const fail = (message) => { throw new ExchangeError(message); };

function readInt(value, what) {
  if (!Number.isFinite(value)) fail(`${what} must be a number`);
  return Math.round(value);
}

/** Reads a library file into this app's shape. */
export function parseLibrary(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail('That file is not JSON.');
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    fail(`Unsupported schema version ${document.schemaVersion}; expected ${SCHEMA_VERSION}.`);
  }
  if (document.kind && document.kind !== 'library') {
    fail(`This is a ${document.kind} document, not a library document.`);
  }
  const library = {
    schemaVersion: SCHEMA_VERSION,
    collections: (document.collections ?? []).map(parseCollection),
    fields: (document.fields ?? []).map(parseField),
    methods: (document.methods ?? []).map(parseMethod),
  };
  return library;
}

function parseCollection(raw) {
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: String(raw.name ?? ''),
    orders: (raw.orders ?? []).map(parseOrder),
  };
}

function parseOrder(raw) {
  return {
    id: raw.id ?? crypto.randomUUID(),
    client: String(raw.client ?? ''),
    stop: readInt(raw.stop ?? 1, 'stop'),
    color: readInt(raw.color ?? 0, 'color'),
    boxes: (raw.boxes ?? []).map(parseBox),
  };
}

function parseBox(raw) {
  const size = raw.sizeMM ?? [];
  if (size.length !== 3) fail('A box size needs three values.');
  return {
    id: raw.id ?? crypto.randomUUID(),
    number: readInt(raw.number ?? 1, 'number'),
    sizeMM: size.map((value) => readInt(value, 'size')),
    weightKg: Number(raw.weightKg ?? 0),
    quantity: readInt(raw.quantity ?? 1, 'quantity'),
    color: raw.color == null ? null : readInt(raw.color, 'color'),
    strength: raw.strength ?? null,
    turnAllowed: raw.turnAllowed !== false,
  };
}

function parseField(raw) {
  const type = raw.type === 'container' ? 'container' : 'surface';
  const size = (raw.sizeMM ?? []).map((value) => readInt(value, 'size'));
  let sizeMM;
  if (type === 'surface') {
    if (size.length === 2) {
      if (raw.stackLimitMM == null) fail('A two-dimensional surface size needs stackLimitMM.');
      sizeMM = [size[0], size[1], readInt(raw.stackLimitMM, 'stackLimitMM')];
    } else if (size.length === 3) {
      // Also accept the app's internal [x, y, z] form.
      if (raw.stackLimitMM != null && readInt(raw.stackLimitMM, 'stackLimitMM') !== size[2]) {
        fail(`The surface height ${size[2]} does not match stackLimitMM ${raw.stackLimitMM}.`);
      }
      sizeMM = size;
    } else {
      fail(`A surface field has ${size.length} size values.`);
    }
  } else {
    if (size.length !== 3) fail(`A container field has ${size.length} size values.`);
    if (raw.stackLimitMM != null) fail('A container puts its height in sizeMM and must not have stackLimitMM.');
    sizeMM = size;
  }
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: String(raw.name ?? ''),
    type,
    sizeMM,
    maxLoadKg: Number(raw.maxLoadKg ?? 0),
    openFaces: raw.openFaces?.length ? [...raw.openFaces] : (type === 'surface' ? ['top', 'front', 'back', 'left', 'right'] : ['front']),
    floorColor: readInt(raw.floorColor ?? 11, 'floorColor') % PALETTE.length,
  };
}

function parseMethod(raw) {
  const weights = raw.weights ?? {};
  const unloadFrom = raw.unloadFrom ?? 'auto';
  const unloadFaces = Array.isArray(raw.unloadFaces)
    ? [...raw.unloadFaces]
    : (unloadFrom === 'auto' ? [] : [unloadFrom]);
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: String(raw.name ?? ''),
    profile: raw.profile ?? null,
    unloadFrom,
    unloadFaces,
    loadingFrom: Array.isArray(raw.loadingFrom) ? [...raw.loadingFrom] : [...unloadFaces],
    unloadRule: raw.unloadRule === 'strict' ? 'strict' : 'preferred',
    engineRules: raw.engineRules ? {
      minSupportPct: Number(raw.engineRules.minSupportPct ?? 80),
      requireCenterSupport: raw.engineRules.requireCenterSupport !== false,
      requireSideContact: raw.engineRules.requireSideContact !== false,
      allowHeightGrowth: raw.engineRules.allowHeightGrowth === true,
    } : null,
    weights: {
      unload: Number(weights.unload ?? 5),
      damage: Number(weights.damage ?? 5),
      space: Number(weights.space ?? 5),
      grouping: Number(weights.grouping ?? 5),
    },
  };
}

/** Writes a library file the phone can open. */
export function serializeLibrary(library) {
  return stableJSON({
    schemaVersion: SCHEMA_VERSION,
    kind: 'library',
    collections: library.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      orders: collection.orders.map((order) => ({
        id: order.id,
        client: order.client,
        stop: order.stop,
        color: order.color,
        boxes: order.boxes.map((item) => ({
          id: item.id,
          number: item.number,
          sizeMM: item.sizeMM,
          weightKg: item.weightKg,
          quantity: item.quantity,
          ...(item.color == null ? {} : { color: item.color }),
          ...(item.strength ? { strength: item.strength } : {}),
          turnAllowed: item.turnAllowed,
        })),
      })),
    })),
    fields: library.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      ...(field.type === 'surface'
        ? { sizeMM: [field.sizeMM[0], field.sizeMM[1]], stackLimitMM: field.sizeMM[2] }
        : { sizeMM: field.sizeMM }),
      maxLoadKg: field.maxLoadKg,
      openFaces: field.openFaces,
      floorColor: field.floorColor,
    })),
    methods: library.methods.map((method) => ({
      id: method.id,
      name: method.name,
      profile: method.profile,
      unloadFrom: method.unloadFrom,
      unloadFaces: method.unloadFaces,
      loadingFrom: method.loadingFrom,
      unloadRule: method.unloadRule,
      engineRules: method.engineRules,
      weights: method.weights,
    })),
  });
}

/** Writes a plan file in the same shape the app exports. */
export function serializePlan(result) {
  const field = result.field;
  return stableJSON({
    schemaVersion: SCHEMA_VERSION,
    kind: 'plan',
    field: {
      id: field.id,
      name: field.name,
      type: field.type,
      ...(field.type === 'surface'
        ? { sizeMM: [field.sizeMM[0], field.sizeMM[1]], stackLimitMM: field.sizeMM[2] }
        : { sizeMM: field.sizeMM }),
      maxLoadKg: field.maxLoadKg,
      openFaces: field.openFaces,
      floorColor: field.floorColor,
    },
    method: {
      id: result.method.id,
      name: result.method.name,
      profile: result.method.profile,
      unloadFrom: result.method.unloadFrom,
      unloadFaces: result.method.unloadFaces,
      loadingFrom: result.method.loadingFrom,
      unloadRule: result.method.unloadRule,
      engineRules: result.method.engineRules,
      weights: result.method.weights,
    },
    unloadFace: result.unloadFace,
    unloadFaceFellBack: result.unloadFaceFellBack,
    loadingOrder: result.sequence,
    placements: result.steps.map((step, index) => {
      const placed = step.placement;
      return {
        step: index + 1,
        boxID: placed.box.id,
        orderID: placed.box.orderId,
        number: placed.box.number,
        client: placed.box.client,
        stop: placed.box.stop,
        color: placed.box.color,
        sizeMM: placed.box.sizeMM,
        positionMM: [placed.x, placed.y, placed.z],
        turned: placed.turned,
        weightKg: placed.box.weightKg,
        strength: placed.box.strength,
      };
    }),
    unplaced: result.unplaced.map((entry) => ({
      boxID: entry.box.id,
      orderID: entry.box.orderId,
      number: entry.box.number,
      client: entry.box.client,
      reason: reasonOf(entry.failure),
    })),
    results: {
      placedCount: result.metrics.placedCount,
      selectedCount: result.metrics.selectedCount,
      fillRatio: result.metrics.fillRatio,
      worstLoad: result.metrics.worstLoad
        ? {
          boxID: result.metrics.worstLoad.boxID,
          boxNumber: result.metrics.worstLoad.boxNumber,
          loadKg: result.metrics.worstLoad.loadKg,
          capacityKg: result.metrics.worstLoad.capacityKg,
          ratio: Number.isFinite(result.metrics.worstLoad.ratio) ? result.metrics.worstLoad.ratio : null,
        }
        : null,
      centerOfGravityMM: result.metrics.centerOfGravityMM
        ? [result.metrics.centerOfGravityMM.x, result.metrics.centerOfGravityMM.y, result.metrics.centerOfGravityMM.z]
        : null,
      centerOfGravityOffset: result.metrics.centerOfGravityOffset,
      centerOfGravityWithinLimit: result.metrics.centerOfGravityWithinLimit,
      blockedBoxNumbers: result.metrics.blockedBoxNumbers,
      blockedBoxIDs: result.metrics.blockedBoxIDs,
      groupCompactness: result.metrics.groupCompactness,
      heightUsedMM: result.metrics.heightUsedMM,
      totalWeightKg: result.metrics.totalWeightKg,
    },
  });
}

function reasonOf(failure) {
  const reason = { code: failure.kind, check: failure.check };
  for (const key of ['boxNumber', 'loadKg', 'capacityKg', 'ratio', 'topMM', 'limitMM', 'totalKg', 'maxKg']) {
    if (failure[key] != null) reason[key] = failure[key];
  }
  return reason;
}

/** Pretty JSON with sorted keys, so the same plan always writes the same bytes. */
function stableJSON(value) {
  const sortKeys = (input) => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sortKeys(input[key])]));
    }
    return input;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Load ÷ capacity for a placed box, for the web viewer's load colors. */
export { loadRatio, resolvedStrength };
