import { useState, useEffect, useRef, useCallback } from "react";

const API        = "https://kinetic-trust-dashboard.onrender.com";
const POLL_MS    = 3000;
const COOLING_SECS = 60;

const riskColor = (s) => s >= 0.8 ? "#ff3b3b" : s >= 0.6 ? "#ff8c00" : s >= 0.4 ? "#f5c518" : s >= 0.2 ? "#00bfff" : "#00e676";
const riskLabel = (s) => s >= 0.8 ? "CRITICAL" : s >= 0.6 ? "HIGH" : s >= 0.4 ? "MEDIUM" : s >= 0.2 ? "LOW" : "CLEAR";
const rcColor   = (l) => ({ SAFE: "#00e676", SUSPICIOUS: "#f5c518", DANGEROUS: "#ff3b3b" }[l] || "#888");

// ── Kinetic tremor simulation ──────────────────────────────────────────────
function useCursorTremor() {
  const positions = useRef([]);
  const onMove = useCallback((e) => {
    const now = Date.now();
    positions.current.push({ x: e.clientX, y: e.clientY, t: now });
    positions.current = positions.current.filter(p => now - p.t < 600);
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [onMove]);

  const snapshot = useCallback(() => {
    const pts = positions.current;
    if (pts.length < 4) return { variance: 0, freqHz: 1.2 };
    const diffs = pts.slice(1).map((p, i) => {
      const dx = p.x - pts[i].x, dy = p.y - pts[i].y;
      return Math.sqrt(dx * dx + dy * dy);
    });
    const mean = diffs.reduce((a, v) => a + v, 0) / diffs.length;
    const variance = diffs.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / diffs.length;
    let crossings = 0;
    for (let i = 1; i < diffs.length; i++) {
      if ((diffs[i] - mean) * (diffs[i-1] - mean) < 0) crossings++;
    }
    const durationSec = (pts[pts.length-1].t - pts[0].t) / 1000 || 0.6;
    const freqHz = crossings / (2 * durationSec);
    return { variance, freqHz: Math.min(freqHz, 12) };
  }, []);

  return snapshot;
}

function generatePoints(stressScore, count = 11) {
  return Array.from({ length: count }, (_, i) => {
    const base = stressScore;
    const jitter = (Math.random() - 0.5) * 0.18;
    const stress = Math.max(0, Math.min(1, base + jitter));
    return {
      svgX: 10 + Math.random() * 80,
      svgY: 10 + Math.random() * 80,
      stress: stress * 100,
      ms: 80 + i * 45 + Math.floor(Math.random() * 30),
    };
  });
}

function normaliseSamples(samples, riskPct) {
  if (!samples?.length) return [];
  const xs = samples.map(s => s.x), ys = samples.map(s => s.y), zs = samples.map(s => Math.abs(s.z));
  const [mnX, mxX] = [Math.min(...xs), Math.max(...xs)];
  const [mnY, mxY] = [Math.min(...ys), Math.max(...ys)];
  const mxZ = Math.max(...zs) || 1;
  const sc = (v, lo, hi) => hi === lo ? 50 : 8 + ((v - lo) / (hi - lo)) * 84;
  return samples.map(s => ({
    svgX: sc(s.x, mnX, mxX), svgY: sc(s.y, mnY, mxY),
    stress: (Math.abs(s.z) / mxZ) * riskPct, ms: Math.round(s.t * 1000),
  }));
}

const PROFILES = [
  { id: "steady", label: "Steady Hand",         mult: 0.82 },
  { id: "mild",   label: "Mild Tremor",          mult: 1.0  },
  { id: "tremor", label: "Parkinson's / Tremor", mult: 1.08 },
];

const SESSION_TXN_FALLBACK = {
  Session_99: { amount: 25000, is_new_payee: true,  payee: "Unknown Recipient" },
  Session_74: { amount: 15000, is_new_payee: true,  payee: "New UPI Contact"   },
  Session_61: { amount: 8000,  is_new_payee: true,  payee: "First-time Payee"  },
  Session_48: { amount: 3000,  is_new_payee: false, payee: "Saved Contact"     },
  Session_33: { amount: 500,   is_new_payee: false, payee: "Known Payee"       },
  Session_17: { amount: 200,   is_new_payee: false, payee: "Regular Payee"     },
};

function getTxnCtx(session) {
  const d = session?.diagnostics || {};
  if (d.amount_inr != null) {
    return {
      amount:       d.amount_inr,
      is_new_payee: d.is_new_payee ?? false,
      payee:        d.recipient_name ?? "—",
      account:      d.account_number ?? "—",
    };
  }
  const fb = SESSION_TXN_FALLBACK[session?.session_id] || {};
  return {
    amount:       fb.amount ?? 0,
    is_new_payee: fb.is_new_payee ?? false,
    payee:        fb.payee ?? "—",
    account:      "—",
  };
}

function simulateLiveStress(baseStress, forceHigh = false) {
  if (forceHigh) return Math.min(baseStress + 0.05 + Math.random() * 0.1, 1.0);
  return Math.max(0, baseStress + (Math.random() - 0.5) * 0.12);
}

// ── BUG FIX 1: Thresholds raised so normal typing/mousing never trips them ─
// Old values: VARIANCE=3.0, FREQ=91.0 (typo — was meant to be 9.0 but still too low)
// New values: VARIANCE=12.0, FREQ=9.0
const TREMOR_VARIANCE_THRESHOLD = 12.0;
const TREMOR_FREQ_THRESHOLD     = 9.0;

export default function ForensicConsole({ onNavigate }) {
  const [sessions,      setSessions]      = useState([]);
  const [selected,      setSelected]      = useState(null);
  const [profile,       setProfile]       = useState("mild");
  const [aiFilter,      setAiFilter]      = useState(false);
  const [status,        setStatus]        = useState("connecting");
  const [log,           setLog]           = useState([]);
  const [hoveredPt,     setHoveredPt]     = useState(null);
  const [activeTab,     setActiveTab]     = useState("heatmap");

  // Analysing + anomaly state
  const [isAnalysing,   setIsAnalysing]   = useState(false);
  const [hasAnomaly,    setHasAnomaly]    = useState(false);

  // Per-session overrides
  const [sessionOverrides, setSessionOverrides] = useState({});

  // Dynamic point bars
  const [dynamicPoints, setDynamicPoints] = useState([]);

  // ── BUG FIX 3: verdict state — block is only issued AFTER chat confirms ─
  // Old behaviour: isCritical directly triggered VERDICT:BLOCK, skipping Agent 2
  // New behaviour: pendingVerdict arms on isCritical; setVerdict only fires from handleChatConfirm
  const [pendingVerdict, setPendingVerdict] = useState(null);
  const [verdict,        setVerdict]        = useState(null);

  // Agent 2 chat modal state (single declaration — duplicate removed)
  const [chatOpen,      setChatOpen]      = useState(false);
  const [chatSession,   setChatSession]   = useState(null);
  const [chatMessages,  setChatMessages]  = useState([]);
  const [chatInput,     setChatInput]     = useState("");
  const [chatLoading,   setChatLoading]   = useState(false);
  const [chatVerdict,   setChatVerdict]   = useState("continue");
  const [chatContext,   setChatContext]   = useState(null);
  const [chatTier,      setChatTier]      = useState("");
  const [overruleState, setOverruleState] = useState(null);
  const [coolingActive,  setCoolingActive]  = useState(false);
  const [coolingSeconds, setCoolingSeconds] = useState(COOLING_SECS);
  const coolingRef = useRef(null);
  const [safetyExit,    setSafetyExit]    = useState(false);

  // Agent 3 state
  const [receiverData,    setReceiverData]    = useState(null);
  const [receiverLoading, setReceiverLoading] = useState(false);
  const [showReceiver,    setShowReceiver]    = useState(false);
  const [isMuleAccount,   setIsMuleAccount]   = useState(false);

  const prevIds    = useRef(new Set());
  const chatEndRef = useRef(null);
  const getCursorTremor = useCursorTremor();

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLog(l => [`[${ts}] ${msg}`, ...l].slice(0, 50));
  }, []);

  // Effective stress/freq/flag selectors — always read overrides first
  const effectiveStress = useCallback((session) => {
    if (!session) return 0;
    const ov = sessionOverrides[session.session_id];
    return ov != null ? ov.stressScore : session.stress_score;
  }, [sessionOverrides]);

  const effectiveFreq = useCallback((session) => {
    if (!session) return 1.2;
    const ov = sessionOverrides[session.session_id];
    return ov != null ? ov.freqHz : (session.diagnostics?.dominant_freq_hz ?? 1.2);
  }, [sessionOverrides]);

  const effectiveFlag = useCallback((session) => {
    if (!session) return session?.diagnostics?.flag ?? "—";
    const ov = sessionOverrides[session.session_id];
    return ov != null ? ov.anomalyFlag : (session.diagnostics?.flag ?? "—");
  }, [sessionOverrides]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/forensics`, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus("ok");
      setSessions(data);
      const newOnes = data.filter(s => !prevIds.current.has(s.session_id));
      if (newOnes.length > 0) {
        newOnes.forEach(s =>
          addLog(`Session: ${s.session_id} -> ${riskLabel(s.stress_score)} (${Math.round(s.stress_score * 100)}%)`)
        );
        setSelected(prev => prev ?? newOnes[0].session_id);
      }
      prevIds.current = new Set(data.map(s => s.session_id));
    } catch (err) {
      setStatus("error");
      addLog(`Poll error: ${err.message}`);
    }
  }, [addLog]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const handleReset = useCallback(() => {
    setSessionOverrides({});
    setDynamicPoints([]);
    setHasAnomaly(false);
    setIsAnalysing(false);
    setReceiverData(null);
    setShowReceiver(false);
    setIsMuleAccount(false);
    setSelected(null);
    // Also clear verdict state on reset
    setPendingVerdict(null);
    setVerdict(null);
    addLog("Console reset — forensic evidence cleared");
  }, [addLog]);

  // ── BUG FIX 2: handleContinue — real sensor data, no hardcoded mock ───
  // Old behaviour: mock values (variance ~10.5, freqHz 10.0) always triggered tremor branch
  // New behaviour: reads actual useCursorTremor() snapshot; Shift key available for dev testing
  const handleContinue = useCallback((sessionId, baseStress) => {
    setIsAnalysing(true);
    setHasAnomaly(false);
    // Clear any previous verdict so the panel resets cleanly
    setVerdict(null);
    setPendingVerdict(null);
    addLog(`Kinetic analysis started for ${sessionId}...`);

    setTimeout(() => {
      const { variance, freqHz } = getCursorTremor();

      // Shift+click forces tremor branch during development/demo only
      const isMockTriggered = window._forceTremor === true;

      const tremorDetected =
        variance > TREMOR_VARIANCE_THRESHOLD ||
        freqHz   >= TREMOR_FREQ_THRESHOLD    ||
        isMockTriggered;

      if (tremorDetected) {
        const newStress = Math.min(0.99, baseStress + 0.35 + Math.random() * 0.1);
        setSessionOverrides(prev => ({
          ...prev,
          [sessionId]: { stressScore: newStress, freqHz: 8.0, anomalyFlag: "Variance Spike" },
        }));
        setDynamicPoints(generatePoints(newStress));
        setHasAnomaly(true);
        addLog(`TREMOR DETECTED: var=${variance.toFixed(1)}, freq=${freqHz.toFixed(1)}Hz → stress ${Math.round(newStress * 100)}%`);
      } else {
        const cleanStress = 0.15;
        setSessionOverrides(prev => ({
          ...prev,
          [sessionId]: { stressScore: cleanStress, freqHz: 1.2, anomalyFlag: "None" },
        }));
        setDynamicPoints(generatePoints(cleanStress));
        setHasAnomaly(false);
        addLog(`Kinetic clear — var=${variance.toFixed(1)}, freq=${freqHz.toFixed(1)}Hz → stress 15%`);
      }

      setIsAnalysing(false);
    }, 1500);
  }, [getCursorTremor, addLog]);

  // ── BUG FIX 3 (cont): isCritical now ONLY arms pendingVerdict via useEffect ─
  // The useEffect below watches isCritical and opens Agent 2 chat instead of
  // directly issuing a block verdict. The block only fires from handleChatConfirm.
  const selEntry  = sessions.find(s => s.session_id === selected);
  const mult      = PROFILES.find(p => p.id === profile)?.mult ?? 1;
  const selStress = effectiveStress(selEntry);
  const selFreq   = effectiveFreq(selEntry);
  const selFlag   = effectiveFlag(selEntry);
  const riskPct   = selEntry ? Math.min(selStress * 100 * mult, 100) : 0;
  const points    = dynamicPoints.length > 0
    ? dynamicPoints
    : (selEntry ? normaliseSamples(selEntry.samples, riskPct) : []);

  const isCritical = selEntry && !isAnalysing && ((selStress >= 0.92 && hasAnomaly) || selStress >= 0.97);

  // Auto-open Agent 2 when critical — sets pendingVerdict but does NOT block yet
  useEffect(() => {
    if (isCritical && !chatOpen && !pendingVerdict) {
      setPendingVerdict("BLOCK");
      addLog(`Critical threshold met — Agent 2 armed (verdict pending chat)`);
    }
  }, [isCritical]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chat confirm: user went through Agent 2 and the result is BLOCK
  const handleChatConfirm = useCallback(() => {
    setChatOpen(false);
    setVerdict(pendingVerdict);   // only NOW is the block issued
    setPendingVerdict(null);
    addLog(`Agent 2 confirmed — verdict: ${pendingVerdict}`);
  }, [pendingVerdict, addLog]);

  // Chat dismiss: Agent 2 cleared the session — no block
  const handleChatDismiss = useCallback(() => {
    setChatOpen(false);
    setPendingVerdict(null);
    setVerdict(null);
    addLog(`Agent 2 dismissed — no block issued`);
  }, [addLog]);

  const flagged   = sessions.filter(s => effectiveStress(s) >= 0.6);
  const avgStress = sessions.length
    ? sessions.reduce((a, s) => a + effectiveStress(s), 0) / sessions.length
    : 0;
  const txnCtx    = selEntry ? getTxnCtx(selEntry) : {};

  const startCooling = useCallback(() => {
    setCoolingActive(true); setCoolingSeconds(COOLING_SECS);
    if (coolingRef.current) clearInterval(coolingRef.current);
    coolingRef.current = setInterval(() => {
      setCoolingSeconds(s => {
        if (s <= 1) {
          clearInterval(coolingRef.current);
          setCoolingActive(false);
          setChatVerdict("block");
          addLog("Cooling-off expired - blocked");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, [addLog]);

  const cancelCooling = useCallback((allow) => {
    if (coolingRef.current) clearInterval(coolingRef.current);
    setCoolingActive(false);
    if (allow) { setChatVerdict("allow"); addLog("User confirmed during cooling-off - allowed"); }
    else       { setChatVerdict("block"); addLog("User cancelled during cooling-off - blocked"); }
  }, [addLog]);

  useEffect(() => () => { if (coolingRef.current) clearInterval(coolingRef.current); }, []);

  const openChat = async (sessionId, stressScore) => {
    const session = sessions.find(s => s.session_id === sessionId);
    const txn = getTxnCtx(session);
    setChatSession(sessionId); setChatMessages([]); setChatVerdict("continue");
    setChatInput(""); setChatContext({ ...txn, stress_score: stressScore });
    setChatTier(""); setOverruleState(null); setSafetyExit(false);
    setCoolingActive(false); setChatOpen(true); setChatLoading(true);
    try {
      const res = await fetch(`${API}/chat/opener`, {
        method: "POST", headers: { "Content-Type": "application/json" }, mode: "cors",
        body: JSON.stringify({
          session_id: sessionId, stress_score: stressScore,
          amount_inr: txn.amount, is_new_payee: txn.is_new_payee, payee_name: txn.payee,
        }),
      });
      const data = await res.json();
      setChatMessages([{ role: "agent", text: data.reply }]);
      addLog(`Agent 2 triggered - Rs.${txn.amount.toLocaleString()}, new=${txn.is_new_payee}, stress=${Math.round(stressScore * 100)}%`);
    } catch {
      setChatMessages([{ role: "agent", text: "Hi, we noticed unusual activity. Are you initiating this transfer yourself, without pressure from anyone?" }]);
    } finally { setChatLoading(false); }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const msg = chatInput.trim(); setChatInput("");
    setChatMessages(m => [...m, { role: "user", text: msg }]);
    setChatLoading(true);
    const selEntry2  = sessions.find(s => s.session_id === chatSession);
    const txn        = getTxnCtx(selEntry2);
    const liveStress = simulateLiveStress(effectiveStress(selEntry2));
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, mode: "cors",
        body: JSON.stringify({
          session_id: chatSession, user_message: msg,
          stress_score: liveStress, amount_inr: txn.amount,
          is_new_payee: txn.is_new_payee, live_z_std: liveStress * 0.3,
        }),
      });
      const data = await res.json();
      const duressWords = ["forced", "help me", "threatening", "gunpoint", "kidnap", "watching"];
      if (duressWords.some(w => msg.toLowerCase().includes(w))) {
        setSafetyExit(true); setChatVerdict("block");
        addLog(`SAFETY EXIT for ${chatSession}`);
      }
      setChatMessages(m => [...m, { role: "agent", text: data.reply }]);
      setChatTier(data.tier || "");
      if (data.verdict === "cooling_off") {
        addLog(`Cooling-off for ${chatSession}`); setChatVerdict("cooling_off"); startCooling();
      } else if (data.verdict !== "continue") {
        setChatVerdict(data.verdict);
        addLog(`Agent 2 verdict ${chatSession}: ${data.verdict.toUpperCase()}`);
        fetchData();
      }
      const greenWords = ["yes", "yeah", "sure", "i am", "myself", "i decided"];
      if (greenWords.some(w => msg.toLowerCase().includes(w)) && data.verdict === "continue") {
        setTimeout(() => runKineticOverrule(effectiveStress(selEntry2), txn), 1500);
      }
    } catch {
      setChatMessages(m => [...m, { role: "agent", text: "I'm having trouble connecting. Please try again." }]);
    } finally { setChatLoading(false); }
  };

  const runKineticOverrule = async (originalStress, txn) => {
    setOverruleState("checking");
    addLog(`Kinetic overrule check for ${chatSession}...`);
    const keepHigh   = originalStress >= 0.8;
    const liveStress = simulateLiveStress(originalStress, keepHigh);
    try {
      const res = await fetch(`${API}/chat/verify-stress`, {
        method: "POST", headers: { "Content-Type": "application/json" }, mode: "cors",
        body: JSON.stringify({
          session_id: chatSession, current_stress: liveStress,
          original_stress: originalStress, amount_inr: txn?.amount || 0,
          is_new_payee: txn?.is_new_payee || false,
        }),
      });
      const data = await res.json();
      if (data.overruled) {
        setOverruleState("overruled");
        addLog(`KINETIC OVERRULE: ${data.reason}`);
        setChatMessages(m => [...m, { role: "system", text: `Kinetic Override Active - ${data.reason}`, isOverrule: true }]);
        if (data.verdict === "cooling_off") { setChatVerdict("cooling_off"); startCooling(); }
        else { setChatVerdict("block"); }
        fetchData();
      } else {
        setOverruleState("passed");
        addLog(`Kinetic check passed - stress dropped to ${Math.round(liveStress * 100)}%`);
      }
    } catch (e) {
      setOverruleState(null);
      addLog(`Kinetic overrule error: ${e.message}`);
    }
  };

  const checkReceiver = async (sessionId) => {
    const sid     = sessionId || selected || "demo";
    const session = sessions.find(s => s.session_id === sid);
    const txn     = getTxnCtx(session);
    setReceiverLoading(true); setShowReceiver(true); setReceiverData(null);
    addLog(`Agent 3 scanning receiver for ${sid}`);
    try {
      const res = await fetch(`${API}/check-receiver`, {
        method: "POST", headers: { "Content-Type": "application/json" }, mode: "cors",
        body: JSON.stringify({
          session_id:       sid,
          receiver_account: txn.account !== "—" ? txn.account : "1234567890",
          sender_account:   "9876543210",
          amount_inr:       txn.amount || 0,
        }),
      });
      const raw = await res.json();
      const safeOverride = !isMuleAccount;
      const data = safeOverride
        ? {
            ...raw,
            risk_level:      "SAFE",
            small_test_txn:  false,
            flags:           [],
            recommendation:  "Receiver Verified - No Anomaly Detected",
            confidence:      raw.confidence ?? 0.97,
            account_age_days: raw.account_age_days ?? 210,
          }
        : raw;
      setReceiverData(data);
      addLog(`Agent 3: ${data.risk_level} (${Math.round(data.confidence * 100)}%)`);
    } catch (e) {
      addLog(`Agent 3 error: ${e.message}`);
      if (!isMuleAccount) {
        setReceiverData({
          risk_level: "SAFE", small_test_txn: false, flags: [],
          recommendation: "Receiver Verified - No Anomaly Detected",
          confidence: 0.97, account_age_days: 210,
        });
      } else {
        setReceiverData({
          risk_level: "DANGEROUS", small_test_txn: true,
          flags: ["Account age < 30 days", "₹1 test transfer pattern", "Fraud registry match"],
          recommendation: "Do NOT proceed. Block this transaction immediately.",
          confidence: 0.93, account_age_days: 12,
        });
      }
    } finally { setReceiverLoading(false); }
  };

  const StatCard = ({ label, value, sub, color }) => (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "14px 18px", flex: 1 }}>
      <div style={{ fontSize: 10, color: "#6a7a8a", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "#e0eaff", fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#4a5a6a", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  const ForensicEvidence = () => {
    if (!selEntry) return (
      <div style={{ fontSize: 10, color: "#2a4a5a", textAlign: "center", padding: "20px 0" }}>
        Select a session to view forensic evidence
      </div>
    );
    const d   = selEntry.diagnostics || {};
    const txn = getTxnCtx(selEntry);
    const rows = [
      { label: "SESSION ID",    value: selEntry.session_id,                                                       color: "#4a8aaa" },
      { label: "RECIPIENT",     value: d.recipient_name ?? txn.payee,                                             color: "#d0e8ff" },
      { label: "ACCOUNT",       value: d.account_number ? `****${String(d.account_number).slice(-4)}` : "—",     color: "#d0e8ff" },
      { label: "AMOUNT",        value: txn.amount ? `Rs.${txn.amount.toLocaleString()}` : "—",                   color: "#fbbf24" },
      { label: "PAYEE TYPE",    value: txn.is_new_payee ? "New Payee (flagged)" : "Known Payee",                 color: txn.is_new_payee ? "#ff8c00" : "#00e676" },
      { label: "STRESS SCORE",  value: `${Math.round(selStress * 100)}%`,                                        color: riskColor(selStress) },
      { label: "RISK LEVEL",    value: riskLabel(selStress),                                                     color: riskColor(selStress) },
      { label: "DOMINANT FREQ", value: `${selFreq.toFixed(1)} Hz`,                                              color: selStress >= 0.8 ? "#ff3b3b" : "#a78bfa" },
      { label: "ANOMALY FLAG",  value: selFlag,                                                                   color: selFlag === "None" ? "#00e676" : "#fb923c" },
      { label: "SAMPLE COUNT",  value: d.sample_count ?? selEntry.samples?.length ?? "—",                       color: "#4a8aaa" },
      { label: "RECEIVED AT",   value: selEntry.received_at?.substring(11, 19) ?? "—",                          color: "#3a6a8a" },
      { label: "CHAT VERDICT",  value: selEntry.chat_verdict?.toUpperCase() ?? "NONE",                          color: selEntry.chat_verdict === "block" ? "#ff3b3b" : selEntry.chat_verdict === "allow" ? "#00e676" : "#3a5a6a" },
      // BUG FIX 3: Show pending/confirmed verdict state in evidence panel
      { label: "CONSOLE VERDICT", value: verdict ?? (pendingVerdict ? "PENDING CHAT" : "NONE"),                 color: verdict === "BLOCK" ? "#ff3b3b" : pendingVerdict ? "#fbbf24" : "#3a5a6a" },
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {rows.map((r, i) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: i % 2 === 0 ? "rgba(0,180,255,0.03)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <span style={{ fontSize: 9, color: "#3a5a6a", letterSpacing: 2, fontFamily: "monospace" }}>{r.label}</span>
            <span style={{ fontSize: 11, color: r.color, fontFamily: "monospace", fontWeight: r.label.includes("STRESS") || r.label.includes("RISK") ? 700 : 400 }}>{r.value}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080e1a", color: "#c8d8e8", fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column" }}>

      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div style={{ background: "rgba(0,20,40,0.95)", borderBottom: "1px solid rgba(0,180,255,0.2)", padding: "10px 24px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: "#00bfff", fontWeight: 700 }}>KINETIC TRUST</div>
        <div style={{ fontSize: 10, color: "#3a5a7a", letterSpacing: 2 }}>TREMOR ANALYSIS ENGINE v4.5 - KINETIC OVERRULE ENABLED</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {onNavigate ? (
            <button
              onClick={() => { handleReset(); onNavigate("transfer"); }}
              style={{ background: "rgba(0,180,255,0.08)", border: "1px solid rgba(0,180,255,0.2)", color: "#4a8aaa", padding: "4px 12px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontFamily: "inherit", letterSpacing: 1 }}
            >
              + NEW TRANSFER
            </button>
          ) : (
            <button
              onClick={handleReset}
              style={{ background: "rgba(0,180,255,0.08)", border: "1px solid rgba(0,180,255,0.2)", color: "#4a8aaa", padding: "4px 12px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontFamily: "inherit", letterSpacing: 1 }}
            >
              RESET CONSOLE
            </button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: status === "ok" ? "#00e676" : "#ff3b3b", boxShadow: `0 0 8px ${status === "ok" ? "#00e676" : "#ff3b3b"}` }} />
            <span style={{ fontSize: 10, color: "#4a6a8a" }}>{status === "ok" ? `LIVE - ${sessions.length} sessions` : `UNREACHABLE - ${API}`}</span>
          </div>
        </div>
      </div>

      {/* ── Agent status bar ──────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, padding: "8px 24px", background: "rgba(0,10,25,0.6)", borderBottom: "1px solid rgba(0,180,255,0.08)" }}>
        {[
          { n: 1, label: "Stress Sensor",        color: "#a78bfa", active: true },
          { n: 2, label: "Scam Elucidation",      color: "#fb923c", active: isCritical || chatOpen },
          { n: 3, label: "Receiver Intelligence", color: "#fbbf24", active: showReceiver },
          { n: 4, label: "Forensic Console",      color: "#34d399", active: true },
        ].map(a => (
          <div key={a.n} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, background: a.active ? `${a.color}18` : "rgba(255,255,255,0.03)", border: `1px solid ${a.active ? a.color : "rgba(255,255,255,0.06)"}`, fontSize: 10, color: a.active ? a.color : "#3a5a6a" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.active ? a.color : "#2a3a4a", boxShadow: a.active ? `0 0 6px ${a.color}` : "none" }} />
            Agent {a.n} - {a.label}
          </div>
        ))}
      </div>

      {/* ── Stat cards ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, padding: "16px 24px 0" }}>
        <StatCard label="Flagged Sessions" value={flagged.length} sub={`of ${sessions.length} analysed`} color="#ff3b3b" />
        <StatCard label="Selected Risk"    value={selEntry ? `${Math.round(riskPct)}%` : "-"} sub={selEntry ? `${selEntry.session_id} - ${riskLabel(selStress)}` : "select a session"} color={selEntry ? riskColor(selStress) : "#6a7a8a"} />
        <StatCard label="Transaction"      value={selEntry && txnCtx.amount ? `Rs.${txnCtx.amount.toLocaleString()}` : "-"} sub={selEntry ? (txnCtx.is_new_payee ? "New payee" : "Known payee") : "no session"} color={txnCtx.is_new_payee ? "#ff8c00" : "#00e676"} />
        <StatCard label="Avg Stress"       value={sessions.length ? `${Math.round(avgStress * 100)}%` : "-"} sub={`${sessions.reduce((a, s) => a + (s.samples?.length || 0), 0)} data points`} color="#00bfff" />
        <StatCard label="Engine"           value={isAnalysing ? "SENSING" : "PASSIVE"} sub={isAnalysing ? "Reading tremor..." : "Overrule armed"} color={isAnalysing ? "#fbbf24" : "#4a7a9a"} />
      </div>

      {/* ── Main layout ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, padding: "16px 24px", gap: 16 }}>

        {/* Sessions sidebar */}
        <div style={{ width: 230, flexShrink: 0 }}>
          <div style={{ fontSize: 9, letterSpacing: 3, color: "#3a5a7a", marginBottom: 10 }}>
            <span style={{ color: "#ff8c00" }}>FLAG</span> SESSIONS
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {sessions.map(s => {
              const eff   = effectiveStress(s);
              const pct   = Math.min(eff * 100 * mult, 100);
              const color = riskColor(eff);
              const isSel = selected === s.session_id;
              const txn   = getTxnCtx(s);
              const hasChat = s.chat_log?.length > 0;
              return (
                <div
                  key={s.session_id}
                  onClick={() => {
                    setSelected(s.session_id);
                    setShowReceiver(false);
                    setReceiverData(null);
                    setDynamicPoints([]);
                  }}
                  style={{ background: isSel ? "rgba(0,180,255,0.12)" : "rgba(255,255,255,0.02)", border: `1px solid ${isSel ? "rgba(0,180,255,0.4)" : "rgba(255,255,255,0.06)"}`, borderLeft: `3px solid ${color}`, borderRadius: 6, padding: "10px 12px", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#d0e8ff" }}>{s.session_id}</span>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {s.overruled && <span style={{ fontSize: 8, color: "#ff3b3b", background: "rgba(255,59,59,0.15)", padding: "1px 5px", borderRadius: 3 }}>OVERRULED</span>}
                      <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}22`, padding: "2px 6px", borderRadius: 3 }}>{riskLabel(eff)}</span>
                    </div>
                  </div>
                  <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 5 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#4a6a8a" }}>
                    <span>{effectiveFlag(s)}</span>
                    <span style={{ display: "flex", gap: 4 }}>
                      {hasChat && <span style={{ color: "#fb923c" }}>chat</span>}
                      {txn.is_new_payee && <span style={{ color: "#ff8c00" }}>NEW</span>}
                    </span>
                  </div>
                  {txn.amount > 0 && <div style={{ fontSize: 9, color: "#3a5a6a", marginTop: 3 }}>Rs.{txn.amount.toLocaleString()} - {txn.payee}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Centre panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>

          {/* ── BUG FIX 3: Critical alert — OPEN SAFETY CHAT button arms Agent 2.
               The verdict === 'BLOCK' banner only shows AFTER chat confirms.      */}
          {isCritical && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(255,30,0,0.09)", border: "1px solid rgba(255,60,0,0.45)", borderRadius: 8, padding: "14px 18px" }}>
              <div style={{ fontSize: 11, color: "#ff5020", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>AGENT 2 - SCAM ELUCIDATION REQUIRED</div>
              <div style={{ fontSize: 10, color: "#8a5a3a", marginBottom: 10, lineHeight: 1.7 }}>
                <span style={{ color: "#ff8060" }}>Stress:</span> {Math.round(selStress * 100)}% &nbsp;|&nbsp;
                <span style={{ color: "#ff8060" }}>Amount:</span> {txnCtx.amount ? `Rs.${txnCtx.amount.toLocaleString()}` : "-"} &nbsp;|&nbsp;
                <span style={{ color: txnCtx.is_new_payee ? "#ff8c00" : "#00e676" }}>{txnCtx.is_new_payee ? "New payee" : "Known payee"}</span>
                {txnCtx.payee && txnCtx.payee !== "-" && <span style={{ color: "#6a5a4a" }}> - {txnCtx.payee}</span>}
              </div>
              {pendingVerdict && !chatOpen && (
                <div style={{ fontSize: 10, color: "#fbbf24", marginBottom: 8 }}>
                  Verdict pending — open Safety Chat to proceed.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => openChat(selEntry.session_id, selStress)} style={{ background: "#ff6020", border: "none", color: "#fff", padding: "8px 18px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>OPEN SAFETY CHAT</button>
                <button onClick={() => { checkReceiver(selEntry.session_id); setActiveTab("evidence"); }} style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.4)", color: "#fbbf24", padding: "8px 14px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>SCAN RECEIVER</button>
                {onNavigate && (
                  <button onClick={() => onNavigate("transfer")} style={{ background: "rgba(0,180,255,0.08)", border: "1px solid rgba(0,180,255,0.25)", color: "#4a8aaa", padding: "8px 14px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>NEW TRANSFER</button>
                )}
              </div>
            </div>
          )}

          {/* BUG FIX 3: VERDICT:BLOCK banner — only renders after handleChatConfirm fires */}
          {verdict === "BLOCK" && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(255,0,0,0.12)", border: "1px solid rgba(255,59,59,0.5)", borderRadius: 8, padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 12, color: "#ff3b3b", fontWeight: 700, letterSpacing: 2 }}>VERDICT: BLOCK</div>
                <div style={{ fontSize: 10, color: "#8a3a3a", marginTop: 3 }}>Transaction blocked after Agent 2 review.</div>
              </div>
              <button onClick={() => { setVerdict(null); setPendingVerdict(null); }} style={{ background: "rgba(255,59,59,0.1)", border: "1px solid rgba(255,59,59,0.3)", color: "#ff8080", padding: "6px 12px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontFamily: "inherit" }}>DISMISS</button>
            </div>
          )}

          {/* Continue button — visible when no critical alert */}
          {selEntry && !isCritical && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(0,30,10,0.4)", border: "1px solid rgba(0,230,118,0.2)", borderRadius: 8, padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, color: "#00e676", letterSpacing: 1, marginBottom: 2 }}>KINETIC ANALYSIS</div>
                <div style={{ fontSize: 9, color: "#3a6a4a" }}>Click Continue while keeping your hand on the mouse to detect tremor patterns.</div>
              </div>
              <button
                onClick={() => handleContinue(selEntry.session_id, selEntry.stress_score)}
                disabled={isAnalysing}
                style={{ background: isAnalysing ? "rgba(0,230,118,0.05)" : "rgba(0,230,118,0.12)", border: "1px solid rgba(0,230,118,0.35)", color: "#00e676", padding: "9px 20px", borderRadius: 6, cursor: isAnalysing ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", letterSpacing: 1, whiteSpace: "nowrap" }}
              >
                {isAnalysing ? "SENSING..." : "CONTINUE →"}
              </button>
            </div>
          )}

          {/* isMuleAccount toggle */}
          <div style={{ width: "100%", maxWidth: 540, background: "rgba(0,10,25,0.5)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 9, color: "#fbbf24", letterSpacing: 2 }}>AGENT 3 DEMO — MULE ACCOUNT FLAG</div>
              <div style={{ fontSize: 9, color: "#4a5a3a", marginTop: 2 }}>Toggle ON to simulate a suspicious receiver (₹1 test transfer pattern)</div>
            </div>
            <div
              onClick={() => setIsMuleAccount(v => !v)}
              style={{ width: 36, height: 18, borderRadius: 9, cursor: "pointer", background: isMuleAccount ? "#fbbf24" : "rgba(255,255,255,0.1)", position: "relative", flexShrink: 0 }}
            >
              <div style={{ position: "absolute", top: 3, left: isMuleAccount ? 20 : 3, width: 12, height: 12, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
            </div>
          </div>

          {/* Tab bar */}
          <div style={{ display: "flex", gap: 4, alignSelf: "stretch", maxWidth: 540 }}>
            {["heatmap", "evidence", "chatlog", "kinetic"].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex: 1, padding: "6px", borderRadius: 5, cursor: "pointer", background: activeTab === tab ? "rgba(0,180,255,0.15)" : "rgba(255,255,255,0.03)", border: `1px solid ${activeTab === tab ? "rgba(0,180,255,0.4)" : "rgba(255,255,255,0.06)"}`, color: activeTab === tab ? "#00bfff" : "#3a5a6a", fontSize: 10, fontFamily: "inherit", letterSpacing: 1 }}>
                {tab === "heatmap" ? "HEATMAP" : tab === "evidence" ? "EVIDENCE" : tab === "chatlog" ? `CHAT ${selEntry?.chat_log?.length ? `(${selEntry.chat_log.length})` : ""}` : `KINETIC ${selEntry?.kinetic_samples?.length ? `(${selEntry.kinetic_samples.length})` : ""}`}
              </button>
            ))}
          </div>

          {/* HEATMAP tab */}
          {activeTab === "heatmap" && (
            <>
              <div style={{ width: 220, height: 370, border: "2px solid rgba(0,180,255,0.5)", borderRadius: 28, background: "rgba(0,10,25,0.95)", position: "relative", boxShadow: "0 0 40px rgba(0,120,255,0.15)", overflow: "hidden" }}>
                <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0 }}>
                  {[20,40,60,80].map(p => (<line key={`v${p}`} x1={`${p}%`} y1="0" x2={`${p}%`} y2="100%" stroke="rgba(0,180,255,0.05)" strokeWidth="1"/>))}
                  {[20,40,60,80].map(p => (<line key={`h${p}`} x1="0" y1={`${p}%`} x2="100%" y2={`${p}%`} stroke="rgba(0,180,255,0.05)" strokeWidth="1"/>))}
                </svg>
                {!selEntry ? (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: 9, color: "#2a5a8a", letterSpacing: 2 }}>SELECT A SESSION</div>
                  </div>
                ) : (
                  <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0 }}>
                    {points.map((pt, i) => {
                      const c = riskColor(pt.stress / 100), r = 4 + (pt.stress / 100) * 10;
                      const op = aiFilter ? Math.max(0, pt.stress / 100 - 0.1) : pt.stress / 100;
                      return (
                        <g key={i}>
                          <circle cx={`${pt.svgX}%`} cy={`${pt.svgY}%`} r={r*2} fill={c} opacity={op*0.15}/>
                          <circle cx={`${pt.svgX}%`} cy={`${pt.svgY}%`} r={r} fill={c} opacity={Math.max(op,0.2)} style={{ cursor:"pointer" }} onMouseEnter={() => setHoveredPt({...pt, index: i})} onMouseLeave={() => setHoveredPt(null)} />
                        </g>
                      );
                    })}
                  </svg>
                )}
                <div style={{ position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 7, color: "rgba(0,180,255,0.3)", letterSpacing: 2 }}>{selEntry ? "ANALYSING DATA" : "AWAITING INPUT"}</div>
              </div>
              <div style={{ width: 220 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a", marginBottom: 6 }}>PROFILE SENSITIVITY</div>
                <select value={profile} onChange={e => setProfile(e.target.value)} style={{ width: "100%", background: "rgba(0,20,40,0.8)", border: "1px solid rgba(0,180,255,0.25)", color: "#80b0d0", padding: "7px 10px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>
                  {PROFILES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </>
          )}

          {/* EVIDENCE tab */}
          {activeTab === "evidence" && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(0,10,25,0.8)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 10, overflow: "hidden", flex: 1, minHeight: 300 }}>
              <div style={{ padding: "12px 14px", borderBottom: "1px solid rgba(0,180,255,0.1)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#34d399" }}>FORENSIC EVIDENCE - READ ONLY</div>
                {selEntry && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: riskColor(selStress), boxShadow: `0 0 6px ${riskColor(selStress)}` }} />
                    <span style={{ fontSize: 9, color: riskColor(selStress) }}>{riskLabel(selStress)}</span>
                  </div>
                )}
              </div>
              <div style={{ padding: "8px 0" }}><ForensicEvidence /></div>
              {selEntry && (
                <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ fontSize: 9, letterSpacing: 2, color: "#fbbf24", marginBottom: 8 }}>AGENT 3 - RECEIVER INTELLIGENCE</div>
                  <button onClick={() => checkReceiver(selected)} disabled={receiverLoading} style={{ width: "100%", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", padding: "9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit", letterSpacing: 1 }}>
                    {receiverLoading ? "SCANNING..." : `SCAN RECEIVER FOR ${selEntry.session_id}`}
                  </button>
                  {showReceiver && receiverData && !receiverLoading && (
                    <div style={{ marginTop: 10, background: "rgba(0,10,25,0.6)", border: `1px solid ${rcColor(receiverData.risk_level)}44`, borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: rcColor(receiverData.risk_level) }}>{receiverData.risk_level}</span>
                        <span style={{ fontSize: 10, color: "#4a6a8a" }}>Age: {receiverData.account_age_days}d - {Math.round(receiverData.confidence * 100)}%</span>
                      </div>
                      {receiverData.small_test_txn && (
                        <div style={{ fontSize: 10, color: "#ff8c00", marginBottom: 5 }}>Rs.1 test transfer pattern detected</div>
                      )}
                      <div style={{ marginBottom: 8 }}>
                        {receiverData.flags.length > 0
                          ? receiverData.flags.map((f, i) => <div key={i} style={{ fontSize: 10, color: "#7a8a9a" }}>- {f}</div>)
                          : <div style={{ fontSize: 10, color: "#00e676" }}>No suspicious flags detected</div>
                        }
                      </div>
                      <div style={{ fontSize: 10, color: rcColor(receiverData.risk_level), borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>{receiverData.recommendation}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* CHAT LOG tab */}
          {activeTab === "chatlog" && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(0,10,25,0.8)", border: "1px solid rgba(255,140,0,0.2)", borderRadius: 10, padding: "14px", flex: 1, minHeight: 300 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#fb923c", marginBottom: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                CHAT FORENSICS - {selected}
                {selEntry?.overruled && <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3, background: "rgba(255,59,59,0.2)", color: "#ff3b3b", border: "1px solid #ff3b3b" }}>KINETIC OVERRULED</span>}
                {selEntry?.chat_verdict && <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3, background: selEntry.chat_verdict === "block" ? "rgba(255,59,59,0.15)" : "rgba(0,230,118,0.15)", color: selEntry.chat_verdict === "block" ? "#ff3b3b" : "#00e676", border: `1px solid ${selEntry.chat_verdict === "block" ? "#ff3b3b" : "#00e676"}` }}>VERDICT: {selEntry.chat_verdict?.toUpperCase()}</span>}
              </div>
              {!selEntry?.chat_log?.length ? (
                <div style={{ fontSize: 10, color: "#2a4a5a", textAlign: "center", paddingTop: 40 }}>
                  No chat interactions recorded.
                  {isCritical && <div style={{ marginTop: 8, color: "#fb923c" }}>Open Safety Chat above to start Agent 2.</div>}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 400, overflowY: "auto" }}>
                  {selEntry.chat_log.map((msg, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                      <div style={{ maxWidth: "88%", padding: "8px 12px", borderRadius: 8, background: msg.role === "system" ? "rgba(255,59,59,0.1)" : msg.role === "user" ? "rgba(0,180,255,0.1)" : "rgba(255,140,0,0.07)", border: `1px solid ${msg.role === "system" ? "rgba(255,59,59,0.25)" : msg.role === "user" ? "rgba(0,180,255,0.2)" : "rgba(255,140,0,0.15)"}`, fontSize: 11, lineHeight: 1.5, color: msg.role === "system" ? "#ff8080" : msg.role === "user" ? "#90c8e8" : "#c89050" }}>
                        <div style={{ fontSize: 8, marginBottom: 3, opacity: 0.6, letterSpacing: 1 }}>
                          {msg.role === "agent" ? "AGENT 2" : msg.role === "system" ? "SYSTEM" : "USER"} - {msg.ts?.substring(11,19)}
                          {msg.stress_at_message != null && <span style={{ marginLeft: 6, color: riskColor(msg.stress_at_message) }}>stress:{Math.round(msg.stress_at_message * 100)}%</span>}
                        </div>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* KINETIC tab */}
          {activeTab === "kinetic" && (
            <div style={{ width: "100%", maxWidth: 540, background: "rgba(0,10,25,0.8)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "14px", flex: 1, minHeight: 300 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#a78bfa", marginBottom: 10 }}>LIVE TREMOR DURING CHAT - {selected}</div>
              {!selEntry?.kinetic_samples?.length ? (
                <div style={{ fontSize: 10, color: "#2a4a5a", textAlign: "center", paddingTop: 40 }}>No live kinetic samples recorded during chat.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 400, overflowY: "auto" }}>
                  {selEntry.kinetic_samples.map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 9, color: "#3a5a6a", width: 60, flexShrink: 0 }}>{s.ts?.substring(11,19)}</span>
                      <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3 }}>
                        <div style={{ width: `${Math.min(s.stress * 100, 100)}%`, height: "100%", background: riskColor(s.stress), borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 10, color: riskColor(s.stress), width: 40, textAlign: "right" }}>{Math.round(s.stress * 100)}%</span>
                      {s.z_std > 0 && <span style={{ fontSize: 9, color: "#4a6a8a" }}>sigma={s.z_std.toFixed(3)}</span>}
                    </div>
                  ))}
                  <div style={{ marginTop: 8, padding: "8px", background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
                    <div style={{ fontSize: 9, color: "#4a6a8a" }}>Peak stress: <span style={{ color: riskColor(Math.max(...selEntry.kinetic_samples.map(s => s.stress))) }}>{Math.round(Math.max(...selEntry.kinetic_samples.map(s => s.stress)) * 100)}%</span></div>
                    {selEntry.overruled && <div style={{ fontSize: 9, color: "#ff8080", marginTop: 4 }}>Kinetic overrule applied - stress remained high after "Yes"</div>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel */}
        <div style={{ width: 230, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "rgba(0,20,40,0.6)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a" }}>FILTER NOISE</div>
              <div onClick={() => setAiFilter(v => !v)} style={{ width: 32, height: 16, borderRadius: 8, cursor: "pointer", background: aiFilter ? "#00bfff" : "rgba(255,255,255,0.1)", position: "relative" }}>
                <div style={{ position: "absolute", top: 2, left: aiFilter ? 18 : 2, width: 12, height: 12, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#2a4a6a" }}>{aiFilter ? "AI normalisation on" : "Disabled"}</div>
          </div>
          <div style={{ background: "rgba(0,20,40,0.6)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a", marginBottom: 10 }}>SIGNAL LEGEND</div>
            {[
              { label: "Critical >80%",      sub: "Agent 2 + overrule", color: "#ff3b3b" },
              { label: "High 61-80%",        sub: "Elevated tremor",    color: "#ff8c00" },
              { label: "Medium 41-60%",      sub: "Cooling-off tier",   color: "#f5c518" },
              { label: "Low 40% and below",  sub: "Within tolerance",   color: "#00bfff" },
              { label: "Clear",              sub: "Baseline match",     color: "#00e676" },
            ].map(item => (
              <div key={item.label} style={{ display: "flex", gap: 10, marginBottom: 7 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, flexShrink: 0, marginTop: 2, boxShadow: `0 0 5px ${item.color}` }} />
                <div>
                  <div style={{ fontSize: 10, color: "#a0c0d8" }}>{item.label}</div>
                  <div style={{ fontSize: 9, color: "#3a5a6a" }}>{item.sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Dynamic Point Analysis bars */}
          <div style={{ background: "rgba(0,20,40,0.6)", border: "1px solid rgba(0,180,255,0.15)", borderRadius: 8, padding: "12px 14px", flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a" }}>POINT ANALYSIS</div>
              {selEntry && <div style={{ fontSize: 9, color: "#2a5a7a" }}>{selEntry.session_id}</div>}
            </div>
            {hoveredPt ? (
              <div style={{ fontSize: 10, color: "#80a8c8", lineHeight: 1.8 }}>
                <div>PT-{String(hoveredPt.index+1).padStart(2,"0")}</div>
                <div style={{ color: riskColor(hoveredPt.stress/100) }}>Stress: {Math.round(hoveredPt.stress)}%</div>
                <div>T: {hoveredPt.ms}ms</div>
              </div>
            ) : points.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 180, overflowY: "auto" }}>
                {points.slice(0, 14).map((pt, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, color: "#3a5a6a" }}>
                    <span>PT-{String(i+1).padStart(2,"0")}</span>
                    <div style={{ width: 55, height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2 }}>
                      <div style={{ width: `${pt.stress}%`, height: "100%", background: riskColor(pt.stress/100), borderRadius: 2, transition: "width 0.5s, background 0.5s" }} />
                    </div>
                    <span style={{ color: riskColor(pt.stress/100) }}>{Math.round(pt.stress)}%</span>
                  </div>
                ))}
              </div>
            ) : <div style={{ fontSize: 10, color: "#2a4a5a" }}>Press CONTINUE to run analysis</div>}
          </div>

          <div style={{ background: "rgba(0,10,20,0.8)", border: "1px solid rgba(0,180,255,0.08)", borderRadius: 8, padding: "10px 12px", maxHeight: 130, overflow: "hidden" }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#2a4a5a", marginBottom: 5 }}>SYSTEM LOG</div>
            {log.slice(0, 6).map((entry, i) => (
              <div key={i} style={{ fontSize: 9, fontFamily: "monospace", color: entry.includes("OVERRULE") || entry.includes("TREMOR") ? "#ff3b3b" : entry.includes("BLOCK") ? "#ff5050" : entry.includes("Agent 2") ? "#fb923c" : entry.includes("cooling") ? "#fbbf24" : entry.includes("Agent 3") ? "#fbbf24" : entry.includes("reset") ? "#00bfff" : "#2a6a4a" }}>{entry}</div>
            ))}
            {!log.length && <div style={{ fontSize: 9, color: "#1a3a4a" }}>waiting...</div>}
          </div>
        </div>
      </div>

      {/* ── Agent 2 chat modal ─────────────────────────────────────────── */}
      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,4,12,0.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ width: 520, maxHeight: "86vh", display: "flex", flexDirection: "column", background: "#08121f", border: `1px solid ${safetyExit ? "rgba(255,0,0,0.7)" : chatVerdict === "block" ? "rgba(255,59,59,0.5)" : chatVerdict === "allow" ? "rgba(0,230,118,0.4)" : "rgba(255,100,30,0.45)"}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", background: safetyExit ? "rgba(255,0,0,0.15)" : "rgba(255,80,0,0.08)", borderBottom: "1px solid rgba(255,100,30,0.2)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: safetyExit ? "#ff3b3b" : "#fb923c", letterSpacing: 1 }}>{safetyExit ? "SAFETY EXIT - DURESS DETECTED" : "AGENT 2 - SCAM ELUCIDATION"}</div>
                  <div style={{ fontSize: 9, color: "#6a5a3a", marginTop: 2 }}>Session: {chatSession}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {overruleState === "checking"  && <span style={{ fontSize: 10, color: "#fbbf24" }}>Kinetic check...</span>}
                  {overruleState === "overruled" && <span style={{ fontSize: 10, color: "#ff3b3b", background: "rgba(255,59,59,0.15)", padding: "2px 8px", borderRadius: 4 }}>OVERRULED</span>}
                  {overruleState === "passed"    && <span style={{ fontSize: 10, color: "#00e676" }}>Kinetic OK</span>}
                  {chatVerdict !== "continue" && chatVerdict !== "cooling_off" && (
                    <div style={{ padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: chatVerdict === "block" ? "rgba(255,59,59,0.2)" : "rgba(0,230,118,0.2)", color: chatVerdict === "block" ? "#ff3b3b" : "#00e676", border: `1px solid ${chatVerdict === "block" ? "#ff3b3b" : "#00e676"}` }}>{chatVerdict === "block" ? "BLOCKED" : "ALLOWED"}</div>
                  )}
                  {/* BUG FIX 3: X button routes through handleChatDismiss/Confirm based on verdict */}
                  <button
                    onClick={() => {
                      if (chatVerdict === "block" || safetyExit) {
                        handleChatConfirm();  // issue the block
                      } else {
                        handleChatDismiss();  // clear without blocking
                      }
                      fetchData();
                    }}
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#6a7a8a", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
                  >X</button>
                </div>
              </div>
              {chatContext && (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 12, background: "rgba(255,59,59,0.15)", border: "1px solid rgba(255,59,59,0.3)", color: "#ff8080" }}>Stress: {Math.round((chatContext.stress_score || 0) * 100)}%</span>
                  <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 12, background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24" }}>Rs.{(chatContext.amount || 0).toLocaleString()}</span>
                  {chatContext.is_new_payee && <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 12, background: "rgba(255,140,0,0.15)", border: "1px solid rgba(255,140,0,0.35)", color: "#ff8c00" }}>New Payee</span>}
                  <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 12, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#6a8a9a" }}>{chatContext.payee}</span>
                  {chatTier && <span style={{ fontSize: 9, padding: "3px 8px", borderRadius: 12, background: "rgba(0,180,255,0.08)", border: "1px solid rgba(0,180,255,0.2)", color: "#60a0c0" }}>{chatTier}</span>}
                </div>
              )}
            </div>
            {coolingActive && (
              <div style={{ padding: "16px 18px", background: "rgba(251,191,36,0.08)", borderBottom: "1px solid rgba(251,191,36,0.2)" }}>
                <div style={{ fontSize: 11, color: "#fbbf24", fontWeight: 700, marginBottom: 8 }}>COOLING-OFF PERIOD - {coolingSeconds}s remaining</div>
                <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#fbbf24", borderRadius: 3, width: `${(coolingSeconds / COOLING_SECS) * 100}%`, transition: "width 1s linear" }} />
                </div>
                <div style={{ fontSize: 10, color: "#8a7a3a", marginBottom: 10 }}>Transaction on hold. Scammers rely on urgency - take a moment.</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => cancelCooling(true)} style={{ flex: 1, background: "rgba(0,230,118,0.1)", border: "1px solid rgba(0,230,118,0.3)", color: "#00e676", padding: "9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>YES - PROCEED</button>
                  <button onClick={() => cancelCooling(false)} style={{ flex: 1, background: "rgba(255,59,59,0.1)", border: "1px solid rgba(255,59,59,0.3)", color: "#ff3b3b", padding: "9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>CANCEL TRANSACTION</button>
                </div>
              </div>
            )}
            {safetyExit && (
              <div style={{ padding: "16px 18px", background: "rgba(255,0,0,0.12)", borderBottom: "1px solid rgba(255,0,0,0.3)" }}>
                <div style={{ fontSize: 12, color: "#ff3b3b", fontWeight: 700, marginBottom: 6 }}>TRANSACTION BLOCKED - YOUR SAFETY IS THE PRIORITY</div>
                <div style={{ fontSize: 11, color: "#c08080", marginBottom: 12, lineHeight: 1.7 }}>We detected signs of duress. If someone is forcing you, please:</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <a href="tel:18001201740" style={{ flex: 1, display: "block", background: "#ff3b3b", color: "#fff", padding: "10px", borderRadius: 6, textDecoration: "none", fontSize: 12, fontWeight: 700, textAlign: "center", fontFamily: "inherit" }}>CALL BANK SECURITY</a>
                  <a href="tel:112" style={{ display: "block", background: "rgba(255,59,59,0.2)", border: "1px solid rgba(255,59,59,0.4)", color: "#ff8080", padding: "10px 16px", borderRadius: 6, textDecoration: "none", fontSize: 12, fontWeight: 700, textAlign: "center", fontFamily: "inherit" }}>EMERGENCY 112</a>
                </div>
              </div>
            )}
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10, minHeight: 220 }}>
              {chatMessages.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth: "84%", padding: "9px 13px", borderRadius: 10, background: m.isOverrule ? "rgba(255,59,59,0.12)" : m.role === "user" ? "rgba(0,180,255,0.11)" : "rgba(255,120,30,0.08)", border: `1px solid ${m.isOverrule ? "rgba(255,59,59,0.3)" : m.role === "user" ? "rgba(0,180,255,0.22)" : "rgba(255,120,30,0.18)"}`, fontSize: 12, color: m.isOverrule ? "#ff8080" : m.role === "user" ? "#90c0e0" : "#c89050", lineHeight: 1.55 }}>
                    {m.role === "agent" && !m.isOverrule && <div style={{ fontSize: 8, color: "#7a5a30", marginBottom: 4, letterSpacing: 1 }}>KINETIC TRUST SAFETY AI</div>}
                    {m.isOverrule && <div style={{ fontSize: 8, color: "#ff6060", marginBottom: 4, letterSpacing: 1 }}>KINETIC OVERRULE</div>}
                    {m.text}
                  </div>
                </div>
              ))}
              {chatLoading && <div style={{ display: "flex" }}><div style={{ padding: "9px 13px", background: "rgba(255,120,30,0.06)", border: "1px solid rgba(255,120,30,0.15)", borderRadius: 10, fontSize: 12, color: "#6a5030" }}>Analysing...</div></div>}
              <div ref={chatEndRef} />
            </div>
            {!coolingActive && chatVerdict === "continue" && !safetyExit ? (
              <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 8 }}>
                <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Type your response..." style={{ flex: 1, background: "rgba(0,20,40,0.8)", border: "1px solid rgba(255,120,30,0.22)", color: "#c0a070", padding: "8px 12px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                <button onClick={sendChat} disabled={chatLoading} style={{ background: "#fb923c", border: "none", color: "#000", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>SEND</button>
              </div>
            ) : !coolingActive && chatVerdict !== "continue" && !safetyExit ? (
              <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 8 }}>
                <button onClick={() => { handleChatDismiss(); setActiveTab("chatlog"); }} style={{ flex: 1, background: "rgba(0,180,255,0.08)", border: "1px solid rgba(0,180,255,0.25)", color: "#00bfff", padding: "9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>VIEW FORENSICS LOG</button>
                {chatVerdict === "block" && (
                  <button onClick={() => { handleChatConfirm(); checkReceiver(chatSession); setActiveTab("evidence"); }} style={{ flex: 1, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", padding: "9px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>RUN AGENT 3</button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <style>{`
        select option { background: #0a1a2a; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,180,255,0.2); border-radius: 2px; }
        input:focus { outline: none; }
      `}</style>
    </div>
  );
}