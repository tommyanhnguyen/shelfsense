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

// Each shelf opens at 10 kg, then loses 1 kg per step until empty, then is refilled to 10 kg.
// A step is two readings 900 ms apart on the sensor clock, so the edge debounce settles it into
// exactly one stock.delta. The opening reading is the only one-message step.
function createShelfCycle({ stores, shelvesPerStore, runId }) {
  const shelves = [];
  for (let storeNumber = 1; storeNumber <= stores; storeNumber += 1) {
    const store = 'store-' + String(storeNumber).padStart(2, '0');
    for (let shelfNumber = 1; shelfNumber <= shelvesPerStore; shelfNumber += 1) {
      const shelfId = 'shelf-' + String(shelfNumber).padStart(3, '0') + (runId ? '-r' + runId : '');
      shelves.push({ store, shelfId, grams: 10000, ts: 0, opened: false });
    }
  }
  let next = 0;
  return function nextStep() {
    const shelf = shelves.at(next);
    next = (next + 1) % shelves.length;
    const reading = (grams, ts) => ({
      topic: `shelfsense/raw/${shelf.store}/shelf/${shelf.shelfId}`,
      payload: { store: shelf.store, shelfId: shelf.shelfId, skuId: 'milk-1l', grams, ts, ...(runId ? { runId } : {}) }
    });
    if (!shelf.opened) {
      shelf.opened = true;
      return [reading(shelf.grams, 0)];
    }
    shelf.grams = shelf.grams >= 1000 ? shelf.grams - 1000 : 10000;
    const settled = [reading(shelf.grams, shelf.ts + 1000), reading(shelf.grams, shelf.ts + 1900)];
    shelf.ts += 2000;
    return settled;
  };
}

// Publishes `rate` raw readings per second for `duration` seconds, paced against the clock.
async function runLoad(options) {
  const rate = positiveInteger(options.rate, 'rate', 5000);
  const duration = positiveInteger(options.duration, 'duration', 3600);
  const stores = positiveInteger(options.stores ?? 20, 'stores', 100);
  const shelvesPerStore = positiveInteger(options.shelvesPerStore ?? 50, 'shelvesPerStore', 1000);
  const runId = options.runId || '';
  if (runId && !/^[a-zA-Z0-9]{1,32}$/.test(runId)) throw new Error('runId must be alphanumeric');
  if (typeof options.publish !== 'function') throw new Error('publish is required');
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const nextStep = createShelfCycle({ stores, shelvesPerStore, runId });
  const total = rate * duration;
  const start = now();
  const startedAt = new Date().toISOString();
  let published = 0;
  let expectedStockEvents = 0;

  while (published < total) {
    const due = Math.min(total, Math.floor((now() - start) * rate / 1000));
    const batch = [];
    while (published + batch.length < due) {
      batch.push(...nextStep());
      expectedStockEvents += 1;
    }
    for (const message of batch) message.payload.wallTs = Date.now();
    await Promise.all(batch.map(message => options.publish(message.topic, message.payload)));
    published += batch.length;
    if (options.onProgress) options.onProgress({ published, total });
    if (published < total) await sleep(20);
  }
  return { runId, rate, duration, stores, shelvesPerStore, published, expectedStockEvents,
    startedAt, finishedAt: new Date().toISOString() };
}

async function runLoadFromEnv() {
  const runId = process.env.RUN_ID || randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await connectMqtt(config.mqttUrl, 'shelfsense-workload-' + process.pid);
  let lastLog = 0;
  try {
    const result = await runLoad({
      rate: process.env.RATE || 100,
      duration: process.env.DURATION || 60,
      stores: process.env.STORES || 20,
      shelvesPerStore: process.env.SHELVES_PER_STORE || 50,
      runId,
      publish: (topic, payload) => publishJson(client, topic, payload),
      onProgress: ({ published, total }) => {
        if (Date.now() - lastLog < 30000) return;
        lastLog = Date.now();
        console.log(JSON.stringify({ kind: 'load', runId, published, total, at: new Date().toISOString() }));
      }
    });
    console.log(JSON.stringify({ kind: 'load_done', ...result }));
  } finally {
    await new Promise(resolve => client.end(false, resolve));
  }
}

if (require.main === module) {
  (process.argv[2] === 'demo' ? runSimulator() : runLoadFromEnv()).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createShelfCycle, createSimulation, runLoad, runSimulator };
