// ─────────────────────────────────────────────
//  OLIA Born to Move — Backend Node.js
//  Stripe (carta + Klarna) + PayPal + Email (Resend)
//  npm install express stripe @paypal/checkout-server-sdk cors dotenv resend
// ─────────────────────────────────────────────

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
const paypal    = require('@paypal/checkout-server-sdk');
const { Resend } = require('resend');
const resend    = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors({ origin: ['https://oliaborntomove.it', 'https://www.oliaborntomove.it'] }));
app.use(express.json());

// ── ENV richieste (.env) ──────────────────────
// STRIPE_SECRET_KEY=sk_live_...
// STRIPE_WEBHOOK_SECRET=whsec_...
// PAYPAL_CLIENT_ID=AV...
// PAYPAL_CLIENT_SECRET=EH...
// PAYPAL_ENV=live   (oppure sandbox per test)
// RESEND_API_KEY=re_...
// EMAIL_FROM=ordini@oliaborn.com
// EMAIL_STORE=info@oliaborn.com
// PORT=3000

// ── PayPal setup ─────────────────────────────
const paypalEnv = process.env.PAYPAL_ENV === 'live'
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

// ─────────────────────────────────────────────
//  STRIPE — Crea PaymentIntent
//  Supporta: carta, Apple Pay, Google Pay, Klarna
// ─────────────────────────────────────────────
app.post('/api/stripe/create-payment-intent', async (req, res) => {
  try {
    const { items, shipping, currency = 'eur' } = req.body;

    // Calcola totale lato server (sicuro!)
    const subtotal = items.reduce((sum, item) => {
      const price = parseFloat(item.price.replace('€','').replace(',','.'));
      return sum + price * item.qty;
    }, 0);
    const shippingCost = subtotal >= 80 ? 0 : (shipping?.express ? 5.90 : 0);
    const totalCents   = Math.round((subtotal + shippingCost) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   totalCents,
      currency: currency,
      payment_method_types: ['card', 'klarna', 'paypal'],
      metadata: {
        items: JSON.stringify(items.map(i => ({ name: i.name, qty: i.qty, size: i.size }))),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  STRIPE — Webhook (conferma ordine)
// ─────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi    = event.data.object;
      const items = JSON.parse(pi.metadata.items || '[]');
      const email = pi.receipt_email || pi.metadata.email;
      console.log('✅ Stripe pagamento ricevuto:', pi.id, '€' + pi.amount / 100);
      if (email) await sendOrderEmails(email, items, pi.amount / 100, pi.id);
    }

    res.json({ received: true });
  }
);

// ─────────────────────────────────────────────
//  PAYPAL — Crea ordine
// ─────────────────────────────────────────────
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { items, shipping } = req.body;

    const subtotal = items.reduce((sum, item) => {
      const price = parseFloat(item.price.replace('€','').replace(',','.'));
      return sum + price * item.qty;
    }, 0);
    const shippingCost = subtotal >= 80 ? 0 : (shipping?.express ? 5.90 : 0);
    const total = (subtotal + shippingCost).toFixed(2);

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'EUR',
          value: total,
          breakdown: {
            item_total:  { currency_code: 'EUR', value: subtotal.toFixed(2) },
            shipping:    { currency_code: 'EUR', value: shippingCost.toFixed(2) },
          }
        },
        items: items.map(i => ({
          name:       i.name,
          unit_amount:{ currency_code: 'EUR', value: parseFloat(i.price.replace('€','').replace(',','.')).toFixed(2) },
          quantity:   String(i.qty),
        })),
      }],
      application_context: {
        brand_name:  'OLIA Born to Move',
        return_url:  'https://tuo-sito-olia.com/success',
        cancel_url:  'https://tuo-sito-olia.com/cart',
        user_action: 'PAY_NOW',
      }
    });

    const order = await paypalClient.execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  PAYPAL — Cattura pagamento
// ─────────────────────────────────────────────
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body;
    const request = new paypal.orders.OrdersCaptureRequest(orderID);
    request.requestBody({});
    const capture = await paypalClient.execute(request);

    if (capture.result.status === 'COMPLETED') {
      const payer = capture.result.payer;
      const email = payer?.email_address;
      const total = parseFloat(capture.result.purchase_units[0].amount.value);
      const items = capture.result.purchase_units[0].items || [];
      console.log('✅ PayPal pagamento completato:', orderID);
      if (email) await sendOrderEmails(email, items, total, orderID);
    }

    res.json({ status: capture.result.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  EMAIL — Conferma ordine (cliente + store)
// ─────────────────────────────────────────────
async function sendOrderEmails(customerEmail, items, total, orderId) {
  const orderRef = orderId.substring(0, 12).toUpperCase();
  const itemsHtml = items.map(i =>
    `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #ede8f5;font-family:sans-serif;font-size:14px;color:#333">${i.name}${i.size ? ` — ${i.size}` : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid #ede8f5;font-family:sans-serif;font-size:14px;color:#333;text-align:right">x${i.qty || i.quantity}</td>
    </tr>`
  ).join('');

  // ── Email al cliente ──
  await resend.emails.send({
    from:    process.env.EMAIL_FROM,
    to:      customerEmail,
    subject: `💜 Ordine confermato — OLIA Born to Move #${orderRef}`,
    html: `
      <div style="max-width:560px;margin:0 auto;font-family:sans-serif;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #ede8f5">
        <div style="background:linear-gradient(135deg,#6B3FA8,#9B5FD4);padding:36px;text-align:center">
          <h1 style="color:#fff;font-size:32px;letter-spacing:6px;margin:0">OLIA</h1>
          <p style="color:rgba(255,255,255,.75);letter-spacing:3px;font-size:11px;margin:6px 0 0">BORN TO MOVE</p>
        </div>
        <div style="padding:36px">
          <h2 style="color:#1c1426;font-size:20px;margin:0 0 8px">Ordine confermato! 🎉</h2>
          <p style="color:#666;font-size:14px;line-height:1.7;margin:0 0 24px">
            Grazie per il tuo acquisto. Il tuo ordine è stato ricevuto e verrà preparato a breve.
          </p>
          <div style="background:#f7f0ff;border-radius:10px;padding:14px 18px;margin-bottom:24px;font-size:12px;color:#6B3FA8;font-weight:700;letter-spacing:1px">
            Riferimento ordine: #${orderRef}
          </div>
          <table style="width:100%;border-collapse:collapse">
            ${itemsHtml}
          </table>
          <div style="display:flex;justify-content:space-between;padding:16px 0 0;font-weight:700;font-size:16px;color:#1c1426">
            <span>Totale pagato</span>
            <span style="color:#9B5FD4">€${total.toFixed(2).replace('.',',')}</span>
          </div>
          <hr style="border:none;border-top:1px solid #ede8f5;margin:24px 0">
          <p style="color:#999;font-size:12px;line-height:1.8;margin:0">
            Spediremo il tuo ordine entro 1-2 giorni lavorativi.<br>
            Per qualsiasi domanda: <a href="mailto:info@oliaborn.com" style="color:#9B5FD4">info@oliaborn.com</a>
          </p>
        </div>
        <div style="background:#0a0810;padding:20px;text-align:center">
          <p style="color:rgba(255,255,255,.4);font-size:11px;margin:0">© 2026 OLIA Born to Move · <a href="https://oliaborn.com" style="color:#C97BE8;text-decoration:none">oliaborn.com</a></p>
        </div>
      </div>
    `,
  });

  // ── Notifica allo store ──
  await resend.emails.send({
    from:    process.env.EMAIL_FROM,
    to:      process.env.EMAIL_STORE,
    subject: `🛍 Nuovo ordine #${orderRef} — €${total.toFixed(2)}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#6B3FA8">Nuovo ordine ricevuto!</h2>
        <p><strong>Ref:</strong> #${orderRef}</p>
        <p><strong>Cliente:</strong> ${customerEmail}</p>
        <p><strong>Totale:</strong> €${total.toFixed(2)}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          ${itemsHtml}
        </table>
      </div>
    `,
  });

  console.log('📧 Email inviate a:', customerEmail);
}

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', brand: 'OLIA Born to Move' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 OLIA backend su http://localhost:${PORT}`));