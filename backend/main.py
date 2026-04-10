"""
KineticTrust — main.py  (v4.3 — Kinetic Overrule + Tiered Friction)
================================================================
New in v4.3:
  POST /chat/verify-stress  — Kinetic Overrule endpoint
      Frontend sends a fresh stress_score after user clicks "Yes I'm safe"
      Backend compares against original score and overrules if still critical

  POST /chat  — now returns tier: "block" | "cooling_off" | "allow" | "continue"
      cooling_off = low-value or known payee → 60s timer instead of hard block

  Forensic logging now includes:
      chat_log[]         — every message with role + timestamp
      kinetic_samples[]  — tremor readings taken DURING the chat
      chat_verdict       — final outcome
      overruled          — True if user said Yes but kinetic overruled
"""

from __future__ import annotations

import math
import random
import time
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from engine import (
    JitterSample,
    SteadyHandProfile,
    AnalysisResult,
    analyze_session,
    compare_to_baseline,
)


# ─────────────────────────────────────────────────────────────────────────────
# Global state
# ─────────────────────────────────────────────────────────────────────────────

HISTORY: List[Dict[str, Any]] = []
CHAT_SESSIONS: Dict[str, Dict] = {}


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

class SampleIn(BaseModel):
    t: float = Field(..., ge=0)
    x: float
    y: float
    z: float

    @field_validator("t")
    @classmethod
    def t_non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("t must be >= 0")
        return v


class BaselineOverrideIn(BaseModel):
    mean_z_std:    Optional[float] = Field(None, gt=0)
    max_freq_hz:   Optional[float] = Field(None, gt=0)
    rms_threshold: Optional[float] = Field(None, gt=0)


class AnalyzeRequest(BaseModel):
    session_id:        str = Field(
        default_factory=lambda: f"Session_{uuid.uuid4().hex[:6].upper()}",
        min_length=1, max_length=128,
    )
    samples:           List[SampleIn] = Field(..., min_length=3)
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


class ChatOpenerRequest(BaseModel):
    session_id:   str
    stress_score: float = Field(..., ge=0.0, le=1.0)
    amount_inr:   float = Field(default=0.0, ge=0)
    is_new_payee: bool  = False
    payee_name:   str   = "this recipient"


class ChatRequest(BaseModel):
    session_id:   str
    user_message: str
    stress_score: float  = Field(..., ge=0.0, le=1.0)
    amount_inr:   float  = Field(default=0.0)
    is_new_payee: bool   = False
    # Live kinetic sample sent alongside the message (forensic evidence)
    live_z_std:   Optional[float] = None


class ChatResponse(BaseModel):
    session_id:  str
    reply:       str
    verdict:     Literal["continue", "allow", "block", "cooling_off"]
    tier:        str    # human-readable reason
    turn:        int
    context:     dict


class KineticVerifyRequest(BaseModel):
    """
    POST /chat/verify-stress
    Frontend sends a fresh stress sample AFTER user clicks 'Yes I'm safe'.
    Backend compares with original_stress to detect coerced compliance.
    """
    session_id:      str
    current_stress:  float = Field(..., ge=0.0, le=1.0)
    original_stress: float = Field(..., ge=0.0, le=1.0)
    amount_inr:      float = Field(default=0.0)
    is_new_payee:    bool  = False


class KineticVerifyResponse(BaseModel):
    session_id:  str
    overruled:   bool
    reason:      str
    verdict:     Literal["allow", "block", "cooling_off"]
    delta_stress: float   # how much stress changed after "Yes"


class ReceiverCheckRequest(BaseModel):
    session_id:       str
    receiver_account: str
    sender_account:   str
    amount_inr:       float


class ReceiverCheckResponse(BaseModel):
    session_id:       str
    risk_level:       Literal["SAFE", "SUSPICIOUS", "DANGEROUS"]
    flags:            List[str]
    account_age_days: int
    small_test_txn:   bool
    recommendation:   str
    confidence:       float


# ─────────────────────────────────────────────────────────────────────────────
# Agent 1 helpers
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


def _build_history_entry(result, samples, profile, raw_body):
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
        "session_id":       result.session_id,
        "stress_score":     result.stress_score,
        "risk_level":       result.risk_level,
        "recommendation":   result.recommendation,
        "diagnostics":      diagnostics,
        "samples":          [{"t": s.t, "x": s.x, "y": s.y, "z": s.z} for s in raw_body],
        "received_at":      _iso_now(),
        # Agent 2 forensic fields
        "chat_log":         [],
        "chat_verdict":     None,
        "overruled":        False,
        "kinetic_samples":  [],   # live tremor readings taken DURING chat
    }


def _append_chat(session_id: str, role: str, text: str, extra: dict = None):
    for entry in HISTORY:
        if entry["session_id"] == session_id:
            if "chat_log" not in entry:
                entry["chat_log"] = []
            rec = {"role": role, "text": text, "ts": _iso_now()}
            if extra:
                rec.update(extra)
            entry["chat_log"].append(rec)
            break


def _append_kinetic(session_id: str, stress: float, z_std: float):
    """Log a live tremor reading taken during the chat session."""
    for entry in HISTORY:
        if entry["session_id"] == session_id:
            if "kinetic_samples" not in entry:
                entry["kinetic_samples"] = []
            entry["kinetic_samples"].append({
                "ts":     _iso_now(),
                "stress": round(stress, 4),
                "z_std":  round(z_std, 4),
            })
            break


def _set_verdict(session_id: str, verdict: str, overruled: bool = False):
    for entry in HISTORY:
        if entry["session_id"] == session_id:
            entry["chat_verdict"] = verdict
            if overruled:
                entry["overruled"] = True
            break


# ─────────────────────────────────────────────────────────────────────────────
# Agent 2 — Kinetic Overrule + Tiered Friction
# ─────────────────────────────────────────────────────────────────────────────

# Thresholds
OVERRULE_THRESHOLD   = 0.75   # if stress stays above this after "Yes" → overrule
COOLING_OFF_MAX_AMT  = 5000   # amounts below this use cooling-off instead of hard block
COOLING_OFF_SECS     = 60

IMMEDIATE_BLOCK_PHRASES = [
    "forced", "forcing", "gunpoint", "threatened", "threat",
    "blackmail", "they will hurt", "kidnap", "hostage",
    "help me", "someone is here", "they are watching",
    "don't want to", "making me",
]

RED_FLAG_PHRASES = [
    "no i didn't", "not really", "someone told", "they told me",
    "he told", "she told", "was told", "instructed me",
    "on the phone", "they called", "someone called",
    "don't know them", "never met", "met online",
    "not to tell", "keep it secret", "don't tell anyone",
    "they said urgent", "must send now", "account will be closed",
    "police will come", "you will be arrested",
]

GREEN_FLAG_PHRASES = [
    "yes i am", "yes myself", "i decided", "my own choice",
    "i know them", "my friend", "my family", "my relative",
    "i work with", "i chose", "nobody told", "no one told",
    "i contacted", "i called them", "i want to",
]

PSYCH_QUESTIONS_NEW_PAYEE = [
    "Do you personally know {payee} — have you met them or worked with them before?",
    "How did you first contact {payee}? Was it through a call they made to you, or did you reach out first?",
    "Has {payee} or anyone else asked you to keep this transfer private from your family?",
    "Did {payee} tell you the exact amount to send, or did you decide that yourself?",
]

PSYCH_QUESTIONS_HIGH_AMOUNT = [
    "Is someone on a phone call with you right now while you are making this transfer?",
    "Have you verified the recipient's identity through their official website or number — not a number they gave you?",
    "Has anyone warned you that your account is in danger and you need to move money urgently?",
    "Did you decide to send this amount today, or did someone tell you to send this specific amount?",
]

PSYCH_QUESTIONS_GENERAL = [
    "Is someone physically with you right now, or on a call, guiding you through this?",
    "Have you made a similar transfer to this recipient before?",
    "Has anyone told you not to discuss this transfer with your family or your bank?",
    "Are you doing this because someone contacted you first — by call, message, or email?",
]


def _build_opener(stress_score: float, amount_inr: float, is_new_payee: bool, payee_name: str) -> str:
    triggers = []
    if stress_score >= 0.85:
        triggers.append("significant hand tremor on your device")
    elif stress_score >= 0.6:
        triggers.append("unusual movement patterns on your device")

    if is_new_payee and amount_inr > 0:
        triggers.append(
            f"you are sending Rs.{amount_inr:,.0f} to {payee_name}, "
            f"a new recipient you have not transacted with before"
        )
    elif is_new_payee:
        triggers.append(f"{payee_name} is a new recipient in your account")
    elif amount_inr >= 10000:
        triggers.append(f"this is a large transfer of Rs.{amount_inr:,.0f}")

    trigger_text = " and ".join(triggers) if triggers else "unusual activity"
    return (
        f"Hi, I'm KineticTrust's safety assistant. We paused this transaction because "
        f"we noticed {trigger_text}. "
        f"I just want to make sure you're okay and this is what you want to do. "
        f"Are you initiating this transfer yourself, without pressure from anyone?"
    )


def _check_flags(msg: str) -> str:
    msg_l = msg.lower()
    if any(p in msg_l for p in IMMEDIATE_BLOCK_PHRASES):
        return "immediate_block"
    red   = sum(1 for p in RED_FLAG_PHRASES   if p in msg_l)
    green = sum(1 for p in GREEN_FLAG_PHRASES if p in msg_l)
    if red > green:
        return "red"
    if green > 0:
        return "green"
    first = msg_l.strip().split()[0] if msg_l.strip() else ""
    if first in ("no", "nope", "nah", "never"):
        return "red"
    if first in ("yes", "yeah", "yep", "sure", "absolutely", "correct"):
        return "green"
    return "neutral"


def _get_next_question(turn: int, is_new_payee: bool, amount_inr: float, payee_name: str) -> str:
    if is_new_payee:
        pool = PSYCH_QUESTIONS_NEW_PAYEE
    elif amount_inr >= 10000:
        pool = PSYCH_QUESTIONS_HIGH_AMOUNT
    else:
        pool = PSYCH_QUESTIONS_GENERAL
    idx = (turn - 1) % len(pool)
    return pool[idx].replace("{payee}", payee_name)


def _determine_tier(
    verdict: str,
    amount_inr: float,
    is_new_payee: bool,
    stress_score: float,
) -> tuple[Literal["continue", "allow", "block", "cooling_off"], str]:
    """
    Converts a raw block verdict into tiered friction when appropriate.
    Low-value + known payee = cooling-off period instead of hard block.
    High-value + new payee = hard block.
    """
    if verdict == "allow":
        return "allow", "Verified by user responses"
    if verdict == "continue":
        return "continue", "Gathering more information"

    # Cooling-off: low value OR known payee (but NOT both red flags together)
    if amount_inr < COOLING_OFF_MAX_AMT and not is_new_payee:
        return "cooling_off", f"{COOLING_OFF_SECS}s cooling-off period — low value, known payee"

    return "block", "High-risk transaction blocked — new payee or large amount"


def _run_agent2(
    user_msg: str,
    state: dict,
    stress_score: float,
    amount_inr: float,
    is_new_payee: bool,
    payee_name: str,
) -> tuple[str, str, str]:
    """Returns (reply, raw_verdict, tier_reason)"""

    flag  = _check_flags(user_msg)
    turn  = state["turn"]
    red   = state["red_count"]
    green = state["green_count"]

    # Immediate block — safety exit trigger words
    if flag == "immediate_block":
        state["red_count"] += 2
        return (
            "I am very concerned about your safety right now. "
            "This transaction has been blocked immediately. "
            "Please hang up any call you are on, move to a safe place, "
            "and press the 'Call Bank Security' button below or dial 112 for help. "
            "You are not alone.",
            "block",
            "Safety exit — duress language detected",
        )

    if flag == "red":
        red += 1
        state["red_count"] = red
    if flag == "green":
        green += 1
        state["green_count"] = green

    state["turn"] = turn + 1

    # 2+ red flags → block
    if red >= 2:
        return (
            "Based on what you have shared, this transaction cannot proceed. "
            "It appears you may be under pressure or dealing with a scam. "
            "This transfer has been blocked for your protection. "
            "Please contact your bank on their official number — not a number given to you by anyone.",
            "block",
            "Multiple red-flag responses detected",
        )

    # High stress + 1 red → block
    if stress_score >= 0.85 and red >= 1:
        return (
            "I have noticed physical distress signals on your device along with some concerning responses. "
            "For your safety, I have blocked this transaction. "
            "Please call your bank's official helpline to proceed if everything is genuinely okay.",
            "block",
            "Physiological + verbal red flags combined",
        )

    # Allow: 3+ green flags or all 4 questions with no reds
    if green >= 3 or (turn >= 4 and red == 0):
        amt_str = f"Rs.{amount_inr:,.0f} " if amount_inr > 0 else ""
        return (
            f"Thank you for confirming everything. Your transaction has been verified — "
            f"{amt_str}will be sent now. Stay safe!",
            "allow",
            "User confirmed safe",
        )

    # Continue — next psychological question
    if flag == "red":
        prefix = "I appreciate your honesty. I want to make sure you are protected. "
    elif flag == "green":
        prefix = "Good, thank you for confirming. "
    else:
        prefix = "Understood. "

    next_q = _get_next_question(turn + 1, is_new_payee, amount_inr, payee_name)
    return (prefix + next_q, "continue", "")


def _get_or_create_chat(session_id: str) -> Dict:
    if session_id not in CHAT_SESSIONS:
        CHAT_SESSIONS[session_id] = {
            "turn": 0, "red_count": 0, "green_count": 0,
            "verdict": "continue", "context": {},
            "original_stress": 0.0,
        }
    return CHAT_SESSIONS[session_id]


# ─────────────────────────────────────────────────────────────────────────────
# Agent 3 — Per-session Receiver Intelligence
# ─────────────────────────────────────────────────────────────────────────────

SESSION_RECEIVER_PROFILES = {
    "Session_99": {
        "account_age_days": 3, "small_test_txn": True,
        "flags": [
            "Account flagged in national fraud registry",
            "Receiver linked to 4 other fraud reports this month",
            "Account created only 3 days ago",
            "Rs.1 test transfer detected from sender 2 days ago",
        ],
        "risk_level": "DANGEROUS", "confidence": 0.97,
    },
    "Session_74": {
        "account_age_days": 18, "small_test_txn": True,
        "flags": [
            "New account — only 18 days old",
            "Rs.1 test transfer pattern detected from this sender",
            "No prior transaction history found",
        ],
        "risk_level": "DANGEROUS", "confidence": 0.88,
    },
    "Session_61": {
        "account_age_days": 62, "small_test_txn": False,
        "flags": [
            "Recent account — 62 days old",
            "Large transfer to a relatively new account",
            "Receiver not in sender's known contacts",
        ],
        "risk_level": "SUSPICIOUS", "confidence": 0.72,
    },
    "Session_48": {
        "account_age_days": 210, "small_test_txn": False,
        "flags": ["Receiver not in sender's known contacts", "First-time transfer to this account"],
        "risk_level": "SUSPICIOUS", "confidence": 0.58,
    },
    "Session_33": {
        "account_age_days": 480, "small_test_txn": False,
        "flags": ["No suspicious indicators found"],
        "risk_level": "SAFE", "confidence": 0.91,
    },
    "Session_17": {
        "account_age_days": 1200, "small_test_txn": False,
        "flags": ["Known contact — previous transactions found", "Account in good standing for 3+ years"],
        "risk_level": "SAFE", "confidence": 0.98,
    },
}

RISK_RECOMMENDATIONS = {
    "DANGEROUS": "BLOCK TRANSACTION — Multiple high-risk indicators. This account matches known fraud patterns.",
    "SUSPICIOUS": "CAUTION — Receiver profile shows suspicious characteristics. Require additional confirmation.",
    "SAFE": "Receiver profile appears legitimate. Transaction may proceed normally.",
}


def _simulate_receiver_check(session_id, receiver, sender, amount):
    p = SESSION_RECEIVER_PROFILES.get(session_id)
    if p:
        flags = list(p["flags"])
        if p["risk_level"] == "DANGEROUS" and amount >= 10000:
            flags.append(f"Large transfer (Rs.{amount:,.0f}) to a flagged account")
        return ReceiverCheckResponse(
            session_id=session_id, risk_level=p["risk_level"],
            flags=flags, account_age_days=p["account_age_days"],
            small_test_txn=p["small_test_txn"],
            recommendation=RISK_RECOMMENDATIONS[p["risk_level"]],
            confidence=p["confidence"],
        )
    rng = random.Random(hash(receiver + session_id) % 99999)
    age  = rng.randint(10, 900)
    small = rng.random() < 0.3
    flags, risk_score = [], 0.0
    if age < 30:
        flags.append(f"New account — {age} days old"); risk_score += 0.4
    if small:
        flags.append("Rs.1 test transfer pattern detected"); risk_score += 0.3
    if not flags:
        flags.append("No suspicious indicators found")
    level = "DANGEROUS" if risk_score >= 0.6 else "SUSPICIOUS" if risk_score >= 0.3 else "SAFE"
    return ReceiverCheckResponse(
        session_id=session_id, risk_level=level, flags=flags,
        account_age_days=age, small_test_txn=small,
        recommendation=RISK_RECOMMENDATIONS[level],
        confidence=round(min(0.6 + risk_score * 0.4, 0.99), 2),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Seed history
# ─────────────────────────────────────────────────────────────────────────────

def _seed_history() -> None:
    profile = SteadyHandProfile()

    def _sine(freq_hz, amp, n=60, fs=120.0):
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
        ("Session_99", 9.5, 0.45, 25000, True),
        ("Session_74", 7.2, 0.32, 15000, True),
        ("Session_61", 5.8, 0.20, 8000,  True),
        ("Session_48", 3.8, 0.12, 3000,  False),
        ("Session_33", 2.1, 0.06, 500,   False),
        ("Session_17", 0.5, 0.005, 200,  False),
    ]

    for idx, (sid, freq, amp, amount, is_new) in enumerate(seeds):
        raw = _sine(freq, amp)
        engine_samples = [JitterSample(t=s.t, x=s.x, y=s.y, z=s.z) for s in raw]
        result = analyze_session(sid, engine_samples, profile)
        entry  = _build_history_entry(result, engine_samples, profile, raw)
        entry["received_at"] = f"2024-01-15T14:{9 + idx * 3:02d}:00Z"
        entry["diagnostics"]["amount_inr"]   = amount
        entry["diagnostics"]["is_new_payee"] = is_new
        HISTORY.append(entry)

    HISTORY.reverse()


_seed_history()


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────────────────────

_START_TIME = time.time()

app = FastAPI(title="KineticTrust — 4-Agent Fraud Intelligence", version="4.3.0", docs_url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _global_err(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": str(exc), "id": str(uuid.uuid4())})


@app.get("/health")
async def health():
    return {"status": "ok", "version": "4.3.0",
            "uptime_seconds": round(time.time() - _START_TIME, 1),
            "history_count": len(HISTORY)}


@app.get("/forensics")
async def get_forensics():
    return list(reversed(HISTORY))


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(body: AnalyzeRequest) -> AnalyzeResponse:
    defaults = SteadyHandProfile()
    profile  = defaults
    if body.baseline_override:
        ov = body.baseline_override
        profile = SteadyHandProfile(
            mean_z_std=ov.mean_z_std or defaults.mean_z_std,
            max_freq_hz=ov.max_freq_hz or defaults.max_freq_hz,
            rms_threshold=ov.rms_threshold or defaults.rms_threshold,
        )
    engine_samples = [JitterSample(t=s.t, x=s.x, y=s.y, z=s.z) for s in body.samples]
    result = analyze_session(body.session_id, engine_samples, profile)
    entry  = _build_history_entry(result, engine_samples, profile, body.samples)
    HISTORY.append(entry)
    return AnalyzeResponse(
        session_id=result.session_id, stress_score=result.stress_score,
        risk_level=result.risk_level, recommendation=result.recommendation,
        diagnostics=entry["diagnostics"],
    )


@app.delete("/forensics")
async def clear_forensics():
    HISTORY.clear()
    CHAT_SESSIONS.clear()
    _seed_history()
    return {"cleared": True, "reseeded": True, "history_count": len(HISTORY)}


# ── Agent 2 ───────────────────────────────────────────────────────────────────

@app.post("/chat/opener")
async def chat_opener(body: ChatOpenerRequest):
    CHAT_SESSIONS.pop(body.session_id, None)
    state = _get_or_create_chat(body.session_id)
    state["turn"] = 1
    state["original_stress"] = body.stress_score
    state["context"] = {
        "stress_score": body.stress_score,
        "amount_inr":   body.amount_inr,
        "is_new_payee": body.is_new_payee,
        "payee_name":   body.payee_name,
    }
    opener = _build_opener(body.stress_score, body.amount_inr, body.is_new_payee, body.payee_name)
    _append_chat(body.session_id, "agent", opener, {"stress_at_message": body.stress_score})
    return {
        "session_id": body.session_id,
        "reply":      opener,
        "verdict":    "continue",
        "tier":       "initial",
        "turn":       0,
        "context": {
            "stress_pct":   round(body.stress_score * 100),
            "amount_inr":   body.amount_inr,
            "is_new_payee": body.is_new_payee,
        },
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest) -> ChatResponse:
    state   = _get_or_create_chat(body.session_id)
    ctx     = state.get("context", {})
    amount  = body.amount_inr   or ctx.get("amount_inr", 0)
    new_pay = body.is_new_payee or ctx.get("is_new_payee", False)
    payee   = ctx.get("payee_name", "this recipient")

    # Log live kinetic sample if provided
    if body.live_z_std is not None:
        _append_kinetic(body.session_id, body.stress_score, body.live_z_std)

    # Log user message with stress reading at the time
    _append_chat(body.session_id, "user", body.user_message,
                 {"stress_at_message": body.stress_score,
                  "z_std_at_message":  body.live_z_std})

    reply, raw_verdict, tier_reason = _run_agent2(
        user_msg=body.user_message, state=state,
        stress_score=body.stress_score, amount_inr=amount,
        is_new_payee=new_pay, payee_name=payee,
    )

    # Apply tiered friction
    final_verdict, tier_reason_final = _determine_tier(
        raw_verdict, amount, new_pay, body.stress_score
    )
    if tier_reason:
        tier_reason_final = tier_reason

    _append_chat(body.session_id, "agent", reply,
                 {"stress_at_message": body.stress_score, "verdict": final_verdict})

    if final_verdict not in ("continue", "cooling_off"):
        _set_verdict(body.session_id, final_verdict)
    elif final_verdict == "cooling_off":
        _set_verdict(body.session_id, "cooling_off")

    state["verdict"] = final_verdict
    CHAT_SESSIONS[body.session_id] = state

    return ChatResponse(
        session_id=body.session_id,
        reply=reply,
        verdict=final_verdict,
        tier=tier_reason_final,
        turn=state["turn"],
        context={
            "stress_pct":   round(body.stress_score * 100),
            "amount_inr":   amount,
            "is_new_payee": new_pay,
            "red_count":    state["red_count"],
            "green_count":  state["green_count"],
        },
    )


@app.post("/chat/verify-stress", response_model=KineticVerifyResponse)
async def verify_stress(body: KineticVerifyRequest) -> KineticVerifyResponse:
    """
    Kinetic Overrule endpoint.
    Called by the frontend AFTER the user clicks 'Yes I'm safe'.
    Compares current stress with the stress at chat open.
    If still critical → overrule the Yes and block.
    """
    state   = CHAT_SESSIONS.get(body.session_id, {})
    ctx     = state.get("context", {})
    amount  = body.amount_inr or ctx.get("amount_inr", 0)
    new_pay = body.is_new_payee or ctx.get("is_new_payee", False)

    delta = body.current_stress - body.original_stress

    # Log this kinetic verification to forensics
    _append_kinetic(body.session_id, body.current_stress, 0)
    _append_chat(
        body.session_id, "system",
        f"[KINETIC VERIFY] current={body.current_stress:.2f} original={body.original_stress:.2f} delta={delta:+.2f}",
        {"current_stress": body.current_stress, "delta": delta},
    )

    # Overrule conditions:
    # 1. Current stress is still above overrule threshold (not dropping after "Yes")
    # 2. Stress has actually INCREASED after "Yes" (classic coerced compliance pattern)
    still_critical = body.current_stress >= OVERRULE_THRESHOLD
    stress_rose    = delta > 0.05   # stress increased after claiming to be safe

    if still_critical or stress_rose:
        reason = (
            "Stress overrule: hand tremor increased after 'Yes' — coerced compliance detected."
            if stress_rose else
            f"Stress overrule: tremor remains at {round(body.current_stress*100)}% — duress suspected."
        )
        _set_verdict(body.session_id, "block", overruled=True)
        _append_chat(body.session_id, "system",
                     f"[OVERRULE] Transaction blocked — {reason}")

        # Apply tiered friction for low-value/known payee even on overrule
        if amount < COOLING_OFF_MAX_AMT and not new_pay:
            verdict = "cooling_off"
        else:
            verdict = "block"

        return KineticVerifyResponse(
            session_id=body.session_id,
            overruled=True,
            reason=reason,
            verdict=verdict,
            delta_stress=round(delta, 3),
        )

    # Stress dropped sufficiently → trust the "Yes"
    _set_verdict(body.session_id, "allow")
    return KineticVerifyResponse(
        session_id=body.session_id,
        overruled=False,
        reason=f"Stress dropped to {round(body.current_stress*100)}% — user response accepted.",
        verdict="allow",
        delta_stress=round(delta, 3),
    )


# ── Agent 3 ───────────────────────────────────────────────────────────────────

@app.post("/check-receiver", response_model=ReceiverCheckResponse)
async def check_receiver(body: ReceiverCheckRequest) -> ReceiverCheckResponse:
    return _simulate_receiver_check(
        session_id=body.session_id, receiver=body.receiver_account,
        sender=body.sender_account, amount=body.amount_inr,
    )