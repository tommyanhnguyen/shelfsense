const { validateEvent } = require('../shared/events');

function createColdChainService(options) {
  const { store, publish } = options;

  async function handle(event) {
    validateEvent(event);
    if (event.type !== 'coldchain.alert') throw new Error('Cold-chain expects coldchain.alert');

    await store.saveAlert(event);
    await publish(event);
    return event;
  }

  return { handle };
}

module.exports = { createColdChainService };
