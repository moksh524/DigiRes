const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'DigiRes POS & QR Platform' });
});

// 1. Create Razorpay Order
app.post('/api/create-razorpay-order', (req, res) => {
  const { amount, receipt, keyId, keySecret } = req.body || {};
  const rzpKey = keyId || process.env.RAZORPAY_KEY_ID;
  const rzpSecret = keySecret || process.env.RAZORPAY_KEY_SECRET;

  if (!rzpKey || !rzpSecret) {
    return res.status(400).json({ error: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET required.' });
  }

  const payload = JSON.stringify({
    amount: Math.round(Number(amount) * 100),
    currency: 'INR',
    receipt: receipt || `rcpt_${Date.now()}`
  });

  const auth = Buffer.from(`${rzpKey}:${rzpSecret}`).toString('base64');
  const options = {
    hostname: 'api.razorpay.com',
    port: 443,
    path: '/v1/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => { data += chunk; });
    apiRes.on('end', () => {
      try {
        res.status(apiRes.statusCode).json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: 'Invalid response from Razorpay' });
      }
    });
  });

  apiReq.on('error', (err) => res.status(500).json({ error: err.message }));
  apiReq.write(payload);
  apiReq.end();
});

// 2. Automatic System Verification of Razorpay Payment Signature
app.post('/api/verify-razorpay-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, keySecret } = req.body || {};
  const rzpSecret = keySecret || process.env.RAZORPAY_KEY_SECRET;

  if (!rzpSecret || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing verification parameters.' });
  }

  const expected = crypto
    .createHmac('sha256', rzpSecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected === razorpay_signature) {
    return res.json({ verified: true, paymentId: razorpay_payment_id });
  }
  return res.status(400).json({ verified: false, error: 'Signature mismatch.' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DigiRes running at http://localhost:${PORT}`);
});