# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import os
import logging
import socket
import ssl
import base64
import struct
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WEBSOCKET_URL = os.environ['WEBSOCKET_URL']
cloudwatch = boto3.client('cloudwatch')

# Extract API ID from URL for metric dimension
API_ID = WEBSOCKET_URL.split('//')[1].split('.')[0]


def publish_metric(healthy):
    """Publish canary result to CloudWatch. 1 = healthy, 0 = unhealthy."""
    cloudwatch.put_metric_data(
        Namespace='App/WebSocketHealth',
        MetricData=[{
            'MetricName': 'CanaryStatus',
            'Dimensions': [{'Name': 'ApiId', 'Value': API_ID}],
            'Value': int(healthy),
            'Unit': 'None'
        }]
    )


def build_ws_frame(payload_bytes):
    """Build a masked WebSocket text frame (RFC 6455)."""
    mask = os.urandom(4)
    header = bytearray([0x81])
    length = len(payload_bytes)
    if length < 126:
        header.append(0x80 | length)
    else:
        header.append(0x80 | 126)
        header.extend(struct.pack('>H', length))
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload_bytes))
    return bytes(header) + masked


def ws_connect(host, path):
    """Open TLS socket and perform WebSocket handshake. Returns socket."""
    raw = socket.create_connection((host, 443), timeout=5)
    sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)

    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        f'GET {path} HTTP/1.1\r\n'
        f'Host: {host}\r\n'
        f'Upgrade: websocket\r\n'
        f'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        f'Sec-WebSocket-Version: 13\r\n'
        f'\r\n'.encode()
    )

    response = b''
    while b'\r\n\r\n' not in response:
        response += sock.recv(4096)

    if b'101' not in response.split(b'\r\n')[0]:
        sock.close()
        raise ConnectionError(f'Handshake failed: {response.split(b"\r\n")[0].decode()}')

    return sock


def ws_close(sock):
    """Send close frame and tear down socket."""
    try:
        sock.sendall(bytearray([0x88, 0x80]) + os.urandom(4))
        sock.close()
    except Exception:
        pass


def handler(event, context):
    """Probe the WebSocket endpoint and publish a health metric.

    Connects to the regional WebSocket API, sends a heartbeat message,
    validates the pong response, and publishes the result as a custom
    CloudWatch metric for Route 53 health check evaluation.
    """
    sock = None
    try:
        host_path = WEBSOCKET_URL[len('wss://'):]
        host, path = host_path.split('/', 1) if '/' in host_path else (host_path, '')
        path = '/' + path

        sock = ws_connect(host, path)
        sock.sendall(build_ws_frame(json.dumps({'action': 'heartbeat'}).encode()))

        sock.settimeout(5)
        data = sock.recv(4096)

        healthy = b'pong' in data
        if not healthy:
            logger.warning(f'Unexpected response: {data[:100]}')

        publish_metric(healthy)
        return {'statusCode': 200 if healthy else 500}

    except Exception as e:
        logger.error(f'Canary failed: {e}')
        publish_metric(False)
        return {'statusCode': 500}

    finally:
        if sock:
            ws_close(sock)
