const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API_BASE = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== PayPal Access Token取得 =====
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await axios({
    method: 'post',
    url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: 'grant_type=client_credentials'
  });
  return response.data.access_token;
}

// ===== User ID Token生成（target_customer_id対応）=====
async function generateUserIdToken(customerId = null) {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  let postData = 'grant_type=client_credentials&response_type=id_token';
  if (customerId) {
    postData += `&target_customer_id=${customerId}`;
  }
  const response = await axios({
    method: 'post',
    url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: postData
  });
  return response.data.id_token;
}

// ===== ルート =====

app.get('/api/config', (req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE });
});

// User ID Token生成
app.get('/api/generate-client-token', async (req, res) => {
  try {
    const { customer_id } = req.query;
    const idToken = await generateUserIdToken(customer_id || null);
    res.json({ id_token: idToken });
  } catch (error) {
    console.error('User ID Token error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== [NEW] Setup Token作成（決済なしVault用）=====
// POST /api/setup-tokens
// body: { customerId: "xxx" } ← Returning payerの場合のみ
app.post('/api/setup-tokens', async (req, res) => {
  try {
    const { customerId } = req.body;
    const accessToken = await getPayPalAccessToken();

    const payload = {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          experience_context: {
            shipping_preference: 'NO_SHIPPING',
            return_url: `${req.protocol}://${req.get('host')}/vault-success`,
            cancel_url: `${req.protocol}://${req.get('host')}/vault-cancel`
          }
        }
      }
    };

    // Returning payerの場合はcustomer IDを紐付け
    if (customerId) {
      payload.customer = { id: customerId };
      console.log(`Setup Token作成（Returning payer）: customer_id=${customerId}`);
    } else {
      console.log('Setup Token作成（新規payer）');
    }

    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v3/vault/setup-tokens`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `SETUP-${Date.now()}`
      },
      data: payload
    });

    console.log('Setup Token作成成功:', response.data.id);
    console.log('Status:', response.data.status);
    res.json(response.data);

  } catch (error) {
    console.error('Setup Token作成エラー:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Setup Token作成に失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// ===== [NEW] Payment Token作成（Setup Token承認後）=====
// POST /api/payment-tokens
// body: { setupTokenId: "xxx" }
app.post('/api/payment-tokens', async (req, res) => {
  try {
    const { setupTokenId } = req.body;
    if (!setupTokenId) {
      return res.status(400).json({ error: 'setupTokenId is required' });
    }

    const accessToken = await getPayPalAccessToken();

    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v3/vault/payment-tokens`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `PMTOKEN-${Date.now()}`
      },
      data: {
        payment_source: {
          token: {
            id: setupTokenId,
            type: 'SETUP_TOKEN'
          }
        }
      }
    });

    console.log('Payment Token作成成功:', response.data.id);
    console.log('Customer ID:', response.data.customer?.id);
    res.json(response.data);

  } catch (error) {
    console.error('Payment Token作成エラー:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Payment Token作成に失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// Payment Tokens一覧取得
app.get('/api/payment-tokens/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const accessToken = await getPayPalAccessToken();
    const response = await axios({
      method: 'get',
      url: `${PAYPAL_API_BASE}/v3/vault/payment-tokens?customer_id=${customerId}`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// ===== 既存の決済フロー（Returning Payer用）=====
app.post('/api/orders', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { customerId, vaultId } = req.body;

    let orderPayload;

    if (vaultId) {
      // Vault IDで決済（ユーザー操作不要）
      console.log(`Vault IDで決済: ${vaultId}`);
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'JPY', value: '100' },
          description: 'PayPal Vault テスト商品（保存済み）'
        }],
        payment_source: {
          token: {
            id: vaultId,
            type: 'PAYMENT_METHOD_TOKEN'
          }
        }
      };
    } else {
      // 通常決済（During Purchase Vault）
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'JPY', value: '100' },
          description: 'PayPal Vault テスト商品'
        }],
        payment_source: {
          paypal: {
            experience_context: {
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              brand_name: 'PayPal Vault Demo',
              locale: 'ja-JP',
              landing_page: 'LOGIN',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${req.protocol}://${req.get('host')}/success`,
              cancel_url: `${req.protocol}://${req.get('host')}/cancel`
            },
            attributes: {
              vault: {
                store_in_vault: 'ON_SUCCESS',
                usage_type: 'MERCHANT',
                customer_type: 'CONSUMER'
              }
            }
          }
        }
      };
      if (customerId) {
        orderPayload.payment_source.paypal.attributes.vault.customer_id = customerId;
      }
    }

    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `ORDER-${Date.now()}`
      },
      data: orderPayload
    });

    res.json(response.data);
  } catch (error) {
    console.error('Order作成エラー:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const { orderId } = req.params;
    const accessToken = await getPayPalAccessToken();
    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `CAPTURE-${Date.now()}`
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
