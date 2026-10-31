import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import paymentRoutes from "../src/routes/payments.js";
import Payment from "../src/models/Payment.js";
import Subscription from "../src/models/Subscription.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Mock PayU postservice endpoint for reliable isolated integration testing
app.post("/mock-payu-postservice", (req, res) => {
  const { command, var1, var2, var3 } = req.body ?? {};

  if (command === "verify_payment") {
    const txnid = var1;
    return res.json({
      status: 1,
      msg: "Transaction Fetched Successfully",
      transaction_details: {
        [txnid]: {
          mihpayid: "payu_test_99812",
          status: "success",
          amt: "99.00",
          transaction_amount: "99.00",
          bank_ref_num: "BANK_REF_99812",
          mode: "CC",
          unmappedstatus: "captured"
        }
      }
    });
  }

  if (command === "cancel_refund_transaction") {
    if (!req.body.var5 || !String(req.body.var5).startsWith("https://")) {
      return res.status(400).json({ status: 0, msg: "Refund callback URL (var5) is required." });
    }
    return res.json({
      status: 1,
      msg: "Refund Request Queued",
      request_id: "req_refund_12345",
      bank_ref_num: "REFUND_BANK_REF"
    });
  }

  if (command === "check_action_status_txnid") {
    return res.json({
      status: 1,
      msg: "1 out of 1 Transactions Fetched Successfully",
      transaction_details: {
        [var1]: { [var1]: { status: "success", request_id: var1, amt: "99.00" } }
      }
    });
  }

  res.status(400).json({ status: 0, msg: "Unknown command" });
});

app.use("/api/payments", paymentRoutes);

let server;
let baseUrl;
let originalEnv = {};

test.before(async () => {
  originalEnv = {
    PAYU_MERCHANT_KEY: process.env.PAYU_MERCHANT_KEY,
    PAYU_MERCHANT_SALT: process.env.PAYU_MERCHANT_SALT,
    ADMIN_SECRET_KEY: process.env.ADMIN_SECRET_KEY,
    CLIENT_URL: process.env.CLIENT_URL,
    SERVER_URL: process.env.SERVER_URL,
    PAYU_POST_SERVICE_URL: process.env.PAYU_POST_SERVICE_URL,
    PAYU_REFUND_CALLBACK_URL: process.env.PAYU_REFUND_CALLBACK_URL
  };

  process.env.PAYU_MERCHANT_KEY = "mock_payu_merchant_key_for_testing";
  process.env.PAYU_MERCHANT_SALT = "mock_payu_merchant_salt_for_testing";
  process.env.ADMIN_SECRET_KEY = "mock_admin_secret_key_for_testing";
  process.env.CLIENT_URL = "http://localhost:5173";

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      process.env.SERVER_URL = baseUrl;
      process.env.PAYU_POST_SERVICE_URL = `${baseUrl}/mock-payu-postservice`;
      process.env.PAYU_REFUND_CALLBACK_URL = "https://merchant.example.test/api/payments/refund-callback";
      resolve();
    });
  });
});

test.after(async () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("INTEGRATION 1: POST /api/payments/create validates input and generates valid hash & record", async () => {
  const res = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "product",
      firstname: "Jane Doe",
      email: "jane@bluecode.test",
      phone: "+919876543210"
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.paymentUrl);
  assert.ok(data.fields);
  assert.equal(data.fields.key, "mock_payu_merchant_key_for_testing");
  assert.equal(data.fields.amount, "299.00");
  assert.equal(data.fields.firstname, "Jane Doe");
  assert.equal(data.fields.email, "jane@bluecode.test");
  assert.ok(data.fields.hash);
  assert.ok(data.fields.txnid);

  const stored = await Payment.findOne({ txnid: data.fields.txnid });
  assert.ok(stored);
  assert.equal(stored.status, "pending");
  assert.equal(stored.amount, 299);
});

test("INTEGRATION 2: POST /api/payments/create rejects invalid plan ID", async () => {
  const res = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "invalid_plan",
      firstname: "Jane Doe",
      email: "jane@bluecode.test",
      phone: "+919876543210"
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.message, /valid subscription plan/i);
});

test("INTEGRATION 3: Success callback verifies hash + server-to-server verify_payment, then activates subscription", async () => {
  const createRes = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "starter",
      firstname: "Bob Smith",
      email: "bob@bluecode.test",
      phone: "9876543210"
    })
  });
  const createData = await createRes.json();
  const txnid = createData.fields.txnid;
  const amount = createData.fields.amount;

  const salt = process.env.PAYU_MERCHANT_SALT;
  const key = process.env.PAYU_MERCHANT_KEY;
  const status = "success";
  const firstname = "Bob Smith";
  const email = "bob@bluecode.test";
  const productinfo = "BlueCode OS Starter subscription";
  const mihpayid = "payu_test_99812";

  const reverseSeq = [
    salt, status,
    "", "", "", "", "", "", "", "", "", "",
    email, firstname, productinfo, amount, txnid, key
  ].join("|");
  const hash = crypto.createHash("sha512").update(reverseSeq).digest("hex").toLowerCase();

  const callbackParams = new URLSearchParams({
    key,
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    status,
    mihpayid,
    hash
  });

  const callbackRes = await fetch(`${baseUrl}/api/payments/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackParams.toString(),
    redirect: "manual"
  });

  assert.equal(callbackRes.status, 302);
  const location = callbackRes.headers.get("location");
  assert.match(location, /status=success/);

  // Check database update
  const updatedPayment = await Payment.findOne({ txnid });
  assert.equal(updatedPayment.status, "success");
  assert.equal(updatedPayment.hashVerified, true);
  assert.equal(updatedPayment.serverVerified, true);
  assert.equal(updatedPayment.mihpayid, mihpayid);

  // Check subscription activation
  const sub = await Subscription.findOne({ txnid });
  assert.ok(sub);
  assert.equal(sub.status, "active");
  assert.equal(sub.planId, "starter");
});

test("INTEGRATION 4: Callback idempotency prevents duplicate subscription activations", async () => {
  const createRes = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "starter",
      firstname: "Duplicate Check",
      email: "dup@bluecode.test",
      phone: "9876543210"
    })
  });
  const { fields } = await createRes.json();
  const { txnid, amount, key } = fields;
  const salt = process.env.PAYU_MERCHANT_SALT;

  const reverseSeq = [
    salt, "success",
    "", "", "", "", "", "", "", "", "", "",
    "dup@bluecode.test", "Duplicate Check", "BlueCode OS Starter subscription", amount, txnid, key
  ].join("|");
  const hash = crypto.createHash("sha512").update(reverseSeq).digest("hex").toLowerCase();

  const callbackParams = new URLSearchParams({
    key, txnid, amount, productinfo: "BlueCode OS Starter subscription",
    firstname: "Duplicate Check", email: "dup@bluecode.test", status: "success",
    mihpayid: "payu_test_99812", hash
  });

  // Call once
  await fetch(`${baseUrl}/api/payments/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackParams.toString(),
    redirect: "manual"
  });

  // Call second time
  const dupRes = await fetch(`${baseUrl}/api/payments/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackParams.toString(),
    redirect: "manual"
  });

  assert.equal(dupRes.status, 302);
  const location = dupRes.headers.get("location");
  assert.match(location, /status=success/);

  const sub = await Subscription.findOne({ txnid });
  assert.ok(sub);
  assert.equal(sub.status, "active");

  // A malformed repeated callback must not downgrade an already verified payment.
  const tamperedParams = new URLSearchParams(callbackParams);
  tamperedParams.set("amount", "1.00");
  const tamperedRes = await fetch(`${baseUrl}/api/payments/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tamperedParams.toString(),
    redirect: "manual"
  });
  assert.equal(tamperedRes.status, 302);
  const stillVerified = await Payment.findOne({ txnid });
  assert.equal(stillVerified.status, "success");
  assert.equal(stillVerified.serverVerified, true);
});

test("INTEGRATION 5: Failure callback marks payment as failed and does not activate subscription", async () => {
  const createRes = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "team",
      firstname: "Fail Tester",
      email: "fail@bluecode.test",
      phone: "9876543210"
    })
  });
  const { fields } = await createRes.json();
  const { txnid, amount, key } = fields;
  const salt = process.env.PAYU_MERCHANT_SALT;

  const reverseSeq = [
    salt, "failure",
    "", "", "", "", "", "", "", "", "", "",
    "fail@bluecode.test", "Fail Tester", "BlueCode OS Team subscription", amount, txnid, key
  ].join("|");
  const hash = crypto.createHash("sha512").update(reverseSeq).digest("hex").toLowerCase();

  const callbackParams = new URLSearchParams({
    key, txnid, amount, productinfo: "BlueCode OS Team subscription",
    firstname: "Fail Tester", email: "fail@bluecode.test", status: "failure",
    mihpayid: "payu_fail_123", hash
  });

  const failRes = await fetch(`${baseUrl}/api/payments/failure`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackParams.toString(),
    redirect: "manual"
  });

  assert.equal(failRes.status, 302);
  const location = failRes.headers.get("location");
  assert.match(location, /status=failed/);

  const payment = await Payment.findOne({ txnid });
  assert.equal(payment.status, "failed");

  const sub = await Subscription.findOne({ txnid });
  assert.equal(sub, null);
});

test("INTEGRATION 6: Tampered hash callback is rejected and marked verification_failed", async () => {
  const createRes = await fetch(`${baseUrl}/api/payments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: "product",
      firstname: "Hacker",
      email: "hacker@bluecode.test",
      phone: "9876543210"
    })
  });
  const { fields } = await createRes.json();
  const { txnid, amount, key } = fields;

  const callbackParams = new URLSearchParams({
    key, txnid, amount, productinfo: "BlueCode OS Product subscription",
    firstname: "Hacker", email: "hacker@bluecode.test", status: "success",
    mihpayid: "payu_fake_123",
    hash: "tampered_invalid_sha512_hash"
  });

  const res = await fetch(`${baseUrl}/api/payments/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackParams.toString(),
    redirect: "manual"
  });

  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location, /status=verification_failed/);

  const payment = await Payment.findOne({ txnid });
  assert.equal(payment.status, "verification_failed");
  assert.equal(payment.hashVerified, false);

  const sub = await Subscription.findOne({ txnid });
  assert.equal(sub, null);
});

test("INTEGRATION 7: Server-side transaction verification endpoint POST /api/payments/verify/:txnid", async () => {
  const txnid = "bc_verify_endpoint_" + Date.now();
  await Payment.create({
    txnid,
    planId: "starter",
    planName: "Starter",
    amount: 99,
    firstname: "Verify Endpoint User",
    email: "verify@bluecode.test",
    phone: "9876543210",
    status: "pending"
  });

  const res = await fetch(`${baseUrl}/api/payments/verify/${txnid}`, {
    method: "POST",
    headers: { "x-admin-key": process.env.ADMIN_SECRET_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.verified, true);
  assert.equal(data.status, "success");

  const sub = await Subscription.findOne({ txnid });
  assert.ok(sub);
  assert.equal(sub.status, "active");
});

test("INTEGRATION 8: GET /api/payments/status/:txnid returns sanitized status", async () => {
  const txnid = "bc_status_query_" + Date.now();
  await Payment.create({
    txnid,
    planId: "product",
    planName: "Product",
    amount: 299,
    firstname: "Query User",
    email: "query@bluecode.test",
    phone: "9876543210",
    status: "success",
    serverVerified: true
  });

  const res = await fetch(`${baseUrl}/api/payments/status/${txnid}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.txnid, txnid);
  assert.equal(data.planName, "Product");
  assert.equal(data.amount, 299);
  assert.equal(data.status, "success");
  assert.equal(data.serverVerified, true);
  assert.equal(data.salt, undefined);
  assert.equal(data.rawResponse, undefined);
});

test("INTEGRATION 9: POST /api/payments/refund performs refund via PayU API and updates MongoDB", async () => {
  // Test unauthorized access
  const unauthRes = await fetch(`${baseUrl}/api/payments/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txnid: "any" })
  });
  assert.equal(unauthRes.status, 401);

  // Setup successful payment
  const txnid = "bc_refund_full_" + Date.now();
  const payment = await Payment.create({
    txnid,
    planId: "product",
    planName: "Product",
    amount: 299,
    firstname: "Refundable",
    email: "ref@bluecode.test",
    phone: "9876543210",
    status: "success",
    mihpayid: "payu_test_99812",
    serverVerified: true,
    refundedAmount: 0
  });

  // Execute full refund
  const refundRes = await fetch(`${baseUrl}/api/payments/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": process.env.ADMIN_SECRET_KEY
    },
    body: JSON.stringify({
      txnid,
      amount: 299,
      reason: "Customer requested cancellation"
    })
  });

  assert.equal(refundRes.status, 200);
  const refundData = await refundRes.json();
  assert.equal(refundData.success, true);
  assert.equal(refundData.paymentStatus, "success");
  assert.equal(refundData.totalRefunded, 0);

  // Check refund status inquiry endpoint
  const statusRes = await fetch(`${baseUrl}/api/payments/refund-status/${txnid}/${refundData.requestId}`, {
    headers: { "x-admin-key": process.env.ADMIN_SECRET_KEY }
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.match(statusData.status, /success/i);
  const updated = await Payment.findOne({ txnid });
  assert.equal(updated.status, "refunded");
  assert.equal(updated.refundedAmount, 299);
});


test("INTEGRATION 10: PayU refund callback updates status once and validates request identifiers", async () => {
  const txnid = "bc_refund_callback_" + Date.now();
  const token = "BC" + Date.now() + "abcdef";
  const requestId = "req_callback_123";
  const payment = await Payment.create({
    txnid,
    planId: "product",
    planName: "Product",
    amount: 299,
    firstname: "Refund Callback",
    email: "refund-callback@bluecode.test",
    phone: "9876543210",
    status: "success",
    mihpayid: "payu_refund_callback_123",
    serverVerified: true,
    refunds: [{
      refundId: token,
      requestId,
      token,
      amount: 299,
      status: "queued"
    }]
  });

  const payload = {
    merchantTxnId: txnid,
    token,
    request_id: requestId,
    mihpayid: payment.mihpayid,
    amt: "299.00",
    status: "success",
    action: "refund",
    key: process.env.PAYU_MERCHANT_KEY
  };

  const first = await fetch(`${baseUrl}/api/payments/refund-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${baseUrl}/api/payments/refund-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(second.status, 200);

  const updated = await Payment.findOne({ txnid });
  assert.equal(updated.status, "refunded");
  assert.equal(updated.refundedAmount, 299);
  assert.equal(updated.refunds[0].status, "success");
});
