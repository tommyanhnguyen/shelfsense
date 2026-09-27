const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const { createEdgeProcessor } = require('../node-red/edge');
const { createColdChainService } = require('../src/services/cold-chain');
const { createDeliveryService } = require('../src/services/delivery');
const { createInventoryService } = require('../src/services/inventory');
const { createReplenishmentService } = require('../src/services/replenishment');
const { createSimulation } = require('../src/workload');

// The whole loop in memory: edge, four services and the delivery restock.
async function runLocalDemo(options = {}) {
  const store = options.store || new MemoryStore();
  const edge = createEdgeProcessor({ debounceMs: 800 });
  const published = [];
  const notifications = [];
  let deliveryNumber = 0;
  let orderNumber = 0;

  let inventory;
  let replenishment;
  let coldChain;
  let delivery;

  async function dispatch(event) {
    published.push(event);
    if (event.type === 'stock.delta') return inventory.handle(event);
    if (event.type === 'stock.updated') return replenishment.handleStockUpdated(event);
    if (event.type === 'coldchain.alert') return coldChain.handle(event);
    if (event.type === 'order.approved') return delivery.handle(event);
    return event;
  }

  inventory = createInventoryService({ store, publish: dispatch, clock: Date.now });
  replenishment = createReplenishmentService({
    store,
    publish: dispatch,
    autoApproveUnder: 0,
    idFactory: () => 'order-' + (++orderNumber)
  });
  coldChain = createColdChainService({
    store,
    publish: async event => notifications.push(event)
  });
  delivery = createDeliveryService({
    store,
    publish: dispatch,
    idFactory: () => 'delivery-' + (++deliveryNumber)
  });

  async function processRaw(topic, payload) {
    let event = null;
    if (topic.includes('/shelf/')) event = edge.processShelf(payload);
    else if (topic.endsWith('/pos')) event = edge.processPos(payload);
    else if (topic.includes('/fridge/')) event = edge.processTemperature(payload);
    if (event) await dispatch(event);
  }

  const simulation = createSimulation({ stores: options.stores || 2, publish: processRaw });
  await simulation.run();

  for (const order of await store.listOrders()) {
    if (order.status === 'PENDING_APPROVAL') {
      await replenishment.approve(order.orderId, 'manager:tommy');
    }
  }

  for (const planned of await store.listDeliveries()) {
    if (planned.status === 'DRAFT' || planned.status === 'PLANNED') {
      await delivery.complete(planned.deliveryId);
    }
  }

  const stockRows = await store.listStock();
  const result = {
    stock: stockRows.length,
    stockOnHand: stockRows.reduce((total, row) => total + row.qty, 0),
    orders: (await store.listOrders()).length,
    ordersDelivered: (await store.listOrders()).filter(order => order.status === 'DELIVERED').length,
    alerts: (await store.listAlerts()).length,
    deliveries: (await store.listDeliveries()).length,
    deadLetters: (await store.listDeadLetters()).length,
    events: published.length,
    notifications: notifications.length
  };

  return result;
}

test('local flow creates every planned record type', async () => {
  const result = await runLocalDemo({ stores: 2 });

  assert.ok(result.stock > 0);
  assert.ok(result.orders > 0);
  assert.equal(result.ordersDelivered, result.orders);
  assert.ok(result.alerts > 0);
  assert.ok(result.deliveries > 0);
  assert.ok(result.stockOnHand > 0);
  assert.equal(result.deadLetters, 0);
});
