// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { useEffect, useState } from 'react';
import { useFailoverWebSocket, type FailoverEvent } from './hooks/useFailoverWebSocket';
import { config } from './config';
import './App.css';

/** Shape of counter messages received from the server. */
interface CounterMessage {
  type: 'counter';
  count: number;
  region: string;
  updatedBy?: string;
  connectionId?: string;
}

function App() {
  const [count, setCount] = useState(0);
  const [serverRegion, setServerRegion] = useState<string | null>(null);
  const [lastResponseTime, setLastResponseTime] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const {
    sendJsonMessage,
    lastJsonMessage,
    events,
    reconnectCount,
    reconnectingIn,
    connect,
    disconnect,
    isConnected,
    connectionStatus,
  } = useFailoverWebSocket({ url: config.wsUrl });

  // Process incoming counter messages
  useEffect(() => {
    if (!lastJsonMessage) return;
    const msg = lastJsonMessage as CounterMessage;
    if (msg.type === 'counter') {
      // State mirrors the latest server message; updating it here is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCount(msg.count);
      setServerRegion(msg.region);
      setLastResponseTime(new Date().toLocaleTimeString());
      if (msg.connectionId) setConnectionId(msg.connectionId);
    }
  }, [lastJsonMessage]);

  return (
    <div className="app">
      <h1>🔨 Live Auction — Smart Toaster Pro</h1>

      {/* Connection status card */}
      <StatusCard isConnected={isConnected} status={connectionStatus} reconnectCount={reconnectCount} connectionId={connectionId} reconnectingIn={reconnectingIn} />

      {/* Which AWS region is serving responses */}
      <RegionCard region={serverRegion} lastResponseTime={lastResponseTime} />

      {/* Current bid display */}
      <div className="counter-display">
        <img src="/toaster.svg" alt="Smart Toaster Pro" width="120" height="120" />
        <div className="counter-value">${count}</div>
        <div className="counter-label">Current Bid</div>
      </div>

      {/* Action buttons */}
      <div className="button-group">
        <button className="btn btn-increment" onClick={() => sendJsonMessage({ action: 'increment' })} disabled={!isConnected}>
          💰 Bid +$1
        </button>
        <button className="btn btn-decrement" onClick={() => sendJsonMessage({ action: 'decrement' })} disabled={!isConnected}>
          ⬇️ Bid -$1
        </button>
        <button className="btn btn-connect" onClick={connect} disabled={isConnected}>
          🔗 Join Auction
        </button>
        <button className="btn btn-disconnect" onClick={disconnect} disabled={!isConnected}>
          🚪 Leave Auction
        </button>
      </div>

      {/* Activity log */}
      <ActivityLog events={events} />
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */

function StatusCard({ isConnected, status, reconnectCount, connectionId, reconnectingIn }: {
  isConnected: boolean;
  status: string;
  reconnectCount: number;
  connectionId: string | null;
  reconnectingIn: number | null;
}) {
  const cardClass = isConnected ? 'connected' : status === 'Disconnected' ? 'error' : '';
  return (
    <div className={`card status-card ${cardClass}`}>
      <div className="card-label">Connection Status</div>
      <div className={`status-text ${isConnected ? 'text-green' : 'text-red'}`}>
        {status}
      </div>
      {reconnectingIn !== null && (
        <div className="sub-text text-orange">Connection failure — reconnecting in {reconnectingIn}s</div>
      )}
      {connectionId && <div className="sub-text">ID: {connectionId}</div>}
      {reconnectCount > 0 && <div className="sub-text">Reconnects: {reconnectCount}</div>}
    </div>
  );
}

function RegionCard({ region, lastResponseTime }: {
  region: string | null;
  lastResponseTime: string | null;
}) {
  const colorClass = region === 'us-east-1' ? 'text-green'
    : region === 'us-west-2' ? 'text-orange'
    : 'text-muted';

  return (
    <div className="card">
      <div className="card-label">🌍 Serving Region</div>
      <div className={`region-text ${colorClass}`}>
        {region?.toUpperCase() ?? 'Not Connected'}
      </div>
      {lastResponseTime && <div className="sub-text">Last response: {lastResponseTime}</div>}
    </div>
  );
}

function ActivityLog({ events }: { events: FailoverEvent[] }) {
  return (
    <div className="card log-card">
      <div className="card-label">📝 Activity Log</div>
      <div className="log-entries">
        {events.length === 0 && <div className="log-entry muted">No activity yet</div>}
        {[...events].reverse().map((e, i) => (
          <LogEntry key={i} event={e} />
        ))}
      </div>
    </div>
  );
}

const EVENT_ICONS: Record<FailoverEvent['type'], string> = {
  connect: '🟢',
  disconnect: '🔴',
  reconnect: '🔄',
  error: '❌',
};

function LogEntry({ event }: { event: FailoverEvent }) {
  return (
    <div className={`log-entry ${event.type === 'reconnect' ? 'highlight' : ''}`}>
      <span className="log-time">{event.timestamp.toLocaleTimeString()}</span>
      <span>{EVENT_ICONS[event.type]} {event.message}</span>
    </div>
  );
}

export default App;
