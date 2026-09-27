const assert = require('node:assert/strict');
const test = require('node:test');
const { createSimulation, runWorkload } = require('../src/workload');

test('cloud workload simulates every shelf with settled readings and repeatable bursts', async () => {
  const messages = [];
  const result = await runWorkload({ stores: 2, shelvesPerStore: 3, bursts: 2,
    publish: async (topic, payload) => messages.push({ topic, payload }) });

  assert.equal(result.published, 30);
  assert.equal(messages.length, 30);
  assert.equal(messages[0].topic, 'shelfsense/raw/store-01/shelf/shelf-001');
  assert.equal(messages[0].payload.grams, 10000);
  assert.equal(messages[1].payload.grams, 9000);
  assert.equal(messages[2].payload.grams, 9000);
  assert.equal(messages[2].payload.ts - messages[1].payload.ts, 900);
  assert.equal(new Set(messages.map(row => row.payload.shelfId)).size, 3);
});

test('parallel shelves keep readings in order for each shelf', async () => {
  const readings = new Map();
  await runWorkload({ stores: 1, shelvesPerStore: 5, bursts: 2, concurrency: 5,
    runId: 'trial1', publish: async (_topic, payload) => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2));
      const values = readings.get(payload.shelfId) || [];
      values.push(payload.grams);
      readings.set(payload.shelfId, values);
    } });
  assert.equal(readings.size, 5);
  for (const values of readings.values()) assert.deepEqual(values, [10000, 9000, 9000, 8000, 8000]);
});

test('evidence workload can include a new cold chain breach and clear for each store', async () => {
  const messages = [];
  const result = await runWorkload({ stores: 2, shelvesPerStore: 1, bursts: 1,
    runId: 'trial2', includeTemperature: true,
    publish: async (topic, payload) => messages.push({ topic, payload }) });
  const fridge = messages.filter(row => row.topic.includes('/fridge/'));
  assert.equal(fridge.length, 6);
  assert.equal(result.expectedColdchainAlerts, 4);
  assert.deepEqual(fridge.slice(0, 3).map(row => row.payload.tempC), [6.1, 6.4, 4.1]);
  assert.ok(fridge[0].payload.unitId.includes('trial2'));
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
