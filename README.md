# ShelfSense

ShelfSense is an event-driven IoT system for supermarkets. It watches shelf weight, till sales and fridge temperature, predicts when a product will run out, raises supplier orders, and plans delivery routes. It runs locally with Docker and on AWS with an Auto Scaling Group that grows with the event backlog.

Built for SIT314 (Software Architecture and Scalability for IoT), Deakin University, by Tommy Nguyen.

**Stack:** Node.js 22, MQTT (Aedes), Node-RED 4, MongoDB 7, Amazon SNS and SQS, EC2 Auto Scaling, Application Load Balancer, CloudWatch.

## Results on AWS

The same load was sent twice: 400 shelf readings per second for 90 seconds, which is 18,500 stock events after edge filtering. The first run used one inventory worker. The second let the Auto Scaling Group add workers when the SQS backlog passed 300 messages.

| Measure | 1 worker | Auto scaling (up to 4) | Change |
| --- | --- | --- | --- |
| Events processed | 18,500 | 18,500 | none lost in either run |
| Time to drain the backlog | 447 s | 334 s | 25% faster |
| Throughput | 41.3 events/s | 55.4 events/s | 34% higher |
| p95 latency | 340 s | 242 s | 29% lower |
| Peak worker CPU | about 21% | about 21% | workers wait on I/O, not CPU |

The alarm added workers 1 to 3, then 3 to 4, and each new instance took about two minutes to start. When the queue emptied, a second alarm removed workers down to one. CPU stayed low in every run, so the service scales on queue depth: a CPU alarm would never have fired.

## Architecture

```text
EC2 edge   simulated sensors → MQTT broker → Node-RED edge logic → bridge
                                                                     │ signed events
                                                                     ▼
AWS        SNS topic shelfsense-events, filtered by event type
             ├─ SQS inventory      → inventory workers (Auto Scaling Group, 1 to 4)
             ├─ SQS replenishment  ┐
             ├─ SQS coldchain      ├─ services on EC2 core
             └─ SQS delivery       ┘
           each queue has a dead-letter queue and server-side encryption

EC2 core   API and portal, reachable only through the ALB on port 80
EC2 db     MongoDB, reachable only from core and the workers
```

Only inventory scales, because it receives almost every event. SQS hands each message to one worker, so a new worker takes its share at once. MQTT 3.1.1 has no shared subscriptions, which is why the edge hands events to SNS instead of feeding workers directly. MongoDB runs on EC2 because the Atlas free tier allows 100 operations per second and each stock event needs about five.

## How an event moves

1. **Edge (Node-RED).** A new shelf creates an opening stock event. Later weight changes must be stable across two readings before they count, which removes noise from a customer picking up and putting back a product. A till sale creates a demand event. Two hot fridge readings create one cold-chain breach, and it clears only after the temperature drops below the limit minus a hysteresis margin. Malformed input goes to `shelfsense/dead-letter`.
2. **Bridge.** Checks each event (schema, topic and HMAC signature) and forwards it to SNS. A tampered or unsigned event goes to the dead-letter topic instead.
3. **Inventory.** Records each event once by its unique `eventId`, so a redelivered message never changes stock twice. It updates the quantity and sales velocity and publishes `stock.updated`.
4. **Replenishment.** Orders stock when days of cover fall below the supplier lead time plus one safety day. Orders under $150 are approved automatically. The manager approves the rest. A store keeps one open order per product until it is delivered.
5. **Delivery.** Groups approved orders by supplier and region. The supplier plans a nearest-neighbour route with ETAs, the driver starts it, and each delivered stop restocks the shelf through a new stock event.
6. **Cold chain.** Stores each alert and sends a notification.

## Portal

The portal is served by the API. It has a role switcher for manager, supplier and driver, and each role only sees its own actions as active:

- **Manager:** approves orders.
- **Supplier:** plans and dispatches delivery batches.
- **Driver:** starts routes and confirms each stop.

Every screen refreshes every five seconds. It only redraws a section when its data changes, so scroll position stays put.

On AWS, `./aws/setup.sh portal` opens the portal already signed in as all three roles for one hour. The tokens sit after the `#` in the link, so the browser never sends them to the load balancer. The page moves them into session storage and clears them from the address bar. Locally, authentication is off, so the portal opens without a sign-in.

## Security

| Layer | Control |
| --- | --- |
| Devices | MQTT username and password; broker port closed to the internet |
| Events | HMAC-SHA256 signature on every business event; bad events go to dead-letter |
| API | Signed role tokens with expiry; checks on role and store scope (401 and 403) |
| Network | Security groups: API only from the ALB, MongoDB only from core and workers, Node-RED bound to localhost |
| Secrets | Generated at deploy time and kept in SSM Parameter Store as SecureString |
| Data | SQS server-side encryption; SQS queue policies accept messages only from the ShelfSense topic |
| Instances | IMDSv2 required; no secrets in the repository (`npm test` scans for them) |

`./aws/setup.sh security` tries each attack in turn (missing or forged token, wrong role, wrong password, tampered event, direct port access) and prints the result.

## Code map

| Path | What it holds |
| --- | --- |
| `src/api.js` | REST API, portal hosting and the approval outbox |
| `src/broker.js` | MQTT broker with password check |
| `src/bridge.js` | Edge to SNS bridge with event checks |
| `src/service.js` | Runs one microservice, over MQTT locally or SQS on AWS |
| `src/workload.js` | Demo simulator and paced load generator |
| `src/services/` | Inventory, replenishment, cold chain and delivery |
| `src/shared/` | Config, event rules and signing, MongoDB store, transport, auth |
| `node-red/` | Edge flow, edge logic and the Node-RED launcher |
| `public/` | Portal (plain HTML, CSS and JavaScript, no build step) |
| `aws/` | `setup.sh` for deployment and experiments, `user-data.sh` for each EC2 role |
| `test/` | 105 tests, one file per part of the code, plus a full local loop |

## Run locally

```bash
npm ci
npm test
docker compose up --build -d
docker compose --profile demo run --rm simulator
```

The portal is at `http://localhost:3000` and Node-RED at `http://localhost:1880`. Both bind to your computer only. `docker compose down -v` stops the stack and clears its data. To use Atlas instead of local MongoDB, set `DOCKER_MONGODB_URI` in an ignored `.env` file.

GitHub Actions runs `npm test` and `npm audit` on every push.

## Deploy on AWS Learner Lab

You need the AWS CLI, Node.js and the lab key. Put the key at `aws/labsuser.pem` and run `chmod 400 aws/labsuser.pem`. Copy the AWS CLI block from AWS Details and run `pbpaste > aws/credentials`. Every local file the script writes stays in `aws/` and is ignored by git.

```bash
./aws/setup.sh secrets      # random secrets, stored in Parameter Store
./aws/setup.sh check
./aws/setup.sh messaging    # SNS topic, SQS queues and dead-letter queues
./aws/setup.sh network      # security groups
./aws/setup.sh db
./aws/setup.sh core         # API, services and ALB
./aws/setup.sh edge         # broker, Node-RED and bridge
./aws/setup.sh workers      # inventory Auto Scaling Group and alarms
./aws/setup.sh demo
./aws/setup.sh portal
```

Other commands:

| Command | What it does |
| --- | --- |
| `status` | Portal URL, instance IPs, worker count and queue depth |
| `load <runId> <rate> <seconds>` | Sends paced load from the edge |
| `results <runId>` | Processed events, throughput and p50/p95 latency from MongoDB |
| `scale <n>` | Sets the worker count by hand |
| `security` | Runs the security checks |
| `logs <role> [container]` | Shows logs from an instance |
| `update <role>` | Pulls the latest code on an instance and restarts it |
| `tunnel` | Opens the Node-RED editor through SSH |
| `teardown` | Deletes everything |

To repeat the scaling experiment, run `load calib 400 90` with one worker, then `load scaled 400 90` with the alarms active, and compare `results calib` with `results scaled`.

If the lab role cannot read Parameter Store, prefix the steps with `SECRETS_MODE=userdata` to pass the secrets in instance user data instead.

## Known limits

- The delivery map covers `store-01` to `store-04`. Load tests use up to 20 stores, so orders for other stores stay approved but are not routed.
- Instances use basic CloudWatch monitoring, which averages over five minutes, so short CPU peaks look lower than they were.
- MongoDB is a single instance. A production system would use a replica set or a managed service.
