const config = require('../src/shared/config');
const { createEvent, getSku } = require('../src/shared/events');

function evidenceData(reading) {
  if (reading.runId === undefined) return {};
  if (typeof reading.runId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(reading.runId)) {
    throw new Error('Invalid evidence run ID');
  }
  return { runId: reading.runId };
}

function createEdgeProcessor(options = {}) {
  const debounceMs = options.debounceMs ?? config.debounceMs;
  const settleBandItems = options.settleBandItems ?? 0.15;
  const minimumItemDelta = options.minimumItemDelta ?? 0.4;
  const temperatureLimitC = options.temperatureLimitC ?? config.temperatureLimitC;
  const temperatureSamples = options.temperatureSamples ?? config.temperatureSamples;
  const temperatureHysteresisC = options.temperatureHysteresisC ?? config.temperatureHysteresisC;
  const initialState = options.initialState || {};
  const shelves = new Map((initialState.shelves || []).map(([key, value]) => [key, { ...value }]));
  const fridges = new Map((initialState.fridges || []).map(([key, value]) => [key, { ...value }]));

  function processShelf(reading) {
    const { store, shelfId, skuId, grams, ts } = reading;
    if (!Number.isFinite(grams) || grams < 0) {
      throw new Error('Shelf grams must be a nonnegative number');
    }
    const runData = evidenceData(reading);
    const wallTs = reading.wallTs ?? Date.now();
    const item = getSku(skuId);
    const key = store + '/' + shelfId;
    const current = shelves.get(key);

    if (!current) {
      const opening = Math.round(grams / item.unitWeight);
      shelves.set(key, { settledGrams: opening * item.unitWeight, pendingGrams: grams, pendingAt: ts });
      if (opening <= 0) return null;
      return createEvent('stock.delta', store, {
        skuId, shelfId, delta: opening, source: 'opening', wallTs, ...runData
      }, { ts });
    }

    const band = item.unitWeight * settleBandItems;
    if (Math.abs(grams - current.pendingGrams) > band) {
      current.pendingGrams = grams;
      current.pendingAt = ts;
      return null;
    }

    current.pendingGrams = (current.pendingGrams + grams) / 2;
    if (ts - current.pendingAt < debounceMs) return null;

    const itemDelta = (current.pendingGrams - current.settledGrams) / item.unitWeight;
    if (Math.abs(itemDelta) < minimumItemDelta) return null;

    const delta = Math.round(itemDelta);
    if (delta === 0) return null;

    current.settledGrams += delta * item.unitWeight;
    current.pendingAt = ts;
    return createEvent('stock.delta', store, {
      skuId, shelfId, delta, source: 'shelf', wallTs, ...runData
    }, { ts });
  }

  function processPos(sale) {
    getSku(sale.skuId);
    if (typeof sale.txnId !== 'string' || !sale.txnId.trim()) {
      throw new Error('POS transaction identifier is required');
    }
    if (!Number.isFinite(sale.qty) || sale.qty <= 0) {
      throw new Error('POS quantity must be greater than zero');
    }
    return createEvent('stock.delta', sale.store, {
      skuId: sale.skuId,
      delta: -Math.abs(sale.qty),
      source: 'pos',
      txnId: sale.txnId,
      wallTs: sale.wallTs ?? Date.now()
    }, { eventId: 'pos-' + [sale.store, sale.txnId, sale.skuId].map(encodeURIComponent).join(':'), ts: sale.ts });
  }

  function processTemperature(reading) {
    if (!Number.isFinite(reading.tempC)) {
      throw new Error('Temperature must be a finite number');
    }
    const runData = evidenceData(reading);
    const key = reading.store + '/' + reading.unitId;
    const current = fridges.get(key) || { hotSamples: 0, breached: false };
    fridges.set(key, current);

    if (reading.tempC > temperatureLimitC) {
      current.hotSamples += 1;
      if (current.breached || current.hotSamples < temperatureSamples) return null;
      current.breached = true;
      return createEvent('coldchain.alert', reading.store, {
        unitId: reading.unitId,
        tempC: reading.tempC,
        state: 'BREACH',
        wallTs: reading.wallTs ?? Date.now(), ...runData
      }, { ts: reading.ts });
    }

    current.hotSamples = 0;
    if (!current.breached || reading.tempC > temperatureLimitC - temperatureHysteresisC) return null;
    current.breached = false;
    return createEvent('coldchain.alert', reading.store, {
      unitId: reading.unitId,
      tempC: reading.tempC,
      state: 'CLEARED',
      wallTs: reading.wallTs ?? Date.now(), ...runData
    }, { ts: reading.ts });
  }

  function snapshot() {
    return {
      shelves: [...shelves].map(([key, value]) => [key, { ...value }]),
      fridges: [...fridges].map(([key, value]) => [key, { ...value }])
    };
  }

  return { processShelf, processPos, processTemperature, snapshot };
}

module.exports = { createEdgeProcessor };
