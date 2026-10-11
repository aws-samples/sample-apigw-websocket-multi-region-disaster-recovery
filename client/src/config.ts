// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * WebSocket endpoint configuration.
 *
 * Set VITE_WS_URL in a .env.local file to your custom domain.
 * See .env.example for the expected format.
 */
const wsUrl = import.meta.env.VITE_WS_URL;

if (!wsUrl) {
  throw new Error('VITE_WS_URL is not set. Copy .env.example to .env.local and set your WebSocket endpoint URL.');
}

export const config = { wsUrl } as const;
