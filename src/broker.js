const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');

async function startBroker(port = Number(process.env.MQTT_PORT || 1883), credentials = {}) {
  const { Aedes } = require('aedes');
  const username = credentials.username ?? process.env.MQTT_USERNAME;
  const password = credentials.password ?? process.env.MQTT_PASSWORD;
  const options = {};

  if (username && password) {
    options.authenticate = (client, givenUser, givenPassword, done) => {
      const expected = Buffer.from(password);
      const supplied = Buffer.isBuffer(givenPassword) ? givenPassword : Buffer.from(givenPassword || '');
      const valid = givenUser === username && expected.length === supplied.length
        && timingSafeEqual(expected, supplied);
      done(null, valid);
    };
  }

  const aedes = await Aedes.createBroker(options);
  const server = net.createServer(aedes.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return { aedes, server, port: server.address().port };
}

if (require.main === module) {
  startBroker()
    .then(({ port }) => console.log('Broker ready on port ' + port))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { startBroker };
