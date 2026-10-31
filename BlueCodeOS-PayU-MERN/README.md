# BlueCode OS — PayU MERN starter

This is a **PayU-only MERN-style starter** converted from the PHP sample:
- MongoDB: stores payment attempts and subscription records
- Express + Node.js: creates PayU requests and verifies PayU callback hashes
- React + Vite: subscription selection and checkout UI

## Important
This is a starter/demo, not a production-ready billing system. It uses PayU's **test environment** by default. Do not use real payments until your PayU account, current PayU integration documentation, callback URLs, deployment HTTPS, and security review are complete.

## Requirements
- Node.js 20+ recommended
- MongoDB local or MongoDB Atlas
- PayU merchant test key and salt

## Setup

### 1. Configure backend
```bash
cd server
npm install
```
Copy `.env.example` to `.env`, then fill in:
```env
MONGODB_URI=mongodb://127.0.0.1:27017/bluecodeos_payments
PAYU_MERCHANT_KEY=your_test_key
PAYU_MERCHANT_SALT=your_test_salt
PAYU_PAYMENT_URL=https://test.payu.in/_payment
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:5000
PORT=5000
```
Keep the `.env` file private. Never put the PayU salt in React/frontend code or commit it to GitHub.

### 2. Start backend
```bash
npm run dev
```
The API starts at `http://localhost:5000`.

### 3. Configure and start frontend
Open a second terminal:
```bash
cd client
npm install
```
Copy `client/.env.example` to `client/.env` if needed. Then:
```bash
npm run dev
```
Open `http://localhost:5173`.

## Flow
1. User selects a plan in React.
2. React sends plan ID and customer details to `POST /api/payments/create`.
3. Express validates the plan and calculates the amount on the server.
4. Express creates a transaction ID, generates the SHA-512 request hash, and saves a pending payment record in MongoDB.
5. React submits the returned fields to PayU's hosted checkout.
6. PayU posts the result to Express `POST /api/payments/callback`.
7. Express verifies the response hash and stores the result; it redirects the browser to the React result page.

## Plans
Edit `server/src/config/plans.js`. Amounts are defined on the server and the client cannot choose an arbitrary amount.

## PayU checks included
- Request and response SHA-512 hashes use PayU India hosted checkout field order, including all ten UDF slots and the `additionalCharges` response variant.
- Success and failure callbacks are hash checked. Success is granted only after PayU's `verify_payment` API confirms success and amount; API failures stay unverified and can be retried.
- Refund requests remain queued until PayU's request-ID status API confirms the final refund result.
- Run `npm test` in `server/` for mocked integration coverage. A real payment still needs valid test credentials and a publicly reachable HTTPS callback URL.

## Before production
- Configure HTTPS callback URLs and a stable public `SERVER_URL`.
- Add your existing BlueCode OS authentication and associate orders with the authenticated user ID.
- Add monitoring, rate limits, CSRF/origin controls where appropriate, and database backups.
- Subscription renewals/recurring mandates, GST/invoices, and failed-renewal recovery are not part of this one-time checkout demo.


## Deploy as a public website (Docker / Render)

This repository now includes a root `Dockerfile`, `.dockerignore`, and `render.yaml`. The container builds the React site and serves it from the Express server on one origin, so the browser calls `/api/...` without a separate CORS domain.

1. Push this repository to a Git provider. Do not commit `.env` files or merchant credentials.
2. Create a MongoDB Atlas database and allow network access from your hosting provider. Use a dedicated database user with a strong password.
3. In Render, create a new Blueprint from the repository and review the `bluecode-os-payu` web service. The Blueprint creates a Docker web service; it does not create your PayU merchant account or MongoDB database.
4. Set `MONGODB_URI`, `CLIENT_URL`, `SERVER_URL`, `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `ADMIN_SECRET_KEY`, and `PAYU_REFUND_CALLBACK_URL` in the hosting dashboard. Set `CLIENT_URL` and `SERVER_URL` to the deployed HTTPS URL. Set `PAYU_ENV=test` first. Generate an admin secret with `openssl rand -hex 32`.
5. The backend sends the success/failure callback URLs (`https://YOUR-DOMAIN/api/payments/success` and `/api/payments/failure`) in every hosted-checkout request. Confirm these routes are publicly reachable over HTTPS. Set `PAYU_REFUND_CALLBACK_URL` to `https://YOUR-DOMAIN/api/payments/refund-callback` and configure it as required by your PayU merchant setup.
6. Run a test payment and verify that the server records a `success` status with `serverVerified: true`. Test a failed payment and a refund. Check `/api/health` reports database `connected`.
7. Only after PayU approves the merchant for live processing, replace the test key/salt with LIVE credentials, set `PAYU_ENV=production`, and redeploy. Production mode selects `https://secure.payu.in/_payment` and `https://info.payu.in/merchant/postservice.php?form=2`; startup refuses to run if the required production settings are missing or the live endpoints are not selected.

### Important boundaries

- A ZIP file cannot publish itself. You must connect the repository to a hosting account and configure secrets/database in that account. I cannot create or approve a PayU merchant account, enter your private credentials, or deploy to your hosting account from this ZIP.
- This starter implements one-time hosted checkout for the listed plans. The `/month` label describes the plan period; automatic recurring card/UPI mandate charging, trial conversion, annual billing, cancellation workflows, GST invoices, and failed-renewal recovery are not implemented. Do not advertise automatic recurring billing until those features are separately built and approved by PayU.
- Do not put PayU salt, admin secret, or database password in frontend variables (`VITE_*`) or source control.
- Use the PayU dashboard and current merchant-specific documentation to confirm which refund notification format is enabled for your account. Refund settlement is checked server-to-server before changing the payment record.

## Local run

For local development, copy `server/.env.example` to `server/.env`, add TEST credentials, and run the backend and Vite frontend in separate terminals as described above. Keep `PAYU_ENV=test`.
