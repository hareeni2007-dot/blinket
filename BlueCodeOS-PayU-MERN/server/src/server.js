import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import paymentRoutes from "./routes/payments.js";
import { getPayUEndpoints } from "./utils/payu.js";

const app = express();
const port = Number(process.env.PORT || 5000);
const isProduction = process.env.NODE_ENV === "production";
const configuredOrigins = (process.env.CLIENT_URL || "")
  .split(",").map(value => value.trim().replace(/\/$/, "")).filter(Boolean);
const defaultDevOrigins = isProduction ? [] : [
  "http://localhost:5173", "http://localhost:5174",
  "http://127.0.0.1:5173", "http://127.0.0.1:5174"
];
const allowedOrigins = new Set([...configuredOrigins, ...defaultDevOrigins]);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    if (!isProduction) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: false
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.get("/api/health", (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  const ready = !isProduction || databaseConnected;
  res.status(ready ? 200 : 503).json({
    ok: ready, service: "BlueCode OS PayU API",
    status: ready ? "ready" : "not_ready",
    environment: process.env.NODE_ENV || "development",
    payuEnvironment: process.env.PAYU_ENV || "test",
    database: databaseConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/payments", paymentRoutes);

// In the Docker deployment the React build is served by this same HTTPS origin.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../client/dist");
app.use(express.static(clientDist, { index: false, maxAge: isProduction ? "1h" : 0 }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(clientDist, "index.html"), error => {
    if (error) return res.status(200).json({
      ok: true, service: "BlueCode OS PayU Payment API",
      message: "API is running. Start the Vite client separately for local development."
    });
  });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err.message);
  res.status(500).json({ message: "Internal server error." });
});

function validateProductionConfig() {
  if (!isProduction) return;
  const required = ["MONGODB_URI", "PAYU_MERCHANT_KEY", "PAYU_MERCHANT_SALT", "SERVER_URL", "ADMIN_SECRET_KEY"];
  const missing = required.filter(name => !String(process.env[name] || "").trim());
  if (missing.length) throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
  if (String(process.env.ADMIN_SECRET_KEY).length < 32) throw new Error("ADMIN_SECRET_KEY must contain at least 32 characters.");
  const serverUrl = new URL(process.env.SERVER_URL);
  if (serverUrl.protocol !== "https:") throw new Error("SERVER_URL must use HTTPS in production.");
  const clientUrl = process.env.CLIENT_URL || process.env.SERVER_URL;
  for (const item of clientUrl.split(",")) {
    if (new URL(item.trim()).protocol !== "https:") throw new Error("CLIENT_URL entries must use HTTPS in production.");
  }
  const endpoints = getPayUEndpoints();
  const paymentHost = new URL(endpoints.paymentUrl).hostname;
  const postHost = new URL(endpoints.postServiceUrl).hostname;
  const expectedPaymentHost = "secure.payu.in";
  const expectedPostHost = "info.payu.in";
  if (paymentHost !== expectedPaymentHost || postHost !== expectedPostHost) {
    throw new Error("Production PAYU_ENV must use PayU live endpoints (secure.payu.in and info.payu.in).");
  }
}

let server;
try {
  validateProductionConfig();
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log("MongoDB connected successfully.");
  } else if (isProduction) {
    throw new Error("MONGODB_URI is required in production; in-memory payments are not safe for live transactions.");
  } else {
    console.warn("MONGODB_URI not set. Using in-memory storage for local development only.");
  }
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`BlueCode OS PayU service listening on port ${port} (${process.env.PAYU_ENV || "test"} mode).`);
  });
  process.on("SIGTERM", () => {
    console.log("SIGTERM received; closing server.");
    server.close(async () => {
      if (mongoose.connection.readyState === 1) await mongoose.connection.close();
      process.exit(0);
    });
  });
} catch (error) {
  console.error("Startup configuration/database error:", error.message);
  process.exit(1);
}

export default app;
