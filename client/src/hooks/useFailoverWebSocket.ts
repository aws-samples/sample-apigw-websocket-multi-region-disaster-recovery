// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * useFailoverWebSocket
 *
 * A wrapper around react-use-websocket that adds:
 *  - Automatic reconnect with exponential backoff (2s, 4s, 8s, ... capped at 20s)
 *  - Heartbeat ping to detect stale connections early
 *  - State recovery (sends getState on every reconnect)
 *  - Activity event log for UI display
 *
 * Failover strategy:
 *  The client connects to a single custom domain. Route 53 DNS failover
 *  handles routing to the healthy region. On connection loss, the client
 *  simply reconnects to the same URL — if the primary region is down,
 *  DNS will resolve to the secondary region instead.
 */
import { useCallback, useRef, useState } from 'react';
import * as WebSocketModule from 'react-use-websocket';
// CJS interop: the default export may be nested under .default
type UseWebSocket = typeof WebSocketModule.default;
type Interop = { default?: UseWebSocket & { default?: UseWebSocket } };
const useWebSocket: UseWebSocket = (WebSocketModule as unknown as Interop).default?.default ?? (WebSocketModule as unknown as Interop).default ?? (WebSocketModule as unknown as UseWebSocket);
const { ReadyState } = WebSocketModule;

export interface FailoverEvent {
  timestamp: Date;
  message: string;
  type: 'connect' | 'disconnect' | 'error' | 'reconnect';
}

interface Options {
  url: string;
  heartbeatInterval?: number;   // How often to send a ping (ms)
  heartbeatTimeout?: number;    // How long to wait for pong before closing (ms)
  reconnectAttempts?: number;   // Max consecutive reconnect attempts
  maxReconnectInterval?: number; // Cap on exponential backoff (ms)
}

const STATUS_MAP: Record<number, string> = {
  [ReadyState.CONNECTING]: 'Connecting',
  [ReadyState.OPEN]: 'Connected',
  [ReadyState.CLOSING]: 'Closing',
  [ReadyState.CLOSED]: 'Disconnected',
  [ReadyState.UNINSTANTIATED]: 'Idle',
};

export function useFailoverWebSocket({
  url,
  heartbeatInterval = 30000,
  heartbeatTimeout = 35000,
  reconnectAttempts = 20,
  maxReconnectInterval = 20000,
}: Options) {
  const [events, setEvents] = useState<FailoverEvent[]>([]);
  const [shouldConnect, setShouldConnect] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [reconnectingIn, setReconnectingIn] = useState<number | null>(null);

  const isManualDisconnect = useRef(false);
  const hasConnectedBefore = useRef(false);
  const consecutiveErrors = useRef(0);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Append an event to the activity log, keeping the last 50 entries. */
  const addEvent = useCallback((message: string, type: FailoverEvent['type']) => {
    setEvents(prev => [...prev.slice(-49), { timestamp: new Date(), message, type }]);
  }, []);

  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(
    url,
    {
      // --- Reconnect behaviour ---
      shouldReconnect: () => {
        if (isManualDisconnect.current) return false;
        setReconnectCount(prev => prev + 1);
        return true;
      },
      reconnectAttempts,
      reconnectInterval: (attempt) => {
        // Exponential backoff with full jitter (AWS Architecture Blog pattern)
        // https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
        const expDelay = Math.min(2000 * Math.pow(2, attempt), maxReconnectInterval);
        const delay = Math.random() * expDelay;
        // Start countdown timer for UI
        if (countdownTimer.current) clearInterval(countdownTimer.current);
        let remaining = Math.ceil(delay / 1000);
        setReconnectingIn(remaining);
        countdownTimer.current = setInterval(() => {
          remaining--;
          if (remaining <= 0) {
            setReconnectingIn(null);
            if (countdownTimer.current) clearInterval(countdownTimer.current);
          } else {
            setReconnectingIn(remaining);
          }
        }, 1000);
        return delay;
      },
      retryOnError: true,

      // --- Heartbeat to detect stale connections ---
      heartbeat: {
        message: JSON.stringify({ action: 'heartbeat' }),
        returnMessage: 'pong',
        timeout: heartbeatTimeout,
        interval: heartbeatInterval,
      },

      // --- Lifecycle callbacks ---
      onOpen: () => {
        consecutiveErrors.current = 0;
        setReconnectingIn(null);
        if (countdownTimer.current) clearInterval(countdownTimer.current);
        if (hasConnectedBefore.current) {
          addEvent('Reconnected — DNS may have failed over to secondary region', 'reconnect');
        } else {
          addEvent('Connected', 'connect');
          hasConnectedBefore.current = true;
        }
        // Fetch current counter state after each (re)connect
        setTimeout(() => sendJsonMessage({ action: 'getState' }), 100);
      },
      onClose: () => {
        if (isManualDisconnect.current) {
          addEvent('Disconnected', 'disconnect');
        } else {
          addEvent('Connection lost — retrying automatically', 'disconnect');
        }
      },
      onError: () => {
        addEvent('Connection error', 'error');
      },
      onMessage: (event) => {
        const data = event.data;
        if (data === 'pong' || (typeof data === 'string' && data.startsWith('{'))) {
          try {
            if (data === 'pong' || JSON.parse(data).type) {
              consecutiveErrors.current = 0;
              return;
            }
          } catch { /* fall through to error handling */ }
        }
        // Non-pong, non-app message (e.g., API Gateway error)
        consecutiveErrors.current++;
        if (consecutiveErrors.current >= 2) {
          addEvent('Backend unhealthy — forcing reconnect', 'error');
          consecutiveErrors.current = 0;
          (event.target as WebSocket | null)?.close();
        }
      },
    },
    shouldConnect,
  );

  const connect = useCallback(() => {
    isManualDisconnect.current = false;
    hasConnectedBefore.current = false;
    setReconnectCount(0);
    setShouldConnect(true);
  }, []);

  const disconnect = useCallback(() => {
    isManualDisconnect.current = true;
    setShouldConnect(false);
  }, []);

  return {
    sendJsonMessage,
    lastJsonMessage,
    readyState,
    events,
    reconnectCount,
    reconnectingIn,
    connect,
    disconnect,
    isConnected: readyState === ReadyState.OPEN,
    connectionStatus: STATUS_MAP[readyState] ?? 'Unknown',
  };
}
