// Tape Runner — gameplay constants.
//
// All numeric knobs the designer wants to tweak live here so the
// tuning loop is one-file-edit. Admin overrides (games/runner doc
// in Firestore) layer on top via the bridge init payload.
//
// Coordinate convention (mirrors game.ts):
//   +X right, +Y up, +Z toward camera. Player stays put; world
//   scrolls +Z past them.

// ── Lanes ──────────────────────────────────────────────────────────
// 3 lanes, evenly spaced. Pickups & obstacles snap to one of these
// X positions.
export const LANES = {
  X: [-2.4, 0, 2.4] as const,
  COUNT: 3,
};

// ── Player ─────────────────────────────────────────────────────────
export const PLAYER = {
  BASE_Y: 1,
  JUMP_VY: 8.0,
  GRAVITY: -18.0,
  WIDTH: 1.0,
  HEIGHT: 1.8,
  DEPTH: 0.6,
  // Base lane-change duration in seconds. Buzz scales this up
  // (see BUZZ.EFFECTS[level].laneSlowFactor).
  LANE_CHANGE_BASE_S: 0.18,
};

// ── World scrolling + speed curve ──────────────────────────────────
export const WORLD = {
  SPAWN_Z: -70,            // far end of the lane
  DESPAWN_Z: 8,            // behind the camera
  START_SPEED: 10,         // m/s baseline
  MAX_SPEED: 22,           // m/s cap
  SPEED_RAMP: 0.01,        // +m/s per metre travelled
  COLLISION_PADDING: 0.85, // tighter than visual bbox for fairness
};

// ── Pickups ────────────────────────────────────────────────────────
// Bottles + water. Score is the raw number of points the pickup
// is worth (before combo multiplier). buzzDelta changes the buzz
// meter — positive for bottles (good points / bad survival),
// negative for water (no points / resets the meter).
export type PickupKind =
  | 'water'
  | 'vodkaMini'
  | 'vodkaBottle'
  | 'champagne'
  | 'magnum'
  | 'methuselah';

export interface PickupSpec {
  kind: PickupKind;
  label: string;       // shown briefly when collected (HUD flash)
  score: number;
  buzzDelta: number;   // +1 / +2 for bottles, -1 for water
  weight: number;      // relative spawn frequency
  color: number;       // hex
  // Placeholder geometry — swap for real models later.
  radius: number;
  height: number;
}

export const PICKUPS: Record<PickupKind, PickupSpec> = {
  water: {
    kind: 'water',
    label: 'Water',
    score: 0,
    buzzDelta: -1,
    weight: 30,
    color: 0x4cb8ff,
    radius: 0.18,
    height: 0.55,
  },
  vodkaMini: {
    kind: 'vodkaMini',
    label: 'Vodka shot',
    score: 10,
    buzzDelta: +1,
    weight: 28,
    color: 0xeeeeee,
    radius: 0.13,
    height: 0.32,
  },
  vodkaBottle: {
    kind: 'vodkaBottle',
    label: 'Vodka',
    score: 25,
    buzzDelta: +1,
    weight: 22,
    color: 0xddddee,
    radius: 0.18,
    height: 0.72,
  },
  champagne: {
    kind: 'champagne',
    label: 'Champagne',
    score: 50,
    buzzDelta: +1,
    weight: 14,
    color: 0xf3d77a,
    radius: 0.20,
    height: 0.85,
  },
  magnum: {
    kind: 'magnum',
    label: 'Magnum',
    score: 150,
    buzzDelta: +1,
    weight: 5,
    color: 0xffd45a,
    radius: 0.28,
    height: 1.05,
  },
  methuselah: {
    kind: 'methuselah',
    label: 'Methuselah',
    score: 500,
    buzzDelta: +2,
    weight: 1,
    color: 0xffb800,
    radius: 0.38,
    height: 1.50,
  },
};

// Helper — pick one of the pickups weighted by `weight`. Used by
// the spawner each tick.
const PICKUP_TOTAL_WEIGHT = Object.values(PICKUPS).reduce(
  (sum, p) => sum + p.weight,
  0,
);
export function rollPickup(): PickupSpec {
  let r = Math.random() * PICKUP_TOTAL_WEIGHT;
  for (const p of Object.values(PICKUPS)) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PICKUPS.water; // unreachable
}

// ── Obstacles ──────────────────────────────────────────────────────
// Three categories now:
//   - speaker / bouncer — floor-level, kill on contact while grounded.
//     Player dodges by jumping or changing lanes.
//   - discoBall — ceiling-hung, kills only while airborne. Player
//     dodges by NOT jumping (or by lane change). Inverted Y rule
//     from the floor obstacles.
export type ObstacleKind = 'speaker' | 'bouncer' | 'discoBall';

export interface ObstacleSpec {
  kind: ObstacleKind;
  weight: number;
  width: number;
  height: number;
  depth: number;
  color: number;
  /**
   * Y position of the mesh CENTRE. Floor obstacles use height/2 so
   * the base sits on the ground; ceiling-hung obstacles (disco ball)
   * sit high enough that grounded players pass underneath safely.
   */
  baseY: number;
  /**
   * If true, collisions only register while the player is AIRBORNE.
   * Disco balls use this — the "dodge" is staying on the ground.
   * Floor obstacles default to false: jumping clears them.
   */
  airOnly: boolean;
  // Reason sent back to Flutter for the game-over panel headline.
  failReason: 'speakerHit' | 'bouncerHit';
}

export const OBSTACLES: Record<ObstacleKind, ObstacleSpec> = {
  speaker: {
    kind: 'speaker',
    weight: 4,
    width: 0.9,
    height: 1.6,
    depth: 0.6,
    color: 0x1c1c1c,
    baseY: 0.8,
    airOnly: false,
    failReason: 'speakerHit',
  },
  bouncer: {
    kind: 'bouncer',
    weight: 4,
    width: 1.1,
    height: 1.95,
    depth: 0.7,
    color: 0x2a1010,
    baseY: 0.975,
    airOnly: false,
    failReason: 'bouncerHit',
  },
  discoBall: {
    kind: 'discoBall',
    weight: 2,
    // Used as the ball's diameter (sphere radius = width/2).
    width: 0.9,
    height: 0.9,
    depth: 0.9,
    color: 0xddddff,
    // Player jump apex is ~2.8m; ball centre at 3.4 with radius
    // 0.45 → bottom at 2.95. Player's head clears the ball only
    // while grounded.
    baseY: 3.4,
    airOnly: true,
    // Reused — Flutter maps both speakerHit and bouncerHit (and
    // implicitly discoBall) to GameOverReason.speakerHit today.
    // Unique copy for disco-ball death is a polish item later.
    failReason: 'speakerHit',
  },
};

const OBSTACLE_TOTAL_WEIGHT = Object.values(OBSTACLES).reduce(
  (sum, o) => sum + o.weight,
  0,
);
export function rollObstacle(): ObstacleSpec {
  let r = Math.random() * OBSTACLE_TOTAL_WEIGHT;
  for (const o of Object.values(OBSTACLES)) {
    r -= o.weight;
    if (r <= 0) return o;
  }
  return OBSTACLES.speaker; // unreachable
}

// ── Buzz state machine ─────────────────────────────────────────────
// Buzz level 0 (sober) → 5 (blackout = game over). Each level has
// visual + mechanical effects. Visual values are unitless intensity
// scalars the game uses to drive vignette opacity / blur radius /
// camera sway amplitude / FOV offset. Lane-slow factor multiplies
// PLAYER.LANE_CHANGE_BASE_S so higher buzz = slower lane changes.
export interface BuzzEffectParams {
  vignette: number;       // 0..1, opacity of full-screen vignette div
  blur: number;           // CSS px on canvas filter
  sway: number;           // peak camera roll in degrees
  laneSlowFactor: number; // multiplier on LANE_CHANGE_BASE_S
  fovOffset: number;      // degrees added to base camera FOV
}

export const BUZZ = {
  MAX_LEVEL: 5,
  // Default time per level decay. Overridable by admin via
  // games/runner.tipsyDecaySeconds (the field name is preserved
  // from the Flame engine — same semantics: seconds before buzz
  // drops by 1 level if no new pickup is collected).
  DEFAULT_DECAY_S: 12,

  EFFECTS: [
    // L0 — Sober. Clean.
    { vignette: 0.00, blur: 0.0, sway: 0.0, laneSlowFactor: 1.00, fovOffset: 0 },
    // L1 — Buzzed. Faint vignette. Just a signal.
    { vignette: 0.10, blur: 0.0, sway: 0.0, laneSlowFactor: 1.00, fovOffset: 0 },
    // L2 — Tipsy. Light sway.
    { vignette: 0.18, blur: 0.0, sway: 1.2, laneSlowFactor: 1.00, fovOffset: 0 },
    // L3 — Drunk. Lane changes 25% slower.
    { vignette: 0.28, blur: 0.8, sway: 2.0, laneSlowFactor: 1.25, fovOffset: 2 },
    // L4 — Hammered. Lane changes 50% slower. FOV tunnels.
    { vignette: 0.40, blur: 1.8, sway: 3.0, laneSlowFactor: 1.50, fovOffset: 5 },
    // L5 — Danger zone (May 13, 2026 design change). NOT instant
    // blackout anymore — the next buzz-adding pickup kills the run.
    // Effects are dialled to "intense but playable" so the player
    // can scramble for water without the screen being unreadable.
    { vignette: 0.55, blur: 2.5, sway: 3.5, laneSlowFactor: 1.75, fovOffset: 7 },
  ] as readonly BuzzEffectParams[],
} as const;

// ── Combo system ───────────────────────────────────────────────────
// Each pickup within COMBO_WINDOW_S of the previous = +1 combo.
// The multiplier kicks at the listed thresholds. Missing a bottle
// (it passes you uncollected) resets combo to 0.
export const COMBO = {
  WINDOW_S: 2.0,
  // [thresholdCombo, multiplier] — sorted ascending. Picks the
  // highest threshold the current combo satisfies.
  MULTIPLIERS: [
    [0, 1.0],
    [5, 1.5],
    [10, 2.0],
    [20, 3.0],
  ] as const,
};

export function comboMultiplier(combo: number): number {
  let mult = 1.0;
  for (const [threshold, m] of COMBO.MULTIPLIERS) {
    if (combo >= threshold) mult = m;
  }
  return mult;
}

// ── Spawn rates ────────────────────────────────────────────────────
// Intervals scale inversely with speed (faster = more frequent).
export const SPAWN = {
  PICKUP_INTERVAL_BASE_S: 0.9,
  OBSTACLE_INTERVAL_BASE_S: 1.6,
  // When spawning, the spawner avoids placing a pickup and an
  // obstacle within the same Z window in the same lane. This is
  // the minimum Z separation between simultaneous spawns.
  MIN_Z_SEPARATION: 4.0,
};
