const assert = require('node:assert/strict');
const test = require('node:test');
const { MemoryStore } = require('./memory-store');
const { createInventoryService } = require('../src/services/inventory');
const { createEvent } = require('../src/shared/events');

function delta(eventId, source, amount, ts) {
  return createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l',
    delta: amount,
    source,
    wallTs: ts
  }, { eventId, ts });
}

test('does not subtract POS and shelf events twice', async () => {
  const store = new MemoryStore();
  const service = createInventoryService({ store, publish: async () => {}, clock: () => 20 });

  await service.handle(delta('open-1', 'opening', 10, 1));
  await service.handle(delta('shelf-1', 'shelf', -1, 10));
  await service.handle(delta('pos-1', 'pos', -1, 15));

  assert.equal((await store.getStock('store-01', 'milk-1l')).qty, 9);
});

test('ignores a duplicate event', async () => {
  const store = new MemoryStore();
  const published = [];
  const service = createInventoryService({ store, publish: async event => published.push(event) });
  const opening = delta('open-1', 'opening', 10, 1);

  assert.equal((await service.handle(opening)).duplicate, false);
  assert.equal((await service.handle(opening)).duplicate, true);
  assert.equal((await store.getStock('store-01', 'milk-1l')).qty, 10);
  assert.equal(published.length, 1);
});

test('computes sales velocity after enough history', async () => {
  const store = new MemoryStore();
  const published = [];
  const service = createInventoryService({
    store,
    publish: async event => published.push(event),
    minSales: 3,
    minWindowMs: 60 * 60 * 1000,
    clock: () => 3 * 60 * 60 * 1000
  });

  await service.handle(delta('open-1', 'opening', 10, 0));
  await service.handle(delta('pos-1', 'pos', -1, 0));
  await service.handle(delta('pos-2', 'pos', -1, 30 * 60 * 1000));
  await service.handle(delta('pos-3', 'pos', -1, 60 * 60 * 1000));

  const row = await store.getStock('store-01', 'milk-1l');
  assert.equal(row.velocityPerDay, 72);
  assert.equal(row.daysToStockout, 0.14);
  assert.equal(published.at(-1).type, 'stock.updated');
});

test('stock event retry continues after a storage failure', async () => {
  const store = new MemoryStore();
  const inventory = createInventoryService({ store, publish: async () => {} });
  const original = store.applyPhysicalDelta.bind(store);
  let fail = true;
  store.applyPhysicalDelta = async event => {
    if (fail) { fail = false; throw new Error('storage unavailable'); }
    return original(event);
  };
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', source: 'opening', delta: 10
  }, { eventId: 'reliable-stock-1' });
  await assert.rejects(inventory.handle(event), /storage unavailable/);
  assert.equal((await inventory.handle(event)).duplicate, false);
  assert.equal((await store.getStock('store-01', 'milk-1l')).qty, 10);
});

test('stock retry after publish failure does not apply the delta twice', async () => {
  const store = new MemoryStore();
  let fail = true;
  const events = [];
  const inventory = createInventoryService({ store, publish: async event => {
    if (fail) { fail = false; throw new Error('mqtt unavailable'); }
    events.push(event);
  } });
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', source: 'opening', delta: 10
  }, { eventId: 'reliable-stock-2' });
  await assert.rejects(inventory.handle(event), /mqtt unavailable/);
  await inventory.handle(event);
  assert.equal((await store.getStock('store-01', 'milk-1l')).qty, 10);
  assert.equal(events[0].eventId, 'stock-updated-reliable-stock-2');
});

test('invalid business stock events are rejected before ledger or stock writes', async () => {
  for (const data of [
    { skuId: 'missing', source: 'opening', delta: 1 },
    { skuId: 'toString', source: 'opening', delta: 1 },
    { skuId: 'milk-1l', source: 'pos', delta: 0 },
    { skuId: 'milk-1l', source: 'pos', delta: 1 },
    { skuId: 'milk-1l', source: 'manual', delta: 1 }
  ]) {
    const store = new MemoryStore();
    const published = [];
    const inventory = createInventoryService({ store, publish: async event => published.push(event) });
    await assert.rejects(inventory.handle(createEvent('stock.delta', 'store-01', data)));
    assert.equal(store.stockEvents.size, 0);
    assert.deepEqual(await store.listStock(), []);
    assert.deepEqual(published, []);
  }
});
