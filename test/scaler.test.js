const assert = require('node:assert/strict');
const test = require('node:test');
const { decide, estimate, modelTarget, readSettings } = require('../src/scaler');

// A one-second queue model of the 6.3D burst: 205.5 events/s for 90 s, 41.3 events/s per worker,
// 120 s for a new worker to start. With the old step policy it drains in 342 s, which matches the
// 334 s measured on AWS, so the model is a fair place to compare policies before using the lab.
function simulate({ policy, source, rate = 205.5, duration = 90, mu = 41.3, bootSeconds = 120, max = 6 }) {
  const settings = readSettings({ SCALER_POLICY: policy, SCALER_SOURCE: source, SCALER_MAX: String(max), SCALER_MU: String(mu) });
  const readyAt = [0];
  const backlogBySecond = [];
  const arrivalsBySecond = [];
  let backlog = 0;
  let desired = 1;
  let appliedSinceCheck = 0;
  let state = { mu: settings.mu };
  let firstScaleOutAt = null;
  let firstTarget = null;
  let drainedAt = null;
  let instanceSeconds = 0;
  for (let second = 0; second < 1800 && drainedAt === null; second += 1) {
    const arriving = second < duration ? rate : 0;
    backlog += arriving;
    const ready = readyAt.filter(time => time <= second).length;
    const work = Math.min(backlog, ready * mu);
    backlog -= work;
    appliedSinceCheck += work;
    instanceSeconds += readyAt.length;
    backlogBySecond.push(backlog);
    arrivalsBySecond.push(arriving);
    if (second >= duration && backlog < 1) drainedAt = second;
    if (second % settings.intervalSeconds !== 0) continue;
    let observation = { at: second * 1000, visible: backlog, inFlight: 0, backlog, applied: appliedSinceCheck,
      inService: ready, desired };
    if (source === 'cloudwatch') {
      // CloudWatch reports the average of the last complete minute, about a minute late.
      const end = Math.max(0, Math.floor(second / 60) * 60 - 60);
      const minute = backlogBySecond.slice(Math.max(0, end - 60), end);
      const average = minute.length ? minute.reduce((a, b) => a + b, 0) / minute.length : 0;
      const sent = arrivalsBySecond.slice(Math.max(0, end - 60), end).reduce((a, b) => a + b, 0);
      observation = { ...observation, visible: average, backlog: average, arrivalRate: sent / 60 };
    }
    appliedSinceCheck = 0;
    const decision = decide(settings, state, observation);
    state = decision.state;
    if (decision.target > desired) {
      if (firstScaleOutAt === null) {
        firstScaleOutAt = second;
        firstTarget = decision.target;
      }
      for (let count = desired; count < decision.target; count += 1) readyAt.push(second + bootSeconds);
    } else if (decision.target < desired) {
      readyAt.splice(decision.target);
    }
    desired = decision.target;
  }
  return { drainedAt, firstScaleOutAt, firstTarget, instanceMinutes: Math.round(instanceSeconds / 60) };
}

test('rate model asks for arrivals plus backlog over the drain time, within the limits', () => {
  const settings = readSettings({ SCALER_MAX: '6', SCALER_MU: '40' });
  assert.deepEqual(modelTarget(settings, { lambda: 205, backlog: 1200, mu: 40 }), { needed: 6, target: 6 });
  assert.deepEqual(modelTarget(settings, { lambda: 0, backlog: 0, mu: 40 }), { needed: 0, target: 1 });
  assert.deepEqual(modelTarget(settings, { lambda: 400, backlog: 0, mu: 40 }), { needed: 10, target: 6 });
});

test('model policy scales out in one step and says when the maximum is too low', () => {
  const settings = readSettings({ SCALER_MAX: '4', SCALER_MU: '40' });
  const state = { mu: 40, previous: { at: 0, backlog: 0, inService: 1 } };
  const decision = decide(settings, state, { at: 10000, visible: 1650, inFlight: 10, backlog: 1660, applied: 400,
    inService: 1, desired: 1 });
  assert.equal(decision.target, 4);
  assert.match(decision.reason, /scale out \(needs \d+, capped at 4\)/);
});

test('model policy waits for three low checks before it scales in', () => {
  const settings = readSettings({ SCALER_MU: '40' });
  let state = { mu: 40 };
  const reasons = [];
  for (let tick = 1; tick <= 3; tick += 1) {
    const decision = decide(settings, state, { at: tick * 10000, visible: 0, inFlight: 0, backlog: 0, applied: 0,
      inService: 4, desired: 4 });
    state = decision.state;
    reasons.push(decision.target);
  }
  assert.deepEqual(reasons, [4, 4, 1]);
});

test('model policy does not scale in until new workers have had time to start', () => {
  const settings = readSettings({ SCALER_MU: '40' });
  let state = { mu: 40, lastScaleOutAt: 0 };
  const targets = [];
  for (let tick = 1; tick <= 40; tick += 1) {
    const decision = decide(settings, state, { at: tick * 10000, visible: 0, inFlight: 0, backlog: 0, applied: 0,
      inService: 4, desired: 4 });
    state = decision.state;
    targets.push(decision.target);
  }
  // Held for the 300 s cooldown after the scale out, then three low checks, then down to 1.
  assert.equal(targets.slice(0, 29).every(target => target === 4), true);
  assert.equal(targets.includes(1), true);
  assert.equal(targets.indexOf(1) >= 30, true);
});

test('worker rate is learned only while the workers are busy', () => {
  const settings = readSettings({ SCALER_MU: '40' });
  const busy = estimate(settings, { mu: 40, previous: { at: 0, backlog: 5000, inService: 2 } },
    { at: 10000, backlog: 5000, applied: 1600, inService: 2 });
  const idle = estimate(settings, { mu: 40, previous: { at: 0, backlog: 3, inService: 2 } },
    { at: 10000, backlog: 0, applied: 30, inService: 2 });
  assert.equal(busy.mu > 40, true);
  assert.equal(idle.mu, 40);
});

test('settings reject unknown policies and a minimum above the maximum', () => {
  assert.throws(() => readSettings({ SCALER_POLICY: 'guess' }));
  assert.throws(() => readSettings({ SCALER_SOURCE: 'email' }));
  assert.throws(() => readSettings({ SCALER_MIN: '5', SCALER_MAX: '2' }));
  assert.equal(readSettings({ SCALER_SOURCE: 'cloudwatch' }).intervalSeconds, 60);
});

test('queue model: the step policy on CloudWatch matches the 6.3D run, and each lever helps', () => {
  const baseline = simulate({ policy: 'step', source: 'cloudwatch', max: 4 });
  const fastDetection = simulate({ policy: 'step', source: 'sqs', max: 4 });
  const rateModel = simulate({ policy: 'model', source: 'cloudwatch' });
  const both = simulate({ policy: 'model', source: 'sqs' });

  assert.ok(baseline.drainedAt > 300 && baseline.drainedAt < 400, 'baseline drains in ' + baseline.drainedAt + ' s');
  assert.ok(both.firstScaleOutAt <= 20 && both.firstTarget >= 5, JSON.stringify(both));
  assert.ok(both.drainedAt < fastDetection.drainedAt);
  assert.ok(both.drainedAt < rateModel.drainedAt);
  assert.ok(fastDetection.drainedAt < baseline.drainedAt);
});

module.exports = { simulate };
