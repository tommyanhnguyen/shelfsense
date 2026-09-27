const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mqtt = require('mqtt');
const { startBroker } = require('../src/broker');
const { createEvent, signEvent, verifyEvent } = require('../src/shared/events');
const { buildMqttOptions, connectMqtt, consumeBatch, createPublisher, handleMessage, publishEvent, publishJson } = require('../src/shared/transport');

test('local broker accepts one MQTT message', { timeout: 5000 }, async t => {
  const broker = await startBroker(0);
  const subscriber = mqtt.connect('mqtt://127.0.0.1:' + broker.port);
  const publisher = mqtt.connect('mqtt://127.0.0.1:' + broker.port);

  const subscriberConnected = new Promise((resolve, reject) => {
    subscriber.once('connect', resolve);
    subscriber.once('error', reject);
  });
  const publisherConnected = new Promise((resolve, reject) => {
    publisher.once('connect', resolve);
    publisher.once('error', reject);
  });

  t.after(async () => {
    subscriber.end(true);
    publisher.end(true);
    await new Promise(resolve => broker.server.close(resolve));
    await broker.aedes.close();
  });

  await Promise.all([subscriberConnected, publisherConnected]);
  await new Promise((resolve, reject) => subscriber.subscribe('test/topic', error => error ? reject(error) : resolve()));

  const received = new Promise(resolve => subscriber.once('message', (topic, payload) => resolve({ topic, payload: payload.toString() })));
  publisher.publish('test/topic', 'hello');

  assert.deepEqual(await received, { topic: 'test/topic', payload: 'hello' });
});

test('broker rejects a wrong password and accepts configured MQTT client credentials', { timeout: 5000 }, async t => {
  const broker = await startBroker(0, { username: 'edge', password: 'test-password' });
  t.after(async () => {
    await new Promise(resolve => broker.server.close(resolve));
    await broker.aedes.close();
  });
  const url = 'mqtt://127.0.0.1:' + broker.port;
  let badClient;
  try {
    badClient = await connectMqtt(url, 'wrong-password', {
      username: 'edge', password: 'wrong', reconnectPeriod: 0
    });
    assert.fail('Broker accepted the wrong password');
  } catch (error) {
    assert.match(error.message, /auth|refus|password|connect|accepted the wrong/i);
    assert.notEqual(error.message, 'Broker accepted the wrong password');
  } finally {
    if (badClient) await new Promise(resolve => badClient.end(true, resolve));
  }
  const client = await connectMqtt(url, 'right-password', {
    username: 'edge', password: 'test-password', reconnectPeriod: 0
  });
  await new Promise(resolve => client.end(false, resolve));
});

test('sends invalid JSON to the dead letter handler', async () => {
  const rejected = [];
  const result = await handleMessage({
    topic: 'shelfsense/events/stock.delta',
    payload: Buffer.from('{bad'),
    expectedType: 'stock.delta',
    process: async () => {},
    deadLetter: async item => rejected.push(item)
  });

  assert.equal(result.accepted, false);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /JSON/);
});

test('catches a service error without rejecting the consumer promise', async () => {
  const rejected = [];
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: -1, source: 'shelf'
  });
  const result = await handleMessage({
    topic: 'shelfsense/events/stock.delta',
    payload: Buffer.from(JSON.stringify(event)),
    expectedType: 'stock.delta',
    process: async () => { throw new Error('service failure'); },
    deadLetter: async item => rejected.push(item)
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'service failure');
  assert.equal(rejected.length, 1);
});

test('accepts one valid event', async () => {
  const processed = [];
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: -1, source: 'shelf'
  });
  const result = await handleMessage({
    topic: 'shelfsense/events/stock.delta',
    payload: Buffer.from(JSON.stringify(event)),
    expectedType: 'stock.delta',
    process: async value => processed.push(value),
    deadLetter: async () => {}
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(processed[0].eventId, event.eventId);
});

test('signed consumer accepts a valid event and rejects a modified event', async () => {
  const event = signEvent(createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: -1, source: 'shelf'
  }), 'test-signing-secret');
  const processed = [];
  const rejected = [];
  const options = {
    topic: 'shelfsense/events/stock.delta',
    expectedType: 'stock.delta',
    signingSecret: 'test-signing-secret',
    process: async value => processed.push(value),
    deadLetter: async item => rejected.push(item)
  };

  assert.equal((await handleMessage({ ...options, payload: event })).accepted, true);
  assert.equal(processed.length, 1);
  const modified = { ...event, data: { ...event.data, delta: -5 } };
  assert.equal((await handleMessage({ ...options, payload: modified })).accepted, false);
  assert.equal(processed.length, 1);
  assert.match(rejected[0].reason, /signature/);
});

test('publishing a business event signs its actual MQTT payload', async () => {
  let sent;
  const client = {
    publish(topic, payload, options, callback) {
      sent = { topic, payload: JSON.parse(payload), qos: options.qos };
      callback();
    }
  };
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: 2, source: 'opening'
  });

  await publishJson(client, 'shelfsense/events/stock.delta', event, {
    signingSecret: 'test-signing-secret'
  });

  assert.equal(sent.qos, 1);
  assert.equal(sent.topic, 'shelfsense/events/stock.delta');
  assert.equal(verifyEvent(sent.payload, 'test-signing-secret'), true);
});

test('MQTT TLS options load client certificate, key and trusted CA', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfsense-mqtt-'));
  try {
    for (const [file, contents] of [['cert.pem', 'certificate'], ['key.pem', 'private-key'],
      ['ca.pem', 'trusted-ca']]) {
      fs.writeFileSync(path.join(directory, file), contents);
    }
    const options = buildMqttOptions('iot-edge', {
      certFile: path.join(directory, 'cert.pem'), keyFile: path.join(directory, 'key.pem'),
      caFile: path.join(directory, 'ca.pem')
    });
    assert.equal(options.cert.toString(), 'certificate');
    assert.equal(options.key.toString(), 'private-key');
    assert.equal(options.ca.toString(), 'trusted-ca');
    assert.equal(options.rejectUnauthorized, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AWS queue deletes a signed event only after its service succeeds', async () => {
  const event = signEvent(createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: 4, source: 'opening'
  }), 'aws-test-secret');
  const sent = [];
  const sqs = { send: async command => {
    sent.push(command.constructor.name);
    return command.constructor.name === 'ReceiveMessageCommand'
      ? { Messages: [{ Body: JSON.stringify(event), ReceiptHandle: 'receipt-1' }] } : {};
  } };
  const handled = [];
  const result = await consumeBatch({ sqs, queueUrl: 'https://example.invalid/queue',
    signingSecret: 'aws-test-secret', expectedType: 'stock.delta',
    handle: async value => handled.push(value.eventId) });

  assert.deepEqual(result, { received: 1, processed: 1, failed: 0 });
  assert.deepEqual(handled, [event.eventId]);
  assert.deepEqual(sent, ['ReceiveMessageCommand', 'DeleteMessageCommand']);
});

test('AWS queue keeps failed messages for SQS retry and dead letter policy', async () => {
  const event = createEvent('stock.delta', 'store-01', {
    skuId: 'milk-1l', delta: 4, source: 'opening'
  });
  const sent = [];
  const sqs = { send: async command => {
    sent.push(command.constructor.name);
    return { Messages: [{ Body: JSON.stringify(event), ReceiptHandle: 'receipt-1' }] };
  } };
  const result = await consumeBatch({ sqs, queueUrl: 'https://example.invalid/queue',
    expectedType: 'stock.delta', handle: async () => { throw new Error('Atlas unavailable'); } });

  assert.deepEqual(result, { received: 1, processed: 0, failed: 1 });
  assert.deepEqual(sent, ['ReceiveMessageCommand']);
});

test('AWS event publisher sends a signed event with type attribute to SNS', async () => {
  let published;
  const sns = { send: async command => { published = command.input; return { MessageId: 'msg-1' }; } };
  const event = createEvent('stock.updated', 'store-01', {
    skuId: 'milk-1l', qty: 4, velocityPerDay: 0, daysToStockout: null
  });

  await publishEvent({ sns, topicArn: 'arn:aws:sns:ap-southeast-2:123456789012:events',
    event, signingSecret: 'aws-test-secret' });

  assert.equal(published.MessageAttributes.eventType.StringValue, 'stock.updated');
  assert.equal(JSON.parse(published.Message).eventId, event.eventId);
  assert.equal(JSON.parse(published.Message).signature.length > 20, true);
});

test('AWS API publisher sends approval events to SNS', async () => {
  let sent;
  const publisher = createPublisher({ mode: 'aws', sns: {
    send: async command => { sent = command.input; return {}; }
  }, topicArn: 'arn:aws:sns:region:account:events' });
  const event = createEvent('order.approved', 'store-01', {
    orderId: 'order-1', approvedBy: 'manager:tommy'
  });

  await publisher(event);

  assert.equal(JSON.parse(sent.Message).eventId, event.eventId);
  assert.equal(sent.MessageAttributes.eventType.StringValue, 'order.approved');
});
