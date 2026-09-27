const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

const STOCK_SOURCES = new Set(['opening', 'shelf', 'delivery', 'pos']);

const RULES = {
  'stock.delta': {
    skuId: 'string',
    delta: 'number',
    source: 'stockSource'
  },
  'stock.updated': {
    skuId: 'string',
    qty: 'number',
    velocityPerDay: 'number',
    daysToStockout: 'nullableNumber'
  },
  'temperature.reading': {
    unitId: 'string',
    tempC: 'number'
  },
  'coldchain.alert': {
    unitId: 'string',
    tempC: 'number',
    state: 'string'
  },
  'order.created': {
    orderId: 'string',
    lines: 'array',
    status: 'string'
  },
  'order.approved': {
    orderId: 'string',
    approvedBy: 'string'
  },
  'delivery.created': {
    deliveryId: 'string',
    orderIds: 'array',
    route: 'array',
    stops: 'array'
  },
  'delivery.status': {
    deliveryId: 'string',
    status: 'string'
  }
};

function createEvent(type, store, data, options = {}) {
  return {
    eventId: options.eventId || randomUUID(),
    type,
    store,
    ts: options.ts ?? Date.now(),
    data
  };
}

function isValidType(value, expected) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'number') return Number.isFinite(value);
  if (expected === 'nullableNumber') return value === null || Number.isFinite(value);
  if (expected === 'stockSource') return STOCK_SOURCES.has(value);
  return typeof value === expected && value.length > 0;
}

function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('Event must be an object');
  if (typeof event.eventId !== 'string' || !event.eventId) throw new Error('Invalid eventId');
  if (typeof event.store !== 'string' || !event.store) throw new Error('Invalid store');
  if (!Number.isFinite(event.ts)) throw new Error('Invalid ts');
  if (!event.data || typeof event.data !== 'object') throw new Error('Invalid data');

  const rules = RULES[event.type];
  if (!rules) throw new Error('Unknown event type: ' + event.type);

  const invalid = Object.entries(rules)
    .filter(([field, type]) => !isValidType(event.data[field], type))
    .map(([field]) => field);

  if (invalid.length) throw new Error('Invalid fields: ' + invalid.join(', '));
  return event;
}

// Product catalogue
const ITEMS = {
  'milk-1l': {
    skuId: 'milk-1l',
    name: 'Fresh Milk 1L',
    unitWeight: 1000,
    supplier: 'Dairy Distribution Centre',
    leadTimeDays: 2,
    price: 3.2
  },
  'yoghurt-500g': {
    skuId: 'yoghurt-500g',
    name: 'Natural Yoghurt 500g',
    unitWeight: 500,
    supplier: 'Dairy Distribution Centre',
    leadTimeDays: 2,
    price: 5.5
  },
  'rice-1kg': {
    skuId: 'rice-1kg',
    name: 'Rice 1kg',
    unitWeight: 1000,
    supplier: 'Dry Goods Distribution Centre',
    leadTimeDays: 3,
    price: 4.8
  }
};

function getSku(skuId) {
  if (!Object.hasOwn(ITEMS, skuId)) throw new Error('Unknown SKU: ' + skuId);
  const item = ITEMS[skuId];
  if (!item) throw new Error('Unknown SKU: ' + skuId);
  return item;
}

function listSkus() {
  return Object.values(ITEMS).map(item => ({ ...item }));
}

// Event signing

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(event, secret) {
  const unsigned = { ...event };
  delete unsigned.signature;
  return createHmac('sha256', secret).update(stable(unsigned)).digest('base64url');
}

function signEvent(event, secret) {
  const signed = structuredClone(event);
  signed.signature = digest(signed, secret);
  return signed;
}

function verifyEvent(event, secret) {
  if (typeof event?.signature !== 'string') throw new Error('Event signature is required');
  const expected = Buffer.from(digest(event, secret));
  const supplied = Buffer.from(event.signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('Invalid event signature');
  }
  return true;
}

module.exports = { RULES, STOCK_SOURCES, createEvent, getSku, listSkus, signEvent, stable, validateEvent, verifyEvent };
