const assert = require('node:assert/strict');
const test = require('node:test');
const { createEdgeProcessor } = require('../node-red/edge');
const { createSimulation, runLoad } = require('../src/workload');

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async () => { t += 1000; } };
}

test('load run paces readings to the requested rate and duration', async () => {
  const clock = fakeClock();
  const messages = [];
  const result = await runLoad({ rate: 10, duration: 3, stores: 2, shelvesPerStore: 3, runId: 'calib',
    ...clock, publish: async (topic, payload) => messages.push({ topic, payload }) });

  assert.ok(result.published >= 30 && result.published <= 31);
  assert.equal(messages.length, result.published);
  assert.equal(messages[0].topic, 'shelfsense/raw/store-01/shelf/shelf-001-rcalib');
  assert.ok(messages.every(message => message.payload.runId === 'calib' && message.payload.wallTs > 0));
});

test('every load step settles into exactly one edge event, and an empty shelf is refilled', async () => {
  const messages = [];
  const result = await runLoad({ rate: 24, duration: 1, stores: 1, shelvesPerStore: 1, ...fakeClock(),
    publish: async (topic, payload) => messages.push(payload) });
  const edge = createEdgeProcessor({ debounceMs: 800 });
  const events = messages.map(reading => edge.processShelf(reading)).filter(Boolean);

  assert.equal(events.length, result.expectedStockEvents);
  assert.deepEqual(events.map(event => event.data.delta), [10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10, -1]);
});

test('load run rejects an impossible rate', async () => {
  await assert.rejects(runLoad({ rate: 0, duration: 1, publish: async () => {} }), /rate/);
});

test('simulator uses a real wall timestamp on every message', async () => {
  const messages = [];
  const floor = Date.now() - 1000;
  await createSimulation({ stores: 1, publish: async (topic, payload) => messages.push({ topic, payload }) }).run();

  assert.ok(messages.length > 0);
  for (const message of messages) {
    assert.ok(message.payload.wallTs >= floor, message.topic + ' has an invalid wallTs');
  }
});
