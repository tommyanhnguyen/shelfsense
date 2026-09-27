const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MemoryStore } = require('./memory-store');
const { createEdgeProcessor } = require('../node-red/edge');
const settings = require('../node-red/settings');
const { prepareFlow } = require('../node-red/start');
const { createInventoryService } = require('../src/services/inventory');
const { createEvent, signEvent, validateEvent, verifyEvent } = require('../src/shared/events');

const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '../node-red/flows.json'), 'utf8'));

function findNode(name) {
  const node = flow.find(item => item.name === name);
  assert.ok(node, 'Missing Node-RED node: ' + name);
  return node;
}

function runFunctionNode(name, msg, edge, signBusinessEvent) {
  const body = new Function('msg', 'global', findNode(name).func);
  return body(msg, { get: key => key === 'edgeProcessor' ? edge
    : key === 'signBusinessEvent' ? signBusinessEvent : undefined });
}

function shelfMessage(payload) {
  return { topic: 'shelfsense/raw/store-01/shelf/shelf-1', payload };
}

test('emits opening stock from the first shelf reading', () => {
  const edge = createEdgeProcessor({ debounceMs: 100 });
  const event = edge.processShelf({
    store: 'store-01', shelfId: 's1', skuId: 'milk-1l',
    grams: 10000, ts: 0, wallTs: 0
  });

  assert.equal(event.type, 'stock.delta');
  assert.equal(event.data.delta, 10);
  assert.equal(event.data.source, 'opening');
});

test('edge events carry the evidence run ID through shelf and fridge processing', () => {
  const edge = createEdgeProcessor({ temperatureSamples: 2 });
  const stock = edge.processShelf({ store: 'store-01', shelfId: 'trial', skuId: 'milk-1l',
    grams: 10000, ts: 0, runId: 'trial1' });
  edge.processTemperature({ store: 'store-01', unitId: 'cold', tempC: 6.1,
    ts: 0, runId: 'trial1' });
  const alert = edge.processTemperature({ store: 'store-01', unitId: 'cold', tempC: 6.4,
    ts: 1, runId: 'trial1' });
  assert.equal(stock.data.runId, 'trial1');
  assert.equal(alert.data.runId, 'trial1');
});

test('emits one stock delta after a shelf change settles', () => {
  const edge = createEdgeProcessor({ debounceMs: 100 });
  edge.processShelf({ store: 'store-01', shelfId: 's1', skuId: 'milk-1l', grams: 10000, ts: 0, wallTs: 0 });
  assert.equal(edge.processShelf({ store: 'store-01', shelfId: 's1', skuId: 'milk-1l', grams: 9000, ts: 10, wallTs: 10 }), null);

  const event = edge.processShelf({
    store: 'store-01', shelfId: 's1', skuId: 'milk-1l',
    grams: 9000, ts: 120, wallTs: 120
  });

  assert.equal(event.data.delta, -1);
  assert.equal(event.data.source, 'shelf');
});

test('converts a POS sale into a demand event', () => {
  const edge = createEdgeProcessor();
  const event = edge.processPos({
    store: 'store-01', skuId: 'milk-1l', qty: 2,
    txnId: 'txn-1', ts: 20, wallTs: 25
  });

  assert.equal(event.eventId, edge.processPos({
    store: 'store-01', skuId: 'milk-1l', qty: 2,
    txnId: 'txn-1', ts: 20, wallTs: 25
  }).eventId);
  assert.equal(event.data.delta, -2);
  assert.equal(event.data.source, 'pos');
});

test('rejects a POS sale with zero quantity', () => {
  const edge = createEdgeProcessor();
  assert.throws(() => edge.processPos({
    store: 'store-01', skuId: 'milk-1l', qty: 0,
    txnId: 'txn-empty', ts: 20
  }), /greater than zero/);
});

test('emits one breach and one clear event with hysteresis', () => {
  const edge = createEdgeProcessor({
    temperatureSamples: 2,
    temperatureLimitC: 5,
    temperatureHysteresisC: 0.8
  });

  assert.equal(edge.processTemperature({ store: 'store-01', unitId: 'f1', tempC: 6, ts: 1 }), null);
  assert.equal(edge.processTemperature({ store: 'store-01', unitId: 'f1', tempC: 6.2, ts: 2 }).data.state, 'BREACH');
  assert.equal(edge.processTemperature({ store: 'store-01', unitId: 'f1', tempC: 6.1, ts: 3 }), null);
  assert.equal(edge.processTemperature({ store: 'store-01', unitId: 'f1', tempC: 4.1, ts: 4 }).data.state, 'CLEARED');
});

test('restores shelf and fridge state after an edge restart', () => {
  const first = createEdgeProcessor({ debounceMs: 100, temperatureSamples: 2 });
  first.processShelf({ store: 'store-01', shelfId: 's1', skuId: 'milk-1l', grams: 10000, ts: 0 });
  first.processTemperature({ store: 'store-01', unitId: 'f1', tempC: 6, ts: 0 });
  const restored = createEdgeProcessor({
    debounceMs: 100,
    temperatureSamples: 2,
    initialState: first.snapshot()
  });
  assert.equal(restored.processShelf({
    store: 'store-01', shelfId: 's1', skuId: 'milk-1l', grams: 10000, ts: 1000
  }), null);
  assert.equal(restored.processTemperature({
    store: 'store-01', unitId: 'f1', tempC: 6, ts: 1
  }).data.state, 'BREACH');
});

test('flow contains three inputs, three functions and two outputs', () => {
  assert.equal(flow.filter(node => node.type === 'mqtt in').length, 3);
  assert.equal(flow.filter(node => node.type === 'function').length, 3);
  assert.equal(flow.filter(node => node.type === 'mqtt out').length, 2);
});

test('every MQTT input passes UTF-8 text to its function', () => {
  for (const node of flow.filter(item => item.type === 'mqtt in')) {
    assert.equal(node.datatype, 'utf8');
  }
});

test('Node-RED flow does not embed broker credentials', () => {
  const broker = flow.find(node => node.type === 'mqtt-broker');
  assert.equal(broker.credentials, undefined);
});

test('valid shelf JSON leaves on the business output', () => {
  const [business, rejected] = runFunctionNode('Settle shelf reading', shelfMessage(JSON.stringify({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'milk-1l', grams: 10000, ts: 0, wallTs: Date.now()
  })), createEdgeProcessor());

  assert.equal(rejected, null);
  assert.equal(business.topic, 'shelfsense/events/stock.delta');
  validateEvent(JSON.parse(business.payload));
});

test('unsettled shelf reading produces no output', () => {
  const edge = createEdgeProcessor({ debounceMs: 800 });
  runFunctionNode('Settle shelf reading', shelfMessage(JSON.stringify({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'milk-1l', grams: 10000, ts: 0
  })), edge);

  const result = runFunctionNode('Settle shelf reading', shelfMessage(JSON.stringify({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'milk-1l', grams: 2000, ts: 100
  })), edge);
  assert.equal(result, null);
});

test('malformed JSON leaves on the dead letter output', () => {
  const [business, rejected] = runFunctionNode('Convert POS sale', {
    topic: 'shelfsense/raw/store-01/pos', payload: 'not json'
  }, createEdgeProcessor());

  assert.equal(business, null);
  assert.equal(rejected.topic, 'shelfsense/dead-letter');
  assert.equal(JSON.parse(rejected.payload).payload, 'not json');
});

test('unknown SKU leaves on the dead letter output', () => {
  const [business, rejected] = runFunctionNode('Settle shelf reading', shelfMessage(JSON.stringify({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'unknown', grams: 500, ts: 0
  })), createEdgeProcessor());

  assert.equal(business, null);
  assert.match(JSON.parse(rejected.payload).reason, /Unknown SKU/);
});

test('zero POS quantity leaves on the dead letter output', () => {
  const [business, rejected] = runFunctionNode('Convert POS sale', {
    topic: 'shelfsense/raw/store-01/pos',
    payload: JSON.stringify({ store: 'store-01', skuId: 'milk-1l', qty: 0, txnId: 'empty', ts: 1 })
  }, createEdgeProcessor());

  assert.equal(business, null);
  assert.match(JSON.parse(rejected.payload).reason, /greater than zero/);
});

test('temperature breach leaves on the business output', () => {
  const edge = createEdgeProcessor({ temperatureSamples: 2 });
  const message = tempC => ({
    topic: 'shelfsense/raw/store-01/fridge/fridge-1',
    payload: JSON.stringify({ store: 'store-01', unitId: 'fridge-1', tempC, ts: 1 })
  });

  assert.equal(runFunctionNode('Filter temperature', message(6.1), edge), null);
  const [business] = runFunctionNode('Filter temperature', message(6.4), edge);
  assert.equal(JSON.parse(business.payload).data.state, 'BREACH');
});

test('edge functions sign outgoing business events when signing is enabled', () => {
  const signing = event => signEvent(event, 'edge-signing-secret');
  const shelf = runFunctionNode('Settle shelf reading', shelfMessage(JSON.stringify({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'milk-1l', grams: 10000, ts: 0
  })), createEdgeProcessor(), signing)[0];
  const pos = runFunctionNode('Convert POS sale', {
    topic: 'shelfsense/raw/store-01/pos',
    payload: JSON.stringify({ store: 'store-01', skuId: 'milk-1l', qty: 1, txnId: 'x', ts: 1 })
  }, createEdgeProcessor(), signing)[0];
  const edge = createEdgeProcessor({ temperatureSamples: 2 });
  const temperature = value => ({ topic: 'shelfsense/raw/store-01/fridge/fridge-1',
    payload: JSON.stringify({ store: 'store-01', unitId: 'fridge-1', tempC: value, ts: 1 }) });
  runFunctionNode('Filter temperature', temperature(6.1), edge, signing);
  const alert = runFunctionNode('Filter temperature', temperature(6.4), edge, signing)[0];

  for (const message of [shelf, pos, alert]) {
    assert.equal(verifyEvent(JSON.parse(message.payload), 'edge-signing-secret'), true);
  }
});

test('Node-RED global signer signs events when required', () => {
  const beforeRequired = process.env.EVENT_SIGNING_REQUIRED;
  const beforeSecret = process.env.EVENT_SIGNING_SECRET;
  process.env.EVENT_SIGNING_REQUIRED = 'true';
  process.env.EVENT_SIGNING_SECRET = 'edge-test-secret';
  try {
    const event = createEvent('stock.delta', 'store-01', {
      skuId: 'milk-1l', delta: 1, source: 'opening'
    });
    const signed = settings.functionGlobalContext.signBusinessEvent(event);
    assert.equal(verifyEvent(signed, 'edge-test-secret'), true);
  } finally {
    if (beforeRequired === undefined) delete process.env.EVENT_SIGNING_REQUIRED;
    else process.env.EVENT_SIGNING_REQUIRED = beforeRequired;
    if (beforeSecret === undefined) delete process.env.EVENT_SIGNING_SECRET;
    else process.env.EVENT_SIGNING_SECRET = beforeSecret;
  }
});

test('Node-RED editor requires the configured admin password hash', () => {
  const before = process.env.NODE_RED_ADMIN_PASSWORD_HASH;
  process.env.NODE_RED_ADMIN_PASSWORD_HASH = '$2b$08$example-hash';
  try {
    delete require.cache[require.resolve('../node-red/settings')];
    const protectedSettings = require('../node-red/settings');
    assert.equal(protectedSettings.adminAuth.users[0].username, 'admin');
    assert.equal(protectedSettings.adminAuth.users[0].password, '$2b$08$example-hash');
  } finally {
    if (before === undefined) delete process.env.NODE_RED_ADMIN_PASSWORD_HASH;
    else process.env.NODE_RED_ADMIN_PASSWORD_HASH = before;
    delete require.cache[require.resolve('../node-red/settings')];
  }
});

test('Node-RED launcher puts broker credentials only in a temporary private file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfsense-red-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  prepareFlow(dir, path.join(__dirname, '../node-red/flows.json'), 'reader', 'secret-password');
  const credentials = JSON.parse(fs.readFileSync(path.join(dir, 'flows_cred.json'), 'utf8'));
  assert.deepEqual(credentials['local-broker'], { user: 'reader', password: 'secret-password' });
  const flow = fs.readFileSync(path.join(dir, 'flows.json'), 'utf8');
  assert.equal(flow.includes('secret-password'), false);
  assert.equal(fs.statSync(path.join(dir, 'flows_cred.json')).mode & 0o777, 0o600);
});

test('invalid shelf input cannot poison the next valid opening reading', () => {
  const edge = createEdgeProcessor();
  const reading = { store: 'store-01', shelfId: 's1', skuId: 'milk-1l', ts: 0 };
  for (const grams of [undefined, NaN, Infinity, -1000, '10000']) {
    assert.throws(() => edge.processShelf({ ...reading, grams }));
  }
  assert.equal(edge.processShelf({ ...reading, grams: 10000 }).data.delta, 10);
});

test('invalid temperature cannot clear an active breach', () => {
  const edge = createEdgeProcessor({ temperatureSamples: 1 });
  const reading = { store: 'store-01', unitId: 'f1', ts: 0 };
  assert.equal(edge.processTemperature({ ...reading, tempC: 7 }).data.state, 'BREACH');
  assert.throws(() => edge.processTemperature({ ...reading, tempC: NaN }));
  assert.equal(edge.processTemperature({ ...reading, tempC: 4 }).data.state, 'CLEARED');
});

test('POS deduplication preserves separate stores and separate SKU lines', async () => {
  const edge = createEdgeProcessor();
  const store = new MemoryStore();
  const inventory = createInventoryService({ store, publish: async () => {} });
  const sale = { txnId: 'receipt-1', qty: 1, ts: 0 };
  const first = edge.processPos({ ...sale, store: 'store-01', skuId: 'milk-1l' });
  await inventory.handle(first);
  await inventory.handle(first);
  await inventory.handle(edge.processPos({ ...sale, store: 'store-02', skuId: 'milk-1l' }));
  await inventory.handle(edge.processPos({ ...sale, store: 'store-01', skuId: 'rice-1kg' }));
  assert.equal((await store.getStock('store-01', 'milk-1l')).soldUnits, 1);
  assert.equal((await store.getStock('store-02', 'milk-1l'))?.soldUnits, 1);
  assert.equal((await store.getStock('store-01', 'rice-1kg'))?.soldUnits, 1);
});

test('POS without a transaction identifier is rejected', () => {
  const edge = createEdgeProcessor();
  assert.throws(() => edge.processPos({ store: 'store-01', skuId: 'milk-1l', qty: 1, ts: 0 }));
});

test('shelf debounce uses sensor time while latency uses wall time', async () => {
  const edge = createEdgeProcessor({ debounceMs: 800 });
  const now = Date.now();
  const reading = grams => ({
    store: 'store-01', shelfId: 'shelf-1', skuId: 'milk-1l', grams, ts: 0, wallTs: now
  });

  assert.ok(edge.processShelf(reading(10000)));
  assert.equal(edge.processShelf({ ...reading(2000), ts: 100 }), null);
  assert.equal(edge.processShelf({ ...reading(2000), ts: 1000 }).data.delta, -8);
});
