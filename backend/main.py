"""
KineticTrust — main.py  (Member 2 Backend, v3 — fully connected)
================================================================
Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Requires engine.py in the same directory.

Install deps:
    pip install fastapi uvicorn pydantic numpy scipy

What this file does
-------------------
  POST /analyze   — validate request → run engine.analyze_session()
                    → append full forensics record to HISTORY
  GET  /forensics — return HISTORY (newest first); polled by React every 3 s
  GET  /health    — liveness probe
  DELETE /forensics — clear history (demo resets)

engine.py is the real analysis brain:
  • Z-axis σ via population std-dev       (weight 0.50 of stress score)
  • FFT dominant frequency (numpy)        (weight 0.30, flags >8 Hz)
  • AC-RMS amplitude (mean-centred)       (weight 0.20)
  • Risk classification with flag escalation (Low / Medium / High)
"""

from __future__ import annotations

import math
import time
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

# ── engine.py must be in the same directory ───────────────────────────────────
from engine import (
    JitterSample,
    SteadyHandProfile,
    AnalysisResult,
    analyze_session,
    compare_to_baseline,
)


# ─────────────────────────────────────────────────────────────────────────────
# Global session history
# ─────────────────────────────────────────────────────────────────────────────

HISTORY: List[Dict[str, Any]] = []   # appended by /analyze, read by /forensics


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

class SampleIn(BaseModel):
    """One raw {t, x, y, z} kinetic sample."""
    t: float = Field(..., ge=0,   description="Seconds from session start")
    x: float = Field(...,         description="Lateral displacement (mm or g)")
    y: float = Field(...,         description="Vertical displacement (mm or g)")
    z: float = Field(...,         description="Axial depth / tremor axis (mm or g)")

    @field_validator("t")
    @classmethod
    def t_non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("t must be ≥ 0")
        return v


class BaselineOverrideIn(BaseModel):
    mean_z_std:    Optional[float] = Field(None, gt=0)
    max_freq_hz:   Optional[float] = Field(None, gt=0)
    rms_threshold: Optional[float] = Field(None, gt=0)


class AnalyzeRequest(BaseModel):
    """
    POST /analyze request body.

    {
      "session_id": "Session_99",
      "samples": [{"t":0.00,"x":0.45,"y":-0.30,"z":0.85}, ...],
      "baseline_override": null
    }
    """
    session_id:        str                          = Field(
        default_factory=lambda: f"Session_{uuid.uuid4().hex[:6].upper()}",
        min_length=1, max_length=128,
    )
    samples:           List[SampleIn]               = Field(..., min_length=3)
    baseline_override: Optional[BaselineOverrideIn] = None

    @model_validator(mode="after")
    def samples_ordered(self) -> "AnalyzeRequest":
        ts = [s.t for s in self.samples]
        if ts != sorted(ts):
            raise ValueError("samples must be in ascending t order")
        return self


class AnalyzeResponse(BaseModel):
    session_id:     str
    stress_score:   float = Field(..., ge=0.0, le=1.0)
    risk_level:     Literal["Low", "Medium", "High"]
    recommendation: str
    diagnostics:    dict


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _risk_label(risk_level: str, stress_score: float) -> str:
    pct = stress_score * 100
    if risk_level == "High":
        return "CRITICAL" if pct >= 85 else "HIGH"
    if risk_level == "Medium":
        return "MEDIUM"
    return "LOW" if pct >= 10 else "CLEAR"


def _flag(result: AnalysisResult) -> str:
    for f in result.anomaly_flags:
        if "HIGH_FREQUENCY" in f:
            return f"High Freq {result.dominant_freq_hz:.1f} Hz"
        if "VARIANCE_SPIKE" in f:
            return "Variance Spike"
        if "RMS_AMPLITUDE" in f:
            return "RMS Excess"
    if result.risk_level == "High":   return "Erratic Jitter"
    if result.risk_level == "Medium": return "Pressure Variance"
    return "Baseline Match"


def _build_history_entry(
    result:   AnalysisResult,
    samples:  List[JitterSample],
    profile:  SteadyHandProfile,
    raw_body: List[SampleIn],
) -> Dict[str, Any]:
    """
    Build the full forensics record appended to HISTORY and returned by /forensics.
    The React dashboard reads:
      session_id, stress_score, risk_level, recommendation  — core fields
      diagnostics.risk_label, diagnostics.flag              — sidebar badge + text
      diagnostics.dominant_freq_hz, .z_std_dev, etc.        — diagnostics card
      samples[i].x, samples[i].y                            — SVG dot positions
      received_at                                            — sidebar timestamp
    """
    baseline_cmp = compare_to_baseline(samples, profile)

    diagnostics = {
        "risk_label":          _risk_label(result.risk_level, result.stress_score),
        "flag":                _flag(result),
        "dominant_freq_hz":    result.dominant_freq_hz,
        "z_std_dev":           result.z_std_dev,
        "rms_amplitude":       result.rms_amplitude,
        "baseline_delta":      result.baseline_delta,
        "sample_count":        len(samples),
        "anomaly_flags":       result.anomaly_flags,
        "baseline_comparison": baseline_cmp,
    }

    return {
        "session_id":     result.session_id,
        "stress_score":   result.stress_score,          # 0.0–1.0 → React × 100 = risk %
        "risk_level":     result.risk_level,
        "recommendation": result.recommendation,
        "diagnostics":    diagnostics,
        # Raw samples preserved: React reads .x and .y to plot SVG dots
        "samples": [{"t": s.t, "x": s.x, "y": s.y, "z": s.z} for s in raw_body],
        "received_at": _iso_now(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Seed data — pre-populate HISTORY so dashboard is not blank on startup
# ─────────────────────────────────────────────────────────────────────────────

def _seed_history() -> None:
    """
    Generate 6 representative demo sessions covering the full risk spectrum.
    Called once at startup so the dashboard shows data immediately without
    needing a POST /analyze first.
    Each session uses a real sine-wave signal processed by engine.analyze_session()
    — exactly the same path as a live request.
    """
    profile = SteadyHandProfile()

    def _sine(freq_hz: float, amp: float, n: int = 60, fs: float = 120.0) -> List[SampleIn]:
        dt = 1.0 / fs
        return [
            SampleIn(
                t=round(i * dt, 4),
                x=round(0.5 + amp * math.sin(2 * math.pi * 0.8 * i * dt + 0.3), 4),
                y=round(0.2 + (i / n) * 0.6, 4),
                z=round(amp * math.sin(2 * math.pi * freq_hz * i * dt), 5),
            )
            for i in range(n)
        ]

    seeds = [
        # (session_id,    freq_hz, amplitude)   — higher freq/amp → higher risk
        ("Session_99",   9.5,  0.45),   # CRITICAL — severe tremor, >8 Hz
        ("Session_74",   7.2,  0.32),   # HIGH     — elevated
        ("Session_61",   5.8,  0.20),   # MEDIUM-HIGH
        ("Session_48",   3.8,  0.12),   # MEDIUM
        ("Session_33",   2.1,  0.06),   # LOW
        ("Session_17",   0.5,  0.005),  # CLEAR    — barely any movement
    ]

    for sid, freq, amp in seeds:
        raw = _sine(freq, amp)
        engine_samples = [JitterSample(t=s.t, x=s.x, y=s.y, z=s.z) for s in raw]
        result = analyze_session(sid, engine_samples, profile)
        entry  = _build_history_entry(result, engine_samples, profile, raw)
        # Override received_at with realistic-looking demo timestamps
        base_min = 9 + seeds.index((sid, freq, amp)) * 3
        entry["received_at"] = f"2024-01-15T14:{base_min:02d}:00Z"
        HISTORY.append(entry)

    # Reverse so newest (Session_17 was last appended) shows at top
    HISTORY.reverse()


# Populate on import (before the first request)
_seed_history()


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────────────────────

_START_TIME = time.time()

app = FastAPI(
    title="KineticTrust Analysis Engine",
    description=(
        "Tremor / jitter fraud detection. "
        "POST /analyze to submit a session; GET /forensics for the live feed."
    ),
    version="3.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS — allows Member 3's React dashboard at localhost:5173 ────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server  ← primary
        "http://127.0.0.1:5173",
        "http://localhost:3000",   # CRA fallback
        "http://localhost:4173",   # Vite preview
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _global_err(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "Analysis error", "detail": str(exc), "id": str(uuid.uuid4())},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["Ops"])
async def health():
    """Liveness probe."""
    return {
        "status":         "ok",
        "version":        "3.0.0",
        "uptime_seconds": round(time.time() - _START_TIME, 1),
        "history_count":  len(HISTORY),
    }


@app.get(
    "/forensics",
    tags=["History"],
    summary="Return full session history (polled by React every 3 s)",
)
async def get_forensics():
    """
    GET /forensics
    Newest sessions first. Each record shape:
    {
      session_id, stress_score (0-1), risk_level, recommendation,
      diagnostics: { risk_label, flag, dominant_freq_hz, z_std_dev,
                     rms_amplitude, sample_count, anomaly_flags },
      samples: [{ t, x, y, z }],   ← React reads x/y for SVG dots
      received_at: ISO-8601
    }
    """
    return list(reversed(HISTORY))


@app.post("/analyze", response_model=AnalyzeResponse, tags=["Analysis"])
async def analyze(body: AnalyzeRequest) -> AnalyzeResponse:
    """
    POST /analyze — run the full engine pipeline and store the result.

    Pipeline (via engine.py)
    ------------------------
    1. Z-axis population σ           → stress component A (weight 0.50)
    2. FFT dominant frequency (numpy) → stress component B (weight 0.30)
                                        anomaly flag if > 8 Hz
    3. AC-RMS amplitude               → stress component C (weight 0.20)
    4. Weighted sum → stress_score 0.0–1.0
    5. Risk classification (Low/Medium/High); clinical flags can escalate
    6. Append to HISTORY with raw samples preserved for dashboard plotting
    """
    # Build profile
    defaults = SteadyHandProfile()
    if body.baseline_override:
        ov = body.baseline_override
        profile = SteadyHandProfile(
            mean_z_std    = ov.mean_z_std    or defaults.mean_z_std,
            max_freq_hz   = ov.max_freq_hz   or defaults.max_freq_hz,
            rms_threshold = ov.rms_threshold or defaults.rms_threshold,
        )
    else:
        profile = defaults

    # Convert request samples → engine dataclass
    engine_samples = [JitterSample(t=s.t, x=s.x, y=s.y, z=s.z) for s in body.samples]

    # Run the real analysis engine
    result: AnalysisResult = analyze_session(
        session_id=body.session_id,
        samples=engine_samples,
        profile=profile,
    )

    # Build and store the forensics record
    entry = _build_history_entry(result, engine_samples, profile, body.samples)
    HISTORY.append(entry)

    return AnalyzeResponse(
        session_id=result.session_id,
        stress_score=result.stress_score,
        risk_level=result.risk_level,
        recommendation=result.recommendation,
        diagnostics=entry["diagnostics"],
    )


@app.delete("/forensics", tags=["History"])
async def clear_forensics():
    """Clear history and re-seed demo data."""
    HISTORY.clear()
    _seed_history()
    return {"cleared": True, "reseeded": True, "history_count": len(HISTORY)}