# Client

React and TypeScript client for the live auction sample, built with Vite. It connects to the WebSocket API through your custom domain, sends heartbeats to detect broken connections, and reconnects with exponential backoff and jitter when the connection drops. After each reconnect it requests the current auction state, so the UI recovers after a failover to the secondary Region.

## Run locally

```bash
cp .env.example .env.local
# Set VITE_WS_URL to your custom domain, for example wss://your-custom-domain.example.com/
npm install
npm run dev
```

## Key files

- `src/config.ts`: reads the WebSocket endpoint from `VITE_WS_URL`
- `src/hooks/useFailoverWebSocket.ts`: heartbeat, reconnect, and state recovery logic
- `src/App.tsx`: auction UI, showing the serving Region and connection events

See the [main README](../README.md) for backend deployment and failover testing.
