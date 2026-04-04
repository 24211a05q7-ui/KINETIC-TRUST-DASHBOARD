import { useState, useEffect, useRef, useCallback } from "react";

const API = "http://localhost:8000";
const POLL_MS = 3000;

// ── colour helpers ────────────────────────────────────────────────────────────
const riskColor = (score) => {
  if (score >= 0.8) return "#ff3b3b";
  if (score >= 0.6) return "#ff8c00";
  if (score >= 0.4) return "#f5c518";
  if (score >= 0.2) return "#00bfff";
  return "#00e676";
};

const riskLabel = (score) => {
  if (score >= 0.8) return "CRITICAL";
  if (score >= 0.6) return "HIGH";
  if (score >= 0.4) return "MEDIUM";
  if (score >= 0.2) return "LOW";
  return "CLEAR";
};

const riskBg = (score) => {
  if (score >= 0.8) return "rgba(255,59,59,0.18)";
  if (score >= 0.6) return "rgba(255,140,0,0.18)";
  if (score >= 0.4) return "rgba(245,197,24,0.15)";
  if (score >= 0.2) return "rgba(0,191,255,0.12)";
  return "rgba(0,230,118,0.12)";
};

// ── normalise samples → SVG [8, 92] space ────────────────────────────────────
function normaliseSamples(samples, riskPct) {
  if (!samples || samples.length === 0) return [];
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const zs = samples.map((s) => Math.abs(s.z));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const maxZ = Math.max(...zs) || 1;
  const LO = 8, HI = 92;
  const scale = (v, lo, hi) =>
    hi === lo ? (LO + HI) / 2 : LO + ((v - lo) / (hi - lo)) * (HI - LO);
  return samples.map((s) => ({
    svgX: scale(s.x, minX, maxX),
    svgY: scale(s.y, minY, maxY),
    stress: (Math.abs(s.z) / maxZ) * riskPct,
    ms: Math.round(s.t * 1000),
  }));
}

// ── PROFILE MULTIPLIERS ───────────────────────────────────────────────────────
const PROFILES = [
  { id: "steady", label: "Steady Hand", mult: 0.82 },
  { id: "mild",   label: "Mild Tremor", mult: 1.0  },
  { id: "tremor", label: "Parkinson's / Tremor", mult: 1.08 },
];

// ═════════════════════════════════════════════════════════════════════════════
export default function ForensicConsole() {
  const [sessions, setSessions]       = useState([]);
  const [selected, setSelected]       = useState(null);
  const [profile,  setProfile]        = useState("mild");
  const [aiFilter, setAiFilter]       = useState(false);
  const [status,   setStatus]         = useState("connecting"); // connecting | ok | error
  const [errMsg,   setErrMsg]         = useState("");
  const [log,      setLog]            = useState([]);
  const [hoveredPt, setHoveredPt]     = useState(null);
  const prevIds = useRef(new Set());

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLog((l) => [`[${ts}] ${msg}`, ...l].slice(0, 40));
  }, []);

  // ── fetch loop ──────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/forensics`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        mode: "cors",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus("ok");
      setErrMsg("");
      setSessions(data);

      // detect new arrivals
      const incoming = new Set(data.map((s) => s.session_id));
      const newOnes  = data.filter((s) => !prevIds.current.has(s.session_id));
      if (newOnes.length > 0) {
        newOnes.forEach((s) =>
          addLog(`New session: ${s.session_id} → ${riskLabel(s.stress_score)} (${Math.round(s.stress_score * 100)}%)`)
        );
        // auto-select newest
        setSelected(newOnes[0].session_id);
      }
      prevIds.current = incoming;
    } catch (err) {
      setStatus("error");
      setErrMsg(err.message);
      addLog(`Poll error: ${err.message}`, "error");
    }
  }, [addLog]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── derived ─────────────────────────────────────────────────────────────────
  const mult      = PROFILES.find((p) => p.id === profile)?.mult ?? 1;
  const selEntry  = sessions.find((s) => s.session_id === selected);
  const riskPct   = selEntry ? Math.min(selEntry.stress_score * 100 * mult, 100) : 0;
  const points    = selEntry ? normaliseSamples(selEntry.samples, riskPct) : [];

  const flagged   = sessions.filter((s) => s.stress_score >= 0.6);
  const avgStress = sessions.length
    ? sessions.reduce((a, s) => a + s.stress_score, 0) / sessions.length
    : 0;
  const maxSession = sessions.length
    ? sessions.reduce((a, s) => (s.stress_score > a.stress_score ? s : a), sessions[0])
    : null;

  // ── stat card ────────────────────────────────────────────────────────────────
  const StatCard = ({ label, value, sub, color }) => (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 8,
      padding: "14px 18px",
      flex: 1,
    }}>
      <div style={{ fontSize: 10, color: "#6a7a8a", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || "#e0eaff", fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#4a5a6a", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      background: "#080e1a",
      color: "#c8d8e8",
      fontFamily: "'Courier New', monospace",
      display: "flex",
      flexDirection: "column",
    }}>

      {/* ── TOP BAR ── */}
      <div style={{
        background: "rgba(0,20,40,0.95)",
        borderBottom: "1px solid rgba(0,180,255,0.2)",
        padding: "10px 24px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: "#00bfff", fontWeight: 700 }}>
          ⬡ KINETIC·TRUST
        </div>
        <div style={{ fontSize: 10, color: "#3a5a7a", letterSpacing: 2 }}>
          TREMOR ANALYSIS ENGINE v4.2.1
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: status === "ok" ? "#00e676" : status === "connecting" ? "#f5c518" : "#ff3b3b",
            boxShadow: `0 0 8px ${status === "ok" ? "#00e676" : status === "connecting" ? "#f5c518" : "#ff3b3b"}`,
          }} />
          <span style={{ fontSize: 10, color: "#4a6a8a", letterSpacing: 1 }}>
            {status === "ok" ? `LIVE · ${sessions.length} sessions` :
             status === "connecting" ? "CONNECTING…" :
             `UNREACHABLE · ${API}`}
          </span>
        </div>
      </div>

      {/* ── ERROR BANNER ── */}
      {status === "error" && (
        <div style={{
          background: "rgba(255,40,40,0.1)",
          borderBottom: "1px solid rgba(255,40,40,0.3)",
          padding: "10px 24px",
          fontSize: 12,
          color: "#ff6060",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}>
          <span>⚠</span>
          <span>Cannot reach backend at <b>{API}</b>. Make sure uvicorn is running:&nbsp;
            <code style={{ background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4 }}>
              python -m uvicorn main:app --reload --port 8000
            </code>
          </span>
          <button
            onClick={fetchData}
            style={{
              marginLeft: "auto", background: "rgba(255,60,60,0.2)",
              border: "1px solid rgba(255,60,60,0.4)", color: "#ff8080",
              padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 11,
            }}
          >RETRY</button>
        </div>
      )}

      {/* ── STAT ROW ── */}
      <div style={{ display: "flex", gap: 12, padding: "16px 24px 0" }}>
        <StatCard
          label="Flagged Sessions"
          value={flagged.length}
          sub={`of ${sessions.length} analysed`}
          color="#ff3b3b"
        />
        <StatCard
          label="Session Risk"
          value={maxSession ? `${Math.round(maxSession.stress_score * 100)}%` : "—"}
          sub={maxSession?.session_id}
          color={maxSession ? riskColor(maxSession.stress_score) : "#6a7a8a"}
        />
        <StatCard
          label="Avg Stress Index"
          value={sessions.length ? `${Math.round(avgStress * 100)}%` : "—"}
          sub={`${sessions.reduce((a, s) => a + (s.samples?.length || 0), 0)} data points`}
          color="#00bfff"
        />
        <StatCard
          label="Max Sessions"
          value={sessions.length ? `${Math.max(...sessions.map(s => s.samples?.length || 0)) * 8.33}ms` : "—"}
          sub="Input latency"
          color="#a0c0e0"
        />
        <StatCard
          label="Engine"
          value="PASSIVE"
          sub="Listening for input"
          color="#4a7a9a"
        />
      </div>

      {/* ── MAIN BODY ── */}
      <div style={{ display: "flex", flex: 1, gap: 0, padding: "16px 24px", gap: 16 }}>

        {/* ── LEFT SIDEBAR — session list ── */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{ fontSize: 9, letterSpacing: 3, color: "#3a5a7a", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#ff8c00" }}>⚑</span> FLAGGED SESSIONS
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sessions.map((s) => {
              const pct   = Math.min(s.stress_score * 100 * mult, 100);
              const color = riskColor(s.stress_score);
              const label = riskLabel(s.stress_score);
              const time  = s.received_at ? s.received_at.substring(11, 19) : "";
              const isSel = selected === s.session_id;
              return (
                <div
                  key={s.session_id}
                  onClick={() => setSelected(s.session_id)}
                  style={{
                    background: isSel ? `rgba(0,180,255,0.12)` : "rgba(255,255,255,0.02)",
                    border: `1px solid ${isSel ? "rgba(0,180,255,0.4)" : "rgba(255,255,255,0.06)"}`,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#d0e8ff" }}>{s.session_id}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, color, background: riskBg(s.stress_score),
                      padding: "2px 6px", borderRadius: 3, letterSpacing: 1,
                    }}>{label}</span>
                  </div>
                  <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 6 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4a6a8a" }}>
                    <span>{s.diagnostics?.flag || "—"}</span>
                    <span>{time}</span>
                  </div>
                </div>
              );
            })}
            {sessions.length === 0 && status !== "error" && (
              <div style={{ fontSize: 11, color: "#2a4a6a", textAlign: "center", paddingTop: 20 }}>
                Waiting for sessions…
              </div>
            )}
          </div>
        </div>

        {/* ── CENTRE — phone heatmap ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>

          {/* phone frame */}
          <div style={{
            width: 220,
            height: 400,
            border: "2px solid rgba(0,180,255,0.5)",
            borderRadius: 28,
            background: "rgba(0,10,25,0.95)",
            position: "relative",
            boxShadow: "0 0 40px rgba(0,120,255,0.15), inset 0 0 30px rgba(0,0,0,0.5)",
            overflow: "hidden",
          }}>
            {/* notch */}
            <div style={{
              position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
              width: 60, height: 6, background: "rgba(0,180,255,0.2)", borderRadius: 3,
              display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px",
            }}>
              <span style={{ fontSize: 5, color: "#00bfff", letterSpacing: 1 }}>ZTRC v4.2</span>
              <span style={{ fontSize: 5, color: "#00bfff" }}>5G SIM</span>
            </div>

            {/* grid lines */}
            <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0 }}>
              {[20, 40, 60, 80].map((pct) => (
                <line key={`v${pct}`} x1={`${pct}%`} y1="0" x2={`${pct}%`} y2="100%"
                  stroke="rgba(0,180,255,0.06)" strokeWidth="1" />
              ))}
              {[20, 40, 60, 80].map((pct) => (
                <line key={`h${pct}`} x1="0" y1={`${pct}%`} x2="100%" y2={`${pct}%`}
                  stroke="rgba(0,180,255,0.06)" strokeWidth="1" />
              ))}
            </svg>

            {/* status / dots */}
            {status === "error" ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <div style={{ fontSize: 18, color: "rgba(255,60,60,0.5)" }}>↺</div>
                <div style={{ fontSize: 9, color: "#ff6060", letterSpacing: 2 }}>BACKEND UNREACHABLE</div>
                <div style={{ fontSize: 8, color: "#3a4a5a" }}>{API}</div>
              </div>
            ) : !selEntry ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <div style={{ fontSize: 18, color: "rgba(0,180,255,0.3)", animation: "spin 2s linear infinite" }}>↺</div>
                <div style={{ fontSize: 9, color: "#2a5a8a", letterSpacing: 2 }}>
                  {sessions.length === 0 ? "AWAITING DATA" : "SELECT A SESSION"}
                </div>
              </div>
            ) : (
              <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0 }}>
                {points.map((pt, i) => {
                  const c   = riskColor(pt.stress / 100);
                  const r   = 4 + (pt.stress / 100) * 10;
                  const op  = aiFilter ? Math.max(0, pt.stress / 100 - 0.1) : pt.stress / 100;
                  return (
                    <g key={i}>
                      <circle cx={`${pt.svgX}%`} cy={`${pt.svgY}%`} r={r * 2}
                        fill={c} opacity={op * 0.15} />
                      <circle
                        cx={`${pt.svgX}%`} cy={`${pt.svgY}%`} r={r}
                        fill={c} opacity={Math.max(op, 0.2)}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHoveredPt({ ...pt, index: i })}
                        onMouseLeave={() => setHoveredPt(null)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}

            {/* bottom label */}
            <div style={{
              position: "absolute", bottom: 10, left: 0, right: 0,
              textAlign: "center", fontSize: 8, color: "rgba(0,180,255,0.35)", letterSpacing: 2,
            }}>
              {selEntry ? "ANALYSING DATA" : "AWAITING INPUT"}
            </div>
          </div>

          {/* profile selector */}
          <div style={{ width: 220 }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a", marginBottom: 6 }}>▴ PROFILE SENSITIVITY</div>
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              style={{
                width: "100%",
                background: "rgba(0,20,40,0.8)",
                border: "1px solid rgba(0,180,255,0.25)",
                color: "#80b0d0",
                padding: "7px 10px",
                borderRadius: 5,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* AI filter toggle */}
          <div style={{
            background: "rgba(0,20,40,0.6)",
            border: "1px solid rgba(0,180,255,0.15)",
            borderRadius: 8, padding: "12px 14px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a" }}>▽ FILTER HUMAN NOISE</div>
              <div
                onClick={() => setAiFilter((v) => !v)}
                style={{
                  width: 32, height: 16, borderRadius: 8, cursor: "pointer",
                  background: aiFilter ? "#00bfff" : "rgba(255,255,255,0.1)",
                  position: "relative", transition: "background 0.2s",
                }}
              >
                <div style={{
                  position: "absolute", top: 2,
                  left: aiFilter ? 18 : 2,
                  width: 12, height: 12, borderRadius: "50%",
                  background: "#fff", transition: "left 0.2s",
                }} />
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#2a4a6a" }}>
              {aiFilter ? "AI normalisation active" : "AI normalisation disabled"}
            </div>
          </div>

          {/* signal legend */}
          <div style={{
            background: "rgba(0,20,40,0.6)",
            border: "1px solid rgba(0,180,255,0.15)",
            borderRadius: 8, padding: "12px 14px",
          }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a", marginBottom: 10 }}>SIGNAL LEGEND</div>
            {[
              { label: "Critical >80%", sub: "Fraud indicator — pulsing", color: "#ff3b3b" },
              { label: "High 61–80%",   sub: "Elevated tremor pattern",  color: "#ff8c00" },
              { label: "Medium 41–60%", sub: "Moderate deviation",       color: "#f5c518" },
              { label: "Low ≤40%",      sub: "Within tolerance",         color: "#00bfff" },
              { label: "Norm. Path",    sub: "AI-cleaned trajectory",    color: "#00e676" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: item.color, flexShrink: 0, marginTop: 2,
                  boxShadow: `0 0 6px ${item.color}`,
                }} />
                <div>
                  <div style={{ fontSize: 10, color: "#a0c0d8" }}>{item.label}</div>
                  <div style={{ fontSize: 9, color: "#3a5a6a" }}>{item.sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* point analysis */}
          <div style={{
            background: "rgba(0,20,40,0.6)",
            border: "1px solid rgba(0,180,255,0.15)",
            borderRadius: 8, padding: "12px 14px",
            flex: 1, overflow: "hidden",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#3a5a7a" }}>POINT ANALYSIS</div>
              {selEntry && <div style={{ fontSize: 9, color: "#2a5a7a" }}>{selEntry.session_id}</div>}
            </div>
            {hoveredPt ? (
              <div style={{ fontSize: 10, color: "#80a8c8", lineHeight: 1.8 }}>
                <div>PT-{String(hoveredPt.index + 1).padStart(2, "0")}</div>
                <div style={{ color: riskColor(hoveredPt.stress / 100) }}>
                  Stress: {Math.round(hoveredPt.stress)}%
                </div>
                <div>X: {hoveredPt.svgX.toFixed(1)}</div>
                <div>Y: {hoveredPt.svgY.toFixed(1)}</div>
                <div>T: {hoveredPt.ms}ms</div>
              </div>
            ) : points.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
                {points.slice(0, 12).map((pt, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#3a5a6a" }}>
                    <span style={{ color: "#2a4a5a" }}>PT-{String(i + 1).padStart(2, "0")}</span>
                    <div style={{ width: 60, height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, alignSelf: "center" }}>
                      <div style={{ width: `${pt.stress}%`, height: "100%", background: riskColor(pt.stress / 100), borderRadius: 2 }} />
                    </div>
                    <span style={{ color: riskColor(pt.stress / 100) }}>{Math.round(pt.stress)}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: "#2a4a5a" }}>no data</div>
            )}
          </div>

          {/* system log */}
          <div style={{
            background: "rgba(0,10,20,0.8)",
            border: "1px solid rgba(0,180,255,0.1)",
            borderRadius: 8, padding: "10px 12px",
            maxHeight: 130, overflow: "hidden",
          }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#2a4a5a", marginBottom: 6 }}>⌥ SYSTEM LOG</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {log.slice(0, 6).map((entry, i) => (
                <div key={i} style={{
                  fontSize: 9,
                  color: entry.includes("CRITICAL") || entry.includes("error") ? "#ff6060"
                       : entry.includes("HIGH") ? "#ff9040"
                       : "#2a6a4a",
                  fontFamily: "monospace",
                }}>{entry}</div>
              ))}
              {log.length === 0 && (
                <div style={{ fontSize: 9, color: "#1a3a4a" }}>▌ waiting…</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* spin keyframe */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        select option { background: #0a1a2a; }
        ::-webkit-scrollbar { width: 4px; } 
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,180,255,0.2); border-radius: 2px; }
      `}</style>
    </div>
  );
}