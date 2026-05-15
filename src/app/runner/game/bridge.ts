// JS ↔ Dart bridge contract for Tape Runner.
//
// The Flutter app loads this page in a WebView and registers a
// JavascriptChannel called `GameToFlutter`. Messages we send via
// `postToFlutter()` arrive on the Dart side as a JSON string.
//
// Conversely, Flutter calls `window.tapeRunner.init(...)` and
// `window.tapeRunner.pause()` / `.resume()` to push data + lifecycle
// events into the game. We expose those globals from page.tsx.
//
// When this page is loaded in a regular browser tab (e.g. for
// development on localhost) the GameToFlutter channel is absent —
// `postToFlutter` falls back to console.log so the page is still
// usable standalone.

export type PlayerGender = 'male' | 'female' | 'other' | '';

/** Pushed from Flutter into JS once the WebView mounts. */
export type InitPayload = {
  /** Firestore users/{uid}. Echoed back on gameOver for audit. */
  userId?: string;
  playerGender?: PlayerGender;
  /**
   * Live admin tunables from games/runner. Every field is optional;
   * the game falls back to its built-in default if a field is
   * missing or non-numeric. Lets the operator A/B the gameplay
   * without a redeploy.
   */
  settings?: {
    // ── Speed curve ─────────────────────────────────────────────
    startSpeed?: number;
    maxSpeed?: number;
    speedRamp?: number;
    // ── Buzz mechanic ───────────────────────────────────────────
    maxTipsyLevel?: number;
    tipsyDecaySeconds?: number;
    /**
     * Visual-effect intensity multiplier. 1.0 = stock, 0 = HUD-only
     * buzz with no drunk visuals, > 1 = stronger drunk feel. Clamped
     * to [0, 3] on the game side. Does NOT scale lane-change
     * slowdown (gameplay knob — tuned separately).
     */
    buzzEffect?: number;
    // ── Scene brightness ────────────────────────────────────────
    /**
     * Multiplier on the full scene lighting (ambient + house +
     * pulsing coloured rig). 1.0 = stock dark-nightclub look, > 1 =
     * brighter, < 1 = even darker. Clamped to [0.1, 5] on the game
     * side. At 5x the colored rig hits intensity 60-90 without
     * white-clipping the brand palette.
     */
    brightness?: number;
    /**
     * Per-feature multiplier for the LED ceiling on top of the
     * master `brightness`. 0 = ceiling completely off, 0.7 =
     * stock (slightly darker than the rest of the room), 1.0 =
     * matches master brightness, 2.0 = blown out. Clamped to
     * [0, 2] on the game side.
     */
    ceilingBrightness?: number;
    // ── Spawn pacing (Three.js only) ────────────────────────────
    pickupIntervalSeconds?: number;
    obstacleIntervalSeconds?: number;
    /**
     * Progressive-density ramp. Each interval ramps linearly from
     * its base value toward `*IntervalMinSeconds` over the first
     * `*RampSeconds` seconds of the run, then holds at the min.
     * Independent of the speed-scaling that's always applied (a
     * fast late-game run still can't spawn faster than the floor).
     *
     * Set `*RampSeconds` to 0 to disable the ramp (constant base
     * interval, modulated only by speed — original behaviour).
     *
     * `*IntervalMinSeconds` is clamped server-side to be ≤ the
     * corresponding `*IntervalSeconds` so an admin can't invert
     * the ramp direction.
     */
    pickupRampSeconds?: number;
    pickupIntervalMinSeconds?: number;
    obstacleRampSeconds?: number;
    obstacleIntervalMinSeconds?: number;
    // ── Combo (Three.js only) ───────────────────────────────────
    comboWindowSeconds?: number;
    /**
     * Combo multiplier tiers above the always-baseline ×1.0.
     * Each entry is `{ threshold, multiplier }`. The runner sorts
     * ascending by threshold and picks the highest tier the player's
     * combo count satisfies. Arbitrary length — admins can add as
     * many tiers as they want for deep chains.
     *
     * Defaults if omitted: 5/×1.5, 10/×2.0, 20/×3.0 (mirrors the
     * legacy fixed three-tier behaviour).
     */
    comboTiers?: Array<{ threshold: number; multiplier: number }>;
    /**
     * @deprecated — superseded by `comboTiers`. Honoured only when
     * `comboTiers` is absent, for backwards-compat with Firestore
     * docs that haven't been migrated. New writes should use the
     * array form.
     */
    comboTier2Threshold?: number;
    /** @deprecated — see `comboTiers`. */
    comboTier2Multiplier?: number;
    /** @deprecated — see `comboTiers`. */
    comboTier3Threshold?: number;
    /** @deprecated — see `comboTiers`. */
    comboTier3Multiplier?: number;
    /** @deprecated — see `comboTiers`. */
    comboTier4Threshold?: number;
    /** @deprecated — see `comboTiers`. */
    comboTier4Multiplier?: number;
    // ── Player feel (Three.js only) ─────────────────────────────
    jumpVelocity?: number;
    laneChangeSeconds?: number;
    // ── Pickup spawn weights (Three.js only). 0 = never spawn ──
    waterWeight?: number;
    vodkaMiniWeight?: number;
    vodkaBottleWeight?: number;
    champagneWeight?: number;
    magnumWeight?: number;
    methuselahWeight?: number;
    // ── Pickup point values (Three.js only). Pre-combo base score
    vodkaMiniScore?: number;
    vodkaBottleScore?: number;
    champagneScore?: number;
    magnumScore?: number;
    methuselahScore?: number;
    // ── Obstacle spawn weights (Three.js only) ──────────────────
    speakerWeight?: number;
    /**
     * Dancing character on the dancefloor (used to be called
     * "bouncer" but the animation is a dance). Jump-clearable.
     */
    dancerWeight?: number;
    /**
     * Actual bouncer obstacle — intimidating arms-crossed
     * character blocking the lane. Same collision profile as
     * dancer. Jump-clearable.
     */
    bouncerWeight?: number;
    discoBallWeight?: number;
    // ── Sound effects (Three.js only) ───────────────────────────
    /**
     * Admin master switch for SFX. When false:
     *   • play() is a no-op
     *   • the HUD mute button is hidden entirely (no point letting
     *     users toggle a feature that's off at the source)
     * Default true.
     */
    sfxEnabled?: boolean;
    /** Master volume 0..1. Default 1.0. Clamped game-side. Final
     *  per-clip volume = `sfxVolume * sfx<Event>Volume`. */
    sfxVolume?: number;
    // Per-event volume multipliers 0..1. Final clip volume on each
    // play() is `sfxVolume * sfx<Event>Volume`. Missing or non-
    // numeric values default to 1.0 (no per-event attenuation).
    // Clamped to [0, 1] on the game side.
    sfxJumpVolume?: number;
    sfxPickupVolume?: number;
    sfxWaterVolume?: number;
    sfxComboVolume?: number;
    sfxGameOverVolume?: number;
    sfxLaneChangeVolume?: number;
    sfxRunningVolume?: number;
    /**
     * Per-event SFX URLs. Each key is independent; an empty/missing
     * URL means "admin hasn't configured this SFX, play silently."
     * URLs typically point at MP3/AAC files hosted on Firebase
     * Storage or any public CDN. Asset names match the convention
     * documented on RunnerSettingsRecord.assetUrls.
     */
    sfxJumpUrl?: string;
    sfxPickupUrl?: string;
    sfxWaterUrl?: string;
    sfxComboUrl?: string;
    sfxGameOverUrl?: string;
    /** Fires on every lane change (left or right swipe). */
    sfxLaneChangeUrl?: string;
    /**
     * Looped background SFX. Loop starts the moment the player
     * makes their first input (when the world starts ticking) and
     * runs until game-over / dispose / pause. Mute + master volume
     * apply.
     */
    sfxRunningUrl?: string;
    // ── Game-over copy overrides (Three.js only) ────────────────
    // Each pair (headline + subtitle) overrides the built-in
    // DEATH_COPY default for that death reason. The web sends the
    // resolved strings inside `gameOver` so Flutter can render them
    // without an app update. Setting either to '' falls back to the
    // hard-coded default in tuning.ts.
    gameOverBlackoutHeadline?: string;
    gameOverBlackoutSubtitle?: string;
    gameOverSpeakerHeadline?: string;
    gameOverSpeakerSubtitle?: string;
    gameOverDancerHeadline?: string;
    gameOverDancerSubtitle?: string;
    gameOverBouncerHeadline?: string;
    gameOverBouncerSubtitle?: string;
    gameOverDiscoBallHeadline?: string;
    gameOverDiscoBallSubtitle?: string;
  };
};

/** Sent from JS to Flutter the moment the game finishes loading. */
export type ReadyMessage = {
  type: 'ready';
  /** Bump this on incompatible bridge changes. */
  version: 2;
};

/**
 * Sent from JS to Flutter when a run ends.
 *
 * v2 (May 13, 2026) — added score + combo + buzz fields to support
 * the nightclub-runner gameplay (bottle pickups = points × combo
 * multiplier; buzz meter; bouncer obstacle). The Flutter side
 * submits `score` as the leaderboard metric (the existing
 * `distanceMeters` field on `runnerScoreSubmissions` is overloaded
 * to carry score for WebView-engine runs).
 */
export type GameOverMessage = {
  type: 'gameOver';
  /** Final score — distance + bottle points × combo multipliers. */
  score: number;
  /** Raw distance travelled in metres (display + telemetry). */
  distance: number;
  /** Seconds elapsed. */
  duration: number;
  /** Total bottle pickups (excludes water). */
  bottlesCollected: number;
  /** Water pickups consumed. */
  watersUsed: number;
  /** Peak combo achieved (1 = no combo, higher = consecutive picks). */
  peakCombo: number;
  /** Highest buzz level reached during the run (0..5). */
  peakBuzz: number;
  /** Speed at the moment of game-over (m/s). */
  speed: number;
  /** Why the run ended. */
  reason:
    | 'blackout'
    | 'speakerHit'
    | 'dancerHit'
    | 'bouncerHit'
    | 'discoBallHit'
    | 'manual';
  /**
   * Resolved game-over panel headline for this `reason`. Either the
   * admin-tunable override or the built-in default from
   * tuning.ts → DEATH_COPY. Flutter falls back to its hardcoded copy
   * when this is missing (old web build / parsing failure).
   */
  headline?: string;
  /** Resolved subtitle, same source. */
  subtitle?: string;
};

/** Sent from JS to Flutter for debug logging via the bridge. */
export type LogMessage = {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
};

export type GameToFlutterMessage =
  | ReadyMessage
  | GameOverMessage
  | LogMessage;

/**
 * Type of the JavascriptChannel Flutter registers under the
 * name `GameToFlutter`. The channel object exposes
 * `postMessage(string)` and that's it.
 */
type FlutterChannel = { postMessage(message: string): void };

declare global {
  interface Window {
    GameToFlutter?: FlutterChannel;
    /** Exposed by page.tsx for Flutter to call into the game. */
    tapeRunner?: {
      init(payload: InitPayload): void;
      pause(): void;
      resume(): void;
      /** Force-end the current run (used for testing during the spike). */
      forceGameOver(): void;
      /** Reset game state for a fresh run without reloading the page
       *  (avoids re-downloading the ~75 MB of character FBX assets).
       *  Called from Flutter's "Play again" button. */
      restart(): void;
    };
  }
}

export function postToFlutter(message: GameToFlutterMessage): void {
  const channel = window.GameToFlutter;
  if (channel?.postMessage) {
    try {
      channel.postMessage(JSON.stringify(message));
    } catch (e) {
      console.error('[bridge] postMessage failed', e);
    }
  } else {
    // Standalone browser mode — just log so the page is testable
    // without the Flutter wrapper.
    // eslint-disable-next-line no-console
    console.log('[GameToFlutter→]', message);
  }
}
