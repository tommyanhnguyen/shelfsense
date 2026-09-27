const { randomUUID } = require('node:crypto');
const config = require('./shared/config');
const { connectMqtt, publishJson } = require('./shared/transport');

// Small demo run

function createSimulation(options = {}) {
  const stores = options.stores || 2;
  const publish = options.publish;

  async function run() {
    for (let index = 1; index <= stores; index += 1) {
      const store = 'store-' + String(index).padStart(2, '0');
      const shelfTopic = `shelfsense/raw/${store}/shelf/shelf-1`;
      const posTopic = `shelfsense/raw/${store}/pos`;
      const fridgeTopic = `shelfsense/raw/${store}/fridge/fridge-1`;

      await publish(shelfTopic, { store, shelfId: 'shelf-1', skuId: 'milk-1l', grams: 10000, ts: 0, wallTs: Date.now() });
      await publish(shelfTopic, { store, shelfId: 'shelf-1', skuId: 'milk-1l', grams: 2000, ts: 100, wallTs: Date.now() });
      await publish(shelfTopic, { store, shelfId: 'shelf-1', skuId: 'milk-1l', grams: 2000, ts: 1000, wallTs: Date.now() });

      for (let sale = 0; sale < 3; sale += 1) {
        await publish(posTopic, {
          store,
          skuId: 'milk-1l',
          qty: 1,
          txnId: store + '-txn-' + (sale + 1),
          ts: sale * 60 * 60 * 1000,
          wallTs: Date.now()
        });
      }

      await publish(fridgeTopic, { store, unitId: 'fridge-1', tempC: 6.1, ts: 1, wallTs: Date.now() });
      await publish(fridgeTopic, { store, unitId: 'fridge-1', tempC: 6.4, ts: 2, wallTs: Date.now() });
      await publish(fridgeTopic, { store, unitId: 'fridge-1', tempC: 4.1, ts: 3, wallTs: Date.now() });
    }
  }

  return { run };
}

async function runSimulator() {
  const startupDelayMs = Number(process.env.STARTUP_DELAY_MS || 0);
  if (startupDelayMs > 0) {
    console.log('Waiting ' + startupDelayMs + ' ms for Node-RED');
    await new Promise(resolve => setTimeout(resolve, startupDelayMs));
  }

  const client = await connectMqtt(config.mqttUrl, 'shelfsense-simulator-' + process.pid);
  const simulation = createSimulation({
    stores: Number(process.env.STORES || 2),
    publish: (topic, payload) => publishJson(client, topic, payload)
  });
  await simulation.run();
  await new Promise(resolve => client.end(false, resolve));
  console.log('Simulation published');
}

// Load run for the scaling experiment

function positiveInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(name + ' must be an integer from 1 to ' + maximum);
  }
  return number;
}

async function runWorkload(options) {
  const stores = positiveInteger(options.stores, 'stores', 100);
  const shelvesPerStore = positiveInteger(options.shelvesPerStore, 'shelvesPerStore', 1000);
  const bursts = positiveInteger(options.bursts, 'bursts', 100);
  const concurrency = positiveInteger(options.concurrency || 1, 'concurrency', 500);
  if (bursts > 10) throw new Error('bursts must not empty the shelf below zero');
  if (typeof options.publish !== 'function') throw new Error('publish is required');
  const runId = options.runId || '';
  if (runId && !/^[a-zA-Z0-9]+$/.test(runId)) throw new Error('runId must be alphanumeric');
  const start = Date.now();
  let published = 0;
  const shelves = [];
  for (let storeNumber = 1; storeNumber <= stores; storeNumber += 1) {
    const store = 'store-' + String(storeNumber).padStart(2, '0');
    for (let shelfNumber = 1; shelfNumber <= shelvesPerStore; shelfNumber += 1) {
      const shelfId = 'shelf-' + String(shelfNumber).padStart(3, '0') + (runId ? '-r' + runId : '');
      shelves.push({ store, shelfId });
    }
  }
  let nextShelf = 0;
  async function worker() {
    while (nextShelf < shelves.length) {
      const { store, shelfId } = shelves[nextShelf++];
      const topic = `shelfsense/raw/${store}/shelf/${shelfId}`;
      const send = async (grams, ts) => {
        await options.publish(topic, { store, shelfId, skuId: 'milk-1l', grams, ts,
          wallTs: Date.now(), ...(runId ? { runId } : {}) });
        published += 1;
      };
      await send(10000, 0);
      for (let burst = 1; burst <= bursts; burst += 1) {
        const grams = 10000 - burst * 1000;
        await send(grams, burst * 1000 - 100);
        await send(grams, burst * 1000 + 800);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, shelves.length) }, worker));
  if (options.includeTemperature) {
    for (let storeNumber = 1; storeNumber <= stores; storeNumber += 1) {
      const store = 'store-' + String(storeNumber).padStart(2, '0');
      const unitId = 'fridge-r' + (runId || 'sample');
      const topic = `shelfsense/raw/${store}/fridge/${unitId}`;
      for (const [index, tempC] of [6.1, 6.4, 4.1].entries()) {
        await options.publish(topic, { store, unitId, tempC, ts: index,
          wallTs: Date.now(), ...(runId ? { runId } : {}) });
        published += 1;
      }
    }
  }
  return { runId, stores, shelvesPerStore, bursts, published,
    expectedStockEvents: stores * shelvesPerStore * (1 + bursts),
    expectedColdchainAlerts: options.includeTemperature ? stores * 2 : 0,
    startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString() };
}

async function runLoad() {
  const runId = process.env.RUN_ID || randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await connectMqtt(config.mqttUrl, 'shelfsense-workload-' + process.pid);
  try {
    const result = await runWorkload({
      stores: process.env.STORES || 20,
      shelvesPerStore: process.env.SHELVES_PER_STORE || 50,
      bursts: process.env.BURSTS || 10,
      concurrency: process.env.WORKLOAD_CONCURRENCY || 100,
      runId,
      includeTemperature: process.env.INCLUDE_TEMPERATURE !== 'false',
      publish: (topic, payload) => publishJson(client, topic, payload)
    });
    console.log(JSON.stringify(result));
  } finally {
    await new Promise(resolve => client.end(false, resolve));
  }
}

if (require.main === module) {
  (process.argv[2] === 'demo' ? runSimulator() : runLoad()).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createSimulation, runSimulator, runWorkload };
