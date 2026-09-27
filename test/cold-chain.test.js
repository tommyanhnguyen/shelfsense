const test = require('node:test');
const assert = require('node:assert/strict');

const { createColdChainService } = require('../src/services/cold-chain');
const { MemoryStore } = require('./memory-store');
const { createEvent } = require('../src/shared/events');

test('stores and forwards a cold-chain breach', async () => {
  const store = new MemoryStore();
  const published = [];
  const service = createColdChainService({ store, publish: async event => published.push(event) });
  const event = createEvent('coldchain.alert', 'store-01', {
    unitId: 'fridge-1', tempC: 6.2, state: 'BREACH'
  }, { eventId: 'alert-1', ts: 10 });

  await service.handle(event);

  assert.equal((await store.listAlerts())[0].data.state, 'BREACH');
  assert.equal(published[0].eventId, 'alert-1');
});
