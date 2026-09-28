const fs = require('node:fs');
const { PublishCommand, SNSClient } = require('@aws-sdk/client-sns');
const { DeleteMessageBatchCommand, DeleteMessageCommand, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
const { signEvent, validateEvent, verifyEvent } = require('./events');

// MQTT

function eventTopic(type) {
  return 'shelfsense/events/' + type;
}

function buildMqttOptions(clientId, options = {}) {
  const result = {
    clientId,
    reconnectPeriod: options.reconnectPeriod ?? 1000,
    username: Object.hasOwn(options, 'username') ? options.username : process.env.MQTT_USERNAME,
    password: Object.hasOwn(options, 'password') ? options.password : process.env.MQTT_PASSWORD
  };
  const certFile = options.certFile ?? process.env.MQTT_CERT_FILE;
  const keyFile = options.keyFile ?? process.env.MQTT_KEY_FILE;
  const caFile = options.caFile ?? process.env.MQTT_CA_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) throw new Error('MQTT certificate and key must be supplied together');
  if (certFile) result.cert = fs.readFileSync(certFile);
  if (keyFile) result.key = fs.readFileSync(keyFile);
  if (caFile) result.ca = fs.readFileSync(caFile);
  if (certFile || caFile) result.rejectUnauthorized = true;
  return result;
}

async function connectMqtt(url, clientId, options = {}) {
  const mqtt = require('mqtt');
  const client = mqtt.connect(url, buildMqttOptions(clientId, options));
  await new Promise((resolve, reject) => {
    const connected = () => { client.off('error', failed); resolve(); };
    const failed = error => {
      client.off('connect', connected);
      client.end(true);
      reject(error);
    };
    client.once('connect', connected);
    client.once('error', failed);
  });
  return client;
}

function publishJson(client, topic, value, options = {}) {
  const secret = options.signingSecret ?? (process.env.EVENT_SIGNING_REQUIRED === 'true'
    ? process.env.EVENT_SIGNING_SECRET : null);
  if (topic.startsWith('shelfsense/events/') && process.env.EVENT_SIGNING_REQUIRED === 'true' && !secret) {
    return Promise.reject(new Error('Event signing secret is required'));
  }
  const payload = topic.startsWith('shelfsense/events/') && secret
    ? require('./events').signEvent(value, secret) : value;
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function subscribe(client, topic) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Message validation and dead letters

async function handleMessage(options) {
  const { topic, payload, expectedType, process: processEvent, deadLetter } = options;

  try {
    const event = parsePayload(payload);
    validateEvent(event);
    const signingSecret = options.signingSecret ?? (process.env.EVENT_SIGNING_REQUIRED === 'true'
      ? process.env.EVENT_SIGNING_SECRET : null);
    if (process.env.EVENT_SIGNING_REQUIRED === 'true' && !signingSecret) {
      throw new Error('Event signing secret is required');
    }
    if (signingSecret) verifyEvent(event, signingSecret);
    const acceptedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
    if (!acceptedTypes.includes(event.type)) {
      throw new Error('Unexpected event type: ' + event.type);
    }
    await processEvent(event);
    return { accepted: true };
  } catch (error) {
    const item = {
      sourceTopic: topic,
      reason: error.message,
      payload: Buffer.isBuffer(payload) ? payload.toString() : payload,
      ts: Date.now()
    };
    try {
      await deadLetter(item);
    } catch (deadLetterError) {
      item.deadLetterError = deadLetterError.message;
    }
    return { accepted: false, reason: error.message };
  }
}

function parsePayload(payload) {
  if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString());
  if (typeof payload === 'string') return JSON.parse(payload);
  if (payload && typeof payload === 'object') return payload;
  throw new Error('Payload must contain JSON');
}

// AWS SQS and SNS

async function consumeBatch(options) {
  const { sqs, queueUrl, expectedType, signingSecret, handle, onError = () => {} } = options;
  if (!queueUrl) throw new Error('SQS queue URL is required');
  const response = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: options.waitTimeSeconds ?? 10,
    VisibilityTimeout: options.visibilityTimeout ?? 60
  }));
  const messages = response.Messages || [];
  let processed = 0;
  let failed = 0;

  for (const message of messages) {
    try {
      const event = parsePayload(message.Body);
      validateEvent(event);
      if (event.type !== expectedType) throw new Error('Unexpected event type: ' + event.type);
      if (signingSecret) verifyEvent(event, signingSecret);
      await handle(event);
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle
      }));
      processed += 1;
    } catch (error) {
      failed += 1;
      onError(error, message);
    }
  }
  return { received: messages.length, processed, failed };
}

// Keyed concurrency. Messages for different keys run in parallel, up to `limit` at once.
// Messages for the same key (one shelf: store + sku) run one at a time, because the inventory
// update reads a stock row, computes velocity and writes it back.
function createKeyedLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  const tails = new Map();
  const waiting = [];
  let active = 0;
  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  function run(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(async () => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    });
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }
  return { run, get active() { return active; } };
}

function messageKey(event) {
  const data = event.data || {};
  return event.store + '/' + (data.skuId ?? data.unitId ?? data.orderId ?? data.deliveryId ?? '');
}

// Long-running SQS consumer. It keeps up to `concurrency` messages in progress and prefetches a
// little more, so a worker is never idle while it waits on MongoDB, SNS or SQS. Handled messages
// are deleted in batches of ten. A failed message is not deleted: SQS retries it, then moves it
// to the dead-letter queue. Duplicates from a retry are stopped by the unique eventId.
function createQueueConsumer(options) {
  const { sqs, queueUrl, expectedType, signingSecret, handle, onError = () => {} } = options;
  if (!queueUrl) throw new Error('SQS queue URL is required');
  const concurrency = options.concurrency ?? 1;
  const limiter = createKeyedLimiter(concurrency);
  const prefetch = Math.max(10, concurrency * 2);
  const keyOf = options.keyOf || messageKey;
  const stats = { received: 0, processed: 0, failed: 0 };
  const deletes = [];
  let held = 0;
  let flushing = Promise.resolve();
  let wake = null;

  const signal = () => {
    if (!wake) return;
    const resume = wake;
    wake = null;
    resume();
  };
  const waitForSlot = () => new Promise(resolve => { wake = resolve; });

  function flushOnce() {
    const receipts = deletes.splice(0, 10);
    if (!receipts.length) return flushing;
    flushing = flushing
      .then(() => sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: receipts.map((receipt, index) => ({ Id: String(index), ReceiptHandle: receipt }))
      })))
      .then(result => {
        for (const failure of result?.Failed || []) onError(new Error('Delete failed: ' + failure.Message));
      })
      .catch(error => onError(error));
    return flushing;
  }

  async function flush() {
    while (deletes.length) flushOnce();
    await flushing;
  }

  async function processOne(message, event) {
    try {
      await handle(event);
      deletes.push(message.ReceiptHandle);
      if (deletes.length >= 10) flushOnce();
      stats.processed += 1;
    } catch (error) {
      stats.failed += 1;
      onError(error, message);
    }
  }

  function accept(message) {
    let event;
    try {
      event = parsePayload(message.Body);
      validateEvent(event);
      if (expectedType && event.type !== expectedType) throw new Error('Unexpected event type: ' + event.type);
      if (signingSecret) verifyEvent(event, signingSecret);
    } catch (error) {
      stats.failed += 1;
      onError(error, message);
      return;
    }
    held += 1;
    limiter.run(keyOf(event), () => processOne(message, event)).finally(() => {
      held -= 1;
      signal();
    });
  }

  async function poll() {
    const room = Math.min(10, prefetch - held);
    if (room <= 0) {
      await waitForSlot();
      return 0;
    }
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: room,
      WaitTimeSeconds: options.waitTimeSeconds ?? 10,
      VisibilityTimeout: options.visibilityTimeout ?? 60
    }));
    const messages = response.Messages || [];
    stats.received += messages.length;
    for (const message of messages) accept(message);
    return messages.length;
  }

  async function drain() {
    while (held > 0) await waitForSlot();
    await flush();
  }

  async function start(isStopping) {
    const timer = setInterval(flushOnce, 200);
    timer.unref?.();
    try {
      while (!isStopping()) {
        try {
          await poll();
        } catch (error) {
          onError(error);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      await drain();
    } finally {
      clearInterval(timer);
    }
  }

  return { poll, drain, flush, start, stats, concurrency, get held() { return held; } };
}

async function publishEvent({ sns, topicArn, event, signingSecret }) {
  if (!topicArn) throw new Error('SNS topic ARN is required');
  validateEvent(event);
  const message = signingSecret ? signEvent(event, signingSecret) : event;
  return sns.send(new PublishCommand({
    TopicArn: topicArn,
    Message: JSON.stringify(message),
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: event.type }
    }
  }));
}

// Publisher for either transport

function createPublisher({ mode, mqttClient, sns, topicArn, signingSecret }) {
  if (mode === 'aws') {
    if (!sns || !topicArn) throw new Error('SNS client and event topic are required');
    return event => publishEvent({ sns, topicArn, event, signingSecret });
  }
  if (mode !== 'mqtt' || !mqttClient) throw new Error('MQTT client is required');
  return event => publishJson(mqttClient, eventTopic(event.type), event, { signingSecret });
}

async function openEventPublisher(clientId) {
  const mode = process.env.EVENT_TRANSPORT || 'mqtt';
  const signingSecret = process.env.EVENT_SIGNING_REQUIRED === 'true'
    ? process.env.EVENT_SIGNING_SECRET : undefined;
  if (process.env.EVENT_SIGNING_REQUIRED === 'true' && !signingSecret) {
    throw new Error('Event signing secret is required');
  }
  if (mode === 'aws') {
    const sns = new SNSClient({ region: process.env.AWS_REGION });
    return {
      publish: createPublisher({ mode, sns, topicArn: process.env.SNS_EVENT_TOPIC_ARN, signingSecret }),
      close: async () => sns.destroy()
    };
  }
  if (mode !== 'mqtt') throw new Error('Unknown event transport: ' + mode);
  const mqttClient = await connectMqtt(process.env.MQTT_URL || 'mqtt://localhost:1883', clientId);
  return {
    publish: createPublisher({ mode, mqttClient, signingSecret }),
    close: () => new Promise(resolve => mqttClient.end(false, resolve))
  };
}

module.exports = { buildMqttOptions, connectMqtt, consumeBatch, createKeyedLimiter, createPublisher, createQueueConsumer, eventTopic, handleMessage, messageKey, openEventPublisher, parsePayload, publishEvent, publishJson, subscribe };
