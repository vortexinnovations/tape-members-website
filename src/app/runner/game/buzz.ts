// Buzz state machine — the heart of the nightclub-runner design.
//
// Levels 0..maxLevel (admin-configurable, default 5). Bottle pickups
// add buzz; water pickups subtract it. Buzz also decays over time
// (`tickDecay`) so survival alone is a slow path back to sobriety.
//
// Adding buzz while already at maxLevel → BLACKOUT → game over.
//
// The class owns NO Three.js or DOM state. It just tracks the
// number and exposes:
//   - getLevel()              current 0..maxLevel
//   - getMaxLevel()           the danger-zone level (player dies on
//                              the next bottle while sitting at it)
//   - getEffectParams()       visual + mechanical knobs for the renderer / HUD
//   - getPeak()               highest level ever reached this run (telemetry)
//   - isAtMaxBuzz()           true when level === maxLevel
//
// May 13, 2026 — maxLevel is now dynamic (was hardcoded BUZZ.MAX_LEVEL).
// Admin can set games/runner.maxTipsyLevel to anything in [2, 20] and
// the effect table linearly interpolates between sober (L0 = no
// effects) and danger (Lmax = same intensity as the original L5).

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
  /** Configured maximum buzz level. `level` and `peak` are clamped
   *  to [0, maxLevel]. Adding buzz at maxLevel triggers blackout. */
  private maxLevel: number = BUZZ.MAX_LEVEL;
  /** Generated effects table — one entry per level 0..maxLevel. */
  private effects: BuzzEffectParams[] = BUZZ.EFFECTS as BuzzEffectParams[];
  /**
   * Admin-tunable multiplier on the VISUAL drunk effects (vignette,
   * blur, sway, FOV-offset). 1.0 = stock intensity, 0 = effects
   * fully disabled even at max buzz, > 1 = stronger drunk feel.
   * Does NOT scale `laneSlowFactor` — that's a gameplay knob the
   * admin can already tune separately via the lane-change timing
   * setting, and combining the two scalars makes "drunk" hard to
   * reason about.
   */
  private effectMultiplier = 1.0;

  /** Override the per-level decay time. Called by RunnerGame.init(). */
  setDecaySeconds(s: number) {
    if (Number.isFinite(s) && s > 0) this.decaySeconds = s;
  }

  /**
   * Set the visual-effect multiplier. Clamped to [0, 3]:
   * - 0   → no drunk visuals ever (HUD-only buzz feedback)
   * - 1   → stock intensity (default)
   * - 1.5 → noticeably stronger
   * - 3   → maximum exaggeration before the screen becomes unreadable
   */
  setEffectMultiplier(m: number) {
    if (!Number.isFinite(m)) return;
    this.effectMultiplier = Math.max(0, Math.min(3, m));
  }

  /**
   * Zero out the buzz state for a fresh run. Keeps the configured
   * `maxLevel`, `decaySeconds`, and `effectMultiplier` (admin
   * tunables) — those are session-level, not per-run.
   */
  reset() {
    this.level = 0;
    this.peak = 0;
    this.decayAccum = 0;
  }

  /**
   * Configure the buzz state machine to use a different maximum
   * level. Defaults to 5 (the legacy hardcoded value). Lmax always
   * produces the "danger" effects (same intensity as the original
   * L5); L0 always produces sober (no effects). Intermediate levels
   * interpolate linearly between the two.
   *
   * Clamped to [2, 20] — sub-2 produces a binary sober/danger state
   * which removes the gameplay nuance; above 20 the perceptual
   * difference per level becomes invisible.
   */
  setMaxLevel(n: number) {
    if (!Number.isFinite(n)) return;
    const intN = Math.max(2, Math.min(20, Math.floor(n)));
    if (intN === this.maxLevel && this.effects.length === intN + 1) return;
    this.maxLevel = intN;
    const sober = BUZZ.EFFECTS[0];
    const danger = BUZZ.EFFECTS[BUZZ.EFFECTS.length - 1];
    this.effects = [];
    for (let i = 0; i <= this.maxLevel; i++) {
      const t = i / this.maxLevel;
      this.effects.push({
        vignette: lerp(sober.vignette, danger.vignette, t),
        blur: lerp(sober.blur, danger.blur, t),
        sway: lerp(sober.sway, danger.sway, t),
        laneSlowFactor: lerp(sober.laneSlowFactor, danger.laneSlowFactor, t),
        fovOffset: lerp(sober.fovOffset, danger.fovOffset, t),
      });
    }
    // Clamp existing level/peak in case admin shrunk the range
    // mid-game (defensive — init() runs before the run starts).
    if (this.level > this.maxLevel) this.level = this.maxLevel;
    if (this.peak > this.maxLevel) this.peak = this.maxLevel;
  }

  /**
   * Add (positive) or subtract (negative) buzz. Clamps to [0, max].
   *
   * Returns `true` if this call caused a BLACKOUT — i.e. the player
   * was already at maxLevel and tried to add more buzz. The level
   * itself stays clamped at max so the visuals stay consistent;
   * the boolean is what the game loop uses to end the run.
   *
   * Hitting MAX is NOT instant death — it's a sustained danger
   * state ("one more drink and you're done"), which gives the
   * player a real window to scramble for water. Only the next
   * buzz-adding pickup tips them over.
   */
  add(delta: number): boolean {
    if (delta === 0) return false;
    if (delta > 0 && this.level >= this.maxLevel) {
      // Already maxed — this push is the one that kills the run.
      this.peak = this.maxLevel;
      return true;
    }
    this.level = Math.max(0, Math.min(this.maxLevel, this.level + delta));
    if (this.level > this.peak) this.peak = this.level;
    // Reset the decay accumulator on any change so a fresh bottle
    // doesn't compete with a half-expired decay window.
    this.decayAccum = 0;
    return false;
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

  getMaxLevel(): number {
    return this.maxLevel;
  }

  getPeak(): number {
    return this.peak;
  }

  /**
   * True when the player is sitting at the max-buzz "danger zone" —
   * one more bottle and they black out. Used by the HUD to pulse
   * the meter, NOT by the game loop to end the run (that decision
   * lives inside `add()`, which signals blackout via its return).
   */
  isAtMaxBuzz(): boolean {
    return this.level >= this.maxLevel;
  }

  /**
   * Visual + mechanical effect params for the current level. The
   * renderer interpolates between adjacent levels using
   * `getInterpolatedEffectParams()` (below) for smooth transitions
   * during the decay ramp — this raw getter returns the discrete
   * snapshot.
   */
  getEffectParams(): BuzzEffectParams {
    return this.effects[Math.min(this.level, this.effects.length - 1)];
  }

  /**
   * Smoothed effect params. Linearly interpolates between the
   * current level's effect block and the next one down based on
   * how far we are through the decay window. This makes the
   * visual easing feel continuous instead of a step every 12s.
   */
  getInterpolatedEffectParams(): BuzzEffectParams {
    const lv = Math.min(this.level, this.effects.length - 1);
    if (lv === 0) {
      // Sober — vignette/blur/sway/fovOffset are all 0 here, so the
      // multiplier is a no-op. Returning the stock entry is fine.
      return this.effects[0];
    }
    const a = this.effects[lv];
    const b = this.effects[lv - 1];
    // 0 right after a pickup, → 1 just before the next decay tick.
    const t = Math.min(1, this.decayAccum / this.decaySeconds);
    const m = this.effectMultiplier;
    return {
      vignette: lerp(a.vignette, b.vignette, t) * m,
      blur: lerp(a.blur, b.blur, t) * m,
      sway: lerp(a.sway, b.sway, t) * m,
      // laneSlowFactor stays unscaled — see comment on
      // effectMultiplier. It's a gameplay knob, not a visual one.
      laneSlowFactor: lerp(a.laneSlowFactor, b.laneSlowFactor, t),
      fovOffset: lerp(a.fovOffset, b.fovOffset, t) * m,
    };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
