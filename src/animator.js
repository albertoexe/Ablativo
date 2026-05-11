/**
 * animator.js — Canvas-based pill animation
 *
 * Draws all three states onto a single <canvas> element.
 * True morph transitions — no CSS cross-fades.
 *
 *   loading  ──▶  recording  ──▶  transcribing
 *   spinner       waveform        pulsing dots
 *   (fades)       (grows in)      (squish + pop)
 */

// ── Canvas logical dimensions ─────────────────────────────────────────────────
const CW = 80, CH = 28;
const CX = CW / 2, CY = CH / 2;

// ── Spinner (loading) ─────────────────────────────────────────────────────────
const SPIN_R     = 9;   // orbit radius from canvas centre
const SPIN_STEPS = 60;  // number of trail dots

// ── Waveform (recording) ──────────────────────────────────────────────────────
const BAR_N        = 7;
const BAR_W        = 2.5;
const BAR_GAP      = 2;
const BAR_MIN      = 3;
const BAR_MAX      = 24;
const BAR_STRIDE   = BAR_W + BAR_GAP;                          // 4.5
const BARS_TOTAL_W = BAR_N * BAR_W + (BAR_N - 1) * BAR_GAP;  // 29.5
const BAR_LEFT     = CX - BARS_TOTAL_W / 2;

/** Centre-x of bar i */
function barCX(i) { return BAR_LEFT + i * BAR_STRIDE + BAR_W / 2; }

// ── Dots (transcribing) ───────────────────────────────────────────────────────
const DOT_R       = 2.5;
const DOT_GAP     = 5;
const DOT_TOTAL_W = 3 * DOT_R * 2 + 2 * DOT_GAP;  // 25
const DOT_LEFT    = CX - DOT_TOTAL_W / 2;
const DOT_CYCLE   = 1200;  // ms per pulse cycle
const DOT_STAGGER = 200;   // ms stagger between dots

/** Centre-x of dot i */
function dotCX(i) { return DOT_LEFT + i * (DOT_R * 2 + DOT_GAP) + DOT_R; }

// ── Transition ────────────────────────────────────────────────────────────────
const TRANS_MS = 400;

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function easeOut(t)        { return 1 - (1 - t) * (1 - t); }
function easeInOut(t)      { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

/** roundRect with fallback for older engines */
function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }
  ctx.fill();
}

// ── PillAnimator ──────────────────────────────────────────────────────────────

export class PillAnimator {
  constructor(canvas) {
    this._canvas = canvas;
    this._state  = 'loading';
    this._prev   = null;
    this._morphT = 1;    // 0→1 while morphing, 1 = settled
    this._tStart = 0;

    // RMS level from the native audio thread (0.0 – 1.0)
    this._rmsLevel = 0;

    // Frozen bar heights — used during rec→tx morph
    this._lastBarH = new Float32Array(BAR_N).fill(BAR_MIN);

    // Spinner
    this._angle  = 0;
    this._lastTs = 0;

    // DPR-scaled canvas
    const dpr = window.devicePixelRatio || 1;
    canvas.width        = Math.round(CW * dpr);
    canvas.height       = Math.round(CH * dpr);
    canvas.style.width  = `${CW}px`;
    canvas.style.height = `${CH}px`;
    this._ctx = canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);

    this._bound = this._tick.bind(this);
    this._raf   = requestAnimationFrame(this._bound);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  setLoading() {
    this._go('loading');
  }

  /** Call once when recording starts — no analyser needed anymore. */
  setRecording() {
    this._rmsLevel = 0;
    this._go('recording');
  }

  /** Called on every 'audio-level' event from Rust (~30 ms cadence). */
  setLevel(rms) {
    this._rmsLevel = rms;
  }

  setTranscribing() {
    // _lastBarH holds the frozen heights from the last recording frame
    this._go('transcribing');
  }

  destroy() {
    cancelAnimationFrame(this._raf);
  }

  // ── State machine ─────────────────────────────────────────────────────────────

  _go(to) {
    if (to === this._state && this._morphT >= 1) return;
    this._prev   = this._state;
    this._state  = to;
    this._morphT = 0;
    this._tStart = performance.now();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────────

  _tick(ts) {
    this._raf = requestAnimationFrame(this._bound);

    const dt = Math.min(ts - this._lastTs, 100);  // cap to avoid jumps on tab restore
    this._lastTs = ts;

    // Advance spinner angle (~0.9 s / revolution)
    this._angle = (this._angle + (dt / 900) * Math.PI * 2) % (Math.PI * 2);

    // Advance morph
    if (this._morphT < 1) {
      this._morphT = clamp((ts - this._tStart) / TRANS_MS, 0, 1);
    }

    // Drive waveform bars from native RMS level (~30 ms updates from Rust).
    // Each bar has a unique phase so they don't all move in lockstep.
    // Fast attack (0.4), slow decay (0.85) — mirrors how real waveforms look.
    if (this._state === 'recording') {
      const rms = this._rmsLevel || 0;
      for (let i = 0; i < BAR_N; i++) {
        const wave   = 0.5 + 0.5 * Math.sin(ts / 380 + i * 1.05);
        const target = BAR_MIN + (BAR_MAX - BAR_MIN) * Math.min(rms, 1) * (0.55 + 0.45 * wave);
        const prev   = this._lastBarH[i];
        this._lastBarH[i] = target > prev
          ? prev * 0.60 + target * 0.40   // fast attack
          : prev * 0.85 + target * 0.15;  // slow decay
      }
    }

    this._render(ts);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  _render(ts) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, CW, CH);

    const morphing = this._morphT < 1 && this._prev !== null;

    if (!morphing) {
      // Settled — draw current state
      switch (this._state) {
        case 'loading':      this._drawLoading(1);     break;
        case 'recording':    this._drawBars(1);        break;
        case 'transcribing': this._drawDots(ts, 1);    break;
      }
      return;
    }

    const t = easeInOut(this._morphT);

    if (this._prev === 'loading' && this._state === 'recording') {
      this._morphLoad2Rec(t);
    } else if (this._prev === 'recording' && this._state === 'transcribing') {
      this._morphRec2Tx(t, ts);
    } else {
      // Fallback: simple cross-fade
      ctx.globalAlpha = 1 - this._morphT;
      this._drawState(this._prev, ts);
      ctx.globalAlpha = this._morphT;
      this._drawState(this._state, ts);
      ctx.globalAlpha = 1;
    }
  }

  _drawState(state, ts) {
    switch (state) {
      case 'loading':      this._drawLoading(1);   break;
      case 'recording':    this._drawBars(1);      break;
      case 'transcribing': this._drawDots(ts, 1);  break;
    }
  }

  // ── Morph: loading → recording ────────────────────────────────────────────────

  _morphLoad2Rec(t) {
    const ctx = this._ctx;

    // Spinner fades out over the first 40% of the morph
    const spinA = clamp(1 - t / 0.4, 0, 1);
    if (spinA > 0.01) {
      this._drawLoading(spinA);
    }

    // Bars grow in from height 0, staggered across [0.2, 1.0]
    const barsBase = clamp((t - 0.2) / 0.8, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';

    for (let i = 0; i < BAR_N; i++) {
      // Spread stagger: leftmost bar starts first, rightmost last
      const delay = (i / (BAR_N - 1)) * 0.28;
      const barT  = clamp((barsBase - delay) / (1 - delay + 0.001), 0, 1);
      if (barT <= 0) continue;

      const h = lerp(0, Math.max(BAR_MIN, this._lastBarH[i]), easeOut(barT));
      ctx.globalAlpha = easeOut(barT);
      fillRoundRect(ctx, barCX(i) - BAR_W / 2, CY - h / 2, BAR_W, Math.max(0.5, h), 2);
    }

    ctx.globalAlpha = 1;
  }

  // ── Morph: recording → transcribing ──────────────────────────────────────────

  _morphRec2Tx(t, ts) {
    const ctx = this._ctx;

    // Phase 1 (0→0.6): bars squish toward minimum height and fade
    const squishT = clamp(t / 0.6, 0, 1);
    const barA    = 1 - easeInOut(squishT);

    if (barA > 0.01) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < BAR_N; i++) {
        const h = lerp(this._lastBarH[i], BAR_MIN * 0.5, easeOut(squishT));
        ctx.globalAlpha = barA;
        fillRoundRect(ctx, barCX(i) - BAR_W / 2, CY - h / 2, BAR_W, Math.max(0.5, h), 2);
      }
    }

    // Phase 2 (0.35→1): dots grow in
    const dotsT = clamp((t - 0.35) / 0.65, 0, 1);
    if (dotsT > 0.01) {
      this._drawDots(ts, easeOut(dotsT));
    }

    ctx.globalAlpha = 1;
  }

  // ── Draw: loading spinner ─────────────────────────────────────────────────────

  _drawLoading(overallAlpha) {
    const ctx   = this._ctx;
    const angle = this._angle;

    // Arc trail: series of small squares along the orbit, brightness → head
    for (let s = 0; s < SPIN_STEPS; s++) {
      const prog  = s / SPIN_STEPS;                              // 0 = tail, 1 = head
      const a     = angle - (1 - prog) * Math.PI * 2;
      const x     = CX + Math.sin(a) * SPIN_R;
      const y     = CY - Math.cos(a) * SPIN_R;
      const alpha = Math.pow(prog, 3) * 0.88 * overallAlpha;
      const size  = prog > 0.92 ? 2.5 : 1.5;

      ctx.globalAlpha = alpha;
      ctx.fillStyle   = '#ffffff';
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }

    // Bright head square
    const hx = CX + Math.sin(angle) * SPIN_R;
    const hy = CY - Math.cos(angle) * SPIN_R;
    ctx.globalAlpha  = overallAlpha;
    ctx.fillStyle    = '#ffffff';
    ctx.shadowColor  = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur   = 4;
    ctx.fillRect(hx - 1.5, hy - 1.5, 3, 3);
    ctx.shadowBlur   = 0;
    ctx.globalAlpha  = 1;
  }

  // ── Draw: waveform bars ───────────────────────────────────────────────────────

  _drawBars(overallAlpha) {
    const ctx = this._ctx;
    ctx.fillStyle   = 'rgba(255,255,255,0.85)';
    ctx.globalAlpha = overallAlpha;

    for (let i = 0; i < BAR_N; i++) {
      const h = this._lastBarH[i];
      fillRoundRect(ctx, barCX(i) - BAR_W / 2, CY - h / 2, BAR_W, h, 2);
    }

    ctx.globalAlpha = 1;
  }

  // ── Draw: transcribing dots ───────────────────────────────────────────────────

  _drawDots(ts, overallAlpha) {
    const ctx = this._ctx;

    for (let i = 0; i < 3; i++) {
      // Safe modulo — handles negative ts offset
      const t_ms = ((ts - i * DOT_STAGGER) % DOT_CYCLE + DOT_CYCLE) % DOT_CYCLE;
      const cycle = t_ms / DOT_CYCLE;                                    // 0→1
      const pulse = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);          // 0→1
      const scale = lerp(0.8, 1.25, pulse);
      const opac  = lerp(0.25, 1.0,  pulse);

      ctx.globalAlpha = opac * overallAlpha;
      ctx.fillStyle   = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(dotCX(i), CY, DOT_R * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
}
