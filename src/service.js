const { SNSClient } = require('@aws-sdk/client-sns');
const { SQSClient } = require('@aws-sdk/client-sqs');
const { createColdChainService } = require('./services/cold-chain');
const { createDeliveryService } = require('./services/delivery');
const { createInventoryService } = require('./services/inventory');
const { createReplenishmentService } = require('./services/replenishment');
const config = require('./shared/config');
const { MongoStore } = require('./shared/store');
const { connectMqtt, consumeBatch, eventTopic, handleMessage, publishEvent, publishJson, subscribe } = require('./shared/transport');

// One runner for every service. EVENT_TRANSPORT=mqtt runs locally, EVENT_TRANSPORT=aws reads SQS.
const DEFINITIONS = {
  inventory: { expectedType: 'stock.delta', queueEnvironment: 'SQS_INVENTORY_QUEUE_URL' },
  replenishment: { expectedType: 'stock.updated', queueEnvironment: 'SQS_REPLENISHMENT_QUEUE_URL' },
  'cold-chain': { expectedType: 'coldchain.alert', queueEnvironment: 'SQS_COLDCHAIN_QUEUE_URL' },
  delivery: { expectedType: 'order.approved', queueEnvironment: 'SQS_DELIVERY_QUEUE_URL' },
  'dead-letter': { expectedType: null }
};

function serviceDefinition(name) {
  const definition = DEFINITIONS[name];
  if (!definition) throw new Error('Unknown service: ' + name);
  return {
    topic: definition.expectedType ? eventTopic(definition.expectedType) : 'shelfsense/dead-letter',
    expectedType: definition.expectedType
  };
}

function createService(name, store, publish, notify) {
  if (name === 'inventory') return createInventoryService({ store, publish });
  if (name === 'replenishment') return createReplenishmentService({ store, publish });
  if (name === 'delivery') return createDeliveryService({ store, publish });
  if (name === 'cold-chain') return createColdChainService({ store, publish: notify });
  throw new Error('Unknown service: ' + name);
}

function handleEvent(name, service, event) {
  return name === 'replenishment' ? service.handleStockUpdated(event) : service.handle(event);
}

async function startMqttService(name) {
  const definition = serviceDefinition(name);
  const store = await MongoStore.connect(config.mongoUri);
  const client = await connectMqtt(config.mqttUrl, 'shelfsense-' + name + '-' + process.pid);
  const service = name === 'dead-letter' ? null : createService(name, store,
    event => publishJson(client, eventTopic(event.type), event),
    event => publishJson(client, 'shelfsense/notifications/coldchain', event));
  let messageChain = Promise.resolve();

  await subscribe(client, definition.topic);
  client.on('message', (topic, payload) => {
    messageChain = messageChain.then(async () => {
      if (name === 'dead-letter') {
        try {
          await store.saveDeadLetter(JSON.parse(payload.toString()));
        } catch (error) {
          console.error('Dead letter write failed: ' + error.message);
        }
        return;
      }
      await handleMessage({
        topic,
        payload,
        expectedType: definition.expectedType,
        process: event => handleEvent(name, service, event),
        deadLetter: item => publishJson(client, 'shelfsense/dead-letter', item)
      });
    }).catch(error => console.error(name + ' message failed: ' + error.message));
  });

  async function close() {
    await new Promise(resolve => client.end(false, resolve));
    await store.close();
  }

  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  console.log(name + ' service ready');
  return { client, close, store };
}

async function processQueueBatch(options) {
  const { name, store, sqs, sns, queueUrl, topicArn, alertTopicArn, signingSecret } = options;
  const definition = DEFINITIONS[name];
  if (!definition || !definition.queueEnvironment) throw new Error('Unknown AWS service: ' + name);
  const service = createService(name, store,
    event => publishEvent({ sns, topicArn, event, signingSecret }),
    event => publishEvent({ sns, topicArn: alertTopicArn, event, signingSecret }));
  return consumeBatch({
    sqs,
    queueUrl,
    expectedType: definition.expectedType,
    signingSecret,
    handle: event => handleEvent(name, service, event),
    onError: options.onError || (error => console.error(name + ' message failed: ' + error.message))
  });
}

async function startQueueService(name) {
  config.assertProductionConfig(process.env, 'worker');
  const definition = DEFINITIONS[name];
  if (!definition || !definition.queueEnvironment) throw new Error('Unknown AWS service: ' + name);
  const queueUrl = process.env[definition.queueEnvironment];
  const topicArn = process.env.SNS_EVENT_TOPIC_ARN;
  const alertTopicArn = process.env.SNS_ALERT_TOPIC_ARN;
  if (!queueUrl || !topicArn || (name === 'cold-chain' && !alertTopicArn)) {
    throw new Error('AWS queue and SNS destinations are required for ' + name);
  }
  const signingSecret = config.eventSigningRequired ? config.eventSigningSecret : undefined;
  if (config.eventSigningRequired && !signingSecret) throw new Error('Event signing secret is required');
  const region = process.env.AWS_REGION;
  const store = await MongoStore.connect(config.mongoUri);
  const sqs = new SQSClient({ region });
  const sns = new SNSClient({ region });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(name + ' AWS queue service ready');
  try {
    while (!stopping) {
      try {
        const started = Date.now();
        const result = await processQueueBatch({ name, store, sqs, sns, queueUrl, topicArn,
          alertTopicArn, signingSecret });
        if (result.received) console.log(JSON.stringify({ kind: 'queue_batch', service: name,
          ...result, durationMs: Date.now() - started, at: new Date().toISOString() }));
      } catch (error) {
        console.error(name + ' queue poll failed: ' + error.message);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally {
    sqs.destroy();
    sns.destroy();
    await store.close();
  }
}

function startService(name = process.env.SERVICE_NAME) {
  return process.env.EVENT_TRANSPORT === 'aws' ? startQueueService(name) : startMqttService(name);
}

if (require.main === module) {
  startService().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { DEFINITIONS, processQueueBatch, serviceDefinition, startService };
