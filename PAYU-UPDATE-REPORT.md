# BlueCode OS PayU ZIP – Update Report

## Changes made

- Kept the existing React/Vite frontend and Express/Mongoose backend structure.
- Kept the frontend-to-backend API base URL wiring (`VITE_API_URL` → `http://localhost:5000`) and backend health endpoint.
- Updated the UI accent palette to Azure blue (`#0078D4`).
- Tightened PayU callback checks: SHA-512 reverse hash, merchant key, transaction ID, amount, customer email and expected product description are checked before accepting a callback.
- Moved duplicate-callback handling after validation and prevented an invalid later callback from downgrading an already server-verified successful payment.
- Added reverse-hash support for PayU `additional_charges` and optional `splitInfo` callback formats.
- Kept server-to-server `verify_payment` as the requirement before a subscription is activated.
- Hardened refund initiation: only server-verified successful payments can be refunded; amount validation, pending-refund protection and PayU's 23-character merchant token limit are enforced.
- Added PayU refund callback URL (`var5`) to the refund request and added a refund callback route that checks the merchant key, transaction, PayU ID, token, request ID, amount and action. Duplicate final callbacks do not double-count a refund.
- Corrected refund status persistence for PayU's `failure`, `in progress`, `queued`, `requested` and `od_hit` states.
- Restricted production CORS to configured client origins and removed admin-key query-string authentication.
- Updated npm lockfile registry URLs to the standard npm registry.
- Added/updated tests for split hash handling, refund callback URL, and refund callback idempotency.

## Verification performed for this ZIP revision

- Backend JavaScript syntax checks passed for all backend source and test `.js` files.
- Added a dependency-light smoke-test suite at `server/test/payu-utils.smoke.test.js`; `npm run test:utils` passed all 7 tests. It checks amount formatting, request hash order, standard response hashes, additional-charges hashes, splitInfo hashes, combined split/additional-charges hashes, invalid-hash rejection, and command hashes for payment verification/refund/refund-status.
- Frontend-to-backend paths were manually checked against the Express route mount: frontend calls `/api/health`, `/api/payments/create`, and `/api/payments/status/:txnid`; the backend exposes those routes.
- Azure theme variables are set in `client/src/style.css` using `#0078D4` and related blue shades.
- Full backend integration tests could not complete because this environment could not install all npm dependencies (the npm registry request timed out; the partial install lacks `mongoose` and `express`).
- Frontend production build could not run for the same reason: client dependencies could not be installed before timeout.
- No live PayU sandbox payment or refund was performed because merchant test credentials and a publicly reachable HTTPS callback endpoint were not supplied.

### Commands to run on your computer after dependency installation

```bash
npm --prefix BlueCodeOS-PayU-MERN/server run test:utils
npm --prefix BlueCodeOS-PayU-MERN/server test
npm --prefix BlueCodeOS-PayU-MERN/client run build
```

The first command uses only Node.js built-ins and should run without installing backend packages. The latter two require the dependencies in the respective package files to install successfully.

## Before real sandbox payments

1. Copy `BlueCodeOS-PayU-MERN/server/.env.example` to `BlueCodeOS-PayU-MERN/server/.env`.
2. Add your PayU **test** merchant key and salt. Do not share the salt or commit `.env`.
3. Set `MONGODB_URI` to a working MongoDB database if transaction records must persist after a server restart. In-memory mode is only for local demonstration.
4. Set `SERVER_URL` to the public HTTPS backend URL (for example, your HTTPS tunnel URL) so PayU can reach the payment success/failure return routes.
5. Set `PAYU_REFUND_CALLBACK_URL` to that public HTTPS backend URL plus `/api/payments/refund-callback`. Confirm with PayU that refund callbacks are enabled for your merchant account; the admin refund-status API is available for reconciliation if no callback arrives.
6. Keep the test payment and postservice endpoints until sandbox testing is complete.
7. Extract the ZIP and run `start.bat` on Windows. It installs the frontend/backend dependencies if missing and starts both services. Open `http://localhost:5173`; check `http://localhost:5000/api/health` for the backend health response.
8. Run backend tests with `npm --prefix BlueCodeOS-PayU-MERN/server test` and build the frontend with `npm --prefix BlueCodeOS-PayU-MERN/client run build`.

## Scope note

This ZIP contains the standalone PayU checkout frontend/backend application. It does not contain the full production BlueCode OS website, so merging this payment module into the actual BlueCode OS website (the separate Task 6) remains out of scope as previously agreed.


## Public customer checkout / deployment preparation (30 Oct 2026)

Implemented in source: environment-aware PayU TEST/LIVE endpoint selection; production startup validation; fail-closed persistent MongoDB requirement in production; `/api/health` readiness status; same-origin React static hosting in the Docker image; Dockerfile and Render Blueprint; frontend payment result page now requires server-confirmed status instead of trusting URL query parameters; manual transaction verification endpoint is admin-protected; refund callback now confirms status through PayU's authenticated status API before updating records.

Not completed by source edits alone: creating/approving a PayU merchant account, entering private live credentials, provisioning MongoDB Atlas, configuring the hosting account/domain/DNS, configuring PayU dashboard callback URLs, and performing real sandbox/live payment or refund transactions. Those require the project owner's accounts and explicit credentials/configuration.

The current plans use one-time hosted checkout. Automatic recurring subscription mandates are not included.
