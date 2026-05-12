// Buzz state machine — the heart of the nightclub-runner design.
//
// Level 0..5. Bottle pickups add buzz; water pickups subtract it.
// Buzz also decays over time (`tickDecay`) so survival alone is
// a slow path back to sobriety.
//
// Level >= MAX_LEVEL → blackout → game over.
//
// The class owns NO Three.js or DOM state. It just tracks the
// number and exposes:
//   - getLevel()             current 0..5
//   - getEffectParams()      visual + mechanical knobs for the renderer / HUD
//   - getPeak()              highest level ever reached this run (telemetry)
//   - isBlackout()           true when level >= MAX_LEVEL
//
// The game loop reads these each frame and feeds them into the
// canvas blur filter / vignette opacity / camera sway / lane-change
// duration / FOV.

import { BUZZ, type BuzzEffectParams } from './tuning';

export class Buzz {
  private level = 0;
  private peak = 0;
  /** Accumulator since the last level drop (in seconds). */
  private decayAccum = 0;
  /** Admin-tunable. Defaults to BUZZ.DEFAULT_DECAY_S; init() overrides.
   *  Explicit `number` annotation — without it TS infers the literal
   *  type `12` from BUZZ.DEFAULT_DECAY_S (because BUZZ is `as const`)
   *  and rejects later assignment from setDecaySeconds(). */
  private decaySeconds: number = BUZZ.DEFAULT_DECAY_S;

  /** Override the per-level decay time. Called by RunnerGame.init(). */
  setDecaySeconds(s: number) {
    if (Number.isFinite(s) && s > 0) this.decaySeconds = s;
  }

  /** Add (positive) or subtract (negative) buzz. Clamps to [0, MAX]. */
  add(delta: number) {
    if (delta === 0) return;
    this.level = Math.max(0, Math.min(BUZZ.MAX_LEVEL, this.level + delta));
    if (this.level > this.peak) this.peak = this.level;
    // Reset the decay accumulator on any change so a fresh bottle
    // doesn't compete with a half-expired decay window.
    this.decayAccum = 0;
  }

  /** Advance time. Drops one level every `decaySeconds`. */
  tickDecay(dt: number) {
    if (this.level <= 0) return;
    this.decayAccum += dt;
    if (this.decayAccum >= this.decaySeconds) {
      this.decayAccum = 0;
      this.level = Math.max(0, this.level - 1);
    }
  }

  getLevel(): number {
    return this.level;
  }

  getPeak(): number {
    return this.peak;
  }

  isBlackout(): boolean {
    return this.level >= BUZZ.MAX_LEVEL;
  }

  /**
   * Visual + mechanical effect params for the current level. The
   * renderer interpolates between adjacent levels using
   * `getInterpolatedEffectParams()` (below) for smooth transitions
   * during the decay ramp — this raw getter returns the discrete
   * snapshot.
   */
  getEffectParams(): BuzzEffectParams {
    return BUZZ.EFFECTS[Math.min(this.level, BUZZ.EFFECTS.length - 1)];
  }

  /**
   * Smoothed effect params. Linearly interpolates between the
   * current level's effect block and the next one down based on
   * how far we are through the decay window. This makes the
   * visual easing feel continuous instead of a step every 12s.
   */
  getInterpolatedEffectParams(): BuzzEffectParams {
    const lv = Math.min(this.level, BUZZ.EFFECTS.length - 1);
    if (lv === 0) return BUZZ.EFFECTS[0];
    const a = BUZZ.EFFECTS[lv];
    const b = BUZZ.EFFECTS[lv - 1];
    // 0 right after a pickup, → 1 just before the next decay tick.
    const t = Math.min(1, this.decayAccum / this.decaySeconds);
    return {
      vignette: lerp(a.vignette, b.vignette, t),
      blur: lerp(a.blur, b.blur, t),
      sway: lerp(a.sway, b.sway, t),
      laneSlowFactor: lerp(a.laneSlowFactor, b.laneSlowFactor, t),
      fovOffset: lerp(a.fovOffset, b.fovOffset, t),
    };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
