import { useEffect, useState } from "react";

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const plans = [
  { id: "starter", name: "Starter", price: "₹99", detail: "For trying BlueCode OS" },
  { id: "product", name: "Product", price: "₹299", detail: "For individual builders", popular: true },
  { id: "team", name: "Team", price: "₹799", detail: "For small teams" }
];

function PaymentResult() {
  const params = new URLSearchParams(window.location.search);
  const txnid = params.get("txnid");

  const [txData, setTxData] = useState(null);
  const [loading, setLoading] = useState(Boolean(txnid));

  useEffect(() => {
    if (!txnid) {
      setLoading(false);
      return;
    }
    fetch(`${API}/api/payments/status/${encodeURIComponent(txnid)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        setTxData(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [txnid]);

  // Determine actual verified status
  const isSuccess = txData?.status === "success" && txData?.serverVerified === true;
  const isFailed = txData?.status === "failed";
  const isPending = !loading && (!txData || ["pending", "verification_failed"].includes(txData.status));

  const title = loading
    ? "Verifying transaction…"
    : isSuccess
    ? "Payment successful"
    : isFailed
    ? "Payment not completed"
    : isPending
    ? "Payment verification pending"
    : "Verification failed";

  const message = loading
    ? "Connecting with the BlueCode OS server to confirm your payment with PayU…"
    : isSuccess
    ? `Your payment has been cryptographically verified and your ${txData?.planName || "BlueCode OS"} subscription is active.`
    : isFailed
    ? "PayU reported that this transaction did not succeed. No funds were captured."
    : isPending
    ? "We could not confirm the final status yet. Please wait and refresh this page, or contact support with your transaction ID. Do not pay again until the status is checked."
    : "We could not verify this payment with the payment gateway. Please contact support before retrying.";

  return <main className="result-wrap"><section className="result-card">
    <div className={`result-icon ${isSuccess ? "good" : "bad"}`}>{isSuccess ? "✓" : "!"}</div>
    <p className="eyebrow">BLUECODE OS · PAYU GATEWAY</p>
    <h1>{title}</h1>
    <p className="muted">{message}</p>

    {txData && (
      <div style={{ margin: "20px 0", textAlign: "left", fontSize: "13px", background: "rgba(59,130,246,0.06)", border: "1px solid var(--border-subtle)", borderRadius: "8px", padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
          <span style={{ color: "var(--text-secondary)" }}>Plan:</span>
          <strong style={{ color: "#fff" }}>{txData.planName}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
          <span style={{ color: "var(--text-secondary)" }}>Amount:</span>
          <strong style={{ color: "#fff" }}>₹{txData.amount}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
          <span style={{ color: "var(--text-secondary)" }}>Verification:</span>
          <span style={{ color: txData.serverVerified ? "#34d399" : "#f87171" }}>
            {txData.serverVerified ? "✓ Verified Server-to-Server" : "Unverified"}
          </span>
        </div>
        {txData.subscription?.status && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-secondary)" }}>Subscription:</span>
            <span style={{ color: "#34d399", textTransform: "capitalize" }}>{txData.subscription.status}</span>
          </div>
        )}
      </div>
    )}

    {txnid && <p className="transaction">Transaction ID: <code>{txnid}</code></p>}
    <a className="button" href="/">Back to plans</a>
  </section></main>;
}

function Checkout({ plan, onClose }) {
  const [form, setForm] = useState({ firstname: "", email: "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function update(e) { setForm({ ...form, [e.target.name]: e.target.value }); }

  async function pay(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);

    try {
      const response = await fetch(`${API}/api/payments/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, ...form })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to start payment.");

      // Submit to PayU's hosted checkout; secret salt stays strictly on backend.
      const formElement = document.createElement("form");
      formElement.method = "POST";
      formElement.action = data.paymentUrl;
      Object.entries(data.fields).forEach(([name, value]) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = String(value ?? "");
        formElement.appendChild(input);
      });
      document.body.appendChild(formElement);
      formElement.submit();
    } catch (err) {
      setError(err.message || "Something went wrong.");
      setBusy(false);
    }
  }

  return <div className="overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">SECURE CHECKOUT</p><h2 id="checkout-title">{plan.name} plan</h2>
      <p className="price large">{plan.price}<span>/month</span></p>
      <form onSubmit={pay}>
        <label>Full name<input name="firstname" value={form.firstname} onChange={update} autoComplete="name" minLength="2" required /></label>
        <label>Email address<input name="email" type="email" value={form.email} onChange={update} autoComplete="email" required /></label>
        <label>Phone number<input name="phone" type="tel" value={form.phone} onChange={update} autoComplete="tel" minLength="8" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button full" type="submit" disabled={busy}>
          {busy ? "Preparing payment…" : `Continue to PayU · ${plan.price}`}
        </button>
      </form>
      <p className="fine-print">Your card, UPI or net-banking details are entered only on PayU's hosted checkout page. Never share payment credentials with this website.</p>
    </section>
  </div>;
}

function App() {
  const [selected, setSelected] = useState(null);
  const [apiState, setApiState] = useState("checking");

  useEffect(() => {
    function check() {
      fetch(`${API}/api/health`)
        .then(r => r.ok ? setApiState("online") : setApiState("offline"))
        .catch(() => setApiState("offline"));
    }
    check();
    const timer = setInterval(check, 10000);
    return () => clearInterval(timer);
  }, []);

  if (window.location.pathname === "/payment-result") return <PaymentResult />;

  return <main className="page">
    <nav className="nav"><a className="brand" href="/"><img src="/bluecode-logo.png" alt="Blue Code" className="brand-logo" /></a><span className={`api-status ${apiState}`}><i /> API {apiState}</span></nav>
    <section className="hero">
      <p className="eyebrow">BUILD · CONNECT · GROW</p>
      <h1>Choose a plan.<br /><span>Build something great.</span></h1>
      <p className="hero-copy">Pick a BlueCode OS plan to continue. Checkout is handled securely by PayU.</p>
    </section>
    <section className="plans" aria-label="Subscription plans">
      {plans.map(plan => <article className={`plan ${plan.popular ? "popular" : ""}`} key={plan.id}>
        {plan.popular && <span className="popular-tag">POPULAR</span>}
        <h2>{plan.name}</h2><p className="plan-detail">{plan.detail}</p>
        <p className="price">{plan.price}<span>/month</span></p>
        <ul><li>Access to the selected plan</li><li>Secure PayU checkout</li><li>Payment confirmation</li></ul>
        <button className={`button ${plan.popular ? "" : "secondary"}`} onClick={() => setSelected(plan)}>Choose {plan.name}</button>
      </article>)}
    </section>
    {selected && <Checkout plan={selected} onClose={() => setSelected(null)} />}
  </main>;
}

export default App;
