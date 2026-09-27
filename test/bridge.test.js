const assert = require('node:assert/strict');
const test = require('node:test');
const { forwardEvent } = require('../src/bridge');
const { createEvent, signEvent } = require('../src/shared/events');

const secret = 'b'.repeat(32);
const event = () => signEvent(createEvent('stock.delta', 'store-01', {
  skuId: 'milk-1l', delta: -1, source: 'shelf', wallTs: 1
}), secret);

test('bridge forwards a signed event that matches its topic', async () => {
  const sent = [];
  const signed = event();
  await forwardEvent({ topic: 'shelfsense/events/stock.delta', payload: Buffer.from(JSON.stringify(signed)),
    publish: async value => sent.push(value), signingSecret: secret });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventId, signed.eventId);
});

test('bridge rejects a modified event, a wrong topic and broken JSON before SNS', async () => {
  const sent = [];
  const publish = async value => sent.push(value);
  const modified = { ...event(), data: { skuId: 'milk-1l', delta: -50, source: 'shelf', wallTs: 1 } };
  await assert.rejects(forwardEvent({ topic: 'shelfsense/events/stock.delta',
    payload: JSON.stringify(modified), publish, signingSecret: secret }), /signature/);
  await assert.rejects(forwardEvent({ topic: 'shelfsense/events/coldchain.alert',
    payload: JSON.stringify(event()), publish, signingSecret: secret }), /match/);
  await assert.rejects(forwardEvent({ topic: 'shelfsense/events/stock.delta',
    payload: '{not json', publish, signingSecret: secret }));
  assert.equal(sent.length, 0);
});
