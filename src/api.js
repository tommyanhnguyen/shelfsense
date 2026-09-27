const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { createDeliveryService } = require('./services/delivery');
const { createReplenishmentService } = require('./services/replenishment');
const { authorize, verifyToken } = require('./shared/auth');
const config = require('./shared/config');
const { assertProductionConfig } = require('./shared/config');
const { MongoStore } = require('./shared/store');
const { openEventPublisher } = require('./shared/transport');

async function drainApprovalOutbox({ store, publish }) {
  const events = await store.listPendingApprovalEvents();
  let sent = 0;
  for (const event of events) {
    await publish(event);
    await store.markApprovalPublished(event.eventId);
    sent += 1;
  }
  return sent;
}


const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function securityHeaders(response) {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('strict-transport-security', 'max-age=31536000');
}

function bearerClaims(request, secret, now) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    const error = new Error('Bearer token is required');
    error.status = 401;
    throw error;
  }
  try {
    return verifyToken(header.slice(7), secret, now());
  } catch (cause) {
    const error = new Error(cause.message);
    error.status = 401;
    throw error;
  }
}

function requireAccess(claims, role, store) {
  try { return authorize(claims, role, store); } catch (cause) {
    const error = new Error(cause.message);
    error.status = 403;
    throw error;
  }
}

function requireAllStores(claims, role, stores) {
  if (!Array.isArray(stores) || stores.length === 0) return requireAccess(claims, role);
  for (const store of stores) requireAccess(claims, role, store);
}

function filterForClaims(rows, claims) {
  if (!claims || claims.stores === '*') return rows;
  const allowed = new Set(claims.stores || []);
  return rows.filter(row => row.stores?.length
    ? row.stores.every(store => allowed.has(store)) : allowed.has(row.store));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) throw new Error('Request body is too large');
  }
  return body ? JSON.parse(body) : {};
}

function createApiServer(options) {
  const { store, publish } = options;
  const deliveries = createDeliveryService({ store, publish });
  const replenishment = createReplenishmentService({ store, publish });
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '../public'));
  const authRequired = options.authRequired ?? config.apiAuthRequired;
  const authSecret = options.authSecret || config.apiAuthSecret;
  const now = options.now || Date.now;

  const handler = async (request, response) => {
    try {
      securityHeaders(response);
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) response.setHeader('cache-control', 'no-store');

      if (request.method === 'GET' && url.pathname === '/health') {
        const ready = store.isReady ? store.isReady() : true;
        return sendJson(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable' });
      }
      const claims = authRequired && url.pathname.startsWith('/api/')
        ? bearerClaims(request, authSecret, now)
        : null;

      const readers = {
        '/api/stock': () => store.listStock(),
        '/api/orders': () => store.listOrders(),
        '/api/alerts': () => store.listAlerts(),
        '/api/deliveries': () => store.listDeliveries()
      };
      if (request.method === 'GET' && readers[url.pathname]) {
        return sendJson(response, 200, filterForClaims(await readers[url.pathname](), claims));
      }

      const approval = url.pathname.match(/^\/api\/orders\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approval) {
        const input = await readJson(request);
        if (typeof input.approvedBy !== 'string' || !input.approvedBy.trim()) {
          return sendJson(response, 400, { error: 'approvedBy is required' });
        }

        const current = await store.getOrder(decodeURIComponent(approval[1]));
        if (!current) return sendJson(response, 404, { error: 'Order not found' });
        if (authRequired) requireAccess(claims, 'manager', current.store);
        if (current.status !== 'PENDING_APPROVAL') {
          return sendJson(response, 409, { error: 'Order is not pending approval' });
        }

        const order = await replenishment.approve(current.orderId, input.approvedBy.trim());
        return sendJson(response, 200, order);
      }

      const completion = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/complete$/);
      if (request.method === 'POST' && completion) {
        const deliveryId = decodeURIComponent(completion[1]);
        const current = await store.getDelivery(deliveryId);
        if (!current) {
          return sendJson(response, 404, { error: 'Delivery not found' });
        }
        if (authRequired) requireAllStores(claims, 'driver', current.stores || [current.store]);
        return sendJson(response, 200, await deliveries.complete(deliveryId));
      }

      const dispatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/dispatch$/);
      if (request.method === 'POST' && dispatch) {
        const deliveryId = decodeURIComponent(dispatch[1]);
        const current = await store.getDelivery(deliveryId);
        if (!current) return sendJson(response, 404, { error: 'Delivery not found' });
        if (authRequired) requireAllStores(claims, 'supplier', current.stores || [current.store]);
        return sendJson(response, 200, await deliveries.dispatch(deliveryId));
      }

      const start = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/start$/);
      if (request.method === 'POST' && start) {
        const deliveryId = decodeURIComponent(start[1]);
        const current = await store.getDelivery(deliveryId);
        if (!current) return sendJson(response, 404, { error: 'Delivery not found' });
        if (authRequired) requireAllStores(claims, 'driver', current.stores || [current.store]);
        return sendJson(response, 200, await deliveries.start(deliveryId));
      }

      const stopCompletion = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/stops\/([^/]+)\/complete$/);
      if (request.method === 'POST' && stopCompletion) {
        const deliveryId = decodeURIComponent(stopCompletion[1]);
        if (!await store.getDelivery(deliveryId)) return sendJson(response, 404, { error: 'Delivery not found' });
        if (authRequired) requireAccess(claims, 'driver', decodeURIComponent(stopCompletion[2]));
        return sendJson(response, 200, await deliveries.completeStop(
          deliveryId, decodeURIComponent(stopCompletion[2])
        ));
      }

      if (request.method !== 'GET') return sendJson(response, 404, { error: 'Not found' });
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(publicDir + path.sep) || !fs.existsSync(filePath)) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message });
    }
  };
  return options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : http.createServer(handler);
}

async function startApi() {
  if (process.env.EVENT_TRANSPORT === 'aws') assertProductionConfig(process.env, 'api');
  const store = await MongoStore.connect(config.mongoUri);
  const transport = await openEventPublisher('shelfsense-api-' + process.pid);
  const outbox = setInterval(() => drainApprovalOutbox({ store, publish: transport.publish })
    .catch(error => console.error('Outbox retry failed: ' + error.message)),
  Number(process.env.OUTBOX_INTERVAL_MS || 2000));
  outbox.unref();
  const server = createApiServer({
    store,
    publish: transport.publish,
    tls: config.tlsKeyFile && config.tlsCertFile ? {
      key: fs.readFileSync(config.tlsKeyFile), cert: fs.readFileSync(config.tlsCertFile)
    } : null
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });
  console.log((config.tlsKeyFile ? 'HTTPS' : 'HTTP') + ' API ready on port ' + config.port);
  return { transport, server, store };
}

if (require.main === module) {
  startApi().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { bearerClaims, createApiServer, drainApprovalOutbox, filterForClaims, readJson, startApi };
