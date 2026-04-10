import { useState } from "react";
import TransferForm    from "./TransferForm";
import ForensicConsole from "./ForensicConsole";

export default function App() {
  const [view, setView] = useState("transfer"); // "transfer" | "forensics"

  return (
    <div style={{ minHeight: "100vh", background: "#020b18" }}>

      {/* ── Global nav bar ── */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 2000,
        background: "rgba(2,11,24,0.92)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(0,180,255,0.12)",
        display: "flex", alignItems: "center", gap: 0,
        height: 44,
      }}>
        <div style={{
          padding: "0 20px", fontSize: 11, letterSpacing: 4,
          color: "rgba(0,180,255,0.6)", fontFamily: "monospace",
          borderRight: "1px solid rgba(0,180,255,0.08)",
          height: "100%", display: "flex", alignItems: "center",
        }}>
          ⬡ KT
        </div>

        {[
          { id: "transfer",  label: "TRANSFER",        icon: "→" },
          { id: "forensics", label: "FORENSIC CONSOLE", icon: "⬡" },
        ].map(tab => (
          <button key={tab.id} onClick={() => setView(tab.id)} style={{
            height: "100%", padding: "0 20px",
            background: view === tab.id ? "rgba(0,180,255,0.08)" : "transparent",
            border: "none",
            borderBottom: view === tab.id ? "2px solid #00bfff" : "2px solid transparent",
            borderRight: "1px solid rgba(0,180,255,0.06)",
            color: view === tab.id ? "#00bfff" : "#2a5a7a",
            fontFamily: "monospace", fontSize: 10, letterSpacing: 2,
            cursor: "pointer", transition: "all 0.2s",
          }}>
            <span style={{ marginRight: 6, opacity: 0.6 }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}

        <div style={{ marginLeft: "auto", padding: "0 20px", display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#00e676", boxShadow: "0 0 6px #00e676" }} />
          <span style={{ fontSize: 9, color: "#2a5a6a", fontFamily: "monospace", letterSpacing: 2 }}>
            v4.3 · 4-AGENT SYSTEM
          </span>
        </div>
      </div>

      <div style={{ paddingTop: view === "forensics" ? 44 : 0 }}>
        {view === "transfer"  && <TransferForm    onNavigate={setView} />}
        {view === "forensics" && <ForensicConsole onNavigate={setView} />}
      </div>
    </div>
  );
}