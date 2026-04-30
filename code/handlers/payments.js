'use strict';
/**
 * Payment Service Lambda Handler
 * Handles: POST /payments/webhook  (Razorpay / Stripe webhook)
 * Also triggered by SQS (order-processing-queue) for payment initiation
 * AWS Services: DynamoDB, SNS
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const crypto = require('crypto');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const sns = new SNSClient({ region: process.env.AWS_REGION });

const TABLE     = process.env.DYNAMODB_TABLE;
const SNS_TOPIC = process.env.SNS_TOPIC_ARN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-webhook-secret';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const res = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

// ─── Verify Razorpay Webhook Signature ────────────────────────────────────────
const verifyRazorpaySignature = (rawBody, signature) => {
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
};

// ─── Update Order Status ──────────────────────────────────────────────────────
const updateOrderStatus = async (orderId, userId, status, paymentDetails) => {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `ORDER#${orderId}`, SK: `USER#${userId}` },
    UpdateExpression: 'SET #status = :status, paymentDetails = :pd, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':pd':     paymentDetails,
      ':now':    new Date().toISOString(),
    },
  }));
};

// ─── Send SNS Notification ────────────────────────────────────────────────────
const sendNotification = async (orderId, userId, status, total) => {
  const message = status === 'PAID'
    ? `Your order #${orderId} has been confirmed! Total: ₹${total}. Thank you for shopping with us.`
    : `Payment failed for order #${orderId}. Please retry or contact support.`;

  await sns.send(new PublishCommand({
    TopicArn: SNS_TOPIC,
    Subject:  `Order ${status === 'PAID' ? 'Confirmed' : 'Payment Failed'} - #${orderId}`,
    Message:  message,
    MessageAttributes: {
      orderId: { DataType: 'String', StringValue: orderId },
      userId:  { DataType: 'String', StringValue: userId },
      status:  { DataType: 'String', StringValue: status },
    },
  }));
};

// ─── Handle Razorpay Webhook ──────────────────────────────────────────────────
const handleWebhook = async (event) => {
  const rawBody  = event.body || '';
  const sig      = event.headers?.['x-razorpay-signature'] || '';
  const body     = JSON.parse(rawBody);

  // Verify signature
  if (!verifyRazorpaySignature(rawBody, sig)) {
    console.warn('Invalid webhook signature');
    return res(401, { error: 'Invalid signature' });
  }

  const { event: eventType, payload } = body;
  console.log('Webhook event:', eventType);

  if (eventType === 'payment.captured') {
    const payment = payload?.payment?.entity;
    const orderId = payment?.notes?.orderId;
    const userId  = payment?.notes?.userId;

    if (!orderId || !userId) {
      console.error('Missing orderId/userId in payment notes');
      return res(400, { error: 'Missing order metadata' });
    }

    await updateOrderStatus(orderId, userId, 'PAID', {
      paymentId:   payment.id,
      method:      payment.method,
      amount:      payment.amount / 100,
      currency:    payment.currency,
      capturedAt:  new Date().toISOString(),
    });

    // Fetch order total for notification
    const order = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `ORDER#${orderId}`, SK: `USER#${userId}` },
    }));

    await sendNotification(orderId, userId, 'PAID', order.Item?.total);
    return res(200, { message: 'Payment processed', orderId, status: 'PAID' });
  }

  if (eventType === 'payment.failed') {
    const payment = payload?.payment?.entity;
    const orderId = payment?.notes?.orderId;
    const userId  = payment?.notes?.userId;

    if (orderId && userId) {
      await updateOrderStatus(orderId, userId, 'PAYMENT_FAILED', {
        reason: payment?.error_description || 'Unknown',
        failedAt: new Date().toISOString(),
      });
      await sendNotification(orderId, userId, 'FAILED', 0);
    }
    return res(200, { message: 'Payment failure recorded' });
  }

  return res(200, { message: `Event ${eventType} acknowledged` });
};

// ─── Handle SQS Trigger (Order Queue) ────────────────────────────────────────
const handleSQS = async (event) => {
  const results = [];

  for (const record of event.Records) {
    try {
      const { orderId, userId, total } = JSON.parse(record.body);
      console.log(`Processing order from queue: ${orderId}`);

      // In production: create a Razorpay/Stripe payment order here
      // For this project, we simulate payment initiation
      const simulatedPaymentOrderId = `pay_sim_${Date.now()}`;

      await updateOrderStatus(orderId, userId, 'AWAITING_PAYMENT', {
        paymentOrderId: simulatedPaymentOrderId,
        amount: total,
        createdAt: new Date().toISOString(),
      });

      results.push({ orderId, status: 'AWAITING_PAYMENT', paymentOrderId: simulatedPaymentOrderId });
      console.log(`Order ${orderId} queued for payment`);
    } catch (err) {
      console.error('SQS record processing error:', err, record);
      // Don't throw — let other records process. Failed message goes to DLQ.
    }
  }

  return { processed: results };
};

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // SQS trigger
  if (event.Records && event.Records[0]?.eventSource === 'aws:sqs') {
    return handleSQS(event);
  }

  // HTTP webhook
  const path   = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';

  try {
    if (method === 'POST' && path.endsWith('/payments/webhook'))
      return await handleWebhook(event);
    return res(404, { error: 'Route not found' });
  } catch (err) {
    console.error('Payment error:', err);
    return res(500, { error: 'Internal server error', details: err.message });
  }
};
