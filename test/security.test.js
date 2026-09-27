const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const patterns = [
  ['AWS access key', /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['MongoDB credential', /mongodb(?:\+srv)?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['assigned secret', /^\s*(?:API_AUTH_SECRET|EVENT_SIGNING_SECRET|MQTT_PASSWORD)\s*=\s*[^\s#"']{8,}/]
];

function scanText(file, content) {
  const findings = [];
  content.split(/\r?\n/).forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, kind });
    }
  });
  return findings;
}

test('security scan reports credentials without repeating their values', () => {
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const findings = scanText('example.js', `const key = '${secret}';`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});

test('security scan accepts blank sample variables and detects embedded Mongo credentials', () => {
  assert.deepEqual(scanText('.env.example', 'MONGODB_URI=\nAPI_AUTH_SECRET=\n'), []);
  assert.equal(scanText('config.js', 'mongodb+srv://' + 'person:password@cluster.example/test').length, 1);
});

test('project files contain no credentials', () => {
  const root = path.join(__dirname, '..');
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  const findings = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const contents = fs.readFileSync(file);
    if (contents.includes(0) || contents.length > 2_000_000) continue;
    findings.push(...scanText(name, contents.toString('utf8')));
  }
  assert.deepEqual(findings, []);
});
