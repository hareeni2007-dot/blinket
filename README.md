# BlueCode OS PayU demo

This ZIP contains a React/Vite checkout and an Express API for PayU India hosted checkout. It includes local mock tests for request hashes, callbacks, server verification, refunds, and refund status. Your PayU test credentials and a public HTTPS callback address are needed for a real sandbox transaction. The demo can start locally without MongoDB by using its in-memory store; records then disappear when the server stops.

## Run on Windows

1. Install Node.js 20 or newer.
2. Open PowerShell in this extracted folder and install dependencies:

   ```powershell
   npm --prefix BlueCodeOS-PayU-MERN/server install
   npm --prefix BlueCodeOS-PayU-MERN/client install
   ```

3. Copy `BlueCodeOS-PayU-MERN/server/.env.example` to `BlueCodeOS-PayU-MERN/server/.env` and enter your PayU **test** key, salt, and a long random `ADMIN_SECRET_KEY`. Keep `.env` private. For persistent transaction/refund records, set `MONGODB_URI` to a running local MongoDB or Atlas URI. The in-memory fallback is for local demonstration only; its records disappear when the server stops.
4. Run `start.bat`, or start the API and frontend separately:

   ```powershell
   npm --prefix BlueCodeOS-PayU-MERN/server run dev
   npm --prefix BlueCodeOS-PayU-MERN/client run dev
   ```

5. Open http://localhost:5173. The API health check is http://localhost:5000/api/health.

## PayU callback and live sandbox testing

The browser return URLs are `/api/payments/success` and `/api/payments/failure`. PayU must be able to reach these URLs from the internet; localhost only works for the included mock tests. For actual PayU sandbox checkout, use a temporary HTTPS tunnel or deployed HTTPS server and set `SERVER_URL` to that public base URL. Set `PAYU_REFUND_CALLBACK_URL` to the public HTTPS URL ending in `/api/payments/refund-callback`; PayU uses this URL to send final refund outcomes. Leave `PAYU_PAYMENT_URL` and `PAYU_POST_SERVICE_URL` on the test endpoints until sandbox verification is complete.

The server creates the request hash from `key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt` and checks the reverse callback sequence. On a success callback it also calls PayU `verify_payment`; paid access is granted only when PayU confirms a successful transaction with the expected amount. A missing/failed verification remains unverified and can be retried at `POST /api/payments/verify/:txnid`.

Failure callbacks are hash checked and stored as failed. Status lookup is `GET /api/payments/status/:txnid`. Refund initiation and refund status are admin-only: send `x-admin-key: <ADMIN_SECRET_KEY>` to `POST /api/payments/refund` and `GET /api/payments/refund-status/:txnid/:requestId`. Refund initiation includes PayU's required merchant token, amount and public HTTPS callback URL. The callback validates the transaction, PayU ID, merchant token, request ID, amount and merchant key. Confirm with PayU that the refund callback feature is enabled for your merchant account; some refund status callback setups require PayU support activation. If no callback arrives, use the admin refund-status endpoint to query PayU directly. A refund remains queued until PayU reports its final status; only a successful final status increases the recorded refunded total.

## Mock tests

Run the backend's isolated tests without live PayU credentials or MongoDB. The route tests use a local mock PayU postservice and include payment callbacks, transaction verification, refund initiation, refund status polling and refund callback idempotency:

```powershell
npm --prefix BlueCodeOS-PayU-MERN/server test
```

These tests exercise locally mocked PayU responses. They do not replace a real end-to-end sandbox transaction or verify that your merchant account credentials/callback configuration are correct.

The frontend and API in this ZIP are a standalone PayU checkout demo; this ZIP does not contain the full BlueCode OS production website, so merging the payment module into that website remains a separate integration task. The UI uses an Azure-blue accent theme. See `BlueCodeOS-PayU-MERN/README.md` for API flow notes. Never expose the PayU salt in frontend code or use real payment credentials in this demo without a security and deployment review.

See `PAYU-UPDATE-REPORT.md` for the exact changes, checks performed, and required PayU sandbox setup.


## Public deployment
See `BlueCodeOS-PayU-MERN/README.md` → **Deploy as a public website (Docker / Render)**. The repository includes a Dockerfile and Render Blueprint. Live payments remain disabled until the owner supplies approved PayU LIVE credentials and production environment variables.
