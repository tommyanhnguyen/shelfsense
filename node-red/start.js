const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function prepareFlow(userDir, sourceFlow, username, password) {
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('MQTT username and password must be supplied together');
  }
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourceFlow, path.join(userDir, 'flows.json'));
  if (username) {
    fs.writeFileSync(path.join(userDir, 'flows_cred.json'),
      JSON.stringify({ 'local-broker': { user: username, password } }), { mode: 0o600 });
  }
  return path.join(userDir, 'flows.json');
}

function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfsense-red-'));
  const flow = prepareFlow(userDir, path.join(__dirname, 'flows.json'),
    process.env.MQTT_USERNAME, process.env.MQTT_PASSWORD);
  const child = spawn(process.env.NODE_RED_BIN || 'node-red',
    ['--settings', path.join(__dirname, 'settings.js'), '--userDir', userDir, flow],
    { stdio: 'inherit', env: { ...process.env, NODE_RED_EPHEMERAL_CREDENTIALS: 'true' } });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  const cleanup = () => fs.rmSync(userDir, { recursive: true, force: true });
  child.once('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code || 0; });
}

if (require.main === module) main();

module.exports = { prepareFlow };
