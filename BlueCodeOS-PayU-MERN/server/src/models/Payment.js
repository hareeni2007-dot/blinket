import mongoose from "mongoose";

const refundItemSchema = new mongoose.Schema({
  refundId: { type: String, required: true },
  requestId: { type: String, default: "" },
  token: { type: String, default: "" },
  amount: { type: Number, required: true },
  status: { type: String, enum: ["queued", "success", "failed", "pending", "in_progress", "requested", "od_hit"], default: "queued" },
  reason: { type: String, default: "" },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date },
  bankRefNum: { type: String, default: "" },
  bankArn: { type: String, default: "" },
  refundMode: { type: String, default: "" },
  callbackResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
  rawResponse: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  txnid: { type: String, required: true, unique: true, index: true },
  planId: { type: String, required: true },
  planName: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  firstname: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, index: true },
  phone: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "success", "failed", "verification_failed", "refunded", "partially_refunded"],
    default: "pending",
    index: true
  },
  payuStatus: { type: String, default: "" },
  unmappedstatus: { type: String, default: "" },
  mihpayid: { type: String, default: "", index: true },
  bank_ref_num: { type: String, default: "" },
  mode: { type: String, default: "" },
  hashVerified: { type: Boolean, default: false },
  serverVerified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
  refundedAmount: { type: Number, default: 0 },
  refunds: [refundItemSchema],
  rawResponse: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

const MongoosePayment = mongoose.model("Payment", paymentSchema);

// In-memory fallback store when MongoDB is disconnected
const memoryPayments = new Map();

function wrapDoc(data) {
  if (!data) return null;
  const doc = {
    ...data,
    save: async function () {
      memoryPayments.set(doc.txnid, { ...doc, updatedAt: new Date() });
      return doc;
    }
  };
  return doc;
}

const PaymentAdapter = {
  async create(data) {
    if (mongoose.connection.readyState === 1) {
      return MongoosePayment.create(data);
    }
    const doc = {
      _id: "mem_" + Math.random().toString(36).slice(2, 11),
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "pending",
      payuStatus: "",
      unmappedstatus: "",
      mihpayid: "",
      bank_ref_num: "",
      mode: "",
      currency: "INR",
      hashVerified: false,
      serverVerified: false,
      verifiedAt: null,
      refundedAmount: 0,
      refunds: [],
      rawResponse: {},
      ...data
    };
    memoryPayments.set(doc.txnid, doc);
    return wrapDoc(doc);
  },

  findOne(query) {
    if (mongoose.connection.readyState === 1) {
      return MongoosePayment.findOne(query);
    }
    const execute = async () => {
      let found = null;
      if (query?.txnid) {
        found = memoryPayments.get(query.txnid);
      } else {
        for (const doc of memoryPayments.values()) {
          let match = true;
          for (const [k, v] of Object.entries(query || {})) {
            if (doc[k] !== v) { match = false; break; }
          }
          if (match) { found = doc; break; }
        }
      }
      return found ? wrapDoc(found) : null;
    };

    return {
      select() { return this; },
      then(onFulfilled, onRejected) { return execute().then(onFulfilled, onRejected); },
      catch(onRejected) { return execute().catch(onRejected); }
    };
  },

  async findOneAndUpdate(filter, update, options = {}) {
    if (mongoose.connection.readyState === 1) {
      return MongoosePayment.findOneAndUpdate(filter, update, options);
    }
    const key = filter.txnid;
    const existing = memoryPayments.get(key) || {
      _id: "mem_pay_" + Math.random().toString(36).slice(2, 11),
      createdAt: new Date()
    };

    let updatedDoc = { ...existing };
    if (update.$set) {
      updatedDoc = { ...updatedDoc, ...update.$set };
    } else if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        updatedDoc[k] = [...(updatedDoc[k] || []), v];
      }
    } else {
      updatedDoc = { ...updatedDoc, ...update };
    }
    updatedDoc.updatedAt = new Date();
    memoryPayments.set(key, updatedDoc);
    return wrapDoc(updatedDoc);
  },

  async find(query = {}) {
    if (mongoose.connection.readyState === 1) {
      return MongoosePayment.find(query);
    }
    const results = [];
    for (const doc of memoryPayments.values()) {
      let match = true;
      for (const [k, v] of Object.entries(query)) {
        if (doc[k] !== v) { match = false; break; }
      }
      if (match) results.push(wrapDoc(doc));
    }
    return results;
  }
};

export default PaymentAdapter;
