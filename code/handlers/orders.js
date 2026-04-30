'use strict';
/**
 * Order Service Lambda Handler
 * Handles: GET/POST /cart, DELETE /cart/{productId}
 *          POST /orders, GET /orders, GET /orders/{id}
 * AWS Services: DynamoDB, SQS
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand, QueryCommand, TransactWriteCommand
} = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { v4: uuidv4 } = require('uuid');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const sqs = new SQSClient({ region: process.env.AWS_REGION });

const TABLE     = process.env.DYNAMODB_TABLE;
const QUEUE_URL = process.env.ORDER_QUEUE_URL;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const res  = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});
const parseBody = (e) => { try { return JSON.parse(e.body || '{}'); } catch { return {}; } };
const getUserId = (e) => {
  // Extracted from Cognito Authorizer context
  return e.requestContext?.authorizer?.claims?.sub
      || e.requestContext?.authorizer?.jwt?.claims?.sub
      || 'test-user-id';
};

// ─── Cart: Get ────────────────────────────────────────────────────────────────
const getCart = async (event) => {
  const userId = getUserId(event);
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `CART#${userId}`, ':sk': 'ITEM#' },
  }));

  const items = result.Items || [];
  const total = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  return res(200, { items, total: Math.round(total * 100) / 100, itemCount: items.length });
};

// ─── Cart: Add Item ───────────────────────────────────────────────────────────
const addToCart = async (event, body) => {
  const userId = getUserId(event);
  const { productId, quantity = 1 } = body;
  if (!productId) return res(400, { error: 'productId is required' });

  // Fetch product to get price & name
  const productResult = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' },
  }));
  if (!productResult.Item) return res(404, { error: 'Product not found' });

  const product = productResult.Item;
  const now     = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK:        `CART#${userId}`,
      SK:        `ITEM#${productId}`,
      entityType: 'CART_ITEM',
      userId,
      productId,
      name:      product.name,
      price:     product.price,
      imageUrl:  product.imageUrl || '',
      quantity:  Number(quantity),
      addedAt:   now,
    },
  }));

  return res(200, { message: 'Item added to cart', productId, quantity });
};

// ─── Cart: Remove Item ────────────────────────────────────────────────────────
const removeFromCart = async (event) => {
  const userId    = getUserId(event);
  const productId = (event.pathParameters || {}).productId || '';
  if (!productId) return res(400, { error: 'productId path parameter required' });

  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { PK: `CART#${userId}`, SK: `ITEM#${productId}` },
  }));

  return res(200, { message: 'Item removed from cart', productId });
};

// ─── Order: Place ─────────────────────────────────────────────────────────────
const placeOrder = async (event, body) => {
  const userId = getUserId(event);
  const { shippingAddress } = body;
  if (!shippingAddress) return res(400, { error: 'shippingAddress is required' });

  // 1. Get cart items
  const cartResult = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `CART#${userId}`, ':sk': 'ITEM#' },
  }));

  const cartItems = cartResult.Items || [];
  if (!cartItems.length) return res(400, { error: 'Cart is empty' });

  const orderId  = uuidv4();
  const now      = new Date().toISOString();
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const tax      = Math.round(subtotal * 0.18 * 100) / 100; // 18% GST
  const total    = Math.round((subtotal + tax) * 100) / 100;

  const orderItems = cartItems.map(i => ({
    productId: i.productId,
    name:      i.name,
    price:     i.price,
    quantity:  i.quantity,
    lineTotal: Math.round(i.price * i.quantity * 100) / 100,
  }));

  // 2. Write order + clear cart in a transaction
  const transactItems = [
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK:              `ORDER#${orderId}`,
          SK:              `USER#${userId}`,
          entityType:      'ORDER',
          orderId,
          userId,
          items:           orderItems,
          subtotal,
          tax,
          total,
          status:          'PENDING',
          shippingAddress,
          createdAt:       now,
          updatedAt:       now,
        },
      }
    },
    ...cartItems.map(i => ({
      Delete: { TableName: TABLE, Key: { PK: `CART#${userId}`, SK: `ITEM#${i.productId}` } }
    }))
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

  // 3. Push to SQS for async payment processing
  await sqs.send(new SendMessageCommand({
    QueueUrl:               QUEUE_URL,
    MessageGroupId:         orderId,        // FIFO queue
    MessageDeduplicationId: orderId,
    MessageBody: JSON.stringify({ orderId, userId, total, createdAt: now }),
  }));

  return res(201, {
    message:  'Order placed successfully',
    orderId,
    total,
    status:   'PENDING',
    itemCount: orderItems.length,
  });
};

// ─── Order: List ──────────────────────────────────────────────────────────────
const listOrders = async (event) => {
  const userId = getUserId(event);
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'user-orders-index',
    KeyConditionExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': `USER#${userId}` },
    ScanIndexForward: false, // newest first
  }));

  return res(200, { orders: result.Items || [], count: (result.Items || []).length });
};

// ─── Order: Get ───────────────────────────────────────────────────────────────
const getOrder = async (event) => {
  const userId  = getUserId(event);
  const orderId = (event.pathParameters || {}).id || '';
  if (!orderId) return res(400, { error: 'orderId is required' });

  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `ORDER#${orderId}`, SK: `USER#${userId}` },
  }));

  if (!result.Item) return res(404, { error: 'Order not found' });
  return res(200, { order: result.Item });
};

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const path   = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const body   = parseBody(event);

  console.log(`${method} ${path}`, { userId: getUserId(event) });

  try {
    if (method === 'GET'    && path === '/cart')                          return await getCart(event);
    if (method === 'POST'   && path === '/cart')                          return await addToCart(event, body);
    if (method === 'DELETE' && /\/cart\/[^/]+/.test(path))               return await removeFromCart(event);
    if (method === 'POST'   && path === '/orders')                        return await placeOrder(event, body);
    if (method === 'GET'    && path === '/orders')                        return await listOrders(event);
    if (method === 'GET'    && /\/orders\/[^/]+$/.test(path))             return await getOrder(event);
    return res(404, { error: 'Route not found' });
  } catch (err) {
    console.error('Order error:', err);
    return res(500, { error: 'Internal server error', details: err.message });
  }
};
