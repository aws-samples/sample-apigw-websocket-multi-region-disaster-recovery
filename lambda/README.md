# AWS Lambda functions

## counter-lambda.py

Handles all WebSocket routes for the auction application.

- `$connect` — stores connection in Amazon DynamoDB
- `$disconnect` — removes connection record
- `increment` / `decrement` — updates shared counter, broadcasts to all clients
- `getState` — returns current counter to the requesting client (used for state recovery after reconnection)
- `heartbeat` — responds with `pong`

**Environment variables:**

- `CONNECTIONS_TABLE` — DynamoDB table for active connections
- `COUNTER_TABLE` — DynamoDB table for counter state
- `REGION` — current AWS Region, included in responses

## canary-lambda.py

Probes the WebSocket endpoint once per minute to confirm the full path is working. Connects using raw sockets to avoid external dependencies, sends a heartbeat message, and checks for a valid pong.

Publishes a custom Amazon CloudWatch metric after each probe:

- **Namespace:** `App/WebSocketHealth`
- **Metric name:** `CanaryStatus`
- **Dimension:** `ApiId` (extracted from the WebSocket URL)
- **Values:** `1` (healthy) or `0` (unhealthy)

If the Lambda itself cannot run (Region outage), no metric is published. The downstream alarm treats missing data as unhealthy.

**Environment variables:**

- `WEBSOCKET_URL` — regional WebSocket endpoint to probe

## Health check flow

The canary metric feeds a CloudWatch alarm that fires after 2 consecutive unhealthy or missing datapoints. An Amazon Route 53 health check watches that alarm and marks the primary Region unhealthy, triggering DNS failover to the secondary. Recovery reverses the process automatically.
