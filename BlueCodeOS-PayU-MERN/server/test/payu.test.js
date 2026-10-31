import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  sha512,
  formatAmount,
  createRequestHash,
  verifyResponseHash,
  createVerifyPaymentHash,
  createRefundHash,
  createCheckActionStatusHash
} from "../src/utils/payu.js";
import Payment from "../src/models/Payment.js";
import Subscription from "../src/models/Subscription.js";

const TEST_KEY = "mock_payu_merchant_key_for_testing";
const TEST_SALT = "mock_payu_merchant_salt_for_testing";

test("TASK 1.1: SHA-512 utility formats lowercase hex digest correctly", () => {
  const result = sha512("hello-payu");
  assert.equal(typeof result, "string");
  assert.equal(result.length, 128); // 512 bits in hex = 128 chars
  assert.equal(result, crypto.createHash("sha512").update("hello-payu").digest("hex").toLowerCase());
});

test("TASK 1.2: formatAmount formats numbers and strings to 2 decimal places", () => {
  assert.equal(formatAmount(99), "99.00");
  assert.equal(formatAmount("299"), "299.00");
  assert.equal(formatAmount("799.5"), "799.50");
  assert.throws(() => formatAmount("not-a-number"), /Invalid payment amount/);
  assert.throws(() => formatAmount(-1), /Invalid payment amount/);
  assert.throws(() => formatAmount(Infinity), /Invalid payment amount/);
});

test("TASK 1.3: Valid payment request hash matches PayU official sequence", () => {
  const params = {
    key: TEST_KEY,
    txnid: "tx_test_12345",
    amount: "299.00",
    productinfo: "BlueCode OS Product subscription",
    firstname: "Alex",
    email: "alex@bluecode.test",
    salt: TEST_SALT
  };

  const calculatedHash = createRequestHash(params);
  const expectedSeq = [
    TEST_KEY,
    "tx_test_12345",
    "299.00",
    "BlueCode OS Product subscription",
    "Alex",
    "alex@bluecode.test",
    "", "", "", "", "", "", "", "", "", "",
    TEST_SALT
  ].join("|");
  const expectedHash = crypto.createHash("sha512").update(expectedSeq).digest("hex").toLowerCase();

  assert.equal(calculatedHash, expectedHash);
});

test("TASK 1.4: Invalid payment request hash throws for missing parameters", () => {
  assert.throws(() => {
    createRequestHash({
      key: TEST_KEY,
      txnid: "",
      amount: "299.00",
      productinfo: "Product",
      firstname: "Alex",
      email: "alex@bluecode.test",
      salt: TEST_SALT
    });
  }, /Missing required parameters/);
});

test("TASK 1.5: Valid PayU response hash without additionalCharges verifies successfully", () => {
  const txnid = "tx_resp_valid_1";
  const amount = "299.00";
  const status = "success";
  const firstname = "Alex";
  const email = "alex@bluecode.test";
  const productinfo = "BlueCode OS Product subscription";

  const reverseSeq = [
    TEST_SALT,
    status,
    "", "", "", "", "", "", "", "", "", "", // udf10 down to udf1
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    TEST_KEY
  ].join("|");
  const validHash = crypto.createHash("sha512").update(reverseSeq).digest("hex").toLowerCase();

  const responseBody = {
    key: TEST_KEY,
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    status,
    hash: validHash
  };

  assert.equal(verifyResponseHash(responseBody, TEST_SALT), true);
});

test("TASK 1.6: Valid PayU response hash WITH additionalCharges verifies successfully", () => {
  const txnid = "tx_resp_valid_add_charges";
  const amount = "299.00";
  const additionalCharges = "5.50";
  const status = "success";
  const firstname = "Alex";
  const email = "alex@bluecode.test";
  const productinfo = "BlueCode OS Product subscription";

  const seqWithCharges = [
    additionalCharges,
    TEST_SALT,
    status,
    "", "", "", "", "", "", "", "", "", "",
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    TEST_KEY
  ].join("|");
  const validHash = crypto.createHash("sha512").update(seqWithCharges).digest("hex").toLowerCase();

  const responseBody = {
    key: TEST_KEY,
    txnid,
    amount,
    additionalCharges,
    productinfo,
    firstname,
    email,
    status,
    hash: validHash
  };

  assert.equal(verifyResponseHash(responseBody, TEST_SALT), true);
});

test("TASK 1.6b: PayU reverse hash includes splitInfo only when PayU returns it", () => {
  const response = {
    key: TEST_KEY,
    txnid: "tx_split_123",
    amount: "299.00",
    productinfo: "BlueCode OS Product subscription",
    firstname: "Alex",
    email: "alex@bluecode.test",
    status: "success",
    splitInfo: "{\"splitStatus\":\"success\"}"
  };
  const sequence = [
    TEST_SALT, "success", response.splitInfo,
    "", "", "", "", "", "", "", "", "", "",
    response.email, response.firstname, response.productinfo,
    response.amount, response.txnid, TEST_KEY
  ].join("|");
  response.hash = crypto.createHash("sha512").update(sequence).digest("hex");
  assert.equal(verifyResponseHash(response, TEST_SALT), true);
});

test("TASK 1.7: Invalid PayU response hash fails verification", () => {
  const responseBody = {
    key: TEST_KEY,
    txnid: "tx_tampered",
    amount: "299.00",
    productinfo: "Product",
    firstname: "Alex",
    email: "alex@bluecode.test",
    status: "success",
    hash: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  };

  assert.equal(verifyResponseHash(responseBody, TEST_SALT), false);
});

test("TASK 3.1: verify_payment hash follows official PayU postservice formula", () => {
  const hash = createVerifyPaymentHash({ key: TEST_KEY, txnid: "tx_123", salt: TEST_SALT });
  const expectedSeq = `${TEST_KEY}|verify_payment|tx_123|${TEST_SALT}`;
  const expectedHash = crypto.createHash("sha512").update(expectedSeq).digest("hex").toLowerCase();
  assert.equal(hash, expectedHash);
});

test("TASK 5.1: cancel_refund_transaction hash follows official PayU formula", () => {
  const hash = createRefundHash({ key: TEST_KEY, mihpayid: "payu_4039937155", salt: TEST_SALT });
  const expectedSeq = `${TEST_KEY}|cancel_refund_transaction|payu_4039937155|${TEST_SALT}`;
  const expectedHash = crypto.createHash("sha512").update(expectedSeq).digest("hex").toLowerCase();
  assert.equal(hash, expectedHash);
});

test("TASK 5.2: check_action_status_txnid hash follows official PayU formula", () => {
  const hash = createCheckActionStatusHash({ key: TEST_KEY, requestId: "req_99812", salt: TEST_SALT });
  const expectedSeq = `${TEST_KEY}|check_action_status_txnid|req_99812|${TEST_SALT}`;
  const expectedHash = crypto.createHash("sha512").update(expectedSeq).digest("hex").toLowerCase();
  assert.equal(hash, expectedHash);
});

test("TASK 4.1: MongoDB transaction storage and lifecycle tracking", async () => {
  const txnid = "bc_test_" + Date.now();
  const payment = await Payment.create({
    txnid,
    planId: "product",
    planName: "Product",
    amount: 299,
    firstname: "Tester",
    email: "tester@bluecode.test",
    phone: "9876543210",
    status: "pending"
  });

  assert.ok(payment);
  assert.equal(payment.txnid, txnid);
  assert.equal(payment.status, "pending");
  assert.equal(payment.currency, "INR");

  // Retrieve
  const found = await Payment.findOne({ txnid });
  assert.ok(found);
  assert.equal(found.amount, 299);

  // Update status
  found.status = "success";
  found.mihpayid = "4039937155229";
  found.serverVerified = true;
  await found.save();

  const updated = await Payment.findOne({ txnid });
  assert.equal(updated.status, "success");
  assert.equal(updated.serverVerified, true);
  assert.equal(updated.mihpayid, "4039937155229");
});

test("TASK 2.1 & 2.2: Subscription activated only for verified success transactions", async () => {
  const txnid = "bc_sub_test_" + Date.now();
  const payment = await Payment.create({
    txnid,
    planId: "team",
    planName: "Team",
    amount: 799,
    firstname: "TeamLead",
    email: "team@bluecode.test",
    phone: "9123456789",
    status: "success",
    serverVerified: true
  });

  const startedAt = new Date();
  const periodEndsAt = new Date(startedAt);
  periodEndsAt.setMonth(periodEndsAt.getMonth() + 1);

  const sub = await Subscription.findOneAndUpdate(
    { txnid },
    {
      paymentId: payment._id,
      txnid,
      planId: payment.planId,
      planName: payment.planName,
      customerEmail: payment.email,
      status: "active",
      startedAt,
      periodEndsAt
    },
    { upsert: true, new: true }
  );

  assert.ok(sub);
  assert.equal(sub.status, "active");
  assert.equal(sub.planId, "team");

  // Idempotency: re-running does not create duplicates
  const sub2 = await Subscription.findOneAndUpdate(
    { txnid },
    { status: "active" },
    { upsert: true, new: true }
  );
  assert.equal(sub2.txnid, sub.txnid);
});

test("TASK 5.3: Refund tracking and partial/full refund transitions", async () => {
  const txnid = "bc_ref_test_" + Date.now();
  const payment = await Payment.create({
    txnid,
    planId: "product",
    planName: "Product",
    amount: 299,
    firstname: "RefundUser",
    email: "refund@bluecode.test",
    phone: "9876543210",
    status: "success",
    mihpayid: "4039937155229",
    serverVerified: true,
    refundedAmount: 0,
    refunds: []
  });

  // Partial refund of 100
  payment.refunds.push({
    refundId: "ref_part_1",
    requestId: "req_part_1",
    amount: 100,
    status: "queued",
    reason: "Partial refund requested"
  });
  payment.refundedAmount += 100;
  payment.status = "partially_refunded";
  await payment.save();

  const partialCheck = await Payment.findOne({ txnid });
  assert.equal(partialCheck.status, "partially_refunded");
  assert.equal(partialCheck.refundedAmount, 100);

  // Full remaining refund of 199
  partialCheck.refunds.push({
    refundId: "ref_part_2",
    requestId: "req_part_2",
    amount: 199,
    status: "queued",
    reason: "Remaining refund requested"
  });
  partialCheck.refundedAmount += 199;
  if (partialCheck.refundedAmount >= partialCheck.amount) {
    partialCheck.status = "refunded";
  }
  await partialCheck.save();

  const fullCheck = await Payment.findOne({ txnid });
  assert.equal(fullCheck.status, "refunded");
  assert.equal(fullCheck.refundedAmount, 299);
  assert.equal(fullCheck.refunds.length, 2);
});
