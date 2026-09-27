const assert = require('node:assert/strict');
const test = require('node:test');
const { MemoryStore } = require('./memory-store');
const { processQueueBatch, serviceDefinition } = require('../src/service');
const { validateProductionConfig } = require('../src/shared/config');
const { createEvent } = require('../src/shared/events');

const base = { MONGODB_URI: 'mongodb+srv://example.net/shelfsense', AWS_REGION: 'ap-southeast-2',
  EVENT_SIGNING_REQUIRED: 'true', EVENT_SIGNING_SECRET: 'x'.repeat(32) };

test('defines the input contract for every local service', () => {
  assert.deepEqual(serviceDefinition('inventory'), {
    topic: 'shelfsense/events/stock.delta',
    expectedType: 'stock.delta'
  });
  assert.deepEqual(serviceDefinition('replenishment'), {
    topic: 'shelfsense/events/stock.updated',
    expectedType: 'stock.updated'
  });
  assert.deepEqual(serviceDefinition('cold-chain'), {
    topic: 'shelfsense/events/coldchain.alert',
    expectedType: 'coldchain.alert'
  });
  assert.deepEqual(serviceDefinition('delivery'), {
    topic: 'shelfsense/events/order.approved',
    expectedType: 'order.approved'
  });
});

test('rejects an unknown service name', () => {
  assert.throws(() => serviceDefinition('missing'), /Unknown service/);
});

test('production worker needs Atlas, AWS region and event signing', () => {
  assert.deepEqual(validateProductionConfig(base, 'worker'), []);
  const errors = validateProductionConfig({ ...base, EVENT_SIGNING_SECRET: 'short', AWS_REGION: '' }, 'worker');
  assert.ok(errors.includes('EVENT_SIGNING_SECRET must be at least 32 characters'));
  assert.ok(errors.includes('AWS_REGION is required'));
});

test('production API requires scoped authentication', () => {
  assert.deepEqual(validateProductionConfig({ ...base, API_AUTH_REQUIRED: 'true',
    API_AUTH_SECRET: 'y'.repeat(32) }, 'api'), []);
  assert.ok(validateProductionConfig(base, 'api').includes('API_AUTH_REQUIRED must be true'));
});

test('AWS inventory worker consumes stock delta, saves stock and emits stock update', async () => {
  const store = new MemoryStore();
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: 10, source: 'opening'
  });
  const published = [];
  let deleted = 0;
  const sqs = { send: async command => {
    if (command.constructor.name === 'ReceiveMessageCommand') {
      return { Messages: [{ Body: JSON.stringify(event), ReceiptHandle: 'r-1' }] };
    }
    deleted += 1;
    return {};
  } };
  const sns = { send: async command => { published.push(JSON.parse(command.input.Message)); return {}; } };

  const result = await processQueueBatch({ name: 'inventory', store, sqs, sns,
    queueUrl: 'https://example.invalid/inventory', topicArn: 'arn:aws:sns:region:account:events' });

  assert.equal(result.processed, 1);
  assert.equal((await store.getStock('store-01', 'milk-1l')).qty, 10);
  assert.equal(published[0].type, 'stock.updated');
  assert.equal(deleted, 1);
});
