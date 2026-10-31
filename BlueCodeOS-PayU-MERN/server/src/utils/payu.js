import crypto from "node:crypto";


/** Resolve PayU endpoints from an explicit environment. Test is the safe default. */
export function getPayUEndpoints(env = process.env.PAYU_ENV || "test") {
  const mode = String(env).trim().toLowerCase();
  if (!["test", "production"].includes(mode)) {
    throw new Error("PAYU_ENV must be either 'test' or 'production'.");
  }
  return mode === "production"
    ? {
        paymentUrl: process.env.PAYU_PAYMENT_URL || "https://secure.payu.in/_payment",
        postServiceUrl: process.env.PAYU_POST_SERVICE_URL || "https://info.payu.in/merchant/postservice.php?form=2"
      }
    : {
        paymentUrl: process.env.PAYU_PAYMENT_URL || "https://test.payu.in/_payment",
        postServiceUrl: process.env.PAYU_POST_SERVICE_URL || "https://test.payu.in/merchant/postservice.php?form=2"
      };
}

/**
 * Computes lowercase SHA-512 hex digest of input string
 */
export function sha512(value) {
  return crypto.createHash("sha512").update(String(value ?? ""), "utf8").digest("hex").toLowerCase();
}

/**
 * Format amount to 2 decimal places as required by PayU
 */
export function formatAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error("Invalid payment amount. Amount must be a finite number greater than zero.");
  }
  return num.toFixed(2);
}

/**
 * TASK 1: Generates the SHA-512 payment request hash according to official PayU India sequence:
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|udf6|udf7|udf8|udf9|udf10|salt)
 */
export function createRequestHash({
  key,
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
  udf5 = "",
  udf6 = "",
  udf7 = "",
  udf8 = "",
  udf9 = "",
  udf10 = "",
  salt
}) {
  if (!key || !txnid || !amount || !productinfo || !firstname || !email || !salt) {
    throw new Error("Missing required parameters for PayU request hash generation.");
  }

  const formattedAmount = formatAmount(amount);
  const sequence = [
    String(key),
    String(txnid),
    formattedAmount,
    String(productinfo),
    String(firstname),
    String(email),
    String(udf1 ?? ""),
    String(udf2 ?? ""),
    String(udf3 ?? ""),
    String(udf4 ?? ""),
    String(udf5 ?? ""),
    String(udf6 ?? ""),
    String(udf7 ?? ""),
    String(udf8 ?? ""),
    String(udf9 ?? ""),
    String(udf10 ?? ""),
    String(salt)
  ].join("|");

  return sha512(sequence);
}

/**
 * TASK 1: Verifies PayU India response hash with support for:
 * 1. Standard response:
 *    sha512(salt|status|udf10|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 * 2. With additionalCharges / additional_charges:
 *    sha512(additionalCharges|salt|status|udf10|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
export function verifyResponseHash(body = {}, salt) {
  if (!body || !salt) return false;

  const {
    status = "",
    email = "",
    firstname = "",
    productinfo = "",
    amount = "",
    txnid = "",
    key = "",
    hash = ""
  } = body;

  if (!hash || !txnid || !key || !status) return false;

  // Extract UDFs in reverse order (udf10 down to udf1)
  const udfReverse = [];
  for (let i = 10; i >= 1; i--) {
    udfReverse.push(String(body[`udf${i}`] ?? ""));
  }

  // PayU inserts splitInfo after status only for split transactions.
  // Do not add an empty splitInfo slot for ordinary payments: that would
  // change the standard reverse-hash string and cause a mismatch.
  const baseSequence = [String(salt), String(status)];
  if (body.splitInfo !== undefined && body.splitInfo !== null) {
    baseSequence.push(String(body.splitInfo));
  }
  baseSequence.push(
    ...udfReverse,
    String(email),
    String(firstname),
    String(productinfo),
    String(amount),
    String(txnid),
    String(key)
  );

  // Check if additional charges exist
  const additionalCharges = body.additional_charges ?? body.additionalCharges;

  const candidateSequences = [];

  if (additionalCharges !== undefined && additionalCharges !== null && String(additionalCharges).trim() !== "") {
    // PayU prepends additional_charges before the salt.
    candidateSequences.push([String(additionalCharges).trim(), ...baseSequence].join("|"));
  }

  // Standard sequence without additional charges
  candidateSequences.push(baseSequence.join("|"));

  const suppliedHash = String(hash).trim().toLowerCase();
  const suppliedBuf = Buffer.from(suppliedHash);

  for (const seq of candidateSequences) {
    const calcHash = sha512(seq);
    const calcBuf = Buffer.from(calcHash);
    if (calcBuf.length === suppliedBuf.length && crypto.timingSafeEqual(calcBuf, suppliedBuf)) {
      return true;
    }
  }

  return false;
}

/**
 * TASK 3: Hash for PayU server-to-server verify_payment command
 * Formula: sha512(key|verify_payment|var1|salt) where var1 is txnid
 */
export function createVerifyPaymentHash({ key, txnid, salt }) {
  if (!key || !txnid || !salt) throw new Error("Missing parameters for verify_payment hash.");
  const sequence = [String(key).trim(), "verify_payment", String(txnid).trim(), String(salt).trim()].join("|");
  return sha512(sequence);
}

/**
 * TASK 5: Hash for PayU cancel_refund_transaction command
 * Formula: sha512(key|cancel_refund_transaction|var1|salt) where var1 is mihpayid
 */
export function createRefundHash({ key, mihpayid, salt }) {
  if (!key || !mihpayid || !salt) throw new Error("Missing parameters for refund hash.");
  const sequence = [String(key).trim(), "cancel_refund_transaction", String(mihpayid).trim(), String(salt).trim()].join("|");
  return sha512(sequence);
}

/**
 * TASK 5: Hash for checking refund status
 * Formula: sha512(key|check_action_status|var1|salt) where var1 is requestId
 */
export function createCheckActionStatusHash({ key, requestId, salt }) {
  if (!key || !requestId || !salt) throw new Error("Missing parameters for check_action_status hash.");
  const sequence = [String(key).trim(), "check_action_status_txnid", String(requestId).trim(), String(salt).trim()].join("|");
  return sha512(sequence);
}

/**
 * TASK 3: Official PayU server-to-server payment verification API
 * Calls PayU postservice with `verify_payment` command
 */
export async function verifyPaymentWithPayU({ key, salt, postServiceUrl, txnid }) {
  const url = postServiceUrl || getPayUEndpoints().postServiceUrl;
  const hash = createVerifyPaymentHash({ key, txnid, salt });

  const params = new URLSearchParams();
  params.append("key", key);
  params.append("command", "verify_payment");
  params.append("var1", txnid);
  params.append("hash", hash);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`PayU verification service returned HTTP ${response.status}`);
  }

  const data = await response.json();
  // PayU response format: { status: 1, msg: "...", transaction_details: { [txnid]: { status: "success", amt: "...", mihpayid: "..." } } }
  const details = data?.transaction_details?.[txnid];
  return {
    raw: data,
    fetched: Boolean(details),
    details: details || null,
    status: details?.status || "not_found",
    unmappedstatus: details?.unmappedstatus || "",
    amount: details?.amt || details?.transaction_amount || null,
    mihpayid: details?.mihpayid || null,
    bankRefNum: details?.bank_ref_num || null,
    mode: details?.mode || null
  };
}

/**
 * TASK 5: Official PayU refund initiation API
 * Calls PayU postservice with `cancel_refund_transaction` command
 */
export async function initiateRefundWithPayU({ key, salt, postServiceUrl, refundCallbackUrl, mihpayid, refundToken, amount }) {
  const url = postServiceUrl || getPayUEndpoints().postServiceUrl;
  const hash = createRefundHash({ key, mihpayid, salt });
  const formattedAmount = formatAmount(amount);

  const params = new URLSearchParams();
  params.append("key", key);
  params.append("command", "cancel_refund_transaction");
  params.append("hash", hash);
  params.append("var1", String(mihpayid).trim());
  params.append("var2", String(refundToken).trim());
  params.append("var3", formattedAmount);
  if (refundCallbackUrl) params.append("var5", String(refundCallbackUrl).trim());

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`PayU refund service returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    raw: data,
    success: Number(data?.status) === 1 || Number(data?.error_code) === 102,
    msg: data?.msg || "",
    requestId: data?.request_id != null
      ? String(data.request_id)
      : (data?.txn_update_id != null ? String(data.txn_update_id) : null),
    bankRefNum: data?.bank_ref_num || null
  };
}

/**
 * TASK 5: Official PayU refund status check API
 * Calls PayU postservice with `check_action_status` command
 */
export async function checkRefundStatusWithPayU({ key, salt, postServiceUrl, requestId }) {
  const url = postServiceUrl || getPayUEndpoints().postServiceUrl;
  const hash = createCheckActionStatusHash({ key, requestId, salt });

  const params = new URLSearchParams();
  params.append("key", key);
  params.append("command", "check_action_status_txnid");
  params.append("hash", hash);
  params.append("var1", String(requestId).trim());

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`PayU check_action_status service returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const detail = data?.transaction_details?.[requestId];
  const nestedDetail = detail && typeof detail === "object" ? (detail[requestId] || detail) : null;
  return {
    raw: data,
    success: Number(data?.status) === 1 || Number(data?.error_code) === 102,
    actionStatus: nestedDetail?.status || data?.action_status || "unknown",
    msg: data?.msg || ""
  };
}
