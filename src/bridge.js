const { SNSClient } = require('@aws-sdk/client-sns');
const config = require('./shared/config');
const { validateEvent, verifyEvent } = require('./shared/events');
const { connectMqtt, parsePayload, publishEvent, publishJson, subscribe } = require('./shared/transport');

// Runs on the edge EC2. Node-RED publishes signed business events to the local broker;
// the bridge checks each one and forwards it to SNS, which routes it to the right SQS queue.
function checkEvent(topic, payload, signingSecret) {
  const event = parsePayload(payload);
  validateEvent(event);
  if (topic !== 'shelfsense/events/' + event.type) throw new Error('Topic does not match event type');
  if (signingSecret) verifyEvent(event, signingSecret);
  return event;
}

async function forwardEvent({ topic, payload, publish, signingSecret }) {
  const event = checkEvent(topic, payload, signingSecret);
  await publish(event);
  return event;
}

async function startBridge() {
  config.assertProductionConfig(process.env, 'bridge');
  const topicArn = process.env.SNS_EVENT_TOPIC_ARN;
  if (!topicArn) throw new Error('SNS_EVENT_TOPIC_ARN is required');
  const signingSecret = config.eventSigningSecret;
  const sns = new SNSClient({ region: process.env.AWS_REGION });
  const client = await connectMqtt(config.mqttUrl, 'shelfsense-bridge-' + process.pid);
  const counts = { forwarded: 0, rejected: 0, failed: 0, inFlight: 0 };
  const publish = event => publishEvent({ sns, topicArn, event, signingSecret });

  await subscribe(client, 'shelfsense/events/+');
  // Messages are forwarded concurrently: one SNS call per message in sequence would cap the edge
  // at a few dozen events per second. Order does not matter because SQS does not keep it either.
  client.on('message', (topic, payload) => {
    let event;
    try {
      event = checkEvent(topic, payload, signingSecret);
    } catch (error) {
      counts.rejected += 1;
      publishJson(client, 'shelfsense/dead-letter', { sourceTopic: topic, reason: error.message,
        payload: payload.toString(), ts: Date.now() }).catch(() => {});
      return;
    }
    counts.inFlight += 1;
    publish(event)
      .then(() => { counts.forwarded += 1; })
      .catch(error => {
        counts.failed += 1;
        console.error('SNS publish failed: ' + error.message);
      })
      .finally(() => { counts.inFlight -= 1; });
  });

  const timer = setInterval(() => console.log(JSON.stringify({ kind: 'bridge', ...counts,
    at: new Date().toISOString() })), 10000);
  const close = () => {
    clearInterval(timer);
    client.end(false, () => { sns.destroy(); process.exit(0); });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log('Bridge ready: MQTT shelfsense/events/+ to SNS');
  return { client, counts };
}

if (require.main === module) {
  startBridge().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkEvent, forwardEvent, startBridge };
