#!/bin/bash
# Runs once as root when an EC2 instance first boots. setup.sh puts a header in front of this file
# that sets ROLE (db, core, edge or worker), the AWS resource names and, in userdata mode, the secrets.
set -euo pipefail
exec >>/var/log/shelfsense.log 2>&1
echo "ShelfSense $ROLE setup started $(date -u)"

dnf install -y docker git
systemctl enable --now docker
mkdir -p /opt/shelfsense

# Secrets come from Parameter Store, unless setup.sh already wrote them into the header.
if [ -z "${MQTT_PASSWORD:-}" ]; then
  while IFS=$'\t' read -r name value; do
    export "${name##*/}=$value"
  done < <(aws ssm get-parameters-by-path --region "$AWS_REGION" --path /shelfsense/ \
    --with-decryption --query 'Parameters[].[Name,Value]' --output text)
fi
if [ -z "${MQTT_PASSWORD:-}" ]; then
  echo "No secrets found. Run setup.sh again with SECRETS_MODE=userdata."
  exit 1
fi

# One env file for every container on this machine. Only root can read it.
umask 077
cat > /opt/shelfsense/app.env <<EOF
AWS_REGION=$AWS_REGION
EVENT_TRANSPORT=aws
EVENT_SIGNING_REQUIRED=true
EVENT_SIGNING_SECRET=$EVENT_SIGNING_SECRET
API_AUTH_REQUIRED=true
API_AUTH_SECRET=$API_AUTH_SECRET
MQTT_USERNAME=shelfsense
MQTT_PASSWORD=$MQTT_PASSWORD
MONGODB_URI=mongodb://shelfsense:$MONGO_PASSWORD@${DB_HOST:-localhost}:27017/shelfsense?authSource=admin
SNS_EVENT_TOPIC_ARN=${SNS_EVENT_TOPIC_ARN:-}
SNS_ALERT_TOPIC_ARN=${SNS_ALERT_TOPIC_ARN:-}
SQS_INVENTORY_QUEUE_URL=${SQS_INVENTORY_QUEUE_URL:-}
SQS_REPLENISHMENT_QUEUE_URL=${SQS_REPLENISHMENT_QUEUE_URL:-}
SQS_COLDCHAIN_QUEUE_URL=${SQS_COLDCHAIN_QUEUE_URL:-}
SQS_DELIVERY_QUEUE_URL=${SQS_DELIVERY_QUEUE_URL:-}
EOF
umask 022

if [ "$ROLE" = db ]; then
  docker rm -f mongo >/dev/null 2>&1 || true
  docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongo-data:/data/db \
    -e MONGO_INITDB_ROOT_USERNAME=shelfsense -e MONGO_INITDB_ROOT_PASSWORD="$MONGO_PASSWORD" mongo:7
  touch /opt/shelfsense/ready
  echo "db ready $(date -u)"
  exit 0
fi

APP=/opt/shelfsense/app
# First boot clones the repo; running this script again (./aws/setup.sh update <role>) pulls the latest commit.
if [ -d "$APP" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP"; fi
docker build -t shelfsense "$APP"

# Container logs go to CloudWatch Logs when the lab role allows it, otherwise they stay on the machine.
LOG="--log-driver awslogs --log-opt awslogs-region=$AWS_REGION --log-opt awslogs-group=/shelfsense/$ROLE"
if ! docker run --rm $LOG alpine:3 true; then
  echo "CloudWatch Logs is not available, keeping logs on the instance"
  LOG="--log-opt max-size=20m"
fi

run() {
  local name=$1
  shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped $LOG --env-file /opt/shelfsense/app.env "$@"
}

case "$ROLE" in
  core)
    run api -p 3000:3000 shelfsense node src/api.js
    for service in replenishment cold-chain delivery; do
      run "$service" -e SERVICE_NAME="$service" shelfsense node src/service.js
    done
    ;;
  worker)
    run inventory -e SERVICE_NAME=inventory -e QUEUE_CONCURRENCY="${QUEUE_CONCURRENCY:-1}" shelfsense node src/service.js
    ;;
  edge)
    docker network create shelfsense >/dev/null 2>&1 || true
    run broker --network shelfsense shelfsense node src/broker.js
    run node-red --network shelfsense -p 127.0.0.1:1880:1880 -e MQTT_HOST=broker -e MQTT_PORT=1883 \
      -v "$APP/node-red/settings.js:/data/settings.js:ro" -v "$APP/node-red/start.js:/data/start.js:ro" \
      -v "$APP/node-red/flows.json:/data/flows.json:ro" -v "$APP/node-red/edge.js:/data/edge.js:ro" \
      -v "$APP/src/shared:/src/shared:ro" --entrypoint node nodered/node-red:4.0.9 /data/start.js
    run bridge --network shelfsense -e MQTT_URL=mqtt://broker:1883 shelfsense node src/bridge.js
    ;;
  *)
    echo "Unknown role $ROLE"
    exit 1
    ;;
esac

touch /opt/shelfsense/ready
echo "$ROLE ready $(date -u)"
