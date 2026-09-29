const { AutoScalingClient, DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand } = require('@aws-sdk/client-auto-scaling');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const { GetQueueAttributesCommand, SQSClient } = require('@aws-sdk/client-sqs');
const config = require('./shared/config');
const { MongoStore } = require('./shared/store');

// Autoscaler for the inventory workers. It replaces the CloudWatch alarm policy of the 6.3D build.
//
// Two switches let each part be measured on its own (the HD ablation):
//   SCALER_SOURCE  sqs         read the queue directly every 10 s (fast detection)
//                  cloudwatch  read the one-minute CloudWatch metrics, as the alarms did
//   SCALER_POLICY  model       size the group from a rate model: N = (arrival rate + backlog / T) / worker rate
//                  step        the old rule: +1 over 300 messages, +2 over 2300, -1 under 20 for 3 minutes
//
// The rate model follows DS2 (Kalavri et al., OSDI 2018) and the event-queue autoscaler of
// Ezzeddine et al. (2025): measure the true processing rate of one worker, then set the whole
// group in one step instead of adding one instance at a time.

const DEFAULTS = {
  policy: 'model',
  source: 'sqs',
  min: 1,
  max: 6,
  mu: 40,
  drainSeconds: 60,
  scaleInTicks: 3,
  warmupSeconds: 180,
  alpha: 0.3,
  busyPerWorker: 20,
  scaleInBacklog: 100,
  scaleInCooldownSeconds: 300,
  stepHigh: 300,
  stepHigher: 2300,
  stepLow: 20,
  stepLowSeconds: 180,
  stepCooldownSeconds: 120,
  stepInSeconds: 60
};

function readSettings(env = process.env) {
  const number = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(name + ' must be a positive number');
    return parsed;
  };
  const settings = {
    ...DEFAULTS,
    policy: env.SCALER_POLICY || DEFAULTS.policy,
    source: env.SCALER_SOURCE || DEFAULTS.source,
    min: number('SCALER_MIN', DEFAULTS.min),
    max: number('SCALER_MAX', DEFAULTS.max),
    mu: number('SCALER_MU', DEFAULTS.mu),
    drainSeconds: number('SCALER_DRAIN_SECONDS', DEFAULTS.drainSeconds),
    dryRun: env.SCALER_DRY_RUN === 'true'
  };
  if (!['model', 'step'].includes(settings.policy)) throw new Error('SCALER_POLICY must be model or step');
  if (!['sqs', 'cloudwatch'].includes(settings.source)) throw new Error('SCALER_SOURCE must be sqs or cloudwatch');
  if (settings.min > settings.max) throw new Error('SCALER_MIN must not exceed SCALER_MAX');
  settings.intervalSeconds = settings.source === 'sqs' ? 10 : 60;
  return settings;
}

// Worker count the rate model asks for, before and after the min and max limits.
function modelTarget(settings, rates) {
  const needed = Math.ceil((rates.lambda + rates.backlog / settings.drainSeconds) / rates.mu);
  return { needed, target: Math.min(settings.max, Math.max(settings.min, needed)) };
}

// Rates between two observations. Arrivals = events applied + growth of the backlog.
// A worker's rate is only learned while the queue keeps every worker busy and no new worker is
// still starting, otherwise idle time would make the workers look slower than they are.
function estimate(settings, state, observation) {
  const previous = state.previous;
  let lambda = observation.arrivalRate ?? 0;
  let mu = state.mu ?? settings.mu;
  if (previous) {
    const seconds = (observation.at - previous.at) / 1000;
    if (seconds > 0) {
      if (observation.arrivalRate === undefined) {
        lambda = Math.max(0, (observation.applied + observation.backlog - previous.backlog) / seconds);
      }
      // Busy means messages were still waiting (not yet taken by a worker) at both ends of the
      // interval. The backlog alone is not enough: at C = 8 a worker holds up to 16 messages in
      // flight while it still has spare capacity, which made the learned rate far too low.
      const waiting = sample => sample.visible ?? sample.backlog;
      const busy = waiting(previous) > previous.inService * settings.busyPerWorker
        && waiting(observation) > observation.inService * settings.busyPerWorker;
      const settled = observation.at - (state.lastChangeAt ?? -Infinity) > settings.warmupSeconds * 1000;
      if (busy && settled && observation.inService > 0 && observation.applied > 0) {
        const perWorker = observation.applied / seconds / observation.inService;
        mu = settings.alpha * perWorker + (1 - settings.alpha) * mu;
      }
    }
  }
  return { lambda, mu, backlog: observation.backlog };
}

function decideModel(settings, state, observation) {
  const rates = estimate(settings, state, observation);
  const { needed, target } = modelTarget(settings, rates);
  const next = { ...state, mu: rates.mu, previous: observation };
  const current = observation.desired;
  const capped = needed > settings.max ? ` (needs ${needed}, capped at ${settings.max})` : '';
  const facts = { lambda: rates.lambda, mu: rates.mu, needed };
  if (target > current) {
    return { ...facts, target, reason: 'scale out' + capped,
      state: { ...next, lowTicks: 0, lastChangeAt: observation.at, lastScaleOutAt: observation.at } };
  }
  // Scale out fast, scale in slowly. A new worker needs about three minutes to start, and the
  // 6.4HD E3 runs showed that scaling in sooner removed workers before they had done any work, then
  // added them again on the next burst.
  const sinceScaleOut = observation.at - (state.lastScaleOutAt ?? -Infinity);
  if (target < current && sinceScaleOut < settings.scaleInCooldownSeconds * 1000) {
    return { ...facts, target: current, reason: 'hold, workers added less than '
      + settings.scaleInCooldownSeconds + ' s ago', state: { ...next, lowTicks: 0 } };
  }
  // Scale in only once the queue is nearly empty. Shrinking while a backlog remains would slow the
  // tail of the drain, because the model always plans to finish the rest in drainSeconds.
  if (target < current && observation.backlog > settings.scaleInBacklog) {
    return { ...facts, target: current, reason: 'hold, backlog still draining', state: { ...next, lowTicks: 0 } };
  }
  if (target < current) {
    const lowTicks = (state.lowTicks || 0) + 1;
    if (lowTicks >= settings.scaleInTicks) {
      return { ...facts, target, reason: 'scale in', state: { ...next, lowTicks: 0, lastChangeAt: observation.at } };
    }
    return { ...facts, target: current, reason: `hold, lower for ${lowTicks} of ${settings.scaleInTicks} checks`, state: { ...next, lowTicks } };
  }
  return { ...facts, target: current, reason: 'hold' + capped, state: { ...next, lowTicks: 0 } };
}

// The 6.3D rule, driven by the same observations, so that only the policy changes.
function decideStep(settings, state, observation) {
  const current = observation.desired;
  const visible = observation.visible;
  const next = { ...state, previous: observation };
  const facts = { lambda: null, mu: null, needed: null };
  if (visible > settings.stepHigh) {
    const cooled = observation.at - (state.lastChangeAt ?? -Infinity) >= settings.stepCooldownSeconds * 1000;
    const step = visible > settings.stepHigher ? 2 : 1;
    const target = Math.min(settings.max, current + step);
    if (cooled && target > current) {
      return { ...facts, target, reason: `scale out +${step}`, state: { ...next, lowSince: null, lastChangeAt: observation.at } };
    }
    return { ...facts, target: current, reason: 'hold, cooling down', state: { ...next, lowSince: null } };
  }
  if (visible < settings.stepLow) {
    const lowSince = state.lowSince ?? observation.at;
    const longEnough = observation.at - lowSince >= settings.stepLowSeconds * 1000;
    const spaced = observation.at - (state.lastScaleInAt ?? -Infinity) >= settings.stepInSeconds * 1000;
    if (longEnough && spaced && current > settings.min) {
      return { ...facts, target: current - 1, reason: 'scale in -1', state: { ...next, lowSince, lastScaleInAt: observation.at } };
    }
    return { ...facts, target: current, reason: 'hold', state: { ...next, lowSince } };
  }
  return { ...facts, target: current, reason: 'hold', state: { ...next, lowSince: null } };
}

function decide(settings, state, observation) {
  return settings.policy === 'model' ? decideModel(settings, state, observation) : decideStep(settings, state, observation);
}

// AWS side

async function latestMetric(cloudwatch, queueName, metric, statistic, now) {
  const result = await cloudwatch.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/SQS',
    MetricName: metric,
    Dimensions: [{ Name: 'QueueName', Value: queueName }],
    StartTime: new Date(now - 5 * 60 * 1000),
    EndTime: new Date(now),
    Period: 60,
    Statistics: [statistic]
  }));
  const points = (result.Datapoints || []).sort((a, b) => b.Timestamp - a.Timestamp);
  return points.length ? points[0][statistic] : 0;
}

async function observe({ settings, sqs, cloudwatch, autoscaling, store, queueUrl, groupName, previousAt, now }) {
  const at = now();
  const group = (await autoscaling.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [groupName] })))
    .AutoScalingGroups?.[0];
  if (!group) throw new Error('Auto Scaling Group not found: ' + groupName);
  const inService = (group.Instances || []).filter(instance => instance.LifecycleState === 'InService').length;
  const applied = previousAt ? await store.countAppliedSince(previousAt) : 0;
  let visible;
  let inFlight;
  let arrivalRate;
  if (settings.source === 'sqs') {
    const attributes = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes || {};
    visible = Number(attributes.ApproximateNumberOfMessages || 0);
    inFlight = Number(attributes.ApproximateNumberOfMessagesNotVisible || 0);
  } else {
    const queueName = queueUrl.split('/').pop();
    visible = await latestMetric(cloudwatch, queueName, 'ApproximateNumberOfMessagesVisible', 'Average', at);
    inFlight = await latestMetric(cloudwatch, queueName, 'ApproximateNumberOfMessagesNotVisible', 'Average', at);
    arrivalRate = (await latestMetric(cloudwatch, queueName, 'NumberOfMessagesSent', 'Sum', at)) / 60;
  }
  return { at, visible, inFlight, backlog: visible + inFlight, applied, inService,
    desired: group.DesiredCapacity, ...(arrivalRate === undefined ? {} : { arrivalRate }) };
}

async function startScaler() {
  const settings = readSettings();
  const queueUrl = process.env.SQS_INVENTORY_QUEUE_URL;
  const groupName = process.env.SCALER_GROUP || 'shelfsense-inventory';
  if (!queueUrl) throw new Error('SQS_INVENTORY_QUEUE_URL is required');
  const region = process.env.AWS_REGION;
  const sqs = new SQSClient({ region });
  const cloudwatch = new CloudWatchClient({ region });
  const autoscaling = new AutoScalingClient({ region });
  const store = await MongoStore.connect(config.mongoUri);
  let state = { mu: settings.mu };
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  console.log('scaler ready: ' + JSON.stringify(settings));
  while (!stopping) {
    try {
      const observation = await observe({ settings, sqs, cloudwatch, autoscaling, store, queueUrl, groupName,
        previousAt: state.previous?.at, now: Date.now });
      const decision = decide(settings, state, observation);
      state = decision.state;
      if (decision.target !== observation.desired && !settings.dryRun) {
        await autoscaling.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: groupName,
          DesiredCapacity: decision.target, HonorCooldown: false }));
      }
      const row = { kind: 'scaler', at: new Date(observation.at).toISOString(), source: settings.source,
        policy: settings.policy, visible: observation.visible, inFlight: observation.inFlight,
        backlog: observation.backlog, applied: observation.applied, inService: observation.inService,
        desired: observation.desired, target: decision.target,
        lambda: decision.lambda === null ? null : Number(decision.lambda.toFixed(1)),
        mu: decision.mu === null ? null : Number(decision.mu.toFixed(1)), needed: decision.needed, reason: decision.reason };
      console.log(JSON.stringify(row));
      await store.saveScalerDecision(row).catch(error => console.error('scaler log write failed: ' + error.message));
    } catch (error) {
      console.error('scaler tick failed: ' + error.message);
    }
    await new Promise(resolve => setTimeout(resolve, settings.intervalSeconds * 1000));
  }
  sqs.destroy();
  cloudwatch.destroy();
  autoscaling.destroy();
  await store.close();
}

if (require.main === module) {
  startScaler().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULTS, decide, decideModel, decideStep, estimate, modelTarget, observe, readSettings };
