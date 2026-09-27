# ShelfSense

ShelfSense is the SIT314 IoT Distinction project. It tracks shelf stock and fridge temperature in supermarkets, predicts when a product will run out, creates supplier orders, and plans delivery routes. It uses Node.js, MQTT, Node-RED, MongoDB and AWS.

## How an event moves

```text
src/workload.js          simulated shelves, tills and fridges publish raw MQTT readings
  → node-red/            flows.json calls edge.js: shelf debounce, POS dedup, fridge breach
  → shelfsense/events/*  signed business events (HMAC)
  → src/service.js       runs one service: MQTT locally, SQS on AWS
  → src/services/        inventory → replenishment → delivery, and cold-chain
  → MongoDB              stock_events, stock_levels, orders, deliveries, coldchain
  → src/api.js           API with role tokens, portal in public/
```

1. **Edge.** A shelf opening creates a `stock.delta` event. Later weight changes need two stable readings across the debounce interval. A POS sale creates a demand event. Two hot fridge readings create one `coldchain.alert` breach, and cooling below the hysteresis limit clears it. Bad input goes to `shelfsense/dead-letter`.
2. **Inventory** records each event once through a unique `eventId`, then updates stock or sales velocity and publishes `stock.updated`. Only shelf, opening and delivery events change the physical quantity. POS sales only drive velocity, so a sale is never counted twice.
3. **Replenishment** orders stock when days to stock out fall below the supplier lead time plus a safety day. Small orders are approved automatically. A manager approves the rest through the API. The API retries unsent approvals from an outbox.
4. **Delivery** groups approved orders by supplier and region, plans a route, and emits a restock `stock.delta` for each delivered stop.
5. **Cold chain** stores each alert and sends a notification.

## Code map

| Folder or file | What it holds |
| --- | --- |
| `src/*.js` | Processes you can run: `broker`, `service`, `api`, `workload` |
| `src/services/` | The four microservices |
| `src/shared/` | Config, event rules and signing, MongoDB store, MQTT and AWS transport, auth |
| `node-red/` | Edge flow, edge logic and Node-RED launcher |
| `public/` | Portal |
| `test/` | One test file per part of the code, plus `local-flow` for the whole loop. `memory-store.js` is the in memory store used by tests |

## Run locally

```bash
npm ci
npm test
docker compose up --build -d
docker compose --profile demo run --rm simulator
```

The portal is at `http://localhost:3000` and Node-RED is at `http://localhost:1880`. Both bind to your computer only. The stack uses local MongoDB by default. Set `DOCKER_MONGODB_URI` in an ignored `.env` file to use Atlas. `docker compose down` stops the stack.

`npm test` also scans every project file for credentials. Run `npm audit --omit=dev --audit-level=high` for dependency advisories. To create a role token for the API, set `API_AUTH_SECRET` and run `npm run auth-token -- manager store-01`.

## AWS

The AWS deployment targets AWS Learner Lab. It uses EC2, SNS, SQS, an Application Load Balancer, an Auto Scaling Group for the inventory service, and CloudWatch. It is being built in `aws/`. Deployment and scaling still need live verification.
