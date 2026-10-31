import { Router } from "express";
import crypto from "node:crypto";
import Payment from "../models/Payment.js";
import Subscription from "../models/Subscription.js";
import { PLANS } from "../config/plans.js";
import {
  createRequestHash,
  verifyResponseHash,
  verifyPaymentWithPayU,
  initiateRefundWithPayU,
  checkRefundStatusWithPayU,
  formatAmount,
  getPayUEndpoints
} from "../utils/payu.js";

const router = Router();

/**
 * Admin authorization middleware for sensitive endpoints (refunds, transaction audits)
 */
function requireAdminAuth(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) {
    return res.status(500).json({ message: "Admin authorization key is not configured on the server." });
  }

  const providedKey = req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (!providedKey || providedKey !== adminSecret) {
    return res.status(401).json({ message: "Unauthorized. Valid admin credentials required." });
  }

  next();
}

/**
 * Helper to activate subscription upon verified payment
 */
async function activateSubscription(payment) {
  const startedAt = new Date();
  const periodEndsAt = new Date(startedAt);
  periodEndsAt.setMonth(periodEndsAt.getMonth() + 1);

  return Subscription.findOneAndUpdate(
    { txnid: payment.txnid },
    {
      paymentId: payment._id,
      txnid: payment.txnid,
      planId: payment.planId,
      planName: payment.planName,
      customerEmail: payment.email,
      status: "active",
      startedAt,
      periodEndsAt
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Common PayU callback processor
 */
async function handlePayUCallback(req, res) {
  const clientUrl = (process.env.CLIENT_URL || process.env.SERVER_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
  const body = req.body ?? {};
  const txnid = String(body.txnid ?? "").trim();

  if (!txnid) {
    return res.redirect(`${clientUrl}/payment-result?status=failed&reason=missing_txnid`);
  }

  try {
    const payment = await Payment.findOne({ txnid });
    const salt = process.env.PAYU_MERCHANT_SALT;
    const key = process.env.PAYU_MERCHANT_KEY;
    const postServiceUrl = process.env.PAYU_POST_SERVICE_URL;

    if (!payment || !salt || !key) {
      console.error(`Callback error: Payment ${txnid} not found or PayU credentials missing.`);
      return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
    }

    // TASK 1: Response Hash Verification
    const hashVerified = verifyResponseHash(body, salt);
    const bodyAmount = Number(body.amount);
    const paymentAmount = Number(payment.amount);
    const amountMatches = !isNaN(bodyAmount) && Math.abs(bodyAmount - paymentAmount) < 0.01;
    const keyMatches = String(body.key ?? "").trim() === key.trim();
    const txnidMatches = String(body.txnid ?? "").trim() === payment.txnid;
    const emailMatches = String(body.email ?? "").trim().toLowerCase() === payment.email;
    const productInfoMatches = String(body.productinfo ?? "") === `BlueCode OS ${payment.planName} subscription`;

    if (!hashVerified || !amountMatches || !keyMatches || !txnidMatches || !emailMatches || !productInfoMatches) {
      console.warn(`PayU callback verification failed for ${txnid}: hash=${hashVerified}, amount=${amountMatches}, key=${keyMatches}, txnid=${txnidMatches}, email=${emailMatches}, productinfo=${productInfoMatches}`);
      // Never let a later malformed callback downgrade a transaction that
      // PayU has already confirmed server-to-server as successful.
      if (!(payment.status === "success" && payment.serverVerified)) {
        payment.status = "verification_failed";
        payment.hashVerified = false;
        payment.rawResponse = { status: body.status, msg: "Hash or parameter mismatch", txnid };
        await payment.save();
      }
      return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
    }

    // Only treat a callback as a duplicate after its hash and transaction
    // fields have been validated. Never trust a repeated unverified browser POST.
    if (payment.status === "success" && payment.serverVerified) {
      console.log(`Callback notice: Payment ${txnid} already processed and verified.`);
      return res.redirect(`${clientUrl}/payment-result?status=success&txnid=${encodeURIComponent(txnid)}`);
    }

    payment.hashVerified = true;
    payment.payuStatus = String(body.status ?? "").toLowerCase();
    payment.unmappedstatus = String(body.unmappedstatus ?? "");
    payment.mihpayid = String(body.mihpayid ?? "");
    payment.bank_ref_num = String(body.bank_ref_num ?? "");
    payment.mode = String(body.mode ?? "");
    payment.rawResponse = body;

    // If PayU reports success
    if (payment.payuStatus === "success") {
      // TASK 3: Server-Side Transaction Verification before activating subscription
      try {
        const verifyRes = await verifyPaymentWithPayU({ key, salt, postServiceUrl, txnid });
        if (verifyRes.details) {
          const verifiedStatus = String(verifyRes.details.status ?? "").toLowerCase();
          const verifiedAmt = Number(verifyRes.details.amt || verifyRes.details.transaction_amount);
          const verifiedMatches = verifiedStatus === "success" && Math.abs(verifiedAmt - paymentAmount) < 0.01;

          if (verifiedMatches) {
            payment.serverVerified = true;
            payment.verifiedAt = new Date();
            payment.status = "success";
            payment.mihpayid = String(verifyRes.details.mihpayid || payment.mihpayid);
            payment.bank_ref_num = String(verifyRes.details.bank_ref_num || payment.bank_ref_num);
            await payment.save();

            // TASK 2: Activate subscription only after successful verification
            await activateSubscription(payment);
            return res.redirect(`${clientUrl}/payment-result?status=success&txnid=${encodeURIComponent(txnid)}`);
          } else {
            console.warn(`PayU verify_payment returned non-matching status for ${txnid}:`, verifyRes.details);
            payment.status = "verification_failed";
            payment.serverVerified = false;
            await payment.save();
            return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
          }
        } else {
          // A browser callback alone is not sufficient to grant paid access.
          payment.status = "verification_failed";
          payment.serverVerified = false;
          await payment.save();
          return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
        }
      } catch (verifyErr) {
        console.error(`PayU verify_payment API error for ${txnid}:`, verifyErr.message);
        // Keep the payment unverified. The customer or an operator can retry /verify.
        payment.serverVerified = false;
        payment.status = "verification_failed";
        await payment.save();
        return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
      }
    }

    // Payment failed or was cancelled by user
    payment.status = "failed";
    payment.serverVerified = false;
    await payment.save();
    return res.redirect(`${clientUrl}/payment-result?status=failed&txnid=${encodeURIComponent(txnid)}`);
  } catch (err) {
    console.error("PayU callback processing exception:", err.message);
    return res.redirect(`${clientUrl}/payment-result?status=verification_failed&txnid=${encodeURIComponent(txnid)}`);
  }
}

/**
 * TASK 6 & 7: Initiate payment request
 */
router.post("/create", async (req, res) => {
  try {
    const { planId, firstname, email, phone } = req.body ?? {};
    const plan = PLANS[String(planId ?? "")];
    if (!plan) return res.status(400).json({ message: "Choose a valid subscription plan." });

    const cleanName = String(firstname ?? "").trim().slice(0, 80);
    const cleanEmail = String(email ?? "").trim().toLowerCase().slice(0, 254);
    const cleanPhone = String(phone ?? "").trim().replace(/[^\d+]/g, "").slice(0, 20);

    if (cleanName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanPhone.length < 8) {
      return res.status(400).json({ message: "Enter a valid name, email address, and phone number." });
    }

    const key = process.env.PAYU_MERCHANT_KEY;
    const salt = process.env.PAYU_MERCHANT_SALT;
    if (!key || !salt) {
      return res.status(503).json({ message: "PayU is not configured. Add credentials to server/.env." });
    }

    const txnid = `bc${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 25);
    const amount = formatAmount(plan.amount);
    const productinfo = `BlueCode OS ${plan.name} subscription`;

    const hash = createRequestHash({
      key,
      txnid,
      amount,
      productinfo,
      firstname: cleanName,
      email: cleanEmail,
      salt
    });

    // TASK 4: Store transaction in MongoDB
    await Payment.create({
      txnid,
      planId: plan.id,
      planName: plan.name,
      amount: Number(amount),
      currency: "INR",
      firstname: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      status: "pending"
    });

    const serverUrl = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`).trim().replace(/\/$/, "");
    const fields = {
      key,
      txnid,
      amount,
      productinfo,
      firstname: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      surl: `${serverUrl}/api/payments/success`,
      furl: `${serverUrl}/api/payments/failure`,
      hash
    };
    for (let i = 1; i <= 10; i++) fields[`udf${i}`] = "";

    const endpoints = getPayUEndpoints();
    res.json({ paymentUrl: endpoints.paymentUrl, fields });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Transaction ID already exists. Please try again." });
    }
    console.error("PayU payment creation error:", error.message);
    res.status(500).json({ message: "Unable to start payment. Please try again." });
  }
});

/**
 * TASK 2: Callbacks for success, failure, and generic callback
 */
router.post("/callback", handlePayUCallback);
router.post("/success", handlePayUCallback);
router.post("/failure", handlePayUCallback);

/**
 * TASK 3: Explicit Server-to-Server transaction verification endpoint
 */
router.post("/verify/:txnid", requireAdminAuth, async (req, res) => {
  try {
    const { txnid } = req.params;
    const payment = await Payment.findOne({ txnid });
    if (!payment) return res.status(404).json({ message: "Transaction not found." });

    const key = process.env.PAYU_MERCHANT_KEY;
    const salt = process.env.PAYU_MERCHANT_SALT;
    const postServiceUrl = process.env.PAYU_POST_SERVICE_URL;
    if (!key || !salt) {
      return res.status(503).json({ message: "PayU merchant key and salt are not configured." });
    }

    const result = await verifyPaymentWithPayU({ key, salt, postServiceUrl, txnid });

    if (result.details) {
      const verifiedStatus = String(result.details.status ?? "").toLowerCase();
      const verifiedAmt = Number(result.details.amt || result.details.transaction_amount);
      const isVerified = verifiedStatus === "success" && Math.abs(verifiedAmt - Number(payment.amount)) < 0.01;

      payment.serverVerified = isVerified;
      payment.payuStatus = verifiedStatus;
      payment.unmappedstatus = result.details.unmappedstatus || payment.unmappedstatus;
      if (result.details.mihpayid) payment.mihpayid = String(result.details.mihpayid);
      if (result.details.bank_ref_num) payment.bank_ref_num = String(result.details.bank_ref_num);

      if (isVerified) {
        payment.status = "success";
        payment.verifiedAt = new Date();
        await payment.save();
        await activateSubscription(payment);
      } else {
        payment.status = verifiedStatus === "pending" ? "pending" : "failed";
        payment.serverVerified = false;
        await payment.save();
      }

      return res.json({
        verified: isVerified,
        status: payment.status,
        payuStatus: verifiedStatus,
        details: result.details
      });
    }

    payment.status = "verification_failed";
    payment.serverVerified = false;
    await payment.save();
    res.status(502).json({
      verified: payment.serverVerified,
      status: payment.status,
      message: "No live transaction details found on PayU postservice. Retry verification later."
    });
  } catch (error) {
    console.error("Verification endpoint error:", error.message);
    res.status(500).json({ message: "Server-side verification failed.", error: error.message });
  }
});

/**
 * TASK 5: Official PayU refund initiation API
 */
router.post("/refund", requireAdminAuth, async (req, res) => {
  try {
    const { txnid, amount, reason } = req.body ?? {};
    if (!txnid) return res.status(400).json({ message: "Transaction ID (txnid) is required." });

    const payment = await Payment.findOne({ txnid });
    if (!payment) return res.status(404).json({ message: "Payment record not found." });

    if (!payment.serverVerified || (payment.status !== "success" && payment.status !== "partially_refunded")) {
      return res.status(400).json({
        message: `Only server-verified successful payments can be refunded. Current status is '${payment.status}'.`
      });
    }

    if (!payment.mihpayid) {
      return res.status(400).json({
        message: "PayU Payment Reference (mihpayid) is missing. Cannot initiate refund without mihpayid."
      });
    }

    const hasPendingRefund = (payment.refunds || []).some(refund =>
      ["queued", "pending", "in_progress", "requested", "od_hit"].includes(String(refund.status).toLowerCase())
    );
    if (hasPendingRefund) {
      return res.status(409).json({ message: "A refund request is already awaiting PayU's final status. Check its status before creating another refund." });
    }

    const totalPaid = Number(payment.amount);
    const alreadyRefunded = Number(payment.refundedAmount || 0);
    const remainingRefundable = totalPaid - alreadyRefunded;

    if (remainingRefundable <= 0) {
      return res.status(400).json({ message: "This transaction has already been fully refunded." });
    }

    let refundAmount;
    try {
      refundAmount = Number(formatAmount(amount !== undefined && amount !== null ? amount : remainingRefundable));
    } catch {
      refundAmount = NaN;
    }
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ message: "Refund amount must be a positive number." });
    }

    if (refundAmount > remainingRefundable) {
      return res.status(400).json({
        message: `Refund amount (₹${refundAmount}) exceeds remaining refundable amount (₹${remainingRefundable}).`
      });
    }

    const key = process.env.PAYU_MERCHANT_KEY;
    const salt = process.env.PAYU_MERCHANT_SALT;
    const postServiceUrl = process.env.PAYU_POST_SERVICE_URL;
    const refundCallbackUrl = process.env.PAYU_REFUND_CALLBACK_URL;
    if (!key || !salt) {
      return res.status(503).json({ message: "PayU merchant key and salt are not configured." });
    }
    if (!refundCallbackUrl) {
      return res.status(503).json({ message: "Configure PAYU_REFUND_CALLBACK_URL with a public HTTPS refund callback URL before initiating refunds." });
    }
    let callbackUrl;
    try {
      callbackUrl = new URL(refundCallbackUrl);
    } catch {
      return res.status(503).json({ message: "PAYU_REFUND_CALLBACK_URL must be a valid public HTTPS URL." });
    }
    if (callbackUrl.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(callbackUrl.hostname)) {
      return res.status(503).json({ message: "PAYU_REFUND_CALLBACK_URL must be publicly reachable over HTTPS (for example, your HTTPS tunnel URL)." });
    }

    // PayU limits the merchant refund token (var2) to 23 characters.
    const refundToken = `BC${Date.now()}${crypto.randomBytes(3).toString("hex")}`;

    // Call PayU's official cancel_refund_transaction API
    const refundResult = await initiateRefundWithPayU({
      key,
      salt,
      postServiceUrl,
      refundCallbackUrl: callbackUrl.toString(),
      mihpayid: payment.mihpayid,
      refundToken,
      amount: refundAmount
    });

    const isSuccess = refundResult.success;

    const refundRecord = {
      refundId: refundToken,
      requestId: refundResult.requestId || "",
      token: refundToken,
      amount: refundAmount,
      status: isSuccess && refundResult.requestId ? "queued" : "failed",
      reason: String(reason || "User requested refund"),
      requestedAt: new Date(),
      processedAt: null,
      rawResponse: refundResult.raw
    };

    payment.refunds = payment.refunds || [];
    payment.refunds.push(refundRecord);

    // PayU acceptance means queued, not settled. Only the status inquiry can
    // increase refundedAmount and transition the payment to refunded.

    await payment.save();

    res.json({
      success: isSuccess && Boolean(refundResult.requestId),
      message: refundResult.msg || (isSuccess && refundResult.requestId ? "Refund initiated successfully; awaiting PayU settlement status." : "PayU did not return a refund request ID. Check the PayU dashboard before retrying."),
      refundId: refundToken,
      requestId: refundResult.requestId || null,
      txnid: payment.txnid,
      refundedAmount: refundAmount,
      totalRefunded: payment.refundedAmount,
      paymentStatus: payment.status
    });
  } catch (error) {
    console.error("Refund error:", error.message);
    res.status(500).json({ message: "Refund processing failed.", error: error.message });
  }
});

/**
 * PayU refund webhook callback. The merchant token is generated with crypto
 * randomness and is matched together with merchantTxnId, mihpayid, amount,
 * request_id and merchant key before changing a payment record.
 */
router.post("/refund-callback", async (req, res) => {
  try {
    const body = req.body ?? {};
    const txnid = String(body.merchantTxnId ?? "").trim();
    const requestId = String(body.request_id ?? "").trim();
    const token = String(body.token ?? "").trim();
    if (!txnid || !requestId || !token) {
      return res.status(400).json({ message: "Refund callback is missing its transaction identifiers." });
    }

    const payment = await Payment.findOne({ txnid });
    if (!payment) return res.status(404).json({ message: "Refund transaction not found." });
    const refundItem = (payment.refunds || []).find(item => item.token === token && item.requestId === requestId);
    if (!refundItem) return res.status(404).json({ message: "Refund request does not match this payment." });

    // Do not trust a browser/webhook payload or the public merchant key as proof
    // of refund settlement. Ask PayU's authenticated status API before updating.
    const result = await checkRefundStatusWithPayU({
      key: process.env.PAYU_MERCHANT_KEY,
      salt: process.env.PAYU_MERCHANT_SALT,
      postServiceUrl: process.env.PAYU_POST_SERVICE_URL,
      requestId
    });
    if (!result.success) {
      return res.status(502).json({ received: true, verified: false, message: result.msg || "PayU refund status could not be verified." });
    }

    const normalized = String(result.actionStatus || "unknown").toLowerCase();
    const statusMap = { success: "success", failure: "failed", queued: "queued", "in progress": "in_progress", requested: "requested", od_hit: "od_hit" };
    if (!statusMap[normalized]) {
      return res.status(202).json({ received: true, verified: true, status: normalized });
    }

    if (refundItem.processedAt == null) {
      refundItem.status = statusMap[normalized];
      if (normalized === "success" || normalized === "failure") refundItem.processedAt = new Date();
      if (normalized === "success") {
        payment.refundedAmount = Number(payment.refundedAmount || 0) + Number(refundItem.amount || 0);
        if (payment.refundedAmount >= Number(payment.amount)) {
          payment.status = "refunded";
          await Subscription.findOneAndUpdate({ txnid: payment.txnid }, { status: "cancelled" });
        } else {
          payment.status = "partially_refunded";
        }
      }
      await payment.save();
    }
    return res.status(200).json({ received: true, verified: true, status: refundItem.status });
  } catch (error) {
    console.error("PayU refund callback error:", error.message);
    return res.status(500).json({ message: "Could not verify PayU refund callback." });
  }
});

/**
 * TASK 5: Official PayU refund status inquiry API
 */
router.get("/refund-status/:txnid/:requestId", requireAdminAuth, async (req, res) => {
  try {
    const { txnid, requestId } = req.params;
    const payment = await Payment.findOne({ txnid });
    if (!payment) return res.status(404).json({ message: "Payment not found." });

    const key = process.env.PAYU_MERCHANT_KEY;
    const salt = process.env.PAYU_MERCHANT_SALT;
    const postServiceUrl = process.env.PAYU_POST_SERVICE_URL;

    const refundItem = (payment.refunds || []).find(r => r.requestId === requestId);
    if (!refundItem || !refundItem.requestId) {
      return res.status(404).json({ message: "Refund request ID was not found for this payment. Use the request ID returned by PayU." });
    }

    const result = await checkRefundStatusWithPayU({ key, salt, postServiceUrl, requestId });
    if (!result.success) {
      return res.status(502).json({ message: result.msg || "PayU could not retrieve the refund status.", details: result.raw });
    }

    // Update stored refund status if present
    if (payment.refunds && payment.refunds.length > 0) {
      const storedRefund = payment.refunds.find(r => r.requestId === requestId);
      if (storedRefund && result.actionStatus && storedRefund.processedAt == null) {
        const refundItem = storedRefund;
        const normalized = String(result.actionStatus).toLowerCase();
        const statusMap = {
          success: "success",
          failure: "failed",
          queued: "queued",
          "in progress": "in_progress",
          requested: "requested",
          od_hit: "od_hit"
        };
        if (statusMap[normalized]) refundItem.status = statusMap[normalized];
        if (result.raw?.transaction_details?.[requestId]?.[requestId]) {
          const detail = result.raw.transaction_details[requestId][requestId];
          refundItem.bankRefNum = String(detail.bank_ref_num ?? "");
          refundItem.bankArn = String(detail.bank_arn ?? "");
          refundItem.refundMode = String(detail.refund_mode ?? "");
        }
        if (normalized === "success") {
          refundItem.processedAt = new Date();
          payment.refundedAmount = Number(payment.refundedAmount || 0) + Number(refundItem.amount || 0);
          if (payment.refundedAmount >= Number(payment.amount)) {
            payment.status = "refunded";
            await Subscription.findOneAndUpdate({ txnid: payment.txnid }, { status: "cancelled" });
          } else {
            payment.status = "partially_refunded";
          }
        } else if (normalized === "failure") {
          refundItem.processedAt = new Date();
        }
        await payment.save();
      }
    }

    res.json({
      txnid,
      requestId,
      status: result.actionStatus,
      message: result.msg,
      details: result.raw
    });
  } catch (error) {
    console.error("Refund status error:", error.message);
    res.status(500).json({ message: "Could not check refund status.", error: error.message });
  }
});

/**
 * TASK 6: Verified public payment status for frontend polling/result display
 */
router.get("/status/:txnid", async (req, res) => {
  try {
    const { txnid } = req.params;
    const payment = await Payment.findOne({ txnid }).select("-rawResponse -__v");
    if (!payment) return res.status(404).json({ message: "Transaction not found." });

    const subscription = await Subscription.findOne({ txnid });

    res.json({
      txnid: payment.txnid,
      planName: payment.planName,
      planId: payment.planId,
      amount: payment.amount,
      currency: payment.currency || "INR",
      status: payment.status,
      serverVerified: payment.serverVerified,
      payuStatus: payment.payuStatus,
      createdAt: payment.createdAt,
      subscription: subscription ? {
        status: subscription.status,
        startedAt: subscription.startedAt,
        periodEndsAt: subscription.periodEndsAt
      } : null
    });
  } catch (error) {
    res.status(400).json({ message: "Invalid transaction query.", error: error.message });
  }
});

/**
 * Admin: List recent payments for auditing and verification
 */
router.get("/history", requireAdminAuth, async (req, res) => {
  try {
    const payments = await Payment.find().select("-rawResponse -__v");
    res.json({ total: payments.length, payments });
  } catch (error) {
    res.status(500).json({ message: "Could not fetch payment history.", error: error.message });
  }
});

export default router;
