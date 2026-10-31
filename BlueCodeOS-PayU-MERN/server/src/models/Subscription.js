import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema({
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
  txnid: { type: String, required: true, unique: true, index: true },
  planId: { type: String, required: true },
  planName: { type: String, required: true },
  customerEmail: { type: String, required: true, lowercase: true, index: true },
  status: { type: String, enum: ["active", "inactive", "cancelled"], default: "inactive", index: true },
  startedAt: { type: Date },
  periodEndsAt: { type: Date }
}, { timestamps: true });

const MongooseSubscription = mongoose.model("Subscription", subscriptionSchema);

const memorySubscriptions = new Map();

function wrapDoc(data) {
  if (!data) return null;
  const doc = {
    ...data,
    save: async function () {
      memorySubscriptions.set(doc.txnid, { ...doc, updatedAt: new Date() });
      return doc;
    }
  };
  return doc;
}

const SubscriptionAdapter = {
  async findOne(filter) {
    if (mongoose.connection.readyState === 1) {
      return MongooseSubscription.findOne(filter);
    }
    const key = filter.txnid;
    if (key) {
      const found = memorySubscriptions.get(key);
      return found ? wrapDoc(found) : null;
    }
    for (const doc of memorySubscriptions.values()) {
      let match = true;
      for (const [k, v] of Object.entries(filter || {})) {
        if (doc[k] !== v) { match = false; break; }
      }
      if (match) return wrapDoc(doc);
    }
    return null;
  },

  async findOneAndUpdate(filter, update, options = {}) {
    if (mongoose.connection.readyState === 1) {
      return MongooseSubscription.findOneAndUpdate(filter, update, options);
    }
    const key = filter.txnid;
    const existing = memorySubscriptions.get(key) || {
      _id: "mem_sub_" + Math.random().toString(36).slice(2, 11),
      createdAt: new Date()
    };
    const merged = { ...existing, ...(update.$set || update), updatedAt: new Date() };
    memorySubscriptions.set(key, merged);
    return wrapDoc(merged);
  },

  async find(query = {}) {
    if (mongoose.connection.readyState === 1) {
      return MongooseSubscription.find(query);
    }
    const results = [];
    for (const doc of memorySubscriptions.values()) {
      let match = true;
      for (const [k, v] of Object.entries(query)) {
        if (doc[k] !== v) { match = false; break; }
      }
      if (match) results.push(wrapDoc(doc));
    }
    return results;
  }
};

export default SubscriptionAdapter;
