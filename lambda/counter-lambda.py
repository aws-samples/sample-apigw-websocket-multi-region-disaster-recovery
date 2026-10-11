# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""WebSocket API handler for the multi-region counter application.

Routes WebSocket events ($connect, $disconnect, heartbeat, increment,
decrement, getState) to manage connections and shared counter state.
Connection metadata and counter values are stored in DynamoDB Global Tables
for cross-region replication.
"""

import json
import boto3
import os
import logging
from datetime import datetime

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
connections_table = dynamodb.Table(os.environ['CONNECTIONS_TABLE'])
counter_table = dynamodb.Table(os.environ['COUNTER_TABLE'])

def get_management_api_endpoint(event):
    """
    Get the correct API Gateway Management API endpoint.
    Custom domains don't need the stage in the URL path.
    """
    domain_name = event['requestContext']['domainName']
    stage = event['requestContext']['stage']
    
    # Check if it's a custom domain (doesn't contain 'execute-api')
    if 'execute-api' not in domain_name:
        # Custom domain - stage is already mapped, don't append it
        return f"https://{domain_name}"
    else:
        # Regional API Gateway domain - include stage
        return f"https://{domain_name}/{stage}"

def handler(event, context):
    """Route WebSocket events to the appropriate action.

    Handles connection lifecycle ($connect/$disconnect), application messages
    (increment/decrement/getState), and heartbeat responses. Broadcasts counter
    updates to all connected clients.
    """
    route_key = event['requestContext']['routeKey']
    connection_id = event['requestContext']['connectionId']
    region = os.environ.get('REGION', 'us-east-1')
    domain_name = event['requestContext']['domainName']
    stage = event['requestContext']['stage']
    
    # Get the correct endpoint URL for API Gateway Management API
    management_endpoint = get_management_api_endpoint(event)
    apigateway = boto3.client('apigatewaymanagementapi', endpoint_url=management_endpoint)
    
    logger.info(f"Using management API endpoint: {management_endpoint}")
    
    # Handle message routing for increment/decrement/getState
    if route_key == '$default' and event.get('body'):
        body = json.loads(event['body'])
        action = body.get('action')
        if action in ['increment', 'decrement', 'getState', 'heartbeat']:
            route_key = action
    
    if route_key == '$connect':
        # Store connection in DynamoDB
        connections_table.put_item(Item={
            'connectionId': connection_id,
            'region': region,
            'connectedAt': datetime.utcnow().isoformat(),
            'ttl': int(datetime.utcnow().timestamp()) + 7200
        })
        
        # Don't send initial message immediately - connection may not be fully established
        # Client will request current state after connection is ready
        
    elif route_key == '$disconnect':
        # Remove connection from DynamoDB
        connections_table.delete_item(Key={'connectionId': connection_id})
        
    elif route_key in ['increment', 'decrement']:
        # Update counter
        change_value = 1 if route_key == 'increment' else -1
        
        # Try to update existing counter, create if doesn't exist
        try:
            response = counter_table.update_item(
                Key={'id': 'global'},
                UpdateExpression='ADD #count :change',
                ExpressionAttributeNames={'#count': 'count'},
                ExpressionAttributeValues={':change': change_value},
                ReturnValues='ALL_NEW'
            )
            new_count = int(response['Attributes']['count'])
        except counter_table.exceptions.ClientError:
            # Counter doesn't exist, create it
            initial_value = 1 if route_key == 'increment' else -1
            counter_table.put_item(Item={'id': 'global', 'count': initial_value})
            new_count = initial_value
        
        # Broadcast to all connections
        broadcast_message = json.dumps({
            'type': 'counter',
            'count': new_count,
            'region': region,
            'updatedBy': connection_id[:8]
        })
        
        connections = connections_table.scan()
        for item in connections['Items']:
            try:
                apigateway.post_to_connection(
                    ConnectionId=item['connectionId'],
                    Data=broadcast_message
                )
            except apigateway.exceptions.GoneException:
                # Clean up stale connections
                logger.warning(f"Connection {item['connectionId']} is gone during broadcast, removing from connections table")
                connections_table.delete_item(Key={'connectionId': item['connectionId']})
    
    elif route_key == 'getState':
        # Send current counter value to requesting connection
        counter_response = counter_table.get_item(Key={'id': 'global'})
        current_count = int(counter_response.get('Item', {}).get('count', 0))
        
        try:
            apigateway.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({
                    'type': 'counter',
                    'count': current_count,
                    'region': region,
                    'connectionId': connection_id
                })
            )
        except apigateway.exceptions.GoneException:
            # Connection is gone, remove from table
            logger.warning(f"Connection {connection_id} is gone during getState, removing from connections table")
            connections_table.delete_item(Key={'connectionId': connection_id})
    
    elif route_key == 'heartbeat':
        # Respond with pong so the client knows the connection is alive
        try:
            apigateway.post_to_connection(
                ConnectionId=connection_id,
                Data='pong'
            )
        except apigateway.exceptions.GoneException:
            connections_table.delete_item(Key={'connectionId': connection_id})
    
    return {'statusCode': 200}
