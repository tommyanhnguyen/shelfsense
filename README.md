# ShelfSense

ShelfSense is an event-driven IoT system for supermarkets. It watches shelf weight, till sales and fridge temperature, predicts when a product will run out, raises supplier orders, and plans delivery routes. It runs locally with Docker and on AWS, where a model-based scaler sizes the inventory workers from measured arrival and service rates.

Built by Tommy Nguyen.

**Stack:** Node.js 22, MQTT (Aedes), Node-RED 4, MongoDB 7, Amazon SNS and SQS, EC2 Auto Scaling, Application Load Balancer, CloudWatch.

## Results on AWS

The same burst was sent five times: 140 shelf readings per second for 240 seconds, which is 17,300 stock events (72 per second) after edge filtering. Each run started from one worker, with at most four. The first row is the v1.0 design, where CloudWatch alarms add workers one step at a time.

| Setup | Time to clear | p95 latency | Worker instance-minutes |
| --- | --- | --- | --- |
| v1.0 CloudWatch alarms | 415 s | 186 s | 39.8 |
| A: read SQS every 10 s | 266 s | 66 s | 31.4 |
| B: rate model on CloudWatch data | 341 s | 122 s | 38.3 |
| A+B | 240 s | 70 s | 24.7 |
| A+B+C: 8 events at once per worker | 241 s | 1.6 s | 14.1 |

Every run applied all 17,300 events, and no message reached a dead-letter queue. A+B and A+B+C cleared the burst in 240 s, the length of the burst itself, so they kept up as the events arrived. Time to clear runs from the first event sent to the last event applied; instance-minutes count from the start of the load until the group is back to one worker.

Capacity of one worker, measured by filling the queue first and then draining it:

| Worker setup | Events per second |
| --- | --- |
| 1 worker, one event at a time | 41 |
| 1 worker, 8 at once | about 207 |
| 2 workers, 8 at once | 419 (linear) |
| 4 workers, 8 at once | 513 (the single MongoDB is the limit, about 500) |

## How scaling works

`src/scaler.js` runs as a container on the core instance and replaces the alarms with one loop every 10 seconds:

- **A. Fast detection.** It reads the SQS backlog directly instead of waiting for the one-minute CloudWatch metric, which arrives two to three minutes late.
- **B. One-step sizing.** It measures the arrival rate λ and the rate μ of one worker, and sets the group to N = ⌈(λ + backlog / 60 s) / μ⌉, between the minimum and maximum. It scales out at once and scales in only 300 seconds after the last scale out, after three low checks in a row.
- **C. Keyed concurrency.** Each worker applies up to `QUEUE_CONCURRENCY` events at once, but events for the same shelf (store and SKU) still run one at a time, in order.

The load tests also found five problems that only show up under sustained load. All are fixed:

1. Each stock row kept every applied event id as a retry guard and grew without limit. It now keeps the last 600.
2. Node-RED rewrote its whole state file on every reading, so the edge slowed down over time. It now saves at most once a second.
3. The scaler scaled in before new workers had started. It now waits 300 seconds.
4. On scale in, the group removed the oldest (warm) worker. It now removes the newest.
5. The worker rate was learned from messages a worker was only holding. It is now learned only while messages are still waiting.

## Architecture

```text
EC2 edge   simulated sensors → MQTT broker → Node-RED edge logic → bridge
                                                                     │ signed events
                                                                     ▼
AWS        SNS topic shelfsense-events, filtered by event type
             ├─ SQS inventory      → inventory workers (Auto Scaling Group, sized by the scaler)
             ├─ SQS replenishment  ┐
             ├─ SQS coldchain      ├─ services on EC2 core
             └─ SQS delivery       ┘
           each queue has a dead-letter queue and server-side encryption

EC2 core   API and portal (reachable only through the ALB on port 80) and the scaler
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
| `src/scaler.js` | Model-based scaler for the inventory workers |
| `src/workload.js` | Demo simulator and paced load generator |
| `src/services/` | Inventory, replenishment, cold chain and delivery |
| `src/shared/` | Config, event rules and signing, MongoDB store, transport, auth |
| `node-red/` | Edge flow, edge logic and the Node-RED launcher |
| `public/` | Portal (plain HTML, CSS and JavaScript, no build step) |
| `aws/` | `setup.sh` for deployment and experiments, `user-data.sh` for each EC2 role |
| `test/` | 120 tests, one file per part of the code, a queue model for the scaler, and a full local loop |

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
./aws/setup.sh workers      # inventory Auto Scaling Group and the v1.0 alarms
./aws/setup.sh demo
./aws/setup.sh portal
```

Other commands:

| Command | What it does |
| --- | --- |
| `status` | Portal URL, instance IPs, worker count and queue depth |
| `load <runId> <rate> <seconds>` | Sends paced load from the edge |
| `results <runId>` | Processed events, throughput and p50/p95 latency from MongoDB |
| `scale <n> [fixed]` | Sets the maximum worker count, or fixes the group at n |
| `scaler <A\|B\|AB\|off\|log\|check> [max] [mu]` | Starts the scaler in one mode (the alarms pause while it runs), or shows its decisions |
| `concurrency <n>` | Sets how many events each worker applies at once |
| `worker <pause\|resume>` | Stops or starts the inventory containers, to measure drain rate |
| `health` | Checks CPU credit mode and whether the edge bridge is keeping up |
| `dbstats` | Shows the size of the stock rows |
| `security` | Runs the security checks |
| `logs <role> [container]` | Shows logs from an instance |
| `update <role>` | Pulls the latest code on an instance and restarts it |
| `tunnel` | Opens the Node-RED editor through SSH |
| `teardown` | Deletes everything |

To repeat the scaling comparison, start from one worker and an empty queue, choose a mode (`scaler off` with `scale 4` for the alarms, or `scaler AB 4 41`), run `load <runId> 140 240`, wait until the queue is empty and the group is back to one worker, then run `results <runId>`. For A+B+C, run `concurrency 8` first and give the scaler a worker rate of 207.

If the lab role cannot read Parameter Store, prefix the steps with `SECRETS_MODE=userdata` to pass the secrets in instance user data instead.

## Known limits

- The delivery map covers `store-01` to `store-04`. Load tests use up to 20 stores, so orders for other stores stay approved but are not routed.
- Instances use basic CloudWatch monitoring, which averages over five minutes, so short CPU peaks look lower than they were.
- MongoDB is a single instance. It caps the workers at about 500 events per second; a production system would use a replica set or shard by store.
- A new worker takes about two minutes to start, which is now the main delay when a burst begins.
