const assert = require('node:assert/strict');
const test = require('node:test');
const { MemoryStore } = require('./memory-store');
const { createApiServer } = require('../src/api');
const { authorize, createRoleToken, issueToken, verifyToken } = require('../src/shared/auth');

async function startTestApi() {
  const store = new MemoryStore();
  const published = [];
  await store.saveStock({ store: 'store-01', skuId: 'milk-1l', qty: 4, velocityPerDay: 3 });
  await store.saveOrder({
    orderId: 'order-1', store: 'store-01', lines: [{ skuId: 'milk-1l', qty: 12 }],
    value: 38.4, status: 'PENDING_APPROVAL'
  });
  const server = createApiServer({ store, publish: async event => published.push(event) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    store,
    published,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function setup() {
  const store = new MemoryStore();
  await store.saveStock({ store: 'store-01', skuId: 'milk-1l', qty: 1 });
  await store.saveStock({ store: 'store-02', skuId: 'milk-1l', qty: 2 });
  await store.saveOrder({ orderId: 'o1', store: 'store-01', status: 'PENDING_APPROVAL',
    lines: [{ skuId: 'milk-1l', qty: 6 }] });
  const server = createApiServer({ store, publish: async () => {}, authRequired: true,
    authSecret: 'api-secret', now: () => 100000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, store, baseUrl: 'http://127.0.0.1:' + server.address().port };
}

function token(role, stores) {
  return issueToken({ sub: role, role, stores, exp: 200 }, 'api-secret', 100000);
}

test('serves stock through the API', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));

  const response = await fetch(api.baseUrl + '/api/stock');
  const rows = await response.json();

  assert.equal(response.status, 200);
  assert.equal(rows[0].qty, 4);
});

test('health reports unavailable when the database connection is lost', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  api.store.isReady = () => false;
  const response = await fetch(api.baseUrl + '/health');
  assert.equal(response.status, 503);
});

test('approves a pending order and publishes the decision', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));

  const response = await fetch(api.baseUrl + '/api/orders/order-1/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy: 'manager:tommy' })
  });
  const order = await response.json();

  assert.equal(response.status, 200);
  assert.equal(order.status, 'APPROVED');
  assert.equal(api.published[0].type, 'order.approved');
});

test('completes a delivery and releases its order', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  await api.store.saveOrder({
    orderId: 'order-2',
    store: 'store-01',
    openKey: 'store-01/milk-1l',
    lines: [{ skuId: 'milk-1l', qty: 6 }],
    status: 'IN_DELIVERY'
  });
  await api.store.saveDelivery({
    deliveryId: 'delivery-2', orderId: 'order-2', store: 'store-01', status: 'PLANNED'
  });

  const response = await fetch(api.baseUrl + '/api/deliveries/delivery-2/complete', { method: 'POST' });
  const delivery = await response.json();
  const order = await api.store.getOrder('order-2');

  assert.equal(response.status, 200);
  assert.equal(delivery.status, 'DELIVERED');
  assert.equal(order.openKey, undefined);
  assert.ok(api.published.some(event => event.type === 'stock.delta'));
});

test('returns 404 for an unknown delivery', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));

  const response = await fetch(api.baseUrl + '/api/deliveries/missing/complete', { method: 'POST' });
  assert.equal(response.status, 404);
});

test('dispatches, starts and completes one stop in a delivery batch', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  for (const [orderId, storeId] of [['batch-o1', 'store-01'], ['batch-o2', 'store-02']]) {
    await api.store.saveOrder({ orderId, store: storeId, supplier: 'Dairy Distribution Centre',
      openKey: storeId + '/milk-1l', lines: [{ skuId: 'milk-1l', qty: 6 }], status: 'IN_DELIVERY' });
  }
  await api.store.saveDelivery({
    deliveryId: 'batch-1', batchKey: 'dairy:east', supplier: 'Dairy Distribution Centre',
    region: 'melbourne-east', orderIds: ['batch-o1', 'batch-o2'], stores: ['store-01', 'store-02'],
    route: [], stops: [], status: 'DRAFT', createdAt: 1
  });

  let response = await fetch(api.baseUrl + '/api/deliveries/batch-1/dispatch', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stops.length, 2);
  response = await fetch(api.baseUrl + '/api/deliveries/batch-1/start', { method: 'POST' });
  assert.equal((await response.json()).status, 'IN_TRANSIT');
  response = await fetch(api.baseUrl + '/api/deliveries/batch-1/stops/store-01/complete', { method: 'POST' });
  const delivery = await response.json();
  assert.equal(delivery.status, 'IN_TRANSIT');
  assert.equal(delivery.stops[0].status, 'DELIVERED');
});

test('serves the manager portal', async t => {
  const api = await startTestApi();
  t.after(() => new Promise(resolve => api.server.close(resolve)));

  const response = await fetch(api.baseUrl + '/');
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /ShelfSense/);
});

test('API requires a token and filters reads by store scope', async t => {
  const api = await setup();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  assert.equal((await fetch(api.baseUrl + '/api/stock')).status, 401);
  const response = await fetch(api.baseUrl + '/api/stock', {
    headers: { authorization: 'Bearer ' + token('manager', ['store-01']) }
  });
  const rows = await response.json();
  assert.deepEqual(rows.map(row => row.store), ['store-01']);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('strict-transport-security'), /max-age=/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('API rejects wrong role and wrong store mutations', async t => {
  const api = await setup();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  let response = await fetch(api.baseUrl + '/api/orders/o1/approve', {
    method: 'POST', headers: { authorization: 'Bearer ' + token('driver', ['store-01']), 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy: 'driver' })
  });
  assert.equal(response.status, 403);
  response = await fetch(api.baseUrl + '/api/orders/o1/approve', {
    method: 'POST', headers: { authorization: 'Bearer ' + token('manager', ['store-02']), 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy: 'manager' })
  });
  assert.equal(response.status, 403);
});

test('supplier and driver cannot mutate a route containing an unauthorised store', async t => {
  const api = await setup();
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  await api.store.saveDelivery({ deliveryId: 'route-1', status: 'DRAFT', stores: ['store-01', 'store-02'],
    orderIds: ['o1'], supplier: 'Dairy Distribution Centre', region: 'metro', stops: [] });

  const listing = await fetch(api.baseUrl + '/api/deliveries', {
    headers: { authorization: 'Bearer ' + token('supplier', ['store-01']) }
  });
  assert.deepEqual(await listing.json(), []);

  let response = await fetch(api.baseUrl + '/api/deliveries/route-1/dispatch', {
    method: 'POST', headers: { authorization: 'Bearer ' + token('supplier', ['store-01']) }
  });
  assert.equal(response.status, 403);
  response = await fetch(api.baseUrl + '/api/deliveries/route-1/start', {
    method: 'POST', headers: { authorization: 'Bearer ' + token('driver', ['store-01']) }
  });
  assert.equal(response.status, 403);
});

test('issues and verifies a scoped token', () => {
  const token = issueToken({ sub: 'tommy', role: 'manager', stores: ['store-01'], exp: 200 }, 'secret', 100000);
  const claims = verifyToken(token, 'secret', 150000);
  assert.equal(claims.sub, 'tommy');
  assert.equal(authorize(claims, 'manager', 'store-01'), true);
});

test('rejects expired, modified, wrong role and wrong store tokens', () => {
  const token = issueToken({ sub: 'driver-1', role: 'driver', stores: ['store-01'], exp: 120 }, 'secret', 100000);
  assert.throws(() => verifyToken(token, 'secret', 121000), /expired/);
  assert.throws(() => verifyToken(token + 'x', 'secret', 110000), /signature/);
  const claims = verifyToken(token, 'secret', 110000);
  assert.throws(() => authorize(claims, 'manager', 'store-01'), /role/);
  assert.throws(() => authorize(claims, 'driver', 'store-02'), /store/);
});

test('operator can issue a short lived scoped portal token', () => {
  const secret = 'a'.repeat(32);
  const token = createRoleToken({ role: 'manager', stores: 'store-01,store-02', secret });
  const claims = verifyToken(token, secret);
  assert.equal(claims.role, 'manager');
  assert.deepEqual(claims.stores, ['store-01', 'store-02']);
  assert.ok(claims.exp - claims.iat <= 3600);
  assert.throws(() => createRoleToken({ role: 'manager', stores: 'store-01', secret: 'short' }));
});
