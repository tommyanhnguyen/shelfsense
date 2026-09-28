#!/usr/bin/env bash
# ShelfSense on AWS Learner Lab. Run from anywhere: ./aws/setup.sh <step>
# Steps in order: secrets, check, messaging, network, db, core, edge, workers, demo.
# Experiment: scale, concurrency, scaler, load, results. Evidence: security. Other: status, portal, token, tunnel, logs, update, teardown.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_DEFAULT_REGION=$AWS_REGION
export AWS_PAGER=""
# Every file this script keeps on your computer lives in aws/ and is ignored by git:
# credentials (lab keys you paste), .env.aws (secrets), .state (resource ids), .known_hosts (SSH).
if [ -f aws/credentials ]; then export AWS_SHARED_CREDENTIALS_FILE="$PWD/aws/credentials"; fi
P=shelfsense
KEY_NAME=${KEY_NAME:-vockey}
KEY_FILE=${KEY_FILE:-aws/labsuser.pem}
REPO_URL=${REPO_URL:-https://github.com/tommyanhnguyen/shelfsense.git}
REPO_REF=${REPO_REF:-main}
PROFILE=${INSTANCE_PROFILE:-LabInstanceProfile}
SECRETS_MODE=${SECRETS_MODE:-ssm}
INSTANCE_TYPE=${INSTANCE_TYPE:-t3.small}
SCALE_OUT_BACKLOG=${SCALE_OUT_BACKLOG:-300}
SCALE_IN_BACKLOG=${SCALE_IN_BACKLOG:-20}
STATE=aws/.state
SECRETS=aws/.env.aws
SECRET_NAMES="MONGO_PASSWORD MQTT_PASSWORD EVENT_SIGNING_SECRET API_AUTH_SECRET"
QUEUES="inventory:stock.delta replenishment:stock.updated coldchain:coldchain.alert delivery:order.approved"

touch "$STATE"
say() { printf '\n== %s\n' "$*"; }
ok() { printf '   OK   %s\n' "$*"; }
fail() { printf '   FAIL %s\n' "$*" >&2; exit 1; }
get() { { grep -E "^$1=" "$STATE" || true; } | tail -1 | cut -d= -f2-; }
put() { { grep -v -E "^$1=" "$STATE" || true; } > "$STATE.tmp"; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
need() { local value; value=$(get "$1"); [ -n "$value" ] || fail "$1 is missing, run ./aws/setup.sh $2 first"; echo "$value"; }
secret() { { grep -E "^$1=" "$SECRETS" || true; } | cut -d= -f2-; }
SSH_OPTS=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=aws/.known_hosts -o ConnectTimeout=8 -o LogLevel=ERROR)
public_ip() {
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$P-$1" Name=instance-state-name,Values=running \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}
on() { local role=$1; shift; local ip; ip=$(public_ip "$role"); [ "$ip" != None ] || fail "no running $role instance"; ssh "${SSH_OPTS[@]}" "ec2-user@$ip" "$@"; }

cmd_check() {
  say "Checking your computer and the lab"
  command -v aws >/dev/null || fail "AWS CLI is not installed"
  ok "$(aws --version 2>&1 | cut -d' ' -f1)"
  command -v node >/dev/null || fail "Node.js is not installed"
  local arn
  arn=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) \
    || fail "AWS credentials are missing or expired: copy them from AWS Details, then run: pbpaste > aws/credentials"
  ok "signed in as $arn"
  [ -f "$KEY_FILE" ] || fail "key file $KEY_FILE not found"
  [ "$(ls -l "$KEY_FILE" | cut -c1-10)" = "-r--------" ] || fail "run chmod 400 $KEY_FILE"
  ok "key file $KEY_FILE"
  aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1 || fail "key pair $KEY_NAME not found in $AWS_REGION"
  ok "key pair $KEY_NAME"
  [ "$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)" != None ] \
    || fail "no default VPC in $AWS_REGION"
  ok "default VPC"
  [ -f "$SECRETS" ] || fail "run ./aws/setup.sh secrets first"
  ok "secrets file $SECRETS"
  if [ "$SECRETS_MODE" = ssm ]; then
    aws ssm get-parameter --name "/$P/MQTT_PASSWORD" --with-decryption >/dev/null 2>&1 \
      || fail "Parameter Store has no secrets: run ./aws/setup.sh secrets, or use SECRETS_MODE=userdata"
    ok "secrets in Parameter Store"
  fi
  local remote
  remote=$(git ls-remote "$REPO_URL" "refs/heads/$REPO_REF" | cut -f1)
  if [ "$remote" = "$(git rev-parse HEAD)" ]; then ok "GitHub $REPO_REF matches your local commit"
  else printf '   WARN EC2 clones %s from GitHub, which differs from your local HEAD. Push first.\n' "$REPO_REF"; fi
}

cmd_secrets() {
  say "Secrets"
  if [ ! -f "$SECRETS" ]; then
    (umask 077; for name in $SECRET_NAMES; do echo "$name=$(openssl rand -hex 24)"; done; echo "ALERT_EMAIL=") > "$SECRETS"
    ok "created $SECRETS with random values (ignored by git)"
  else
    ok "keeping existing $SECRETS"
  fi
  if [ "$SECRETS_MODE" = ssm ]; then
    for name in $SECRET_NAMES; do
      aws ssm put-parameter --name "/$P/$name" --type SecureString --value "$(secret "$name")" --overwrite >/dev/null
      ok "stored /$P/$name in Parameter Store"
    done
  fi
}

cmd_messaging() {
  say "SNS topics, SQS queues and log groups"
  local events alerts
  events=$(aws sns create-topic --name "$P-events" --query TopicArn --output text)
  alerts=$(aws sns create-topic --name "$P-alerts" --query TopicArn --output text)
  put SNS_EVENT_TOPIC_ARN "$events"
  put SNS_ALERT_TOPIC_ARN "$alerts"
  ok "topics $P-events and $P-alerts"
  local pair name type dlq dlq_arn attrs url arn policy
  for pair in $QUEUES; do
    name=${pair%%:*}
    type=${pair#*:}
    dlq=$(aws sqs create-queue --queue-name "$P-$name-dlq" \
      --attributes SqsManagedSseEnabled=true,MessageRetentionPeriod=1209600 --query QueueUrl --output text)
    dlq_arn=$(aws sqs get-queue-attributes --queue-url "$dlq" --attribute-names QueueArn --query Attributes.QueueArn --output text)
    attrs=$(node -e 'console.log(JSON.stringify({SqsManagedSseEnabled: "true", VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({deadLetterTargetArn: process.argv[1], maxReceiveCount: "5"})}))' "$dlq_arn")
    url=$(aws sqs create-queue --queue-name "$P-$name" --attributes "$attrs" --query QueueUrl --output text)
    arn=$(aws sqs get-queue-attributes --queue-url "$url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
    policy=$(node -e 'console.log(JSON.stringify({Policy: JSON.stringify({Version: "2012-10-17", Statement: [{
      Effect: "Allow", Principal: {Service: "sns.amazonaws.com"}, Action: "sqs:SendMessage", Resource: process.argv[1],
      Condition: {ArnEquals: {"aws:SourceArn": process.argv[2]}}}]})}))' "$arn" "$events")
    aws sqs set-queue-attributes --queue-url "$url" --attributes "$policy"
    aws sns subscribe --topic-arn "$events" --protocol sqs --notification-endpoint "$arn" --return-subscription-arn \
      --attributes "$(node -e 'console.log(JSON.stringify({RawMessageDelivery: "true",
        FilterPolicy: JSON.stringify({eventType: [process.argv[1]]})}))' "$type")" >/dev/null
    put "SQS_$(echo "$name" | tr '[:lower:]' '[:upper:]')_QUEUE_URL" "$url"
    ok "queue $P-$name with dead letter queue, receives $type"
  done
  local email
  email=$(secret ALERT_EMAIL)
  if [ -n "$email" ]; then
    aws sns subscribe --topic-arn "$alerts" --protocol email --notification-endpoint "$email" >/dev/null
    ok "alert email $email subscribed: confirm it from your inbox"
  fi
  local role
  for role in edge core worker; do
    aws logs create-log-group --log-group-name "/$P/$role" 2>/dev/null || true
    aws logs put-retention-policy --log-group-name "/$P/$role" --retention-in-days 7 2>/dev/null || true
  done
  ok "log groups /$P/edge, /$P/core, /$P/worker"
}

security_group() {
  local name=$1 vpc=$2 id
  id=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$P-$name" "Name=vpc-id,Values=$vpc" \
    --query 'SecurityGroups[0].GroupId' --output text)
  if [ "$id" = None ]; then
    id=$(aws ec2 create-security-group --group-name "$P-$name" --description "ShelfSense $name" --vpc-id "$vpc" \
      --query GroupId --output text)
  fi
  echo "$id"
}

allow() {
  local sg=$1 port=$2 source=$3 out
  if [[ $source == sg-* ]]; then
    out=$(aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port "$port" --source-group "$source" 2>&1) || true
  else
    out=$(aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port "$port" --cidr "$source" 2>&1) || true
  fi
  case "$out" in *Duplicate*|*'"Return": true'*|'') ;; *) fail "$out" ;; esac
}

cmd_network() {
  say "Network and security groups"
  local vpc myip subnets alb edge core worker db
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  subnets=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" Name=default-for-az,Values=true \
    --query 'Subnets[].[AvailabilityZone,SubnetId]' --output text | sort | head -2 | cut -f2)
  put VPC_ID "$vpc"
  put SUBNET_A "$(echo "$subnets" | sed -n 1p)"
  put SUBNET_B "$(echo "$subnets" | sed -n 2p)"
  myip="$(curl -s https://checkip.amazonaws.com)/32"
  alb=$(security_group alb "$vpc"); edge=$(security_group edge "$vpc"); core=$(security_group core "$vpc")
  worker=$(security_group worker "$vpc"); db=$(security_group db "$vpc")
  allow "$alb" 80 0.0.0.0/0
  allow "$core" 3000 "$alb"
  allow "$db" 27017 "$core"
  allow "$db" 27017 "$worker"
  for sg in "$edge" "$core" "$worker" "$db"; do allow "$sg" 22 "$myip"; done
  put SG_ALB "$alb"; put SG_EDGE "$edge"; put SG_CORE "$core"; put SG_WORKER "$worker"; put SG_DB "$db"
  ok "ALB open on port 80; API only from the ALB; MongoDB only from core and workers"
  ok "SSH only from your IP $myip"
}

ami() {
  aws ec2 describe-images --owners amazon --filters 'Name=name,Values=al2023-ami-2023.*-x86_64' Name=state,Values=available \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text
}

user_data() {
  local role=$1 key value name
  echo '#!/bin/bash'
  echo "export ROLE=$role AWS_REGION=$AWS_REGION REPO_URL=$REPO_URL REPO_REF=$REPO_REF"
  for key in DB_HOST SNS_EVENT_TOPIC_ARN SNS_ALERT_TOPIC_ARN SQS_INVENTORY_QUEUE_URL SQS_REPLENISHMENT_QUEUE_URL \
    SQS_COLDCHAIN_QUEUE_URL SQS_DELIVERY_QUEUE_URL QUEUE_CONCURRENCY; do
    value=$(get "$key")
    [ -z "$value" ] || echo "export $key='$value'"
  done
  if [ "$SECRETS_MODE" = userdata ]; then
    for name in $SECRET_NAMES; do echo "export $name='$(secret "$name")'"; done
  fi
  tail -n +2 aws/user-data.sh
}

launch() {
  local role=$1 sg=$2 existing id subnet image
  subnet=$(need SUBNET_A network)
  existing=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$P-$role" \
    Name=instance-state-name,Values=pending,running --query 'Reservations[0].Instances[0].InstanceId' --output text)
  if [ "$existing" != None ]; then ok "$P-$role already running ($existing)"; put "$(echo "$role" | tr "[:lower:]" "[:upper:]")_ID" "$existing"; return; fi
  image=$(ami)
  id=$(aws ec2 run-instances --image-id "$image" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --iam-instance-profile "Name=$PROFILE" --security-group-ids "$sg" --subnet-id "$subnet" \
    --user-data "$(user_data "$role")" --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2 \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$P-$role},{Key=Project,Value=$P}]" \
    --query 'Instances[0].InstanceId' --output text)
  aws ec2 wait instance-running --instance-ids "$id"
  put "$(echo "$role" | tr "[:lower:]" "[:upper:]")_ID" "$id"
  ok "$P-$role running ($id)"
}

wait_ready() {
  local role=$1
  printf '   ...  waiting for %s to finish its setup (a few minutes)' "$role"
  for _ in $(seq 1 60); do
    if on "$role" 'test -f /opt/shelfsense/ready' 2>/dev/null; then printf '\n'; ok "$role setup finished"; return; fi
    printf '.'
    sleep 10
  done
  printf '\n'
  fail "$role did not finish. Read its log with ./aws/setup.sh logs $role"
}

cmd_db() {
  say "Database machine"
  local sg
  sg=$(need SG_DB network)
  launch db "$sg"
  put DB_HOST "$(aws ec2 describe-instances --instance-ids "$(get DB_ID)" \
    --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
  wait_ready db
  ok "MongoDB with a password at $(get DB_HOST):27017, reachable only inside the VPC"
}

cmd_core() {
  say "Core machine and load balancer"
  need DB_HOST db >/dev/null
  need SQS_REPLENISHMENT_QUEUE_URL messaging >/dev/null
  local sg vpc subnet_a subnet_b sg_alb id tg alb dns
  sg=$(need SG_CORE network); vpc=$(need VPC_ID network); sg_alb=$(need SG_ALB network)
  subnet_a=$(need SUBNET_A network); subnet_b=$(need SUBNET_B network)
  launch core "$sg"
  id=$(get CORE_ID)
  tg=$(aws elbv2 create-target-group --name "$P-api" --protocol HTTP --port 3000 --vpc-id "$vpc" \
    --health-check-path /health --health-check-interval-seconds 15 --healthy-threshold-count 2 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  aws elbv2 register-targets --target-group-arn "$tg" --targets "Id=$id"
  alb=$(aws elbv2 create-load-balancer --name "$P-alb" --subnets "$subnet_a" "$subnet_b" \
    --security-groups "$sg_alb" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  if [ "$(aws elbv2 describe-listeners --load-balancer-arn "$alb" --query 'length(Listeners)' --output text)" = 0 ]; then
    aws elbv2 create-listener --load-balancer-arn "$alb" --protocol HTTP --port 80 \
      --default-actions "Type=forward,TargetGroupArn=$tg" >/dev/null
  fi
  dns=$(aws elbv2 describe-load-balancers --load-balancer-arns "$alb" --query 'LoadBalancers[0].DNSName' --output text)
  put TG_ARN "$tg"; put ALB_ARN "$alb"; put ALB_URL "http://$dns"
  wait_ready core
  printf '   ...  waiting for the ALB target to be healthy\n'
  aws elbv2 wait target-in-service --target-group-arn "$tg" --targets "Id=$id"
  ok "portal and API at http://$dns"
}

cmd_edge() {
  say "Edge machine (broker, Node-RED, bridge)"
  need SNS_EVENT_TOPIC_ARN messaging >/dev/null
  local sg
  sg=$(need SG_EDGE network)
  launch edge "$sg"
  wait_ready edge
  ok "Node-RED editor: run ./aws/setup.sh tunnel, then open http://localhost:1880"
}

worker_template() {
  # Launch template for inventory workers. A new version is made whenever the user data changes,
  # for example after ./aws/setup.sh concurrency, so workers launched later get the same settings.
  local sg=$1 data image
  image=$(ami)
  data=$(AMI="$image" TYPE="$INSTANCE_TYPE" KEY="$KEY_NAME" PROFILE="$PROFILE" SG="$sg" \
    USER_DATA="$(user_data worker | base64 | tr -d '\n')" node -e 'const e = process.env; console.log(JSON.stringify({
    ImageId: e.AMI, InstanceType: e.TYPE, KeyName: e.KEY, IamInstanceProfile: {Name: e.PROFILE},
    SecurityGroupIds: [e.SG], UserData: e.USER_DATA,
    MetadataOptions: {HttpTokens: "required", HttpPutResponseHopLimit: 2},
    TagSpecifications: [{ResourceType: "instance", Tags: [{Key: "Name", Value: "shelfsense-worker"}, {Key: "Project", Value: "shelfsense"}]}]}))')
  if aws ec2 describe-launch-templates --launch-template-names "$P-worker" >/dev/null 2>&1; then
    aws ec2 create-launch-template-version --launch-template-name "$P-worker" --launch-template-data "$data" >/dev/null
    ok "launch template $P-worker updated"
  else
    aws ec2 create-launch-template --launch-template-name "$P-worker" --launch-template-data "$data" >/dev/null
    ok "launch template $P-worker created"
  fi
}
cmd_workers() {
  say "Inventory workers: launch template and Auto Scaling Group"
  local high low queue sg subnet_a subnet_b
  sg=$(need SG_WORKER network); subnet_a=$(need SUBNET_A network); subnet_b=$(need SUBNET_B network)
  need SNS_EVENT_TOPIC_ARN messaging >/dev/null; need DB_HOST db >/dev/null
  worker_template "$sg"
  if [ "$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$P-inventory" \
    --query 'length(AutoScalingGroups)' --output text)" = 0 ]; then
    aws autoscaling create-auto-scaling-group --auto-scaling-group-name "$P-inventory" \
      --launch-template "LaunchTemplateName=$P-worker,Version=\$Latest" --min-size 1 --max-size 1 --desired-capacity 1 \
      --vpc-zone-identifier "$subnet_a,$subnet_b" --default-instance-warmup 60 \
      --tags "Key=Project,Value=$P,PropagateAtLaunch=true"
  fi
  aws autoscaling enable-metrics-collection --auto-scaling-group-name "$P-inventory" --granularity 1Minute
  ok "Auto Scaling Group $P-inventory: min 1, max 1 until you run ./aws/setup.sh scale"
  high=$(aws autoscaling put-scaling-policy --auto-scaling-group-name "$P-inventory" --policy-name "$P-scale-out" \
    --policy-type StepScaling --adjustment-type ChangeInCapacity --metric-aggregation-type Average \
    --estimated-instance-warmup 120 --step-adjustments \
    MetricIntervalLowerBound=0,MetricIntervalUpperBound=2000,ScalingAdjustment=1 \
    MetricIntervalLowerBound=2000,ScalingAdjustment=2 --query PolicyARN --output text)
  low=$(aws autoscaling put-scaling-policy --auto-scaling-group-name "$P-inventory" --policy-name "$P-scale-in" \
    --policy-type StepScaling --adjustment-type ChangeInCapacity --metric-aggregation-type Average \
    --step-adjustments MetricIntervalUpperBound=0,ScalingAdjustment=-1 --query PolicyARN --output text)
  queue="$P-inventory"
  aws cloudwatch put-metric-alarm --alarm-name "$P-backlog-high" --namespace AWS/SQS \
    --metric-name ApproximateNumberOfMessagesVisible --dimensions "Name=QueueName,Value=$queue" --statistic Average \
    --period 60 --evaluation-periods 1 --threshold "$SCALE_OUT_BACKLOG" --comparison-operator GreaterThanThreshold \
    --alarm-actions "$high"
  aws cloudwatch put-metric-alarm --alarm-name "$P-backlog-low" --namespace AWS/SQS \
    --metric-name ApproximateNumberOfMessagesVisible --dimensions "Name=QueueName,Value=$queue" --statistic Average \
    --period 60 --evaluation-periods 3 --threshold "$SCALE_IN_BACKLOG" --comparison-operator LessThanThreshold \
    --alarm-actions "$low"
  ok "scale out by 1 when the inventory backlog averages over $SCALE_OUT_BACKLOG for 1 minute (by 2 above +2000)"
  ok "scale in by 1 when it stays under $SCALE_IN_BACKLOG for 3 minutes"
}

cmd_scale() {
  local max=${1:?usage: ./aws/setup.sh scale <max workers> [fixed]}
  if [ "${2:-}" = fixed ]; then
    # Exactly N workers, nothing scales: used to measure throughput at a fixed size (HD E2).
    aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$P-inventory" --min-size "$max" --max-size "$max" --desired-capacity "$max"
    ok "inventory workers fixed at $max; wait until ./aws/setup.sh status shows $max running"
    return
  fi
  if [ "$max" = 1 ]; then
    aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$P-inventory" --min-size 1 --max-size 1 --desired-capacity 1
  else
    aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$P-inventory" --min-size 1 --max-size "$max"
  fi
  ok "inventory workers: min 1, max $max"
}

cmd_demo() {
  say "Small demo through AWS: 2 stores, shelves, POS and fridges"
  on edge 'sudo docker run --rm --network shelfsense --env-file /opt/shelfsense/app.env -e MQTT_URL=mqtt://broker:1883 shelfsense node src/workload.js demo'
  ok "now run ./aws/setup.sh portal to open the portal"
}

cmd_load() {
  local run=${1:?usage: ./aws/setup.sh load <runId> <readings per second> <seconds>} rate=${2:?rate} duration=${3:?seconds}
  say "Load run $run: $rate readings per second for $duration seconds (about $((rate / 2)) stock events per second)"
  echo "   start (UTC): $(date -u +%H:%M:%S). Note it for the CloudWatch time range."
  on edge "sudo docker rm -f load-$run >/dev/null 2>&1; sudo docker run -d --name load-$run --network shelfsense \
    --env-file /opt/shelfsense/app.env -e MQTT_URL=mqtt://broker:1883 -e RUN_ID=$run -e RATE=$rate -e DURATION=$duration \
    shelfsense node src/workload.js >/dev/null && sudo docker logs -f load-$run"
  echo "   end (UTC): $(date -u +%H:%M:%S). Wait for the queue to drain, then run ./aws/setup.sh results $run"
}

cmd_results() {
  local run=${1:?usage: ./aws/setup.sh results <runId>}
  [[ $run =~ ^[A-Za-z0-9]+$ ]] || fail "runId must be letters and digits"
  # The query is written to /tmp on the db machine, not on your computer.
  sed "s/__RUN_ID__/$run/" <<'JSEOF' | on db 'cat > /tmp/results.js'
const runId = '__RUN_ID__';
const rows = db.stock_events.find({ status: 'APPLIED', 'event.data.runId': runId },
  { 'event.data.wallTs': 1, appliedAt: 1 }).toArray();
const latency = rows.map(r => r.appliedAt - r.event.data.wallTs).filter(Number.isFinite).sort((a, b) => a - b);
const pick = p => latency.length ? latency[Math.min(latency.length - 1, Math.ceil(latency.length * p) - 1)] : null;
const sent = rows.map(r => r.event.data.wallTs).sort((a, b) => a - b);
const applied = rows.map(r => r.appliedAt).sort((a, b) => a - b);
const seconds = rows.length ? (applied[applied.length - 1] - sent[0]) / 1000 : 0;
// Drain rate: from the first event applied to the last. With the workers paused during the load
// (./aws/setup.sh worker pause), this is the true capacity of the workers, not the arrival rate.
const drainSeconds = rows.length > 1 ? (applied[applied.length - 1] - applied[0]) / 1000 : 0;
const perMinute = {};
for (const t of applied) { const m = new Date(t).toISOString().slice(11, 16); perMinute[m] = (perMinute[m] || 0) + 1; }
printjson({
  runId,
  processed: rows.length,
  stillProcessing: db.stock_events.countDocuments({ status: 'PROCESSING', 'event.data.runId': runId }),
  firstSentUtc: rows.length ? new Date(sent[0]).toISOString() : null,
  lastAppliedUtc: rows.length ? new Date(applied[applied.length - 1]).toISOString() : null,
  seconds,
  eventsPerSecond: seconds ? Number((rows.length / seconds).toFixed(1)) : null,
  drainSeconds,
  drainEventsPerSecond: drainSeconds ? Number((rows.length / drainSeconds).toFixed(1)) : null,
  p50LatencyMs: pick(0.5),
  p95LatencyMs: pick(0.95),
  maxLatencyMs: latency.length ? latency[latency.length - 1] : null,
  appliedPerMinuteUtc: perMinute
});
JSEOF
  on db 'sudo docker cp /tmp/results.js mongo:/tmp/results.js && sudo docker exec mongo sh -c "mongosh --quiet -u shelfsense -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin shelfsense /tmp/results.js"'
}

cmd_security() {
  # Evidence for the report: each check tries something an attacker would try and shows it is refused.
  local alb edge db core
  alb=$(need ALB_URL core); edge=$(public_ip edge); db=$(public_ip db); core=$(public_ip core)

  say "1. API: the portal rejects missing, forged and out-of-scope tokens"
  ALB="$alb" API_AUTH_SECRET="$(secret API_AUTH_SECRET)" node - <<'JSEOF'
const { createRoleToken, issueToken } = require('./src/shared/auth');
const secret = process.env.API_AUTH_SECRET;
const base = process.env.ALB;
const manager = createRoleToken({ role: 'manager', stores: '*', secret });
const call = async (label, path, token, method = 'GET') => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: method === 'POST' ? '{"approvedBy":"tester"}' : undefined });
  const body = await res.json().catch(() => ({}));
  const detail = Array.isArray(body) ? body.length + ' rows' : (body.error || body.status || '');
  console.log('   ' + String(res.status).padEnd(5) + label.padEnd(52) + detail);
  return body;
};
(async () => {
  await call('GET /api/stock with no token', '/api/stock');
  await call('GET /api/stock with a token signed by a wrong key', '/api/stock',
    issueToken({ role: 'manager', stores: '*' }, 'attacker-guessed-secret-000000000000'));
  const orders = await call('GET /api/orders as manager (allowed)', '/api/orders', manager);
  const order = Array.isArray(orders) ? orders[0] : null;
  if (!order) { console.log('   (no order yet, run ./aws/setup.sh demo first for the 403 checks)'); return; }
  const path = '/api/orders/' + encodeURIComponent(order.orderId) + '/approve';
  await call('approve order as a driver (wrong role)', path,
    createRoleToken({ role: 'driver', stores: '*', secret }), 'POST');
  const other = order.store === 'store-99' ? 'store-98' : 'store-99';
  await call('approve ' + order.store + ' order as manager of ' + other, path,
    createRoleToken({ role: 'manager', stores: other, secret }), 'POST');
})().catch(error => { console.error('   ' + error.message); process.exitCode = 1; });
JSEOF

  say "2. MQTT login, then 3. tampered and unsigned events (bridge sends them to dead-letter, not SNS)"
  on edge 'sudo docker run --rm -i --network shelfsense --env-file /opt/shelfsense/app.env -e MQTT_URL=mqtt://broker:1883 shelfsense node -' <<'JSEOF'
const { connectMqtt } = require('./src/shared/transport');
const { createEvent, signEvent } = require('./src/shared/events');
const url = process.env.MQTT_URL;
const tryLogin = async (label, username, password) => {
  try {
    const client = await connectMqtt(url, 'security-' + Date.now(), { username, password, reconnectPeriod: 0 });
    console.log('   ACCEPTED  ' + label); client.end(true);
  } catch (error) { console.log('   REFUSED   ' + label.padEnd(34) + error.message); }
};
(async () => {
  await tryLogin('wrong password', 'shelfsense', 'wrong-password');
  await tryLogin('no username or password', undefined, undefined);
  await tryLogin('correct password (control)', process.env.MQTT_USERNAME, process.env.MQTT_PASSWORD);
  console.log('');
  const client = await connectMqtt(url, 'security-' + Date.now(), { reconnectPeriod: 0 });
  await new Promise(resolve => client.subscribe('shelfsense/dead-letter', { qos: 1 }, resolve));
  const seen = [];
  client.on('message', (topic, payload) => {
    const row = JSON.parse(payload.toString());
    if (row.payload.includes('security-check')) seen.push(row);
  });
  const signed = signEvent(createEvent('stock.delta', 'store-1',
    { skuId: 'milk-1l', delta: -1, source: 'shelf', note: 'security-check' }), process.env.EVENT_SIGNING_SECRET);
  const tampered = structuredClone(signed); tampered.data.delta = -500;
  const unsigned = structuredClone(signed); delete unsigned.signature;
  client.publish('shelfsense/events/stock.delta', JSON.stringify(tampered), { qos: 1 });
  client.publish('shelfsense/events/stock.delta', JSON.stringify(unsigned), { qos: 1 });
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('   sent: delta changed from -1 to -500 after signing, and one event with no signature');
  for (const row of seen) console.log('   DEAD-LETTER  ' + row.sourceTopic + '  reason: ' + row.reason);
  if (seen.length !== 2) console.log('   expected 2 dead-letter messages, saw ' + seen.length);
  client.end(true);
})().catch(error => { console.error('   ' + error.message); process.exitCode = 1; });
JSEOF

  say "4. Network: internal ports are closed to the internet"
  EDGE="$edge" DB="$db" CORE="$core" node - <<'JSEOF'
const net = require('node:net');
const probe = (label, host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const done = result => { socket.destroy(); console.log('   ' + result.padEnd(9) + label + ' (' + host + ':' + port + ')'); resolve(); };
  socket.setTimeout(4000, () => done('BLOCKED'));
  socket.once('connect', () => done('OPEN'));
  socket.once('error', () => done('BLOCKED'));
});
(async () => {
  await probe('MQTT broker on edge', process.env.EDGE, 1883);
  await probe('Node-RED editor on edge', process.env.EDGE, 1880);
  await probe('MongoDB on db', process.env.DB, 27017);
  await probe('API directly on core, bypassing the ALB', process.env.CORE, 3000);
})();
JSEOF

  say "5. Secrets and encryption at rest"
  aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=/$P/" \
    --query 'Parameters[].[Name,Type]' --output text | awk '{print "   " $2 "  " $1}'
  local pair name url
  for pair in $QUEUES; do
    name=${pair%%:*}
    url=$(get "SQS_$(echo "$name" | tr '[:lower:]' '[:upper:]')_QUEUE_URL")
    [ -z "$url" ] || echo "   SQS $P-$name  SqsManagedSseEnabled=$(aws sqs get-queue-attributes --queue-url "$url" \
      --attribute-names SqsManagedSseEnabled --query 'Attributes.SqsManagedSseEnabled' --output text)"
  done
}
cmd_portal() {
  # One sign-in link for manager, supplier and driver. The tokens sit after '#', so the browser
  # keeps them and never sends them to the ALB. The portal moves them to sessionStorage at once.
  local alb key link role
  alb=$(need ALB_URL core); key=$(secret API_AUTH_SECRET)
  [ -n "$key" ] || fail "API_AUTH_SECRET is missing, run ./aws/setup.sh secrets first"
  link="$alb/#"
  for role in manager supplier driver; do
    link="$link$role=$(API_AUTH_SECRET="$key" node src/shared/auth.js "$role" '*')&"
  done
  link=${link%&}
  say "Portal sign-in link, valid for 1 hour"
  if command -v open >/dev/null 2>&1; then open "$link"; ok "opened $alb in your browser"
  else echo "   $link"; fi
}
cmd_concurrency() {
  local n=${1:?usage: ./aws/setup.sh concurrency <messages each worker handles at once, 1 to 64>} ip
  [[ $n =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le 64 ] || fail "concurrency must be a whole number from 1 to 64"
  say "Inventory worker concurrency: $n"
  put QUEUE_CONCURRENCY "$n"
  worker_template "$(need SG_WORKER network)"
  for ip in $(aws ec2 describe-instances --filters "Name=tag:Name,Values=$P-worker" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].PublicIpAddress' --output text); do
    ssh "${SSH_OPTS[@]}" "ec2-user@$ip" "sudo bash -c 'set -e; git -C /opt/shelfsense/app pull --ff-only -q; { grep \"^export \" /var/lib/cloud/instance/user-data.txt | grep -v QUEUE_CONCURRENCY; echo export QUEUE_CONCURRENCY=$n; tail -n +2 /opt/shelfsense/app/aws/user-data.sh; } > /opt/shelfsense/update.sh; bash /opt/shelfsense/update.sh'" \
      && ok "worker $ip restarted with concurrency $n"
  done
}
cmd_scaler() {
  # HD experiment: the model-based scaler on core replaces the CloudWatch alarms while it runs.
  # A = fast detection (read SQS every 10 s) with the old step rule; B = the rate model on the
  # one-minute CloudWatch metrics; AB = both. The worker rate mu comes from ./aws/setup.sh concurrency runs.
  local mode=${1:?usage: ./aws/setup.sh scaler <A|B|AB|dryrun|off|check|log> [max workers] [worker events/s]}
  local max=${2:-6} mu=${3:-40} source policy dry=false group="$P-inventory" queue
  queue=$(need SQS_INVENTORY_QUEUE_URL messaging)
  case "$mode" in
    off)
      on core 'sudo docker rm -f scaler >/dev/null 2>&1 || true'
      aws cloudwatch enable-alarm-actions --alarm-names "$P-backlog-high" "$P-backlog-low"
      ok "scaler stopped; the CloudWatch alarms are in charge again"; return ;;
    log)
      on core 'sudo docker logs scaler 2>&1 | grep "\"kind\":\"scaler\""'; return ;;
    check)
      say "Can the core machine's role (LabRole) do what the scaler needs?"
      on core "set -e; d=\$(aws autoscaling describe-auto-scaling-groups --region $AWS_REGION --auto-scaling-group-names $group --query 'AutoScalingGroups[0].DesiredCapacity' --output text); echo '   OK   describe group, desired '\$d; aws autoscaling set-desired-capacity --region $AWS_REGION --auto-scaling-group-name $group --desired-capacity \$d && echo '   OK   set desired capacity'; aws sqs get-queue-attributes --region $AWS_REGION --queue-url $queue --attribute-names ApproximateNumberOfMessages >/dev/null && echo '   OK   read the queue'; aws cloudwatch get-metric-statistics --region $AWS_REGION --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible --dimensions Name=QueueName,Value=$P-inventory --start-time \$(date -u -d '-5 min' +%FT%TZ) --end-time \$(date -u +%FT%TZ) --period 60 --statistics Average >/dev/null && echo '   OK   read CloudWatch metrics'"
      return ;;
    A) source=sqs; policy=step ;;
    B) source=cloudwatch; policy=model ;;
    AB) source=sqs; policy=model ;;
    dryrun) source=sqs; policy=model; dry=true ;;
    *) fail "mode must be A, B, AB, dryrun, off, check or log" ;;
  esac
  aws cloudwatch disable-alarm-actions --alarm-names "$P-backlog-high" "$P-backlog-low"
  aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$group" --min-size 1 --max-size "$max"
  on core "sudo docker rm -f scaler >/dev/null 2>&1; sudo docker run -d --name scaler --restart unless-stopped \
    --env-file /opt/shelfsense/app.env -e SCALER_SOURCE=$source -e SCALER_POLICY=$policy -e SCALER_MAX=$max \
    -e SCALER_MU=$mu -e SCALER_DRY_RUN=$dry -e SCALER_GROUP=$group shelfsense node src/scaler.js >/dev/null"
  ok "scaler $mode: source $source, policy $policy, max $max, starting worker rate $mu events/s (alarms paused)"
  ok "watch it with ./aws/setup.sh scaler log"
}
cmd_worker() {
  # Pause the inventory workers while a load runs, so the queue fills up; resume them to measure how
  # fast they drain it. That drain rate is the real capacity (HD experiment E1).
  local action=${1:?usage: ./aws/setup.sh worker <pause|resume>} ip verb
  case "$action" in pause) verb=stop ;; resume) verb=start ;; *) fail "use pause or resume" ;; esac
  for ip in $(aws ec2 describe-instances --filters "Name=tag:Name,Values=$P-worker" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].PublicIpAddress' --output text); do
    ssh "${SSH_OPTS[@]}" "ec2-user@$ip" "sudo docker $verb inventory >/dev/null" && ok "worker $ip: inventory $action"
  done
}
cmd_dbstats() {
  # Size of the stock rows. Each row keeps the ids of the events already applied to it (the retry
  # guard), so rows grow with every run; this shows by how much.
  cat <<'JSEOF' | on db 'cat > /tmp/dbstats.js'
const rows = db.stock_levels.aggregate([
  { $project: { ids: { $size: { $ifNull: ['$appliedEventIds', []] } }, bytes: { $bsonSize: '$$ROOT' } } },
  { $group: { _id: null, rows: { $sum: 1 }, avgIds: { $avg: '$ids' }, maxIds: { $max: '$ids' },
      avgKB: { $avg: { $divide: ['$bytes', 1024] } }, maxKB: { $max: { $divide: ['$bytes', 1024] } } } }
]).toArray()[0] || {};
printjson({ stockRows: rows.rows, avgAppliedIdsPerRow: Math.round(rows.avgIds || 0), maxAppliedIdsPerRow: rows.maxIds,
  avgRowKB: Number((rows.avgKB || 0).toFixed(1)), maxRowKB: Number((rows.maxKB || 0).toFixed(1)),
  stockEvents: db.stock_events.countDocuments({}) });
JSEOF
  on db 'sudo docker cp /tmp/dbstats.js mongo:/tmp/dbstats.js && sudo docker exec mongo sh -c "mongosh --quiet -u shelfsense -p \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin shelfsense /tmp/dbstats.js"'
}
cmd_status() {
  say "Status"
  echo "   portal: $(get ALB_URL)"
  local role
  for role in db core edge; do echo "   $role: $(public_ip "$role")"; done
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$P-inventory" \
    --query 'AutoScalingGroups[0].[MinSize,MaxSize,DesiredCapacity,length(Instances)]' --output text 2>/dev/null \
    | awk '{print "   workers: min " $1 ", max " $2 ", desired " $3 ", running " $4}' || true
  local url
  url=$(get SQS_INVENTORY_QUEUE_URL)
  [ -z "$url" ] || aws sqs get-queue-attributes --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text \
    | awk '{print "   inventory queue: " $1 " waiting, " $2 " in progress"}'
}

cmd_token() {
  local role=${1:?usage: ./aws/setup.sh token <manager|supplier|driver> <stores or *>} stores=${2:-*}
  API_AUTH_SECRET="$(secret API_AUTH_SECRET)" node src/shared/auth.js "$role" "$stores"
}

cmd_tunnel() {
  say "Node-RED editor at http://localhost:1880 (Ctrl-C to close)"
  ssh "${SSH_OPTS[@]}" -N -L 1880:localhost:1880 "ec2-user@$(public_ip edge)"
}

cmd_logs() {
  local role=${1:?usage: ./aws/setup.sh logs <db|core|edge> [container]} container=${2:-}
  if [ -z "$container" ]; then on "$role" 'sudo tail -n 60 /var/log/shelfsense.log; sudo docker ps --format "{{.Names}}: {{.Status}}"'
  else on "$role" "sudo docker logs --tail 60 $container"; fi
}

cmd_update() {
  local role=${1:?usage: ./aws/setup.sh update <db|core|edge|worker>}
  say "Updating $role: pull the latest commit from GitHub and restart its containers"
  # Keep the export header from the original user data, but run the user-data.sh body from the
  # freshly pulled repo, so a change to how containers start takes effect on a running machine.
  on "$role" 'sudo bash -c "set -e; cd /opt/shelfsense/app && git pull --ff-only -q; { grep \"^export \" /var/lib/cloud/instance/user-data.txt; tail -n +2 aws/user-data.sh; } > /opt/shelfsense/update.sh; bash /opt/shelfsense/update.sh" && sudo tail -n 1 /var/log/shelfsense.log && sudo docker ps --format "{{.Names}}: {{.Command}}"'
  ok "$role updated"
}

cmd_teardown() {
  say "Deleting every ShelfSense resource"
  aws autoscaling delete-auto-scaling-group --auto-scaling-group-name "$P-inventory" --force-delete 2>/dev/null && ok "ASG deleting" || true
  aws cloudwatch delete-alarms --alarm-names "$P-backlog-high" "$P-backlog-low" 2>/dev/null || true
  local alb tg ids sub url name topic role sg
  alb=$(get ALB_ARN); tg=$(get TG_ARN)
  if [ -n "$alb" ]; then aws elbv2 delete-load-balancer --load-balancer-arn "$alb" 2>/dev/null || true
    aws elbv2 wait load-balancers-deleted --load-balancer-arns "$alb" 2>/dev/null || true; ok "ALB deleted"; fi
  [ -z "$tg" ] || aws elbv2 delete-target-group --target-group-arn "$tg" 2>/dev/null || true
  ids=$(aws ec2 describe-instances --filters "Name=tag:Project,Values=$P" \
    Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
  if [ -n "$ids" ]; then aws ec2 terminate-instances --instance-ids $ids >/dev/null
    aws ec2 wait instance-terminated --instance-ids $ids; ok "instances terminated"; fi
  aws ec2 delete-launch-template --launch-template-name "$P-worker" >/dev/null 2>&1 || true
  for name in db worker core edge alb; do
    sg=$(get "SG_$(echo "$name" | tr '[:lower:]' '[:upper:]')")
    [ -z "$sg" ] || for _ in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$sg" 2>/dev/null && break || sleep 10; done
  done
  ok "security groups deleted"
  topic=$(get SNS_EVENT_TOPIC_ARN)
  if [ -n "$topic" ]; then
    for sub in $(aws sns list-subscriptions-by-topic --topic-arn "$topic" --query 'Subscriptions[].SubscriptionArn' --output text); do
      aws sns unsubscribe --subscription-arn "$sub" 2>/dev/null || true
    done
  fi
  for url in $(aws sqs list-queues --queue-name-prefix "$P-" --query 'QueueUrls[]' --output text 2>/dev/null); do
    [ "$url" = None ] || aws sqs delete-queue --queue-url "$url"
  done
  ok "queues deleted"
  for topic in "$(get SNS_EVENT_TOPIC_ARN)" "$(get SNS_ALERT_TOPIC_ARN)"; do [ -z "$topic" ] || aws sns delete-topic --topic-arn "$topic"; done
  ok "topics deleted"
  for name in $SECRET_NAMES; do aws ssm delete-parameter --name "/$P/$name" 2>/dev/null || true; done
  for role in edge core worker; do aws logs delete-log-group --log-group-name "/$P/$role" 2>/dev/null || true; done
  : > "$STATE"
  ok "done. $SECRETS is kept; End Lab in the Learner Lab page as well."
}

step=${1:-help}
shift || true
case "$step" in
  check|secrets|messaging|network|db|core|edge|workers|scale|demo|load|results|security|concurrency|scaler|worker|dbstats|status|portal|token|tunnel|logs|update|teardown) "cmd_$step" "$@" ;;
  *) sed -n '2,4p' "$0" | sed 's/^# //'; exit 1 ;;
esac
