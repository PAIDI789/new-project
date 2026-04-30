'use strict';
/**
 * Product Service Lambda Handler
 * Handles: GET/POST /products, GET/PUT/DELETE /products/{id}
 * Also handles: POST /products/{id}/upload-url (pre-signed S3 URL)
 * AWS Services: DynamoDB, S3
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand, ScanCommand, QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const s3  = new S3Client({ region: process.env.AWS_REGION });

const TABLE  = process.env.DYNAMODB_TABLE;
const BUCKET = process.env.S3_BUCKET;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const res = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  },
  body: JSON.stringify(body),
});

const parseBody  = (e) => { try { return JSON.parse(e.body || '{}'); } catch { return {}; } };
const pathParam  = (e, key) => (e.pathParameters || {})[key] || '';
const queryParam = (e, key) => (e.queryStringParameters || {})[key] || '';

// ─── List Products ────────────────────────────────────────────────────────────
const listProducts = async (event) => {
  const category = queryParam(event, 'category');
  const limit = parseInt(queryParam(event, 'limit') || '20', 10);

  let result;
  if (category) {
    result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'category-index',
      KeyConditionExpression: 'PK = :cat',
      ExpressionAttributeValues: { ':cat': `CATEGORY#${category}`, ':type': 'PRODUCT' },
      FilterExpression: 'entityType = :type',
      Limit: limit,
    }));
  } else {
    result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'entityType = :type',
      ExpressionAttributeValues: { ':type': 'PRODUCT' },
      Limit: limit,
    }));
  }

  return res(200, { products: result.Items || [], count: (result.Items || []).length });
};

// ─── Get Product ──────────────────────────────────────────────────────────────
const getProduct = async (event) => {
  const id = pathParam(event, 'id');
  if (!id) return res(400, { error: 'Product ID is required' });

  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `PRODUCT#${id}`, SK: 'METADATA' },
  }));

  if (!result.Item) return res(404, { error: 'Product not found' });
  return res(200, { product: result.Item });
};

// ─── Create Product ───────────────────────────────────────────────────────────
const createProduct = async (body) => {
  const { name, description, price, category, stock, imageUrl } = body;
  if (!name || !price || !category)
    return res(400, { error: 'name, price and category are required' });

  const id  = uuidv4();
  const now = new Date().toISOString();

  const product = {
    PK:          `PRODUCT#${id}`,
    SK:          'METADATA',
    entityType:  'PRODUCT',
    id,
    name,
    description: description || '',
    price:       Number(price),
    category,
    stock:       Number(stock || 0),
    imageUrl:    imageUrl || '',
    createdAt:   now,
    updatedAt:   now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: product }));
  return res(201, { message: 'Product created', product });
};

// ─── Update Product ───────────────────────────────────────────────────────────
const updateProduct = async (event, body) => {
  const id = pathParam(event, 'id');
  if (!id) return res(400, { error: 'Product ID is required' });

  const updateFields = ['name','description','price','category','stock','imageUrl'];
  const expressions  = [];
  const attrNames    = {};
  const attrValues   = { ':updatedAt': new Date().toISOString() };

  updateFields.forEach(f => {
    if (body[f] !== undefined) {
      expressions.push(`#${f} = :${f}`);
      attrNames[`#${f}`]  = f;
      attrValues[`:${f}`] = body[f];
    }
  });

  if (!expressions.length) return res(400, { error: 'No fields to update' });
  expressions.push('#updatedAt = :updatedAt');
  attrNames['#updatedAt'] = 'updatedAt';

  const result = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key:       { PK: `PRODUCT#${id}`, SK: 'METADATA' },
    UpdateExpression:          `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames:  attrNames,
    ExpressionAttributeValues: attrValues,
    ConditionExpression:       'attribute_exists(PK)',
    ReturnValues:              'ALL_NEW',
  }));

  return res(200, { message: 'Product updated', product: result.Attributes });
};

// ─── Delete Product ───────────────────────────────────────────────────────────
const deleteProduct = async (event) => {
  const id = pathParam(event, 'id');
  if (!id) return res(400, { error: 'Product ID is required' });

  await ddb.send(new DeleteCommand({
    TableName:           TABLE,
    Key:                 { PK: `PRODUCT#${id}`, SK: 'METADATA' },
    ConditionExpression: 'attribute_exists(PK)',
  }));

  return res(200, { message: 'Product deleted', id });
};

// ─── Pre-signed S3 Upload URL ─────────────────────────────────────────────────
const getUploadUrl = async (event, body) => {
  const id       = pathParam(event, 'id');
  const fileType = body.fileType || 'image/jpeg';
  const ext      = fileType.split('/')[1] || 'jpg';
  const key      = `products/${id}/${uuidv4()}.${ext}`;

  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: fileType,
  }), { expiresIn: 300 }); // 5 minutes

  const imageUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;
  return res(200, { uploadUrl: url, imageUrl, key });
};

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const path   = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const body   = parseBody(event);

  console.log(`${method} ${path}`, { body });

  try {
    if (method === 'GET'    && path === '/products')                       return await listProducts(event);
    if (method === 'POST'   && path === '/products')                       return await createProduct(body);
    if (method === 'GET'    && /\/products\/[^/]+$/.test(path))            return await getProduct(event);
    if (method === 'PUT'    && /\/products\/[^/]+$/.test(path))            return await updateProduct(event, body);
    if (method === 'DELETE' && /\/products\/[^/]+$/.test(path))            return await deleteProduct(event);
    if (method === 'POST'   && /\/products\/[^/]+\/upload-url/.test(path)) return await getUploadUrl(event, body);
    return res(404, { error: 'Route not found' });
  } catch (err) {
    console.error('Product error:', err);
    if (err.name === 'ConditionalCheckFailedException')
      return res(404, { error: 'Product not found' });
    return res(500, { error: 'Internal server error', details: err.message });
  }
};
