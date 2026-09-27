const assert = require('node:assert/strict');
const test = require('node:test');
const { MemoryStore } = require('./memory-store');
const { drainApprovalOutbox } = require('../src/api');
const { createReplenishmentService } = require('../src/services/replenishment');
const { createEvent } = require('../src/shared/events');

function lowStockEvent() {
  return createEvent('stock.updated', 'store-01', {
    skuId: 'milk-1l',
    qty: 2,
    velocityPerDay: 4,
    daysToStockout: 0.5
  }, { eventId: 'stock-update-1', ts: 100 });
}

function setup() {
  const store = new MemoryStore();
  const published = [];
  const service = createReplenishmentService({
    store,
    publish: async event => published.push(event),
    autoApproveUnder: 0,
    idFactory: () => 'order-1',
    now: () => 200
  });
  return { store, published, service };
}

function lowStock() {
  return createEvent('stock.updated', 'store-01', {
    skuId: 'milk-1l',
    qty: 2,
    velocityPerDay: 4,
    daysToStockout: 0.5
  }, { ts: 100 });
}

test('creates one order when stock cover is too short', async () => {
  const { store, service } = setup();
  const order = await service.handleStockUpdated(lowStockEvent());

  assert.equal(order.orderId, 'order-1');
  assert.equal(order.lines[0].qty, 12);
  assert.equal(order.status, 'PENDING_APPROVAL');
  assert.equal((await store.listOrders()).length, 1);
});

test('does not create a second open order for the same SKU', async () => {
  const { store, service } = setup();
  await service.handleStockUpdated(lowStockEvent());
  assert.equal(await service.handleStockUpdated(lowStockEvent()), null);
  assert.equal((await store.listOrders()).length, 1);
});

test('concurrent updates still create one open order', async () => {
  const store = new MemoryStore();
  let sequence = 0;
  const service = createReplenishmentService({
    store,
    publish: async () => {},
    autoApproveUnder: 0,
    idFactory: () => 'order-' + (++sequence)
  });

  await Promise.all([
    service.handleStockUpdated(lowStockEvent()),
    service.handleStockUpdated(lowStockEvent()),
    service.handleStockUpdated(lowStockEvent())
  ]);

  assert.equal((await store.listOrders()).length, 1);
});

test('manager approval stores the decision and publishes an event', async () => {
  const { store, published, service } = setup();
  await service.handleStockUpdated(lowStockEvent());
  const order = await service.approve('order-1', 'manager:tommy');

  assert.equal(order.status, 'APPROVED');
  assert.equal((await store.getOrder('order-1')).approvedBy, 'manager:tommy');
  assert.equal(published.at(-1).type, 'order.approved');
});

test('does not create an order before velocity is ready', async () => {
  const { service } = setup();
  const event = createEvent('stock.updated', 'store-01', {
    skuId: 'milk-1l', qty: 2, velocityPerDay: 0, daysToStockout: null
  });

  assert.equal(await service.handleStockUpdated(event), null);
});

test('a delivered order allows a later order for the same SKU', async () => {
  const store = new MemoryStore();
  let sequence = 0;
  const service = createReplenishmentService({
    store,
    publish: async () => {},
    autoApproveUnder: 0,
    idFactory: () => 'order-' + (++sequence)
  });

  const first = await service.handleStockUpdated(lowStock());
  await store.closeOrder(first.orderId);
  const second = await service.handleStockUpdated(lowStock());

  assert.equal(second.orderId, 'order-2');
  assert.equal((await store.listOrders()).length, 2);
});

test('approval publish failure remains in the outbox and recovers after restart', async () => {
  const store = new MemoryStore();
  await store.saveOrder({ orderId: 'order-1', store: 'store-01', status: 'PENDING_APPROVAL',
    lines: [{ skuId: 'milk-1l', qty: 6 }] });
  const service = createReplenishmentService({ store, publish: async () => {
    throw new Error('mqtt unavailable');
  }, now: () => 100 });
  await assert.rejects(service.approve('order-1', 'manager:tommy'), /mqtt unavailable/);
  assert.equal((await store.listPendingApprovalEvents()).length, 1);
  const published = [];
  const count = await drainApprovalOutbox({ store, publish: async event => published.push(event) });
  assert.equal(count, 1);
  assert.equal(published[0].eventId, 'order-approved-order-1');
  assert.equal((await store.listPendingApprovalEvents()).length, 0);
});
