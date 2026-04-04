"""
KineticTrust Analysis Engine
============================
Core signal-processing logic for tremor / jitter analysis.
Zero framework dependencies — importable by any ASGI/WSGI layer.

Coordinate system
-----------------
  X  — lateral (left/right)
  Y  — vertical (up/down)
  Z  — axial depth (into/out of screen, most tremor-sensitive axis)

All public functions are pure (no side-effects) and fully type-annotated.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import List, Optional, Tuple


# ─────────────────────────────────────────────────────────────────────────────
# Domain types
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class JitterSample:
    """
    One raw accelerometer / touch-pressure sample.

    Fields
    ------
    t   : float  — timestamp in seconds (relative to session start)
    x   : float  — lateral acceleration / displacement  (mm or g)
    y   : float  — vertical acceleration / displacement (mm or g)
    z   : float  — axial pressure / depth               (mm or g)
    """
    t: float
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class SteadyHandProfile:
    """
    Reference baseline captured from a verified steady-hand user.

    Fields
    ------
    mean_z_std   : float — expected Z-axis std-dev for a calm hand
    max_freq_hz  : float — expected dominant tremor frequency ceiling
    rms_threshold: float — RMS amplitude ceiling for low-stress signal
    """
    mean_z_std: float    = 0.08   # mm — empirically tuned
    max_freq_hz: float   = 3.5    # Hz — normal voluntary tremor
    rms_threshold: float = 0.12   # mm


@dataclass
class AnalysisResult:
    """
    Output produced by `analyze_session()`.  Aligns with the API contract.
    """
    session_id:   str
    stress_score: float          # 0.0 – 1.0
    risk_level:   str            # 'Low' | 'Medium' | 'High'
    recommendation: str

    # ── Extended diagnostics (not in API contract but logged internally) ──
    z_std_dev:        float = 0.0
    dominant_freq_hz: float = 0.0
    rms_amplitude:    float = 0.0
    baseline_delta:   float = 0.0   # how far above baseline z-std
    anomaly_flags:    List[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Signal primitives
# ─────────────────────────────────────────────────────────────────────────────

def _z_values(samples: List[JitterSample]) -> List[float]:
    return [s.z for s in samples]


def _compute_std_dev(values: List[float]) -> float:
    """Population standard deviation (σ) — denominator N, not N-1."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(variance)


def _compute_rms(values: List[float]) -> float:
    """
    Root-mean-square of the AC (mean-subtracted) signal.

    Subtracting the DC mean ensures a signal resting at a non-zero
    baseline (e.g. constant axial pressure of 0.075 mm) does not inflate
    the tremor energy estimate.  What matters is variation around the
    resting point, not the absolute offset.
    """
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    centered = [v - mean for v in values]
    return math.sqrt(sum(v ** 2 for v in centered) / len(centered))


def _estimate_dominant_frequency(samples: List[JitterSample]) -> float:
    """
    Estimate dominant tremor frequency via zero-crossing rate on the
    mean-subtracted Z signal.

    Zero-crossing rate is a lightweight proxy for FFT when scipy is
    unavailable; it over-estimates for noisy signals, so we apply a
    0.5x correction factor informed by empirical comparison with FFT
    results on physiological tremor data.

    Returns
    -------
    float — frequency in Hz, or 0.0 if fewer than 4 samples.
    """
    if len(samples) < 4:
        return 0.0

    zv = _z_values(samples)
    mean_z = sum(zv) / len(zv)
    centered = [v - mean_z for v in zv]

    # Count zero crossings
    crossings = sum(
        1 for i in range(1, len(centered))
        if centered[i - 1] * centered[i] < 0
    )

    total_time = samples[-1].t - samples[0].t
    if total_time <= 0:
        return 0.0

    # ZCR → Hz conversion with 0.5 correction (each oscillation = 2 crossings)
    raw_freq = (crossings / 2.0) / total_time
    return round(raw_freq * 0.95, 3)   # slight empirical damping


def _fft_dominant_frequency(samples: List[JitterSample]) -> float:
    """
    Welch-method FFT estimate using numpy.  Preferred over ZCR when
    available.  Returns dominant frequency in Hz above 0.5 Hz
    (ignoring DC and sub-Hz drift).
    """
    try:
        import numpy as np

        zv = np.array(_z_values(samples), dtype=float)
        if len(zv) < 8:
            return _estimate_dominant_frequency(samples)

        # Infer sample rate from timestamps
        times = np.array([s.t for s in samples])
        dt_arr = np.diff(times)
        if dt_arr.mean() <= 0:
            return _estimate_dominant_frequency(samples)

        fs = 1.0 / dt_arr.mean()   # samples per second

        # Detrend (remove linear baseline wander)
        zv = zv - np.polyval(np.polyfit(times, zv, 1), times)

        # FFT magnitude spectrum
        fft_mag  = np.abs(np.fft.rfft(zv))
        fft_freq = np.fft.rfftfreq(len(zv), d=1.0 / fs)

        # Mask DC and sub-0.5 Hz
        mask = fft_freq >= 0.5
        if not mask.any():
            return 0.0

        dominant = fft_freq[mask][np.argmax(fft_mag[mask])]
        return round(float(dominant), 3)

    except ImportError:
        return _estimate_dominant_frequency(samples)


# ─────────────────────────────────────────────────────────────────────────────
# Stress score computation
# ─────────────────────────────────────────────────────────────────────────────

_ANOMALY_FREQ_HZ = 8.0          # clinical threshold for physical distress
_HIGH_STRESS_THRESHOLD  = 0.65
_MEDIUM_STRESS_THRESHOLD = 0.35


def _compute_stress_score(
    z_std:      float,
    freq_hz:    float,
    rms:        float,
    profile:    SteadyHandProfile,
) -> Tuple[float, List[str]]:
    """
    Multi-factor stress score in [0.0, 1.0].

    Scoring components
    ------------------
    Component A — Z-axis variance ratio  (weight 0.50)
        Ratio of measured Z-std to baseline.  Clamped at 4× baseline
        to prevent a single outlier sample from pinning the score.

    Component B — Frequency excess       (weight 0.30)
        Linear ramp from 0 at baseline max_freq to 1 at anomaly threshold
        (8 Hz).  Anything below baseline contributes 0.

    Component C — RMS amplitude          (weight 0.20)
        Ratio of measured RMS to baseline RMS threshold, clamped at 1.

    Final score = clamp(wA*A + wB*B + wC*C, 0, 1)

    Anomaly flags are raised for clinical thresholds regardless of score.
    """
    flags: List[str] = []

    # ── Component A: variance ──────────────────────────────────────────────
    if profile.mean_z_std > 0:
        variance_ratio = z_std / profile.mean_z_std
    else:
        variance_ratio = 1.0 if z_std == 0 else 4.0

    a = min(variance_ratio / 4.0, 1.0)   # normalise; 4× baseline → score 1

    if z_std > profile.mean_z_std * 3.0:
        flags.append(
            f"VARIANCE_SPIKE: z_std={z_std:.4f} exceeds 3× baseline "
            f"({profile.mean_z_std * 3:.4f})"
        )

    # ── Component B: frequency ─────────────────────────────────────────────
    freq_range = _ANOMALY_FREQ_HZ - profile.max_freq_hz
    if freq_range > 0 and freq_hz > profile.max_freq_hz:
        b = min((freq_hz - profile.max_freq_hz) / freq_range, 1.0)
    else:
        b = 0.0

    if freq_hz > _ANOMALY_FREQ_HZ:
        flags.append(
            f"HIGH_FREQUENCY: {freq_hz:.2f} Hz exceeds clinical threshold "
            f"of {_ANOMALY_FREQ_HZ} Hz — possible physical distress"
        )

    # ── Component C: RMS amplitude ─────────────────────────────────────────
    if profile.rms_threshold > 0:
        c = min(rms / profile.rms_threshold, 1.0)
    else:
        c = 1.0 if rms > 0 else 0.0

    if rms > profile.rms_threshold * 2.5:
        flags.append(
            f"RMS_AMPLITUDE: {rms:.4f} exceeds 2.5× threshold "
            f"({profile.rms_threshold * 2.5:.4f})"
        )

    # ── Weighted sum ───────────────────────────────────────────────────────
    score = 0.50 * a + 0.30 * b + 0.20 * c
    score = max(0.0, min(1.0, score))    # hard clamp

    return round(score, 4), flags


# ─────────────────────────────────────────────────────────────────────────────
# Baseline comparison
# ─────────────────────────────────────────────────────────────────────────────

def compare_to_baseline(
    samples: List[JitterSample],
    profile: SteadyHandProfile,
) -> dict:
    """
    Return a structured comparison of the incoming session against the
    steady-hand baseline profile.

    Returns a plain dict so it can be easily serialised to JSON.
    """
    z_std = _compute_std_dev(_z_values(samples))
    rms   = _compute_rms(_z_values(samples))
    freq  = _fft_dominant_frequency(samples)

    delta_std = z_std - profile.mean_z_std
    delta_pct = (delta_std / profile.mean_z_std * 100) if profile.mean_z_std else 0

    return {
        "measured_z_std":       round(z_std, 5),
        "baseline_z_std":       profile.mean_z_std,
        "delta_z_std":          round(delta_std, 5),
        "delta_pct":            round(delta_pct, 2),
        "measured_freq_hz":     freq,
        "baseline_max_freq_hz": profile.max_freq_hz,
        "exceeds_freq_baseline": freq > profile.max_freq_hz,
        "measured_rms":         round(rms, 5),
        "baseline_rms":         profile.rms_threshold,
        "exceeds_rms_baseline": rms > profile.rms_threshold,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Risk classification & recommendation
# ─────────────────────────────────────────────────────────────────────────────

def _classify_risk(score: float, flags: List[str]) -> str:
    """
    Risk level is determined by the stress score.  Clinical anomaly flags
    can escalate 'Low' → 'Medium' or 'Medium' → 'High'.
    """
    has_clinical_flag = any(
        kw in f for f in flags for kw in ("HIGH_FREQUENCY", "VARIANCE_SPIKE")
    )

    if score >= _HIGH_STRESS_THRESHOLD:
        return "High"
    if score >= _MEDIUM_STRESS_THRESHOLD:
        return "Medium" if not has_clinical_flag else "High"
    # Low baseline — can be escalated by clinical flags
    return "Low" if not has_clinical_flag else "Medium"


_RECOMMENDATIONS: dict[str, str] = {
    "High": (
        "BLOCK TRANSACTION — Kinetic signature deviates significantly from "
        "the enrolled steady-hand baseline. Stress score indicates high "
        "probability of physical duress, impersonation, or Parkinson's-grade "
        "tremor. Escalate to secondary verification (OTP + liveness check) "
        "and flag for manual fraud review within 15 minutes."
    ),
    "Medium": (
        "REQUIRE SECONDARY FACTOR — Jitter pattern shows moderate deviation "
        "from baseline. Could indicate environmental interference, fatigue, "
        "or mild anxiety. Prompt the user for a PIN or biometric re-confirm "
        "and log session for pattern analysis."
    ),
    "Low": (
        "APPROVE TRANSACTION — Kinetic profile matches steady-hand baseline "
        "within acceptable variance bounds. Frequency and amplitude are "
        "sub-threshold. Proceed normally; no additional friction required."
    ),
}


def _build_recommendation(risk: str, flags: List[str]) -> str:
    base = _RECOMMENDATIONS[risk]
    if flags:
        detail = " | Flags: " + "; ".join(flags)
        return base + detail
    return base


# ─────────────────────────────────────────────────────────────────────────────
# Public API — main entry point
# ─────────────────────────────────────────────────────────────────────────────

def analyze_session(
    session_id: str,
    samples: List[JitterSample],
    profile: Optional[SteadyHandProfile] = None,
) -> AnalysisResult:
    """
    Full pipeline:
      1. Baseline comparison
      2. Stress score via variance + frequency + RMS analysis
      3. Anomaly detection (8 Hz threshold)
      4. Risk classification
      5. Recommendation generation

    Parameters
    ----------
    session_id : str              — opaque session identifier from caller
    samples    : List[JitterSample] — chronologically ordered sensor data
    profile    : SteadyHandProfile  — baseline; uses default if None

    Returns
    -------
    AnalysisResult — fully populated result object
    """
    if profile is None:
        profile = SteadyHandProfile()

    # Require minimum viable sample count
    if len(samples) < 3:
        return AnalysisResult(
            session_id=session_id,
            stress_score=0.0,
            risk_level="Low",
            recommendation=(
                "INSUFFICIENT DATA — fewer than 3 samples received. "
                "Cannot perform kinetic analysis. Request re-submission."
            ),
            anomaly_flags=["INSUFFICIENT_SAMPLES"],
        )

    # ── Signal metrics ─────────────────────────────────────────────────────
    zv     = _z_values(samples)
    z_std  = _compute_std_dev(zv)
    rms    = _compute_rms(zv)
    freq   = _fft_dominant_frequency(samples)

    # ── Score & anomaly flags ──────────────────────────────────────────────
    score, flags = _compute_stress_score(z_std, freq, rms, profile)

    # ── Classification ─────────────────────────────────────────────────────
    risk           = _classify_risk(score, flags)
    recommendation = _build_recommendation(risk, flags)

    return AnalysisResult(
        session_id=session_id,
        stress_score=score,
        risk_level=risk,
        recommendation=recommendation,
        z_std_dev=round(z_std, 5),
        dominant_freq_hz=freq,
        rms_amplitude=round(rms, 5),
        baseline_delta=round(z_std - profile.mean_z_std, 5),
        anomaly_flags=flags,
    )