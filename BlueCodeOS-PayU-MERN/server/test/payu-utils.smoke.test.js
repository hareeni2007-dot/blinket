import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  sha512,
  formatAmount,
  createRequestHash,
  verifyResponseHash,
  createVerifyPaymentHash,
  createRefundHash,
  createCheckActionStatusHash,
  getPayUEndpoints
} from '../src/utils/payu.js';

const key = 'local_test_key';
const salt = 'local_test_salt';
const txnid = 'bluecode-test-transaction';
const amount = '99.00';
const productinfo = 'BlueCode OS Starter subscription';
const firstname = 'Test User';
const email = 'test@example.com';
const digest = value => crypto.createHash('sha512').update(value, 'utf8').digest('hex');

test('formats payment amount to two decimals and rejects invalid values', () => {
  assert.equal(formatAmount('99'), '99.00');
  assert.equal(formatAmount('99.5'), '99.50');
  assert.throws(() => formatAmount('not-a-number'));
});

test('creates request hash in the documented PayU India field order', () => {
  const actual = createRequestHash({ key, salt, txnid, amount, productinfo, firstname, email });
  const expected = digest([key, txnid, amount, productinfo, firstname, email, ...Array(10).fill(''), salt].join('|'));
  assert.equal(actual, expected);
});

for (const scenario of [
  { name: 'standard response', fields: {} },
  { name: 'response with additional charges', fields: { additional_charges: '2.00' } },
  { name: 'split response', fields: { splitInfo: '{"type":"absolute"}' } },
  { name: 'combined additional charges and split response', fields: { additional_charges: '2.00', splitInfo: '{"type":"absolute"}' } }
]) {
  test(`verifies ${scenario.name}`, () => {
    const body = { status: 'success', email, firstname, productinfo, amount, txnid, key, ...scenario.fields };
    const sequence = [
      ...(body.additional_charges ? [body.additional_charges] : []),
      salt,
      'success',
      ...(body.splitInfo !== undefined ? [body.splitInfo] : []),
      ...Array(10).fill(''),
      email, firstname, productinfo, amount, txnid, key
    ].join('|');
    body.hash = digest(sequence);
    assert.equal(verifyResponseHash(body, salt), true);
    assert.equal(verifyResponseHash({ ...body, hash: 'invalid' }, salt), false);
  });
}

test('creates PayU verify, refund, and refund-status command hashes', () => {
  assert.equal(createVerifyPaymentHash({ key, txnid, salt }), digest(`${key}|verify_payment|${txnid}|${salt}`));
  assert.equal(createRefundHash({ key, mihpayid: '123456', salt }), digest(`${key}|cancel_refund_transaction|123456|${salt}`));
  assert.equal(createCheckActionStatusHash({ key, requestId: '789', salt }), digest(`${key}|check_action_status_txnid|789|${salt}`));
});


test('selects the official test and production endpoint pairs', () => {
  const oldEnv = process.env.PAYU_ENV;
  const oldPayment = process.env.PAYU_PAYMENT_URL;
  const oldPost = process.env.PAYU_POST_SERVICE_URL;
  try {
    delete process.env.PAYU_PAYMENT_URL;
    delete process.env.PAYU_POST_SERVICE_URL;
    process.env.PAYU_ENV = 'test';
    assert.equal(getPayUEndpoints().paymentUrl, 'https://test.payu.in/_payment');
    assert.equal(getPayUEndpoints().postServiceUrl, 'https://test.payu.in/merchant/postservice.php?form=2');
    process.env.PAYU_ENV = 'production';
    assert.equal(getPayUEndpoints().paymentUrl, 'https://secure.payu.in/_payment');
    assert.equal(getPayUEndpoints().postServiceUrl, 'https://info.payu.in/merchant/postservice.php?form=2');
    process.env.PAYU_ENV = 'invalid';
    assert.throws(() => getPayUEndpoints(), /PAYU_ENV/);
  } finally {
    if (oldEnv === undefined) delete process.env.PAYU_ENV; else process.env.PAYU_ENV = oldEnv;
    if (oldPayment === undefined) delete process.env.PAYU_PAYMENT_URL; else process.env.PAYU_PAYMENT_URL = oldPayment;
    if (oldPost === undefined) delete process.env.PAYU_POST_SERVICE_URL; else process.env.PAYU_POST_SERVICE_URL = oldPost;
  }
});
