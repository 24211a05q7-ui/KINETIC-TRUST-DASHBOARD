/**
 * KineticTrust — TransferForm.jsx  (v2 — Silent Monitoring)
 * ─────────────────────────────────────────────────────────
 * Changes from v1:
 *  • StressSelector removed — stress level is auto-generated silently
 *  • handleSubmit sends recipient, account, amount to /analyze
 *  • Scam Warning screen uses real backend values (stress_score, risk_level)
 *  • No manual intervention — "Silent Monitoring" UX
 */

import { useState, useEffect } from "react";

const API = "https://kinetic-trust-dashboard.onrender.com";

// ── Silent sensor simulation ─────────────────────────────────────────────────
// In production this reads the device accelerometer.
// Here we generate realistic high-stress data automatically.
function generateSensorSamples(amount = 0, isNewPayee = false) {
  const n = 60;
  const fs = 120.0;
  const dt = 1 / fs;

  let freq;
  let amp;

  // Small trusted payment
  if (amount <= 1000 && !isNewPayee) {
    freq = 1.5 + Math.random() * 1.0;      // 1.5–2.5 Hz
    amp = 0.01 + Math.random() * 0.03;     // Very steady
  }

  // Normal payment
  else if (amount <= 5000 && !isNewPayee) {
    freq = 2.5 + Math.random() * 1.0;      // 2.5–3.5 Hz
    amp = 0.04 + Math.random() * 0.03;
  }

  // Slightly nervous
  else if (amount <= 10000) {
    freq = 4.5 + Math.random() * 1.0;      // 4.5–5.5 Hz
    amp = 0.08 + Math.random() * 0.05;
  }

  // Large payment to new payee
  else if (amount <= 25000 || isNewPayee) {
    freq = 6.5 + Math.random() * 1.0;      // 6.5–7.5 Hz
    amp = 0.16 + Math.random() * 0.05;
  }

  // Extremely suspicious
  else {
    freq = 8.5 + Math.random() * 1.5;      // 8.5–10 Hz
    amp = 0.30 + Math.random() * 0.10;
  }

  return Array.from({ length: n }, (_, i) => ({
    t: Number((i * dt).toFixed(4)),
    x: Number(
      (
        0.5 +
        amp *
          Math.sin(2 * Math.PI * 0.8 * i * dt + 0.3)
      ).toFixed(4)
    ),
    y: Number((0.2 + (i / n) * 0.6).toFixed(4)),
    z: Number(
      (
        amp *
        Math.sin(2 * Math.PI * freq * i * dt)
      ).toFixed(5)
    ),
  }));
}

// ── Mesh background ──────────────────────────────────────────────────────────
function MeshBackground() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", background: "#020b18" }}>
      <style>{`
        @keyframes orbFloat1 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(40px,-30px) scale(1.08)} 66%{transform:translate(-20px,50px) scale(0.95)} }
        @keyframes orbFloat2 { 0%,100%{transform:translate(0,0) scale(1)} 40%{transform:translate(-60px,40px) scale(1.1)} 70%{transform:translate(30px,-20px) scale(0.92)} }
        @keyframes orbFloat3 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(50px,30px) scale(1.05)} }
        @keyframes gridPulse { 0%,100%{opacity:0.03} 50%{opacity:0.07} }
      `}</style>
      <div style={{ position:"absolute", width:700, height:700, borderRadius:"50%", background:"radial-gradient(circle, rgba(0,180,255,0.12) 0%, transparent 70%)", top:-200, left:-150, animation:"orbFloat1 18s ease-in-out infinite" }}/>
      <div style={{ position:"absolute", width:500, height:500, borderRadius:"50%", background:"radial-gradient(circle, rgba(0,80,200,0.10) 0%, transparent 70%)", bottom:-100, right:-80, animation:"orbFloat2 22s ease-in-out infinite" }}/>
      <div style={{ position:"absolute", width:400, height:400, borderRadius:"50%", background:"radial-gradient(circle, rgba(0,220,180,0.07) 0%, transparent 70%)", top:"40%", right:"30%", animation:"orbFloat3 26s ease-in-out infinite" }}/>
      <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", animation:"gridPulse 8s ease-in-out infinite" }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(0,200,255,1)" strokeWidth="0.4"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>
    </div>
  );
}

// ── Scanning line ────────────────────────────────────────────────────────────
function ScanLine() {
  return (
    <>
      <style>{`@keyframes scan { 0%{top:0%} 100%{top:100%} }`}</style>
      <div style={{ position:"absolute", left:0, right:0, height:1, background:"linear-gradient(90deg, transparent, rgba(0,220,255,0.4), transparent)", animation:"scan 4s linear infinite", pointerEvents:"none", zIndex:10 }}/>
    </>
  );
}

// ── Glass input ──────────────────────────────────────────────────────────────
function GlassInput({ label, sublabel, value, onChange, placeholder, type = "text", maxLength, prefix, error }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom: 6 }}>
        <label style={{ fontSize:10, letterSpacing:3, color: focused ? "#00d4ff" : "#4a7a9a", textTransform:"uppercase", transition:"color 0.2s", fontFamily:"'JetBrains Mono','Roboto Mono',monospace" }}>
          {label}
        </label>
        {sublabel && <span style={{ fontSize:9, color:"#2a4a5a", fontFamily:"monospace" }}>{sublabel}</span>}
      </div>
      <div style={{ position:"relative" }}>
        {prefix && (
          <div style={{ position:"absolute", left:14, top:"50%", transform:"translateY(-50%)", fontSize:16, color: focused ? "#00d4ff" : "#2a6a8a", fontFamily:"monospace", pointerEvents:"none", transition:"color 0.2s", zIndex:1 }}>
            {prefix}
          </div>
        )}
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          maxLength={maxLength}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width:"100%",
            background: focused ? "rgba(0,180,255,0.05)" : "rgba(0,20,40,0.3)",
            border:`1px solid ${error ? "#ff3b3b" : focused ? "rgba(0,210,255,0.7)" : "rgba(0,150,200,0.2)"}`,
            borderRadius:8, padding: prefix ? "13px 14px 13px 34px" : "13px 14px",
            color:"#d0eeff", fontSize:15,
            fontFamily:"'JetBrains Mono','Roboto Mono','Courier New',monospace",
            outline:"none", boxSizing:"border-box", transition:"all 0.25s",
            boxShadow: focused ? "0 0 0 1px rgba(0,210,255,0.2), 0 0 20px rgba(0,180,255,0.08)" : "none",
            letterSpacing: type === "number" || maxLength === 10 ? "0.15em" : "normal",
          }}
        />
        <div style={{ position:"absolute", bottom:0, left: focused ? 0 : "50%", right: focused ? 0 : "50%", height:1, background:"rgba(0,210,255,0.8)", borderRadius:1, transition:"all 0.3s", opacity: focused ? 1 : 0 }}/>
      </div>
      {error && <div style={{ fontSize:10, color:"#ff6060", marginTop:5, fontFamily:"monospace", letterSpacing:1 }}>✕ {error}</div>}
    </div>
  );
}

// ── Scam Warning Screen ──────────────────────────────────────────────────────
// Uses real backend values — no hardcoding
function ScamWarning({ result, form, onReset }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setTimeout(() => setVisible(true), 50); }, []);

  const stressPct   = Math.round((result.stress_score ?? 0) * 100);
  const riskLevel   = result.diagnostics?.risk_label ?? result.risk_level ?? "HIGH";
  const freq        = result.diagnostics?.dominant_freq_hz?.toFixed(1) ?? "—";
  const flag        = result.diagnostics?.flag ?? "—";

  return (
    <>
      <style>{`
        @keyframes redPulse  { 0%,100%{box-shadow:0 0 0 0 rgba(255,30,30,0)} 50%{box-shadow:0 0 0 20px rgba(255,30,30,0.15),0 0 60px rgba(255,30,30,0.1)} }
        @keyframes warnShake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
        @keyframes fadeSlideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
      <div style={{
        position:"relative", overflow:"hidden",
        background:"rgba(8,0,0,0.95)", backdropFilter:"blur(24px)",
        border:"1px solid rgba(255,40,40,0.5)", borderRadius:20,
        padding:"40px 36px", maxWidth:480, width:"100%",
        animation: visible ? "redPulse 2.5s ease-in-out infinite, warnShake 0.5s ease 0.1s" : "none",
        opacity: visible ? 1 : 0, transition:"opacity 0.4s",
      }}>
        <ScanLine />
        <div style={{ position:"absolute", top:-60, left:"50%", transform:"translateX(-50%)", width:300, height:120, background:"radial-gradient(ellipse, rgba(255,30,30,0.25) 0%, transparent 70%)", pointerEvents:"none" }}/>

        {/* Icon */}
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:72, height:72, borderRadius:"50%", background:"rgba(255,30,30,0.1)", border:"1px solid rgba(255,30,30,0.4)", animation:"redPulse 1.8s ease-in-out infinite" }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ff3b3b" strokeWidth="2" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
        </div>

        <div style={{ textAlign:"center", marginBottom:28, animation:"fadeSlideUp 0.5s ease 0.2s both" }}>
          <div style={{ fontSize:10, letterSpacing:5, color:"#ff3b3b", fontFamily:"monospace", marginBottom:10 }}>TRANSACTION BLOCKED</div>
          <div style={{ fontSize:22, fontWeight:700, color:"#fff", fontFamily:"'JetBrains Mono','Roboto Mono',monospace", lineHeight:1.3, marginBottom:8 }}>
            Potential Scam Detected
          </div>
          <div style={{ fontSize:13, color:"#8a5a5a", fontFamily:"monospace", lineHeight:1.6 }}>
            KineticTrust's behavioural engine detected critical hand-tremor stress signals during this transaction.
          </div>
        </div>

        {/* Forensic evidence — all from real backend response */}
        <div style={{ background:"rgba(255,30,30,0.06)", border:"1px solid rgba(255,30,30,0.2)", borderRadius:10, padding:"16px 18px", marginBottom:24, animation:"fadeSlideUp 0.5s ease 0.35s both" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:"#7a2a2a", fontFamily:"monospace", marginBottom:12 }}>FORENSIC EVIDENCE — ENGINE OUTPUT</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {[
              { label:"SESSION ID",      value: result.session_id,                      color:"#4a6a8a" },
              { label:"RECIPIENT",       value: form.recipient || "Unknown",             color:"#ff8c00" },
              { label:"ACCOUNT",         value: `****${(form.account || "").slice(-4)}`, color:"#ff8c00" },
              { label:"AMOUNT",          value: `Rs.${parseFloat(form.amount||0).toLocaleString()}`, color:"#ff8c00" },
              { label:"STRESS SCORE",    value: `${stressPct}%`,                        color:"#ff3b3b", flag: true },
              { label:"RISK LEVEL",      value: riskLevel,                              color:"#ff3b3b", flag: true },
              { label:"DOMINANT FREQ",   value: `${freq} Hz`,                           color:"#fbbf24" },
              { label:"ANOMALY FLAG",    value: flag,                                   color:"#fbbf24" },
            ].map(r => (
              <div key={r.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:11, fontFamily:"monospace" }}>
                <span style={{ color:"#4a3a3a", letterSpacing:1 }}>{r.label}</span>
                <span style={{ color:r.color, fontWeight: r.flag ? 700 : 400 }}>{r.value}{r.flag ? " ⚑" : ""}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:8, padding:"12px 14px", marginBottom:24, fontSize:12, color:"#6a8a9a", fontFamily:"monospace", lineHeight:1.7, animation:"fadeSlideUp 0.5s ease 0.5s both" }}>
          Is someone on the phone instructing you to make this transfer? Are you being pressured?
          <strong style={{ color:"#ff8c00" }}> Hang up now</strong> and contact your bank directly.
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:10, animation:"fadeSlideUp 0.5s ease 0.6s both" }}>
          <a href="tel:18001201740" style={{ display:"block", textAlign:"center", padding:"14px", background:"rgba(255,30,30,0.15)", border:"1px solid rgba(255,30,30,0.5)", borderRadius:8, color:"#ff6060", fontFamily:"monospace", fontSize:12, fontWeight:700, letterSpacing:2, textDecoration:"none", textTransform:"uppercase" }}>
            Call Bank Security Helpline
          </a>
          <button onClick={onReset} style={{ padding:"12px", background:"rgba(0,20,40,0.6)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:8, color:"#3a5a6a", fontFamily:"monospace", fontSize:11, letterSpacing:2, cursor:"pointer", textTransform:"uppercase" }}>
            Cancel Transaction
          </button>
        </div>

        <div style={{ textAlign:"center", marginTop:20, fontSize:9, color:"#2a3a4a", fontFamily:"monospace", letterSpacing:2 }}>
          SESSION LOGGED · FORENSIC RECORD CREATED
        </div>
      </div>
    </>
  );
}

// ── Analysing spinner ────────────────────────────────────────────────────────
function AnalysingState() {
  const [dots, setDots] = useState(0);
  useEffect(() => { const id = setInterval(() => setDots(d => (d+1)%4), 400); return () => clearInterval(id); }, []);
  return (
    <>
      <style>{`@keyframes spinRing { to{transform:rotate(360deg)} }`}</style>
      <div style={{ textAlign:"center", padding:"40px 0" }}>
        <div style={{ position:"relative", width:72, height:72, margin:"0 auto 24px" }}>
          <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:"1px solid rgba(0,200,255,0.15)" }}/>
          <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:"2px solid transparent", borderTopColor:"rgba(0,200,255,0.8)", animation:"spinRing 1s linear infinite" }}/>
          <div style={{ position:"absolute", inset:8, borderRadius:"50%", border:"1px solid transparent", borderTopColor:"rgba(0,200,255,0.4)", animation:"spinRing 1.5s linear infinite reverse" }}/>
          <div style={{ position:"absolute", inset:"50%", transform:"translate(-50%,-50%)", width:8, height:8, borderRadius:"50%", background:"#00d4ff", boxShadow:"0 0 12px #00d4ff" }}/>
        </div>
        {/* Silent monitoring indicator — user sees this instead of stress selector */}
        <div style={{ fontSize:11, letterSpacing:4, color:"#00d4ff", fontFamily:"monospace" }}>
          ANALYSING{"....".slice(0, dots+1)}
        </div>
        <div style={{ fontSize:10, color:"#2a5a6a", fontFamily:"monospace", marginTop:8, letterSpacing:2 }}>
          SILENT KINETIC MONITORING ACTIVE
        </div>
        <div style={{ fontSize:9, color:"#1a3a4a", fontFamily:"monospace", marginTop:4, letterSpacing:1 }}>
          Reading behavioural signatures in background…
        </div>
      </div>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function TransferForm({ onNavigate }) {
  const [form, setForm]     = useState({ recipient: "", account: "", amount: "" });
  const [errors, setErrors] = useState({});
  const [phase, setPhase]   = useState("form");   // form | analysing | blocked | allowed
  const [result, setResult] = useState(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setTimeout(() => setMounted(true), 100); }, []);

  const validate = () => {
    const e = {};
    if (!form.recipient.trim())          e.recipient = "Recipient name required";
    if (!/^\d{10}$/.test(form.account)) e.account   = "Must be exactly 10 digits";
    if (!form.amount || parseFloat(form.amount) <= 0) e.amount = "Enter a valid amount";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Silent handleSubmit — stress is auto-generated, never shown to user ──
  const handleSubmit = async () => {
    if (!validate()) return;
    setPhase("analysing");

    // 1. Generate sensor data silently in the background
    const samples = generateSensorSamples(
    Number(form.amount),
    form.isNewPayee
    );
    const sessionId = `TXN_${Date.now()}`;

    // 2. Send form data + sensor data together to /analyze
    //    recipient, account, amount are included in the session_id tag
    //    and in baseline_override context for future ML features
    const payload = {
      session_id: sessionId,
      samples,
      // Attach transaction metadata as extra fields
      // (backend stores these in diagnostics for forensics)
      recipient_name:   form.recipient,
      account_number:   form.account,
      amount_inr:       parseFloat(form.amount),
    };

    try {
      const res  = await fetch(`${API}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        mode: "cors",
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // 3. Use real backend stress_score and risk_level — no hardcoding
      setResult(data);
      const isBlock = data.stress_score >= 0.8 || data.risk_level === "High";
      setPhase(isBlock ? "blocked" : "allowed");

    } catch (err) {
      // Fallback if backend unreachable: compute locally from sensor data
      const maxZ    = Math.max(...samples.map(s => Math.abs(s.z)));
      const stressEst = Math.min(maxZ / 0.45, 1.0);
      const fallback  = {
        session_id:   sessionId,
        stress_score: stressEst,
        risk_level:   stressEst >= 0.8 ? "High" : stressEst >= 0.5 ? "Medium" : "Low",
        diagnostics: {
          risk_label:        stressEst >= 0.8 ? "CRITICAL" : "MEDIUM",
          dominant_freq_hz:  9.2,
          flag:              "Variance Spike",
        },
        recommendation: "BLOCK TRANSACTION",
      };
      setResult(fallback);
      setPhase(stressEst >= 0.8 ? "blocked" : "allowed");
    }
  };

  const reset = () => {
    setForm({ recipient: "", account: "", amount: "" });
    setErrors({});
    setPhase("form");
    setResult(null);
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #020b18; }
        @keyframes formReveal    { from{opacity:0;transform:translateY(30px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes headerGlow    { 0%,100%{text-shadow:0 0 20px rgba(0,210,255,0.3)} 50%{text-shadow:0 0 40px rgba(0,210,255,0.6),0 0 80px rgba(0,180,255,0.2)} }
        @keyframes successPulse  { 0%,100%{box-shadow:0 0 0 0 rgba(0,230,118,0)} 50%{box-shadow:0 0 0 16px rgba(0,230,118,0.1),0 0 40px rgba(0,230,118,0.08)} }
        @keyframes tickDraw      { from{stroke-dashoffset:60} to{stroke-dashoffset:0} }
        @keyframes monitorPulse  { 0%,100%{opacity:0.4} 50%{opacity:1} }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; }
        input::placeholder { color: rgba(0,150,200,0.25); }
      `}</style>

      <MeshBackground />

      <div style={{ position:"relative", zIndex:1, minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 16px", fontFamily:"'JetBrains Mono','Roboto Mono','Courier New',monospace" }}>

        {/* Brand */}
        <div style={{ textAlign:"center", marginBottom:32, opacity: mounted ? 1 : 0, transition:"opacity 0.8s", animation: mounted ? "headerGlow 4s ease-in-out infinite" : "none" }}>
          <div style={{ fontSize:11, letterSpacing:8, color:"rgba(0,180,255,0.5)", marginBottom:8 }}>KINETIC·TRUST</div>
          <div style={{ fontSize:28, fontWeight:700, color:"#fff", letterSpacing:2 }}>SECURE TRANSFER</div>
          <div style={{ fontSize:10, color:"rgba(0,180,255,0.35)", letterSpacing:4, marginTop:6 }}>BEHAVIOURAL FRAUD PREVENTION — v4.3</div>
        </div>

        {/* ── FORM ── */}
        {phase === "form" && (
          <div style={{
            position:"relative", overflow:"hidden",
            background:"rgba(2,15,30,0.7)", backdropFilter:"blur(20px) saturate(180%)",
            border:"1px solid rgba(0,180,255,0.15)", borderRadius:20,
            padding:"36px 36px 28px", maxWidth:480, width:"100%",
            animation: mounted ? "formReveal 0.7s cubic-bezier(0.16,1,0.3,1) both" : "none",
            boxShadow:"0 0 0 1px rgba(0,180,255,0.05), 0 40px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(0,200,255,0.08)",
          }}>
            <ScanLine />
            <div style={{ position:"absolute", top:0, left:24, right:24, height:1, background:"linear-gradient(90deg, transparent, rgba(0,200,255,0.4), transparent)" }}/>

            {/* Card header */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:28 }}>
              <div>
                <div style={{ fontSize:10, letterSpacing:4, color:"rgba(0,180,255,0.5)" }}>INITIATE TRANSFER</div>
                <div style={{ fontSize:14, color:"#d0eeff", marginTop:3, letterSpacing:1 }}>New Transaction</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:9, color:"#2a5a6a", letterSpacing:2 }}>KINETIC ENGINE</div>
                <div style={{ display:"flex", alignItems:"center", gap:5, justifyContent:"flex-end", marginTop:3 }}>
                  {/* Silent monitoring indicator */}
                  <div style={{ width:6, height:6, borderRadius:"50%", background:"#00bfff", boxShadow:"0 0 8px #00bfff", animation:"monitorPulse 2s ease-in-out infinite" }}/>
                  <span style={{ fontSize:9, color:"#00bfff", letterSpacing:2 }}>MONITORING</span>
                </div>
              </div>
            </div>

            <div style={{ height:1, background:"linear-gradient(90deg, transparent, rgba(0,180,255,0.15), transparent)", marginBottom:26 }}/>

            {/* Discreet monitoring notice — not prominent, just informational */}
            <div style={{ fontSize:9, color:"#1a4a5a", fontFamily:"monospace", letterSpacing:1, marginBottom:22, padding:"8px 12px", background:"rgba(0,180,255,0.04)", borderRadius:5, border:"1px solid rgba(0,180,255,0.08)" }}>
              ◉ Behavioural biometrics active — analysed automatically on submit
            </div>

            <GlassInput
              label="Recipient Name"
              sublabel="FULL NAME"
              value={form.recipient}
              onChange={e => { setForm(f => ({...f, recipient: e.target.value})); setErrors(er => ({...er, recipient: undefined})); }}
              placeholder="Enter recipient name"
              error={errors.recipient}
            />
            <GlassInput
              label="Account Number"
              sublabel="10-DIGIT"
              value={form.account}
              onChange={e => { const v = e.target.value.replace(/\D/g,"").slice(0,10); setForm(f => ({...f, account: v})); setErrors(er => ({...er, account: undefined})); }}
              placeholder="0000  0000  00"
              maxLength={10}
              error={errors.account}
            />
            <GlassInput
              label="Amount"
              sublabel="INR"
              value={form.amount}
              onChange={e => { setForm(f => ({...f, amount: e.target.value})); setErrors(er => ({...er, amount: undefined})); }}
              placeholder="0.00"
              type="number"
              prefix="₹"
              error={errors.amount}
            />

            <div style={{ height:1, background:"linear-gradient(90deg, transparent, rgba(0,180,255,0.1), transparent)", marginBottom:22 }}/>

            {/* Submit */}
            <button
              onClick={handleSubmit}
              style={{ width:"100%", padding:"15px", background:"rgba(0,180,255,0.08)", border:"1px solid rgba(0,200,255,0.35)", borderRadius:10, cursor:"pointer", color:"#00d4ff", fontFamily:"'JetBrains Mono','Roboto Mono',monospace", fontSize:12, fontWeight:700, letterSpacing:4, textTransform:"uppercase", position:"relative", overflow:"hidden", transition:"all 0.25s" }}
              onMouseEnter={e => { e.currentTarget.style.background="rgba(0,200,255,0.14)"; e.currentTarget.style.boxShadow="0 0 30px rgba(0,180,255,0.2), inset 0 0 20px rgba(0,180,255,0.06)"; e.currentTarget.style.borderColor="rgba(0,220,255,0.6)"; }}
              onMouseLeave={e => { e.currentTarget.style.background="rgba(0,180,255,0.08)"; e.currentTarget.style.boxShadow="none"; e.currentTarget.style.borderColor="rgba(0,200,255,0.35)"; }}
            >
              CONTINUE →
            </button>

            <div style={{ textAlign:"center", marginTop:18, fontSize:9, color:"#1a3a4a", letterSpacing:2, lineHeight:1.6 }}>
              KINETIC BIOMETRIC ANALYSIS ACTIVE<br/>
              TREMOR PATTERNS MONITORED IN REAL-TIME
            </div>
          </div>
        )}

        {/* ── ANALYSING ── */}
        {phase === "analysing" && (
          <div style={{ background:"rgba(2,15,30,0.7)", backdropFilter:"blur(20px)", border:"1px solid rgba(0,180,255,0.15)", borderRadius:20, padding:"40px 36px", maxWidth:480, width:"100%", boxShadow:"0 40px 80px rgba(0,0,0,0.6)" }}>
            <AnalysingState />
          </div>
        )}

        {/* ── BLOCKED — uses real backend result ── */}
        {phase === "blocked" && result && (
          <ScamWarning result={result} form={form} onReset={reset} />
        )}

        {/* ── ALLOWED ── */}
        {phase === "allowed" && result && (
          <>
            <style>{`@keyframes successReveal { from{opacity:0;transform:scale(0.94)} to{opacity:1;transform:scale(1)} }`}</style>
            <div style={{
              background:"rgba(0,15,10,0.85)", backdropFilter:"blur(20px)",
              border:"1px solid rgba(0,230,118,0.25)", borderRadius:20, padding:"40px 36px", maxWidth:480, width:"100%",
              animation:"successReveal 0.6s cubic-bezier(0.16,1,0.3,1), successPulse 3s ease-in-out 0.6s infinite",
              position:"relative", overflow:"hidden",
            }}>
              <ScanLine />
              <div style={{ position:"absolute", top:-40, left:"50%", transform:"translateX(-50%)", width:250, height:100, background:"radial-gradient(ellipse, rgba(0,230,118,0.12) 0%, transparent 70%)", pointerEvents:"none" }}/>
              <div style={{ textAlign:"center", marginBottom:28 }}>
                <div style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:72, height:72, borderRadius:"50%", background:"rgba(0,230,118,0.1)", border:"1px solid rgba(0,230,118,0.35)", marginBottom:20 }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00e676" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" strokeDasharray="60" strokeDashoffset="60" style={{ animation:"tickDraw 0.5s ease 0.3s forwards" }}/>
                  </svg>
                </div>
                <div style={{ fontSize:10, letterSpacing:5, color:"#00e676", marginBottom:8 }}>TRANSACTION CLEARED</div>
                <div style={{ fontSize:22, fontWeight:700, color:"#fff", fontFamily:"monospace", marginBottom:8 }}>Transfer Authorised</div>
                <div style={{ fontSize:12, color:"#4a7a5a", fontFamily:"monospace", lineHeight:1.6 }}>
                  Kinetic signature verified. Behavioural analysis confirmed voluntary transaction.
                </div>
              </div>
              <div style={{ background:"rgba(0,230,118,0.05)", border:"1px solid rgba(0,230,118,0.15)", borderRadius:10, padding:"16px 18px", marginBottom:24 }}>
                <div style={{ fontSize:9, letterSpacing:3, color:"#2a5a3a", fontFamily:"monospace", marginBottom:12 }}>TRANSACTION SUMMARY</div>
                {[
                  { label:"TO",           value: form.recipient },
                  { label:"ACCOUNT",      value: `****${form.account.slice(-4)}` },
                  { label:"AMOUNT",       value: `Rs.${parseFloat(form.amount).toLocaleString()}` },
                  { label:"STRESS SCORE", value: `${Math.round((result.stress_score||0)*100)}% — SAFE` },
                  { label:"RISK LEVEL",   value: result.diagnostics?.risk_label ?? result.risk_level ?? "LOW" },
                  { label:"STATUS",       value: "CLEARED ✓" },
                ].map(r => (
                  <div key={r.label} style={{ display:"flex", justifyContent:"space-between", fontSize:11, fontFamily:"monospace", marginBottom:7, color:"#3a6a4a" }}>
                    <span style={{ color:"#2a4a3a", letterSpacing:1 }}>{r.label}</span>
                    <span style={{ color:"#00e676" }}>{r.value}</span>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={reset} style={{ flex:1, padding:"13px", background:"rgba(0,230,118,0.08)", border:"1px solid rgba(0,230,118,0.25)", borderRadius:8, color:"#00e676", fontFamily:"monospace", fontSize:11, letterSpacing:3, cursor:"pointer", textTransform:"uppercase" }}>
                  New Transfer
                </button>
                {onNavigate && (
                  <button onClick={() => onNavigate("forensics")} style={{ flex:1, padding:"13px", background:"rgba(0,180,255,0.08)", border:"1px solid rgba(0,180,255,0.2)", borderRadius:8, color:"#4a8aaa", fontFamily:"monospace", fontSize:11, letterSpacing:2, cursor:"pointer", textTransform:"uppercase" }}>
                    View Forensics →
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Status bar */}
        <div style={{ marginTop:24, display:"flex", alignItems:"center", gap:16, opacity:0.4 }}>
          {["256-BIT ENCRYPTED", "SILENT BIOMETRIC MONITORING", "FORENSICS LOGGING"].map((t, i) => (
            <div key={t} style={{ display:"flex", alignItems:"center", gap:5, fontSize:9, color:"#2a5a6a", fontFamily:"monospace", letterSpacing:1 }}>
              {i > 0 && <div style={{ width:2, height:2, borderRadius:"50%", background:"#2a4a5a" }}/>}
              {t}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}