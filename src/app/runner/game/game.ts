// Tape Runner — Three.js game.
//
// Nightclub-themed endless runner. Core loop:
//   - Collect bottles (water, vodka, champagne, magnum, methuselah)
//     to rack up score × combo multiplier.
//   - Bottles raise your BUZZ meter; water drops it.
//   - Buzz adds visual + mechanical penalties: vignette, screen
//     blur, camera sway, FOV tunnel, slower lane changes.
//   - Buzz 5 = BLACKOUT = game over.
//   - Speakers + bouncers = run-over = game over.
//
// Detailed design lives in CLAUDE.md ("Tape Runner game design"
// May 13, 2026 entry — not yet written; for now see the conversation
// log + this file). All numeric tuning lives in `tuning.ts`.
//
// Coordinate convention:
//   +X right, -X left
//   +Y up
//   +Z toward camera — the player stays still and the world
//   scrolls +Z past them.

import * as THREE from 'three';
import {
  GLTFLoader,
  type GLTF,
} from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  postToFlutter,
  type GameOverMessage,
  type InitPayload,
  type PlayerGender,
} from './bridge';
import { Buzz } from './buzz';
import { AudioManager } from './audio';
import { HUD } from './hud';
import {
  COMBO,
  DEATH_COPY,
  LANES,
  OBSTACLES,
  PICKUPS,
  PLAYER,
  SPAWN,
  WORLD,
  type ObstacleKind,
  type ObstacleSpec,
  type PickupKind,
  type PickupSpec,
} from './tuning';

// ── Internal entities ─────────────────────────────────────────────

interface ActivePickup {
  mesh: THREE.Mesh;
  spec: PickupSpec;
  /** Set true once the player has either collected OR passed it.
   *  Pickups passed without collection BREAK the combo. */
  resolved: boolean;
}

interface ActiveObstacle {
  mesh: THREE.Mesh;
  spec: ObstacleSpec;
  /** Per-instance AnimationMixer for bouncers (each plays the
   *  dance loop at its own phase). Undefined for non-rigged
   *  obstacles (speakers, disco balls) and for the procedural
   *  bouncer fallback when the GLB hasn't loaded yet. */
  mixer?: THREE.AnimationMixer;
}

// ── Podium LED colour cycle ────────────────────────────────────────
// Slow rainbow rotation for the dancer podiums. Hue moves through
// pink → purple → blue → red → back to pink. Per-podium phase
// offset gives a flowing wave along the row of podiums (see
// `tickDancerPodiums`).
//
// Anchors chosen to land on saturated TAPE-friendly hues (avoid
// muddy intermediates). Linear RGB interpolation between adjacent
// anchors.
const LED_HUE_ANCHORS: [number, number, number][] = [
  [1.0, 0.20, 0.55], // pink
  [0.55, 0.10, 0.95], // purple
  [0.15, 0.30, 1.0], // blue
  [1.0, 0.10, 0.15], // red
];

/** Map a normalised phase 0..1 onto a colour somewhere along the
 *  anchor cycle. Returns `[r, g, b]` each 0..1. */
function cycleLEDColor(phase: number): [number, number, number] {
  const n = LED_HUE_ANCHORS.length;
  const seg = ((phase % 1) + 1) % 1 * n;
  const i = Math.floor(seg) % n;
  const t = seg - Math.floor(seg);
  const a = LED_HUE_ANCHORS[i];
  const b = LED_HUE_ANCHORS[(i + 1) % n];
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// ── Game class ─────────────────────────────────────────────────────

export class RunnerGame {
  // Three.js core
  private scene = new THREE.Scene();
  /**
   * Refs to the two non-pulsing scene lights so `init()` can scale
   * their intensities at runtime (admin "brightness" knob).
   */
  private ambientLight!: THREE.AmbientLight;
  private houseLight!: THREE.DirectionalLight;
  /** Base intensities cached at construction so brightness scaling
   *  is relative to "stock" instead of compounding on each init(). */
  private readonly ambientBaseIntensity = 0.55;
  private readonly houseBaseIntensity = 0.35;
  /**
   * Live brightness multiplier — applied to the ambient + house
   * lights in init(), and folded into each pulsing club-light
   * intensity inside tickClubLights() so the moving rig actually
   * gets brighter too. (Earlier version only scaled the ambient
   * pair, which was ~5% of the total light budget — admin couldn't
   * see any visible effect even at 3x. Bumping the colored rig too
   * is the only way "make it brighter" actually does anything.)
   */
  private brightnessMultiplier = 1.0;
  /**
   * Per-feature multiplier for the LED ceiling on top of the
   * global brightnessMultiplier. Admin-tunable via
   * `games/runner.ceilingBrightness` (clamped to [0, 2]) so the
   * ceiling can be dimmed without dimming the rest of the rig.
   * Default 0.7 is "slightly darker than the rest of the room"
   * which matches typical Tape lighting balance.
   */
  private ceilingBrightnessMultiplier = 0.7;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver | null = null;
  /**
   * Vertical FOV (degrees) before any buzz offset. Recomputed on
   * construction + every resize so the lane edges at x=±2.4 stay
   * inside the frustum on narrow portrait phones (vFOV widens) and
   * desktop/landscape (vFOV stays at the visually-clean 55° default).
   */
  private baseFov = 55;

  // Player + lane state
  private player!: THREE.Mesh;
  /**
   * Visible-but-non-collidable child group of `player`. Owns the
   * humanoid silhouette (torso + head + arms + legs). Animated in
   * the update loop — torso bobs, limbs swing in a run cycle.
   */
  private playerVisual!: THREE.Group;
  /**
   * Limb meshes referenced for the run-cycle animation. Same objects
   * are already added to `playerVisual` — this is just a cache so
   * the per-frame swing loop doesn't traverse the group.
   */
  private playerLimbs!: {
    armL: THREE.Mesh;
    armR: THREE.Mesh;
    legL: THREE.Mesh;
    legR: THREE.Mesh;
  };
  /**
   * When a rigged GLB character is loaded (see `tryLoadGltfPlayer`),
   * `playerMixer` drives the bone animation each frame and the
   * manual `playerLimbs` swing is skipped. When the GLB is missing
   * or fails to load, `playerMixer` stays undefined and we fall
   * back to the capsule-stack placeholder's manual limb swing.
   */
  private playerMixer?: THREE.AnimationMixer;
  private playerRunAction?: THREE.AnimationAction;
  /**
   * The separate "jumping" character — a full Mixamo "with skin"
   * export of the same Ch33 male character carrying the Jump
   * animation. We swap visibility between this and `playerVisual`
   * on jump/landing instead of trying to retarget a clip onto the
   * running character's skeleton (which fails because cross-FBX
   * bind-pose orientation differences twist joints).
   *
   * Both characters are children of `this.player` (the collider),
   * so they always move together — the swap is purely a visibility
   * flip + animation reset.
   */
  private playerJumpVisual?: THREE.Group;
  private playerJumpMixer?: THREE.AnimationMixer;
  private playerJumpAction?: THREE.AnimationAction;
  /** Duration of the loaded jump clip — used to set timeScale so
   *  the clip plays in roughly the actual airtime. */
  private playerJumpClipDuration = 1.0;
  /**
   * The separate "falling" character — same pattern as the jump
   * character. Plays once on game-over BEFORE we notify Flutter,
   * so the player sees a death animation instead of an instant
   * panel. The Flutter game-over panel only appears after the
   * fall clip's `finished` event fires.
   */
  private playerFallVisual?: THREE.Group;
  private playerFallMixer?: THREE.AnimationMixer;
  private playerFallAction?: THREE.AnimationAction;
  /** True while the fall animation is playing — between endGame()
   *  triggering and the clip's `finished` event firing. While true,
   *  the rAF loop ticks `playerFallMixer` even though `running` is
   *  false. */
  private isFalling = false;
  /** Stash of the game-over payload computed at endGame() time so
   *  we can re-emit it (with all the per-run telemetry intact)
   *  when the fall animation finishes. */
  private pendingGameOver?: GameOverMessage;
  /**
   * Edge detector for the run↔jump landing swap. True each frame
   * the player is airborne; flips false on the frame they touch
   * down, which fires the swap-back-to-run-character.
   */
  private wasInAir = false;
  /**
   * Cached references to the player's leg + arm + spine bones —
   * used by `applyAdditiveJumpPose` as a procedural fallback if
   * the jump character FBX fails to load. When the jump visual
   * is wired, this is unused.
   */
  private jumpPoseBones: THREE.Bone[] = [];
  /** True while we're showing the capsule fallback. Flips false
   *  once a GLB load completes successfully. */
  private isPlaceholderPlayer = true;
  /**
   * Per-asset readiness flags. RunnerGame considers itself "ready
   * to play" once BOTH the player visual + the jump character
   * have finished loading (or definitively failed). While this is
   * false the HUD shows a "Loading…" overlay and input is ignored.
   */
  private playerAssetReady = false;
  private jumpAssetReady = false;
  private fallAssetReady = false;
  private assetsReady = false;
  private playerLane = 1;
  // Explicit `number` annotations — without them TS infers the
  // literal type `0` from LANE_X[1] (because LANES.X is `as const`)
  // and rejects later assignment from -2.4 / +2.4 lanes.
  private targetX: number = LANES.X[1];
  private laneChangeTime = 0;
  private laneChangeStartX: number = LANES.X[1];
  private laneChangeDuration = PLAYER.LANE_CHANGE_BASE_S;
  private playerY = PLAYER.BASE_Y;
  private playerVy = 0;

  // World
  private floorStripes: THREE.Mesh[] = [];
  /** Framed portrait planes mounted on the side walls. Scrolled
   *  + recycled like floorStripes so they pass past the runner. */
  private wallPortraits: THREE.Mesh[] = [];
  /** VIP booth groups (sofa + table + bucket + bottles) along the
   *  side walls. Scrolled in lockstep with the rest of the
   *  side-of-runway scenery. */
  private vipBooths: THREE.Group[] = [];
  /** Wall-mounted speaker cabinets above the portraits, scrolling
   *  with the rest of the wall scenery. Spacing admin-tunable via
   *  `worldWallSpeakerSpacingZ`; spacing ≤ 0 disables them. */
  private wallSpeakers: THREE.Group[] = [];
  /** Wall-mounted strobe lights between speakers — emissive panels
   *  whose intensity is animated per-frame for a club-strobe pulse.
   *  Spacing admin-tunable via `worldWallStrobeSpacingZ`; ≤ 0
   *  disables them. */
  private wallStrobes: Array<{
    group: THREE.Group;
    material: THREE.MeshBasicMaterial;
    phase: number;
  }> = [];
  /** "ALL ROADS LEAD TO TAPE" floor-text bands painted across the
   *  runway. Pool wraps in the standard 90 m window. Spacing
   *  admin-tunable via `worldFloorTextSpacingZ`; ≤ 0 disables. */
  private floorTexts: THREE.Mesh[] = [];
  /** Pink neon "Shots Bitch" signs mounted on the side walls,
   *  between booth backrests and portraits. Pool wraps in the
   *  standard 90 m window. Spacing admin-tunable via
   *  `worldWallShotsSpacingZ`; ≤ 0 disables. */
  private wallShots: THREE.Mesh[] = [];
  /**
   * Admin-tunable spacings for the four world-scenery pools. All
   * default to the historical hard-coded values so an unseeded
   * `games/runner` doc plays identically to the original release.
   * Read once via `init()` from the corresponding `world*SpacingZ`
   * setting; the pool is built lazily on first init via
   * `applyWorldDecorations()` so spacings apply on the very first
   * play, not the second.
   */
  private worldDancerSpacingZ = 9;
  private worldBoothSpacingZ = 22.5;
  private worldPortraitSpacingZ = 9;
  private worldWallSpeakerSpacingZ = 18;
  private worldWallStrobeSpacingZ = 12;
  private worldFloorTextSpacingZ = 30;
  private worldWallShotsSpacingZ = 24;
  /** Latch: world decorations (portraits, booths, podiums, speakers,
   *  strobes) are built on first `init()` AFTER settings arrive so
   *  the admin's spacing overrides take effect immediately. Flip
   *  true after the first apply so subsequent init() ticks don't
   *  rebuild (which would duplicate meshes + leak GPU memory). */
  private decorationsApplied = false;
  /**
   * Velvet-rope stanchion pool. Each entry is a Group containing
   * a gold post + base + cap + a red rope tube that visually
   * spans 5 m back to where the NEXT stanchion will be. Two rows
   * (left + right of the runway) interleaved in this array, all
   * scrolled + recycled in the same update-loop pass as the
   * floor stripes.
   */
  private velvetRopes: THREE.Group[] = [];
  /**
   * TAPE dancer podiums — a hollow cage of 8 LED edges (4 vertical
   * corner columns + 4 horizontal top-frame rails) sitting on a
   * raised plinth, with a faintly glowing square panel inside the
   * top frame to read as a "lit lid." Mounted just past the
   * velvet rope on alternating sides of the runway. Pure Tape
   * London iconography — anyone who's been to the venue will
   * recognise the look immediately.
   *
   * Per podium:
   *  - `ledMat`     — one MeshBasicMaterial shared across all 8
   *                   LED tubes (vertical corners + horizontal top
   *                   rails). Pulse mutates this material's color
   *                   so every LED on the podium breathes in unison.
   *  - `panelMat`   — separate material for the translucent top
   *                   lid panel. Lower opacity than the LED tubes
   *                   so the frame reads as the brightness anchor
   *                   and the panel is a soft fill.
   *  - `glowMat`    — soft additive disc on the floor at the base.
   *
   * Per-podium `phase` offset on the pulse means the row creates
   * a travelling wave of intensity along the track.
   */
  private dancerPodiums: {
    group: THREE.Group;
    ledMat: THREE.MeshBasicMaterial;
    panelMat: THREE.MeshBasicMaterial;
    glowMat: THREE.MeshBasicMaterial;
    phase: number;
  }[] = [];
  /**
   * Skinned dancer figures slotted inside each podium cage.
   *
   * The dancers are baked GLBs from Mixamo's auto-rigger:
   *   • `/models/dancer_animated.glb`        — blonde variant
   *   • `/models/dancer_animated_dark.glb`   — dark-haired variant
   *
   * Each podium randomly picks one and SkeletonUtils.clone's
   * an independent rig so animations run on per-podium
   * AnimationMixers (adjacent podiums shouldn't perform the
   * same beat in unison). See `loadDancerVisuals()` for the
   * bbox-derived auto-fit + position logic.
   *
   * Pipeline used to produce the GLBs:
   *   Mixamo "With Skin" FBX → FBX2glTF → gltf-transform resize
   *   1024 → webp encode. Replaces the older procedural-bind
   *   pipeline (bind_dancer.mjs + build_dancer_anim.mjs) which
   *   computed skin weights from bone-vertex distance — that
   *   approach had a SIZE > 1 bind-matrix bug, and Mixamo's
   *   auto-rig is mathematically correct so it scales cleanly.
   */
  private dancerVisuals: {
    /** Root of the cloned rig (SkeletonUtils.clone returns Object3D). */
    root: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    /** -1 for left-side podiums, +1 for right-side — used to flip
     *  the base rotation so the dancer faces the runway. */
    sideSign: number;
  }[] = [];
  private pickups: ActivePickup[] = [];
  private obstacles: ActiveObstacle[] = [];
  private spawnAccumPickup = 0;
  private spawnAccumObstacle = 0;
  /**
   * Nightclub lighting rig. Each entry pulses on its own frequency
   * so the lighting feels "alive" (real club rigs are never fully
   * synchronised). The lights also drift slowly along the runway
   * so the brightness pattern under the player isn't static.
   * Animated in update() via `tickClubLights()`.
   */
  private clubLights: {
    light: THREE.PointLight;
    baseIntensity: number;
    pulseHz: number;
    phase: number;
    baseZ: number;
    driftAmp: number;
  }[] = [];

  /**
   * Tape London's signature LED ceiling — single plane, custom
   * shader that procedurally renders a grid of bright circular
   * dots and animates per-cell colour through pink → purple →
   * blue → red on a moving wave. Kept as a ref so the update
   * loop can tick its `uTime` uniform.
   */
  private ledCeilingMat?: THREE.ShaderMaterial;

  /**
   * Cached canvas-texture used as the glowing shield badge on every
   * champagne / magnum / methuselah pickup. Lazily built on the
   * first champagne spawn; reused for the lifetime of the game,
   * disposed in dispose().
   */
  private champagneLabelTexture?: THREE.CanvasTexture;

  /**
   * Cached GLTF for the dancer obstacle (dancing character on the
   * dancefloor — was called "bouncer" until we noticed the
   * animation is actually a dance). Loaded
   * once on construction, then SkeletonUtils.clone'd per spawn so
   * each dancer instance has its own skeleton + independent
   * AnimationMixer. Undefined while the load is in flight or if
   * the file is missing — spawnObstacle falls back to the procedural
   * capsule-stack humanoid in that case.
   */
  private dancerObstacleGltf?: GLTF;

  /**
   * Cached GLTF for the (actual) bouncer obstacle — intimidating
   * arms-crossed character blocking the lane. Same per-instance
   * SkeletonUtils.clone treatment as the dancer obstacle.
   */
  private bouncerGltf?: GLTF;

  // HUD overlay (DOM) — created on construction, owns vignette + counters.
  private hud: HUD;
  /**
   * Audio manager — preloads SFX, plays on events, owns master
   * mute + volume. Created on construction; URLs are loaded later
   * once Flutter's `init()` bridge call delivers admin settings.
   * Until URLs arrive every play() is silent (no harm done).
   */
  private audio = new AudioManager();

  // Buzz + combo + score state
  private buzz = new Buzz();
  private score = 0;
  private bottlesCollected = 0;
  private watersUsed = 0;
  private combo = 0;
  private comboTimer = 0;
  private peakCombo = 0;

  // World state
  private speed = WORLD.START_SPEED;
  private startSpeed = WORLD.START_SPEED;
  private maxSpeed = WORLD.MAX_SPEED;
  private speedRamp = WORLD.SPEED_RAMP;
  private distance = 0;
  private duration = 0;

  // ── Admin-tunable knobs (all overridable via init.settings) ──
  // Spawn pacing — interval in seconds at base speed; scaled
  // inversely by current speed in the spawner.
  private pickupIntervalSeconds = SPAWN.PICKUP_INTERVAL_BASE_S;
  private obstacleIntervalSeconds = SPAWN.OBSTACLE_INTERVAL_BASE_S;
  // Progressive-density ramp. Interval linearly interpolates from
  // its base value toward `*IntervalMinSeconds` over the first
  // `*RampSeconds` seconds of the run. 0 ramp = constant base
  // interval (modulated only by speed — original behaviour).
  private pickupRampSeconds = SPAWN.PICKUP_RAMP_S;
  private pickupIntervalMinSeconds = SPAWN.PICKUP_INTERVAL_MIN_S;
  private obstacleRampSeconds = SPAWN.OBSTACLE_RAMP_S;
  private obstacleIntervalMinSeconds = SPAWN.OBSTACLE_INTERVAL_MIN_S;
  // Combo window — seconds since the last pickup to keep the chain.
  private comboWindowSeconds: number = COMBO.WINDOW_S;
  /**
   * Combo multiplier tiers above the always-baseline ×1.0.
   * Sorted ascending by threshold. Defaults mirror the historical
   * three-tier behaviour (5/×1.5, 10/×2.0, 20/×3.0) so an unseeded
   * Firestore doc plays the same as the original hardcoded table.
   *
   * Admin can override with any number of tiers via `comboTiers`
   * in settings. Legacy `comboTier2Threshold` / `…Multiplier` keys
   * are still read as a fallback for docs that haven't been
   * migrated yet.
   */
  private comboTiers: Array<{ threshold: number; multiplier: number }> = [
    { threshold: 5, multiplier: 1.5 },
    { threshold: 10, multiplier: 2.0 },
    { threshold: 20, multiplier: 3.0 },
  ];
  // Player feel — jump impulse + base lane-change time (buzz still
  // scales the lane time at higher levels).
  private jumpVelocity = PLAYER.JUMP_VY;
  private laneChangeBaseSeconds = PLAYER.LANE_CHANGE_BASE_S;
  // Per-spec override maps. Keys present = override applied; keys
  // absent = fall back to PICKUPS[kind].weight / .score / etc.
  private pickupWeightOverrides: Partial<Record<PickupKind, number>> = {};
  private pickupScoreOverrides: Partial<Record<PickupKind, number>> = {};
  private obstacleWeightOverrides: Partial<Record<ObstacleKind, number>> = {};
  /**
   * Game-over copy overrides keyed on the death reason. Populated
   * from `InitPayload.settings.gameOver<Reason><Headline|Subtitle>`
   * in init(). When a key is missing the resolver in `resolveDeath
   * Copy()` falls back to DEATH_COPY[reason] from tuning.ts.
   * Lets admins change "You ran into a speaker." → "You hit the wall
   * of sound." from /runnerAdmin without an app rebuild.
   */
  private deathCopyOverrides: Partial<
    Record<keyof typeof DEATH_COPY, { headline?: string; subtitle?: string }>
  > = {};

  private running = true;
  private gameOver = false;
  /**
   * False until the player's first swipe (or jump) lands. While
   * false the world doesn't scroll, distance / score / duration
   * don't tick, and obstacles / pickups don't spawn — the runway
   * sits idle with the player running in place, behind the HUD's
   * input-hint overlay. The first input flips this true, resets
   * `duration` so the run starts at t=0, and dismisses the hint.
   */
  private gameStarted = false;
  /**
   * Animation clock used in the pre-game state (when `gameStarted`
   * is still false). Keeps the player limb-swing and club lights
   * alive while the world is frozen, without polluting `duration`
   * (which feeds the validator's physics check).
   */
  private previewClock = 0;
  private rafId: number | null = null;

  // Init values pushed from Flutter (may be undefined if loaded
  // in a regular browser tab).
  private playerGender: PlayerGender = '';
  private userId: string | undefined;

  // ── Construction ────────────────────────────────────────────────

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x070707);
    this.resize();

    this.baseFov = this.computeBaseFov();
    this.camera = new THREE.PerspectiveCamera(
      this.baseFov,
      this.aspect(),
      0.1,
      200,
    );
    this.camera.position.set(0, 4.5, 8);
    this.camera.lookAt(0, 1, -6);

    // HUD constructed BEFORE buildScene because buildScene →
    // buildPlayerVisual → setLoading(true) on the HUD. The HUD is
    // a DOM overlay independent of the WebGL scene, so it's safe
    // to construct it this early.
    this.hud = new HUD(canvas);

    // ── Audio ↔ HUD handshake ───────────────────────────────────
    // HUD owns the mute button DOM; AudioManager owns the actual
    // mute state. Tap → toggle → notify back via onMuteChanged.
    // Initial icon reflects the localStorage-persisted preference
    // already loaded by AudioManager's constructor.
    this.hud.onMuteToggle = () => this.audio.toggleMute();
    this.audio.onMuteChanged = (muted) => this.hud.setMuteIcon(muted);
    this.hud.setMuteIcon(this.audio.muted);
    // Button is hidden until init() arrives with sfxEnabled. Admin
    // master switch defaults true so the button shows up once
    // settings load.
    this.hud.setMuteVisible(false);

    this.buildScene();
    this.attachInput();
    this.attachResize();
    this.start();
  }

  private aspect(): number {
    const r = this.canvas.getBoundingClientRect();
    return r.width / Math.max(1, r.height);
  }

  /**
   * Compute the vertical FOV needed to keep the lane edges visible
   * at the player's distance from camera. Adapts to aspect ratio:
   * narrow portrait phones get a wider vFOV (so the side lanes
   * don't fall outside the frustum); landscape/desktop gets the
   * clean 55° default.
   *
   * Math:
   *   - We want `LANE_VISIBLE_HALF_X` (lane edge + player half-width
   *     + small margin) to be visible at the camera-to-player view
   *     distance `PLAYER_VIEW_DIST` (≈ 8.6 units given the current
   *     camera at (0, 4.5, 8) looking at (0, 1, -6)).
   *   - That requires horizontal half-angle = atan(half / dist).
   *   - vertical FOV = 2 * atan(tan(hHalf) / aspect).
   *   - Clamped to [55, 72] so wide screens don't telephoto and
   *     ultra-narrow doesn't fisheye.
   */
  private computeBaseFov(): number {
    // 3.2 = ±2.4 lane + ±0.5 player + 0.3 visual breathing room.
    // Was 3.0 + 0.1 margin — tight enough that some narrow phones
    // still clipped the player by a hair.
    const LANE_VISIBLE_HALF_X = 3.2;
    const PLAYER_VIEW_DIST = 8.6;
    const aspect = Math.max(0.3, this.aspect());
    const hHalf = Math.atan(LANE_VISIBLE_HALF_X / PLAYER_VIEW_DIST);
    const vHalf = Math.atan(Math.tan(hHalf) / aspect);
    const vFov = (vHalf * 2 * 180) / Math.PI;
    // Clamp upper bound at 78° — empirically the safe limit before
    // perspective-stretch (fisheye) becomes noticeable at the
    // screen edges on a portrait phone.
    return Math.min(78, Math.max(55, vFov));
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width || window.innerWidth;
    const h = r.height || window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  // ── Scene build ─────────────────────────────────────────────────

  private buildScene() {
    // ── Fog ─────────────────────────────────────────────────────
    // Magenta-tinted exponential fog so obstacles fade in from the
    // spawn distance instead of popping into view. Density tuned so
    // SPAWN_Z (-70) is mostly invisible and obstacles become clearly
    // readable around z=-40. Sells "underground club" atmosphere
    // and hides the spawn boundary at the same time.
    // Background MUST match fog colour, otherwise distant geometry
    // fogs into one colour while the empty "sky" is another and the
    // player sees a visible horizon band where they meet.
    const fogColor = 0x1a0814;
    this.scene.fog = new THREE.FogExp2(fogColor, 0.020);
    this.scene.background = new THREE.Color(fogColor);

    // ── Lighting rig ────────────────────────────────────────────
    // Faint ambient so unlit faces of obstacles aren't pure black —
    // keeps the bottle silhouettes readable in the dark.
    this.ambientLight = new THREE.AmbientLight(
      0x2a1428,
      this.ambientBaseIntensity,
    );
    this.scene.add(this.ambientLight);
    // Soft warm "house lights" overall directional — enough to read
    // the player and floor without washing out the colored rig.
    this.houseLight = new THREE.DirectionalLight(
      0xfff3e0,
      this.houseBaseIntensity,
    );
    this.houseLight.position.set(0, 12, 2);
    this.scene.add(this.houseLight);

    // Three colored point lights drifting along the runway. Each
    // pulses on its own frequency — feels "live" not synchronised.
    // Palette: magenta + cyan + warm amber. Stays on-brand without
    // looking like a kids'-toy rainbow.
    const lightSpecs: {
      color: number;
      intensity: number;
      hz: number;
      phase: number;
      z: number;
      driftAmp: number;
    }[] = [
      { color: 0xff2a8c, intensity: 18.0, hz: 0.55, phase: 0.0,  z: -12, driftAmp: 6 },
      { color: 0x2aa8ff, intensity: 14.0, hz: 0.82, phase: 1.3,  z: -24, driftAmp: 8 },
      { color: 0xffb060, intensity: 12.0, hz: 1.10, phase: 2.7,  z: -36, driftAmp: 10 },
    ];
    for (const s of lightSpecs) {
      const light = new THREE.PointLight(s.color, s.intensity, 60, 1.6);
      light.position.set(0, 7, s.z);
      this.scene.add(light);
      this.clubLights.push({
        light,
        baseIntensity: s.intensity,
        pulseHz: s.hz,
        phase: s.phase,
        baseZ: s.z,
        driftAmp: s.driftAmp,
      });
    }

    // ── Ground ──────────────────────────────────────────────────
    // Slightly metallic so the coloured point lights catch on it
    // and the floor visually pulses with the rig. Roughness still
    // high so it doesn't look like a chrome mirror.
    const groundGeo = new THREE.PlaneGeometry(20, 200);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x140a10,
      roughness: 0.55,
      metalness: 0.35,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -90;
    this.scene.add(ground);

    // ── Side walls ──────────────────────────────────────────────
    // Tall dark walls flanking the runway at the edges of the
    // ground (x = ±10). Length matches the ground, height runs
    // above the LED ceiling (y = 8.5) up to 10 m so a glance up
    // never sees a gap between wall-top and ceiling. Slightly
    // less metallic than the ground so the coloured rig's
    // sidelight catches as a soft sheen rather than a hard
    // specular highlight. PlaneGeometry rotated to face inward
    // toward the runway; DoubleSide so the inside of the club
    // reads correctly from any camera angle.
    const WALL_HALF_LENGTH = 100;   // 200 m total length, matches ground
    const WALL_HEIGHT = 10;
    const WALL_X = 10;              // ground edge
    const wallGeo = new THREE.PlaneGeometry(WALL_HALF_LENGTH * 2, WALL_HEIGHT);
    const wallMat = new THREE.MeshStandardMaterial({
      // Very dark with the slightest cool tint — reads as "the
      // walls of the dark club", not "a featureless black
      // backdrop". Near-matte roughness + 0 metalness means the
      // coloured point-light rig is absorbed rather than reflected
      // — no specular highlights catching on the wall faces.
      color: 0x050308,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    // Left wall — at x = -10, faces +X (toward runway centre).
    const leftWall = new THREE.Mesh(wallGeo, wallMat);
    leftWall.position.set(-WALL_X, WALL_HEIGHT / 2, -90);
    leftWall.rotation.y = Math.PI / 2;
    this.scene.add(leftWall);
    // Right wall — at x = +10, faces -X.
    const rightWall = new THREE.Mesh(wallGeo, wallMat);
    rightWall.position.set(WALL_X, WALL_HEIGHT / 2, -90);
    rightWall.rotation.y = -Math.PI / 2;
    this.scene.add(rightWall);

    // Wall portraits, VIP booths, dancer podiums, wall speakers, and
    // wall strobes are DEFERRED to `applyWorldDecorations()`. That
    // method is called from `init()` once the admin's spacing
    // overrides have been applied, so the first play already
    // honours their tuning. (Building here with default spacings
    // would mean spacings only kick in on the second play.)

    // Lane separators — vertical white strips between lanes.
    const laneStripeGeo = new THREE.PlaneGeometry(0.06, 200);
    const laneStripeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.18,
    });
    [-1.2, 1.2].forEach((x) => {
      const stripe = new THREE.Mesh(laneStripeGeo, laneStripeMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(x, 0.01, -90);
      this.scene.add(stripe);
    });

    // Floor stripes — short bars that translate +Z each frame to
    // give a strong motion cue. Recycled in a small pool.
    const stripeGeo = new THREE.PlaneGeometry(7.2, 0.18);
    const stripeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.08,
    });
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Mesh(stripeGeo, stripeMat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(0, 0.02, -i * 5);
      this.scene.add(s);
      this.floorStripes.push(s);
    }

    // ── Velvet rope barrier ────────────────────────────────────
    // Nightclub-style gold stanchions + red velvet rope along
    // both sides of the runway. Stanchions sit at X = ±3.75 —
    // just outside the 7.2 m white-stripe band, well clear of
    // the outermost lane (X = ±2.4) so they never interfere
    // with obstacle / pickup collisions. Each stanchion "owns"
    // the rope segment extending 5 m behind it (into the
    // distance), matching the floor-stripe rhythm. Whole pool
    // scrolls like the stripes and recycles when units pass
    // the camera.
    this.buildVelvetRopes();

    // ── LED ceiling ────────────────────────────────────────────
    // Tape London's signature dense grid of small circular LEDs
    // overhead — pink/purple/blue/red cycling through patterns.
    // One plane with a shader that draws ~8,000 dots procedurally,
    // so the whole effect is one draw call.
    this.buildLEDCeiling();

    // The old "ALL ROADS LEAD TO TAPE" billboard at the end of the
    // runway has been replaced by floor text — a pool of flat-on-
    // the-floor text bands that scroll past the player. Built from
    // `applyWorldDecorations()` so the admin's spacing kicks in on
    // the first play.

    // TAPE dancer podiums (also deferred — see applyWorldDecorations).

    // ── Player ──────────────────────────────────────────────────
    // Invisible collider sized to the original PLAYER.* dimensions
    // so collision logic stays untouched. The visible character is
    // built as a separate child group by `buildPlayerVisual(gender)`,
    // which we call once now with the empty default and again from
    // init() when Flutter pushes the user's gender. The second call
    // disposes the placeholder visual and swaps in the correct one.
    const collisionGeo = new THREE.BoxGeometry(
      PLAYER.WIDTH,
      PLAYER.HEIGHT,
      PLAYER.DEPTH,
    );
    const collisionMat = new THREE.MeshBasicMaterial({ visible: false });
    this.player = new THREE.Mesh(collisionGeo, collisionMat);
    this.player.position.set(LANES.X[1], PLAYER.BASE_Y, 0);
    this.scene.add(this.player);

    // Default visual — used until init() arrives with a real
    // playerGender. Treated as a neutral/male silhouette.
    this.buildPlayerVisual('');
    // Kick off the async character-model loads. They'll typically
    // land before the first obstacle spawns (~1.6 s into the run);
    // any obstacles that spawn before they land use the procedural
    // humanoid fallback automatically.
    this.loadDancerObstacleModel();
    this.loadBouncerModel();
    // Jump character load is gender-aware — fired from
    // `buildPlayerVisual` once we know which character to load.
    // Fire the dancer-figure load too — populates each podium cage
    // with a swaying T-pose dancer once the GLB arrives. Failure is
    // silent (cages stay empty — they still look great).
    this.loadDancerVisuals();
  }

  /**
   * Currently-loaded jump character's gender, so we don't refetch
   * the same FBX on no-op gender changes. Set to the resolved
   * suffix ('male' / 'female'), or '' if no jump character is
   * loaded yet.
   */
  private loadedJumpGender = '';

  /**
   * Currently-loaded fall character's gender. Same role as
   * `loadedJumpGender` — guards against duplicate loads when init()
   * is called repeatedly with the same gender, and lets gender
   * flips drop in-flight loads cleanly.
   */
  private loadedFallGender = '';

  /**
   * Load the "jumping" character — a full Mixamo "with skin" FBX
   * carrying the Jump animation. Treated as a separate visible
   * entity that we swap visibility with the running character on
   * jump/landing.
   *
   * Why a whole second character instead of extracting + retargeting
   * the clip onto the running character: cross-FBX bone-rotation
   * application produces visible "jelly joint" artifacts because
   * the two FBX exports have subtly different bind-pose orientations
   * — even when the character on each side is nominally the same.
   * Swapping characters sidesteps the issue entirely. Each FBX
   * runs its own animation against its own native skeleton.
   *
   * Gender-aware: `runner_jump_male.fbx` for male/empty/other,
   * `runner_jump_female.fbx` for female. Disposes the previously
   * loaded jump character before swapping so we don't leak GPU
   * memory across gender changes.
   *
   * Cost: ~55 MB male / ~19 MB female FBX download per character
   * load. Rendered only during the brief jump airtime (~0.6 s),
   * but loaded and resident for the whole game; visibility flip
   * swaps which one is drawn.
   */
  private async loadJumpCharacter(gender: string) {
    const suffix = gender === 'female' ? 'female' : 'male';
    // No-op if we already have this gender's jump character.
    if (this.loadedJumpGender === suffix && this.playerJumpVisual) return;
    // Tear down any previously-loaded jump character (could be
    // the other gender if init() flipped, or a stale instance).
    this.disposeJumpCharacter();
    // Stake out this load so concurrent calls for the same gender
    // don't double-fetch and concurrent calls for the OTHER gender
    // know to bail when this one finishes.
    this.loadedJumpGender = suffix;
    try {
      const gltf = await new GLTFLoader().loadAsync(
        `/models/runner_jump_${suffix}.glb`,
      );
      // If gender flipped while we were loading, drop this one on
      // the floor — the newer load is in progress, which will
      // settle the readiness flag itself.
      if (this.loadedJumpGender !== suffix) return;
      const clip = gltf.animations[0];
      if (!clip) {
        // eslint-disable-next-line no-console
        console.debug(`[runner] jump glb (${suffix}) has no animations`);
        this.loadedJumpGender = '';
        this.jumpAssetReady = true;
        this.checkAssetsReady();
        return;
      }
      await this.installJumpCharacter(gltf.scene, clip);
      this.jumpAssetReady = true;
      this.checkAssetsReady();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug(`[runner] jump character (${suffix}) load failed`, e);
      this.loadedJumpGender = '';
      // Procedural jump pose handles the load-failure case at
      // runtime — still flag the asset as "settled" so the
      // loading overlay clears.
      this.jumpAssetReady = true;
      this.checkAssetsReady();
    }
  }

  /**
   * Tear down the current jump character: remove from scene,
   * dispose mixer, dispose geometries + materials + textures.
   * Safe to call when nothing is loaded — it's a no-op.
   */
  private disposeJumpCharacter() {
    if (this.playerJumpMixer) {
      this.playerJumpMixer.stopAllAction();
      this.playerJumpMixer.uncacheRoot(this.playerJumpMixer.getRoot());
      this.playerJumpMixer = undefined;
      this.playerJumpAction = undefined;
    }
    if (this.playerJumpVisual) {
      this.playerJumpVisual.removeFromParent();
      this.playerJumpVisual.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
          else this.disposeMaterial(m);
        }
      });
      this.playerJumpVisual = undefined;
    }
  }

  /**
   * Take the loaded jump-character FBX + clip, apply the same
   * scale + rotation + foot-alignment we do for the running
   * character (so they render at the same screen position), parent
   * into the collider hidden, and prepare its AnimationMixer with
   * a LoopOnce + clampWhenFinished action.
   */
  private async installJumpCharacter(
    model: THREE.Group,
    clip: THREE.AnimationClip,
  ) {
    // Same SkinnedMesh frustum-cull workaround as the running
    // character (bounding sphere reflects bind pose, can clip
    // when the body deforms past it).
    model.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
    });

    // Scale to fit the collider — same math as tryLoadGltfPlayer.
    const bbox = new THREE.Box3().setFromObject(model);
    const rawHeight = Math.max(0.01, bbox.max.y - bbox.min.y);
    const scale = PLAYER.HEIGHT / rawHeight;
    model.scale.setScalar(scale);
    // Mixamo characters face +Z; we want them running into -Z.
    model.rotation.y = Math.PI;
    // Drop the model into the collider with feet at the bottom.
    model.position.y = -PLAYER.HEIGHT / 2;
    // Hidden until the player jumps.
    model.visible = false;
    this.player.add(model);
    model.updateMatrixWorld(true);

    // Foot-bone alignment so feet sit on the ground plane (same
    // technique as the running character — Box3 ignores skinning,
    // bone positions don't).
    let lowestFootWorldY: number | null = null;
    const probe = new THREE.Vector3();
    model.traverse((obj) => {
      if (!(obj instanceof THREE.Bone)) return;
      const n = obj.name.toLowerCase();
      if (n.includes('toe') || n.includes('foot') || n.includes('ankle')) {
        obj.getWorldPosition(probe);
        if (lowestFootWorldY === null || probe.y < lowestFootWorldY) {
          lowestFootWorldY = probe.y;
        }
      }
    });
    if (lowestFootWorldY !== null) {
      model.position.y += 0 - lowestFootWorldY;
    }

    this.playerJumpVisual = model;
    this.playerJumpClipDuration = clip.duration;

    // Mixer + action setup. Action plays once per jump; we
    // reset+play it on takeoff and rely on clampWhenFinished to
    // hold the landing frame if the player's still airborne when
    // it ends. The mixer is only ticked while the jump character
    // is visible (see update()'s tick guard).
    this.playerJumpMixer = new THREE.AnimationMixer(model);
    const action = this.playerJumpMixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    this.playerJumpAction = action;

    // Pre-warm GPU + animation state so the first jump doesn't
    // hitch on the first canvas render. Three phases in order:
    //
    //   1. `renderer.initTexture(t)` for every texture on every
    //      material of the jump character — explicit texImage2D
    //      upload, no render-pass required.
    //   2. `await renderer.compileAsync(scene, camera)` for
    //      shader compile + link. compileAsync uses
    //      `KHR_parallel_shader_compile` to actually POLL until
    //      shaders are GPU-ready (sync compile() only queues).
    //      Mixer is also pre-ticked here so AnimationMixer's
    //      first-binding pass happens now.
    //   3. One real render to the canvas FBO with the jump
    //      character visible — primes Chrome's canvas FBO state
    //      cache (off-screen render targets use a different FBO
    //      and don't fully warm the canvas path).
    //
    // Caveat: on desktop Chrome with ANGLE → D3D11 translation,
    // even all of the above isn't enough to fully eliminate the
    // first-frame hitch — ANGLE does additional D3D-side shader
    // optimisation on first canvas draw that we can't control
    // from JS. Mobile WebViews use native GLES drivers (no ANGLE)
    // and don't have this problem. The runner's production
    // target is the in-app WebView, so this is a dev-only
    // wart.

    // 1. Force-upload every texture on the jump character.
    const seenTextures = new Set<THREE.Texture>();
    model.traverse((obj) => {
      const meshObj = obj as THREE.Mesh;
      if (!meshObj.material) return;
      const mats = Array.isArray(meshObj.material)
        ? meshObj.material
        : [meshObj.material];
      for (const mat of mats) {
        // Walk every property; any Texture instance gets uploaded.
        // Mixamo materials carry map / normalMap / specularMap /
        // glossinessMap / emissiveMap depending on the export
        // variant, plus a few others — too many to enumerate by
        // name, so we just sniff for `.isTexture`.
        for (const key of Object.keys(mat)) {
          const value = (mat as unknown as Record<string, unknown>)[key];
          if (
            value &&
            typeof value === 'object' &&
            (value as THREE.Texture).isTexture &&
            !seenTextures.has(value as THREE.Texture)
          ) {
            seenTextures.add(value as THREE.Texture);
            this.renderer.initTexture(value as THREE.Texture);
          }
        }
      }
    });

    // 2. Shader compile + link — but `compile()` only QUEUES
    //    the compilation; on Chrome the GPU process compiles
    //    shaders asynchronously and the first canvas render
    //    BLOCKS until they're ready. The previous canvas-sized
    //    off-screen render didn't help because rendering to a
    //    different framebuffer doesn't fully prime the canvas
    //    FBO's shader cache.
    //
    //    `compileAsync()` (Three.js r152+) uses the WebGL
    //    extension `KHR_parallel_shader_compile` to actually
    //    POLL the GPU process until all shaders are confirmed
    //    ready. Awaiting it pushes the wait time to install
    //    time instead of the first jump.
    model.visible = true;
    this.playerJumpAction.play();
    this.playerJumpMixer.update(0);
    // compileAsync returns a Promise that resolves when every
    // shader program for every visible object has been confirmed
    // GPU-ready. This is the missing piece — previously we were
    // only doing the sync `compile()` which doesn't wait.
    await this.renderer.compileAsync(this.scene, this.camera);

    // 3. CRITICAL — render once to the CANVAS framebuffer itself.
    //    Off-screen WebGLRenderTarget renders use a different FBO,
    //    so any FBO-specific GPU state caching (Chrome's canvas
    //    composition path, framebuffer attachment validation, etc.)
    //    isn't primed by them. The diagnostic showed frame 1's
    //    canvas render was 713 ms even after textures + shaders
    //    were fully prepped via off-screen pre-warm. Only an actual
    //    canvas render with the jump character visible primes it.
    //
    //    The user momentarily sees the jump character on screen
    //    instead of the runner. With the swipe-to-start input-hint
    //    overlay up and the runner running in place at the same
    //    position, the 1-frame swap is barely noticeable — and we
    //    immediately swap back to the runner before the next rAF
    //    tick.
    const runnerWasVisible = this.playerVisual?.visible ?? true;
    if (this.playerVisual) this.playerVisual.visible = false;
    this.renderer.render(this.scene, this.camera);
    if (this.playerVisual) this.playerVisual.visible = runnerWasVisible;

    // Reset the action so the first real jump starts at frame 0.
    this.playerJumpAction.stop();
    this.playerJumpAction.reset();
    // Hide again until the player jumps.
    model.visible = false;
  }

  /**
   * Load the "falling" character — full Mixamo "with skin" GLB
   * carrying the death/fall animation. Mirrors `loadJumpCharacter`
   * exactly: separate entity parented under the collider, swapped
   * in via a visibility flip, runs its own embedded animation on
   * its own native skeleton (sidesteps cross-FBX bind-pose drift
   * the way the jump character does).
   *
   * Plays once on game-over. The Flutter game-over panel is only
   * posted after the clip's `finished` event fires — so the player
   * sees their character collapse before the play-again sheet
   * appears.
   *
   * Gender-aware: `runner_fall_male.glb` for male/empty/other,
   * `runner_fall_female.glb` for female. Disposes any previously
   * loaded fall character before swapping.
   */
  private async loadFallCharacter(gender: string) {
    const suffix = gender === 'female' ? 'female' : 'male';
    // No-op if we already have this gender's fall character.
    if (this.loadedFallGender === suffix && this.playerFallVisual) return;
    // Tear down any previously-loaded fall character (other gender
    // or stale instance).
    this.disposeFallCharacter();
    // Stake out this load so concurrent calls for the same gender
    // don't double-fetch and concurrent calls for the OTHER gender
    // know to bail when this one finishes.
    this.loadedFallGender = suffix;
    try {
      const gltf = await new GLTFLoader().loadAsync(
        `/models/runner_fall_${suffix}.glb`,
      );
      // If gender flipped while we were loading, drop this one on
      // the floor — the newer load is in progress.
      if (this.loadedFallGender !== suffix) return;
      const clip = gltf.animations[0];
      if (!clip) {
        // eslint-disable-next-line no-console
        console.debug(`[runner] fall glb (${suffix}) has no animations`);
        this.loadedFallGender = '';
        this.fallAssetReady = true;
        this.checkAssetsReady();
        return;
      }
      await this.installFallCharacter(gltf.scene, clip);
      this.fallAssetReady = true;
      this.checkAssetsReady();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug(`[runner] fall character (${suffix}) load failed`, e);
      this.loadedFallGender = '';
      // Fall is an enhancement, not a blocker — game-over still fires
      // immediately when there's no fall character to play. Flag as
      // "settled" so the loading overlay clears.
      this.fallAssetReady = true;
      this.checkAssetsReady();
    }
  }

  /**
   * Tear down the current fall character: remove from scene,
   * dispose mixer, dispose geometries + materials + textures.
   * Safe to call when nothing is loaded — it's a no-op.
   */
  private disposeFallCharacter() {
    if (this.playerFallMixer) {
      this.playerFallMixer.stopAllAction();
      this.playerFallMixer.uncacheRoot(this.playerFallMixer.getRoot());
      this.playerFallMixer = undefined;
      this.playerFallAction = undefined;
    }
    if (this.playerFallVisual) {
      this.playerFallVisual.removeFromParent();
      this.playerFallVisual.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
          else this.disposeMaterial(m);
        }
      });
      this.playerFallVisual = undefined;
    }
  }

  /**
   * Same pipeline as `installJumpCharacter` (scale + rotation +
   * foot-alignment + LoopOnce action + pre-warm pass) PLUS one
   * extra wire-up: a `finished` event listener on the mixer that
   * fires `postGameOverFromFall()`, which is what actually pushes
   * the game-over payload to Flutter.
   */
  private async installFallCharacter(
    model: THREE.Group,
    clip: THREE.AnimationClip,
  ) {
    // SkinnedMesh frustum-cull workaround — same as the running +
    // jump characters.
    model.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
    });

    // Scale to fit the collider.
    const bbox = new THREE.Box3().setFromObject(model);
    const rawHeight = Math.max(0.01, bbox.max.y - bbox.min.y);
    const scale = PLAYER.HEIGHT / rawHeight;
    model.scale.setScalar(scale);
    // Mixamo characters face +Z; we want -Z (running into screen).
    model.rotation.y = Math.PI;
    // Drop into collider with feet at the bottom.
    model.position.y = -PLAYER.HEIGHT / 2;
    // Hidden until game-over.
    model.visible = false;
    this.player.add(model);
    model.updateMatrixWorld(true);

    // Foot-bone alignment so feet sit on the ground plane.
    let lowestFootWorldY: number | null = null;
    const probe = new THREE.Vector3();
    model.traverse((obj) => {
      if (!(obj instanceof THREE.Bone)) return;
      const n = obj.name.toLowerCase();
      if (n.includes('toe') || n.includes('foot') || n.includes('ankle')) {
        obj.getWorldPosition(probe);
        if (lowestFootWorldY === null || probe.y < lowestFootWorldY) {
          lowestFootWorldY = probe.y;
        }
      }
    });
    if (lowestFootWorldY !== null) {
      model.position.y += 0 - lowestFootWorldY;
    }

    this.playerFallVisual = model;

    // Mixer + action setup. LoopOnce + clampWhenFinished so the
    // character holds the final dead pose until restart() hides
    // them. Mixer is only ticked while the fall character is
    // visible (gated in the rAF loop by `isFalling`).
    this.playerFallMixer = new THREE.AnimationMixer(model);
    const action = this.playerFallMixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    this.playerFallAction = action;

    // CRITICAL — wire the "animation done" → "ship game-over to
    // Flutter" handoff. Without this listener, isFalling would
    // never flip false and the game-over panel would never show.
    this.playerFallMixer.addEventListener('finished', () => {
      this.postGameOverFromFall();
    });

    // Pre-warm GPU + animation state so the first death doesn't
    // hitch on the first canvas render. Same 3-phase pipeline as
    // the jump character (see installJumpCharacter for the long
    // explanation): initTexture → compileAsync → canvas FBO warm.

    // 1. Force-upload every texture on the fall character.
    const seenTextures = new Set<THREE.Texture>();
    model.traverse((obj) => {
      const meshObj = obj as THREE.Mesh;
      if (!meshObj.material) return;
      const mats = Array.isArray(meshObj.material)
        ? meshObj.material
        : [meshObj.material];
      for (const mat of mats) {
        for (const key of Object.keys(mat)) {
          const value = (mat as unknown as Record<string, unknown>)[key];
          if (
            value &&
            typeof value === 'object' &&
            (value as THREE.Texture).isTexture &&
            !seenTextures.has(value as THREE.Texture)
          ) {
            seenTextures.add(value as THREE.Texture);
            this.renderer.initTexture(value as THREE.Texture);
          }
        }
      }
    });

    // 2. Shader compile + link via compileAsync (KHR_parallel_shader_compile).
    model.visible = true;
    this.playerFallAction.play();
    this.playerFallMixer.update(0);
    await this.renderer.compileAsync(this.scene, this.camera);

    // 3. One canvas FBO render with the fall character visible so
    //    Chrome's canvas-path state is primed (off-screen FBO renders
    //    don't fully prime it — see installJumpCharacter for the
    //    detailed explanation of why ANGLE makes this necessary).
    const runnerWasVisible = this.playerVisual?.visible ?? true;
    if (this.playerVisual) this.playerVisual.visible = false;
    this.renderer.render(this.scene, this.camera);
    if (this.playerVisual) this.playerVisual.visible = runnerWasVisible;

    // Reset the action so the first real death starts at frame 0,
    // and clear any pre-warm 'finished' that fired during the prime
    // render (compileAsync + render at update(0) shouldn't trip it,
    // but defensive: postGameOverFromFall is a no-op when there's
    // no pendingGameOver).
    this.playerFallAction.stop();
    this.playerFallAction.reset();
    // Hide again until game-over.
    model.visible = false;
  }

  /**
   * Cache references to the bones our procedural jump pose will
   * modify each frame. Looked up by name suffix so the same code
   * works whether bones are sanitized (mixamorig7Hips) or kept
   * raw (mixamorig7:Hips) by the loader.
   *
   * Called from `tryLoadGltfPlayer` after the Mixamo FBX is in
   * place. Safe to re-run on gender swap — clears any stale bone
   * references from the previous character.
   */
  private cacheJumpPoseBones() {
    this.jumpPoseBones = [];
    if (!this.playerVisual) return;
    const targets = new Set([
      'LeftUpLeg',
      'RightUpLeg',
      'LeftLeg',
      'RightLeg',
      'LeftArm',
      'RightArm',
      'Spine',
    ]);
    this.playerVisual.traverse((obj) => {
      if (!(obj instanceof THREE.Bone)) return;
      for (const t of targets) {
        if (obj.name.endsWith(t)) {
          this.jumpPoseBones.push(obj);
          return;
        }
      }
    });
  }

  /**
   * Layer a procedural jump pose on top of whatever the run
   * animation set this frame. Called from `update()` AFTER
   * `playerMixer.update(dt)` so we modify the run-driven bone
   * rotations directly, not the input the mixer sees.
   *
   * Intensity is a bell curve based on actual airborne height —
   * 0 at takeoff/landing, 1 at apex. So the pose ramps in as the
   * character rises, then ramps back to bind/run as they fall.
   */
  private applyAdditiveJumpPose() {
    if (this.jumpPoseBones.length === 0) return;
    const heightAbove = Math.max(0, this.playerY - PLAYER.BASE_Y);
    if (heightAbove < 0.001) return;
    // Predicted peak height under current jumpVelocity + gravity.
    // h_max = v² / (2g). Defensive: skip if jumpVelocity ~ 0.
    const peakH =
      (this.jumpVelocity * this.jumpVelocity) /
      (2 * Math.abs(PLAYER.GRAVITY));
    if (peakH < 0.01) return;
    // Bell curve: peaks at 1 when heightAbove === peakH, falls off
    // on both sides. clamp01(height/peak) gives only the rising
    // half; we want both halves so use sin(πx) of normalised height.
    const norm = Math.min(1, heightAbove / peakH);
    const intensity = Math.sin(norm * Math.PI);

    // Each pair of bones modified by the same delta — additive
    // rotation on top of the run animation's quaternion. Numbers
    // tuned so the pose reads as a "leap" without overriding the
    // run cycle so hard that the limbs look broken.
    for (const bone of this.jumpPoseBones) {
      const n = bone.name;
      if (n.endsWith('LeftUpLeg') || n.endsWith('RightUpLeg')) {
        // Tuck knees up toward the chest (negative X = forward
        // rotation around the hip).
        bone.rotation.x -= 0.7 * intensity;
      } else if (n.endsWith('LeftLeg') || n.endsWith('RightLeg')) {
        // Bend the knee (positive X relative to the leg's local).
        bone.rotation.x += 0.9 * intensity;
      } else if (n.endsWith('LeftArm') || n.endsWith('RightArm')) {
        // Swing arms backward.
        bone.rotation.x += 0.4 * intensity;
      } else if (n.endsWith('Spine')) {
        // Slight forward lean of the torso.
        bone.rotation.x += 0.15 * intensity;
      }
    }
  }

  /**
   * One-shot load of the dancer-obstacle character GLB (the
   * dancefloor dancer that blocks the lane). Failure is silently
   * swallowed — spawnObstacle's dancer branch falls back to the
   * procedural humanoid (capsule torso + sphere head + crossed
   * arms) so the game keeps working without the model.
   */
  private async loadDancerObstacleModel() {
    try {
      this.dancerObstacleGltf =
        await new GLTFLoader().loadAsync('/models/runner_dancer.glb');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[runner] dancer obstacle model load failed', e);
    }
  }

  /**
   * One-shot load of the bouncer character GLB (the actual,
   * intimidating bouncer). Failure is silently swallowed —
   * spawnObstacle's bouncer branch falls back to the procedural
   * humanoid so the game keeps working without the model.
   */
  private async loadBouncerModel() {
    try {
      this.bouncerGltf =
        await new GLTFLoader().loadAsync('/models/runner_bouncer.glb');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[runner] bouncer model load failed', e);
    }
  }

  /**
   * Build (or rebuild) the visible character. Two-phase:
   *
   * 1) Synchronous capsule-stack placeholder — guarantees the
   *    player renders instantly, no loading state on screen.
   * 2) Background GLB upgrade — `tryLoadGltfPlayer` fetches
   *    `/models/runner_<gender>.glb` and, if present + valid,
   *    disposes the placeholder and replaces it with a fully
   *    rigged Mixamo character whose run animation plays on an
   *    AnimationMixer.
   *
   * If the GLB is missing (404) or fails to load, the placeholder
   * stays — the manual `playerLimbs` swing in update() handles
   * the run cycle for it.
   */
  private buildPlayerVisual(gender: string) {
    this.buildPlayerVisualPlaceholder(gender);
    // New gender → new assets → switch the HUD back into loading
    // state until all three settle.
    this.playerAssetReady = false;
    this.jumpAssetReady = false;
    this.fallAssetReady = false;
    this.assetsReady = false;
    this.hud.setLoading(true);
    // Fire-and-forget. If the GLB exists, it'll swap in shortly;
    // if not, the placeholder stays and the player is none the wiser.
    this.tryLoadGltfPlayer(gender);
    // Same pattern for the jump character — gender-aware load so
    // the female player gets the female jump animation. Skipped
    // (returns early) when the requested gender's jump character
    // is already loaded, so flicking gender back and forth via
    // init() doesn't re-fetch.
    this.loadJumpCharacter(gender);
    // Same pattern for the fall character (game-over death animation).
    this.loadFallCharacter(gender);
  }

  /**
   * Called from `tryLoadGltfPlayer` + `loadJumpCharacter` once
   * each of those settles (success OR final failure — placeholder
   * + procedural fallback are still valid play states). When both
   * have settled, flips `assetsReady` true and tells the HUD to
   * switch from "Loading…" to the "Swipe to start" hint.
   */
  private checkAssetsReady() {
    if (this.assetsReady) return;
    if (!this.playerAssetReady || !this.jumpAssetReady || !this.fallAssetReady)
      return;
    this.assetsReady = true;
    this.hud.setLoading(false);
  }

  /**
   * Synchronous capsule-stack character. The fallback when no GLB
   * is available, and the placeholder shown during the brief GLB
   * load window. Owns `playerVisual` + `playerLimbs`.
   *
   * Branches on gender for the silhouette:
   *   - 'female' → little black dress, bare arms, long hair,
   *     gold necklace, heels.
   *   - 'male' / 'other' / '' → tailored suit, white shirt, short
   *     hair, dress shoes.
   *
   * Disposes any existing visual before building the new one so
   * subsequent calls (e.g. init() arriving with a gender) don't
   * leak GPU memory.
   */
  /**
   * Build the velvet-rope nightclub barrier on both sides of the
   * runway. One Group per stanchion holding shared geometries +
   * shared materials (so the 36-instance pool is just ~4 geom +
   * 2 mat in GPU memory; the 36 meshes are cheap instances on
   * top).
   *
   * Each unit's rope tube extends 5 m BEHIND its post — so as
   * the chain scrolls forward, the rope from this stanchion
   * visually meets the next stanchion's post. The whole pool
   * is interleaved (L0, R0, L1, R1, ...) in `velvetRopes` so
   * one update-loop pass scrolls both rows together.
   */
  /**
   * Build the LED ceiling — Tape London's iconic dense grid of
   * small circular lights overhead, colour-cycling through pink
   * / purple / blue / red on a moving wave.
   *
   * Implementation: one big horizontal plane, custom shader
   * that procedurally renders a 40×200 grid of dots (~8,000
   * lights) in a single draw call. Per-cell phase varies with
   * (x, y, time) so adjacent cells are never the same colour
   * and the row of cells reads as a flowing pattern travelling
   * along the runway.
   *
   * Performance: a ShaderMaterial on a single plane is much
   * cheaper than InstancedMesh of 8,000 disc geometries — the
   * GPU does everything in the fragment shader.
   */
  /**
   * Floor text — "ALL ROADS LEAD TO TAPE" painted across the
   * runway, spanning the 3 lanes, recurring every
   * `worldFloorTextSpacingZ` metres. Replaces the old horizon
   * billboard with something the player runs OVER instead of past.
   *
   * Implementation: one shared CanvasTexture (Embossing Tape font,
   * same red-glow + cream-core colour pair as the old sign), mapped
   * onto a 6 m × 1.5 m PlaneGeometry. The plane is rotated -π/2 on
   * X so it lies flat on the floor, then a pool of these meshes is
   * spaced along the runway and scrolled in the standard 90 m wrap.
   *
   * Async because the font fetch is async. Fire-and-forget — the
   * text pops in once the FontFace loads. If the font load fails,
   * the canvas falls back to a generic sans-serif (legible but not
   * on-brand).
   *
   * Spacing of 0 or less disables the pool entirely.
   */
  private async buildFloorText() {
    const SPACING = this.worldFloorTextSpacingZ;
    if (!(SPACING > 0)) return;

    // 1. Load the Embossing Tape font via FontFace, same as the
    //    previous horizon sign. Idempotent — adding the same face
    //    twice is harmless.
    const FONT_FAMILY = 'TapeRunnerSign';
    try {
      const face = new FontFace(
        FONT_FAMILY,
        'url(/fonts/embossing-tape-3.ttf)',
      );
      await face.load();
      (document.fonts as FontFaceSet).add(face);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[runner] floor-text font load failed', e);
    }

    // 2. Render the text onto a wide canvas — same red-glow over
    //    cream-core treatment as the legacy horizon sign. NO dark
    //    backing rectangle here: we want the text to read as
    //    painted directly onto the runway floor, not as a billboard
    //    that happens to be lying down. Transparent background lets
    //    the floor stripes show through around the letters.
    const PIXEL_W = 2048;
    const PIXEL_H = 512;
    const canvas = document.createElement('canvas');
    canvas.width = PIXEL_W;
    canvas.height = PIXEL_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, PIXEL_W, PIXEL_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Adaptive font sizing — start at 260 px and shrink in 8 px
    // steps until the rendered text fits inside the canvas with a
    // safe margin. Necessary because the Embossing Tape glyphs are
    // much wider than a typical sans-serif at the same point size;
    // a fixed 260 px clips "ALL ROADS LEAD TO TAPE" at both ends
    // (the user's screenshot showed exactly that). Looping with
    // measureText is robust to future font swaps + browser metric
    // variation.
    const TEXT = 'ALL ROADS LEAD TO TAPE';
    const SIDE_MARGIN = 60;
    const MAX_TEXT_W = PIXEL_W - 2 * SIDE_MARGIN;
    let fontSize = 260;
    ctx.font = `${fontSize}px "${FONT_FAMILY}", sans-serif`;
    let measured = ctx.measureText(TEXT).width;
    while (measured > MAX_TEXT_W && fontSize > 60) {
      fontSize -= 8;
      ctx.font = `${fontSize}px "${FONT_FAMILY}", sans-serif`;
      measured = ctx.measureText(TEXT).width;
    }
    // Pass 1: warm red glow halo.
    ctx.shadowColor = '#ff3050';
    ctx.shadowBlur = 48;
    ctx.fillStyle = '#ff5566';
    ctx.fillText(TEXT, PIXEL_W / 2, PIXEL_H / 2);
    // Pass 2: cream-pink core — bright fill on top of the glow.
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffe0e2';
    ctx.fillText(TEXT, PIXEL_W / 2, PIXEL_H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;

    // 3. Build the pool. Plane is 6 m wide × 1.5 m deep — spans the
    //    3 lanes (lane separators at x = ±1.2, outermost lane edges
    //    at x = ±3) with a touch of margin. The plane is rotated
    //    -π/2 on X so it lies flat on the floor; in that
    //    orientation the canvas's local +Y axis maps to world -Z
    //    (forward / away from the camera), so default-orientation
    //    text reads correctly to a player approaching it on the
    //    runway. y = 0.025 sits just above the floor stripes
    //    (y = 0.02) so the text composites over them.
    const PLANE_W = 6.0;
    const PLANE_D = 1.5;
    const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_D);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      // Disable scene fog on the text — same trick as the legacy
      // sign so the writing stays readable when it's still far down
      // the runway.
      fog: false,
    });

    const SPACING_Z = Math.max(2.0, SPACING);
    const POOL_LENGTH = 90; // matches the rest of the wall scenery
    const NUM = Math.max(1, Math.floor(POOL_LENGTH / SPACING_Z));
    // Start the first band a few metres ahead of the camera so it
    // scrolls into view rather than sitting underneath the player
    // on game start.
    const START_Z = -SPACING_Z * 0.5;
    for (let i = 0; i < NUM; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0.025, START_Z - i * SPACING_Z);
      this.scene.add(mesh);
      this.floorTexts.push(mesh);
    }
  }

  /**
   * Mount procedurally-painted framed portraits along both side
   * walls. The player sees framed faces flash by at speed — no
   * detail required, the abstract head silhouette + frame is
   * enough to read as "art on the wall".
   *
   * Implementation: 6 distinct portrait CanvasTextures shared
   * across all instances (so total texture memory stays small),
   * each instance is a single plane with the texture mapped. The
   * frame is painted directly into the canvas so no extra
   * geometry per portrait.
   *
   * Portraits are stored in `wallPortraits` and scrolled in the
   * update loop alongside the floor stripes / podiums / ropes,
   * wrapping at z > 4 by subtracting 90 m so they pass past the
   * runner instead of staying locked relative to the camera.
   */
  private buildWallArt(wallX: number) {
    // Per-portrait canvas resolution.
    const PIXEL = 256;

    // 6 distinct portrait textures. Dark / desaturated palette so
    // the figure inside is hard to make out at speed — they read
    // as "framed portraits, can't quite tell who" rather than
    // identifiable faces. Darker skin tones across the board.
    // Each portrait now has a shirt colour so the figure isn't
    // topless.
    // Skin tones span dark brown → near-black across the 6 variants
    // per design request. The eye + mouth marks (#100808) become
    // invisible on the darkest skins — that's fine, the portraits
    // are background art seen at speed; "vague face" is the intent.
    const palettes: Array<{
      bg: string;
      skin: string;
      hair: string;
      shirt: string;
      frame: string;
      frameInner: string;
    }> = [
      // Warm sepia + black hair + earth-tone shirt — dark cocoa skin
      { bg: '#1a1108', skin: '#3a2010', hair: '#0c0604',
        shirt: '#2a1810', frame: '#08050a', frameInner: '#3a2814' },
      // Cool blue + black hair + navy shirt — very dark warm skin
      { bg: '#10141c', skin: '#2a1408', hair: '#050204',
        shirt: '#10182a', frame: '#04060a', frameInner: '#1c2838' },
      // Olive green + dark blonde + olive shirt — dark brown skin
      { bg: '#161810', skin: '#3a1c0c', hair: '#583c14',
        shirt: '#202418', frame: '#0a0c08', frameInner: '#3a3e22' },
      // Burgundy red + dark hair + crimson shirt — near-black skin
      { bg: '#1c0c10', skin: '#1c0c04', hair: '#080404',
        shirt: '#321218', frame: '#0a0408', frameInner: '#421e28' },
      // Slate grey + dark red hair + grey shirt — very dark skin
      { bg: '#16161a', skin: '#241208', hair: '#3a1408',
        shirt: '#1c1c20', frame: '#060608', frameInner: '#2a2a32' },
      // Deep purple + dark silver hair + plum shirt — dark cocoa
      { bg: '#16101c', skin: '#321a0c', hair: '#4a4a52',
        shirt: '#24162a', frame: '#080408', frameInner: '#3a2848' },
    ];

    const textures = palettes.map((p) => {
      const canvas = document.createElement('canvas');
      canvas.width = PIXEL;
      canvas.height = PIXEL;
      const ctx = canvas.getContext('2d');
      if (!ctx) return new THREE.CanvasTexture(canvas);

      // Frame — outer dark, inner trim, inner dark backing
      ctx.fillStyle = p.frame;
      ctx.fillRect(0, 0, PIXEL, PIXEL);
      ctx.fillStyle = p.frameInner;
      ctx.fillRect(14, 14, PIXEL - 28, PIXEL - 28);
      ctx.fillStyle = p.frame;
      ctx.fillRect(22, 22, PIXEL - 44, PIXEL - 44);

      // Portrait inset
      const PAD = 28;
      const innerW = PIXEL - 2 * PAD;
      const innerH = PIXEL - 2 * PAD;

      // Dark background panel
      ctx.fillStyle = p.bg;
      ctx.fillRect(PAD, PAD, innerW, innerH);

      // Head — oval, centred in upper-mid of the portrait
      const headCX = PIXEL / 2;
      const headCY = PAD + innerH * 0.55;
      const headRX = innerW * 0.28;
      const headRY = innerH * 0.34;
      ctx.fillStyle = p.skin;
      ctx.beginPath();
      ctx.ellipse(headCX, headCY, headRX, headRY, 0, 0, Math.PI * 2);
      ctx.fill();

      // Hair — crescent over the top of the head
      ctx.fillStyle = p.hair;
      ctx.beginPath();
      ctx.ellipse(
        headCX,
        headCY - headRY * 0.4,
        headRX * 1.05,
        headRY * 0.85,
        0,
        Math.PI,
        Math.PI * 2,
      );
      ctx.fill();

      // Shirt — wider lower-half ellipse covering shoulders + bust,
      // drawn in the shirt colour (was skin = topless previously).
      ctx.fillStyle = p.shirt;
      ctx.beginPath();
      ctx.ellipse(
        headCX,
        headCY + headRY * 1.5,
        headRX * 1.8,
        headRY * 1.0,
        0,
        Math.PI,
        Math.PI * 2,
      );
      ctx.fill();
      // Neck — small skin patch between head and shirt collar
      ctx.fillStyle = p.skin;
      ctx.fillRect(
        headCX - headRX * 0.25,
        headCY + headRY * 0.7,
        headRX * 0.5,
        headRY * 0.35,
      );

      // Eyes — small dark dots. Low-contrast against the darkened
      // skin so they read as "vague face" rather than caricature.
      ctx.fillStyle = '#100808';
      const eyeY = headCY - headRY * 0.05;
      const eyeOffset = headRX * 0.4;
      ctx.beginPath();
      ctx.arc(headCX - eyeOffset, eyeY, headRX * 0.07, 0, Math.PI * 2);
      ctx.arc(headCX + eyeOffset, eyeY, headRX * 0.07, 0, Math.PI * 2);
      ctx.fill();
      // Mouth — small dark line
      ctx.fillRect(
        headCX - headRX * 0.15,
        headCY + headRY * 0.45,
        headRX * 0.30,
        headRX * 0.06,
      );

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    });

    const PORTRAIT_SIZE = 2.016;     // 2.016 × 2.016 m (44% over base — two 20% bumps)
    const PORTRAIT_Y = 3.5;           // mid-height on the wall (0.5 m below original eye-level)
    // Pool length stays 90 m to match the rest of the wall scenery's
    // wrap distance. Admin-tunable spacing controls how DENSE the
    // portraits are within that 90 m — smaller value = more
    // frequent. Spacing of 0 or less disables the pool entirely.
    const PORTRAIT_SPACING_Z = Math.max(0.5, this.worldPortraitSpacingZ);
    // Pool covers the 90 m wrap range; count derives from the
    // spacing so admin tuning naturally changes density without
    // breaking the wrap math. (Was hard-coded NUM_PER_WALL = 10 at
    // 9 m spacing = 90 m, which is what the default still yields.)
    const POOL_LENGTH_PORTRAITS = 90;
    const NUM_PER_WALL =
        Math.max(1, Math.floor(POOL_LENGTH_PORTRAITS / PORTRAIT_SPACING_Z));

    const portraitGeo = new THREE.PlaneGeometry(PORTRAIT_SIZE, PORTRAIT_SIZE);
    const pickTex = (i: number) => textures[i % textures.length];

    for (let side = 0; side < 2; side++) {
      const sideX = side === 0 ? -wallX : wallX;
      // Faces inward toward the runway centre.
      const facingRotY = side === 0 ? Math.PI / 2 : -Math.PI / 2;
      // Side-offset on the texture-picker so a given Z doesn't
      // pick the same portrait on both walls.
      const sideTexOffset = side * 7;

      for (let i = 0; i < NUM_PER_WALL; i++) {
        const z = -(i + 1) * PORTRAIT_SPACING_Z;
        const tex = pickTex(i + sideTexOffset);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          toneMapped: false,
        });
        const portrait = new THREE.Mesh(portraitGeo, mat);
        portrait.position.set(
          // Float 0.02 m off the wall so it doesn't z-fight.
          sideX + (side === 0 ? 0.02 : -0.02),
          PORTRAIT_Y,
          z,
        );
        portrait.rotation.y = facingRotY;
        this.scene.add(portrait);
        this.wallPortraits.push(portrait);
      }
    }
  }

  /**
   * Build VIP booth tables along both side walls — a black sofa
   * (backrest + seat + sides), a gold cocktail table in front, and
   * a glowing bucket of bottles centred on the table. 4 booths per
   * wall on a 90 m wrap so they parallax past the runner.
   *
   * Bottle selection per bucket is deterministic-by-booth-index so
   * the same booth shows the same bottles every wrap (no jitter).
   * A methuselah (the giant bottle) takes the whole bucket alone;
   * otherwise the bucket holds a mix of champagne / magnum / vodka
   * pickup models (same models the runway uses, scaled down to bucket
   * size) plus the occasional tiny water bottle as a decorative prop.
   */
  private buildVIPBooths(wallX: number) {
    // Layout constants. Pool wraps at 90 m to match the other wall
    // scenery; booth count derives from the admin spacing so a
    // smaller value packs more booths into the same 90 m window.
    const BOOTH_SPACING_Z = Math.max(2.0, this.worldBoothSpacingZ);
    const POOL_LENGTH_BOOTHS = 90;
    const NUM_PER_WALL =
        Math.max(1, Math.floor(POOL_LENGTH_BOOTHS / BOOTH_SPACING_Z));
    const BOOTH_OFFSET_Z = -11;    // first booth's centre Z

    // Shared materials — black sofa, gold table, black bucket
    // with green-glow accents on half the booths + white-glow
    // accents on the other half.
    const sofaMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.75,
      metalness: 0.10,
    });
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x6a5018,
      roughness: 0.25,
      metalness: 0.85,
      emissive: 0x281a06,
      emissiveIntensity: 0.18,
    });
    const bucketMat = new THREE.MeshStandardMaterial({
      color: 0x070608,
      roughness: 0.55,
      metalness: 0.30,
    });
    // Two glow variants — green and white. Picked alternately
    // per booth (booth index parity).
    const glowMatGreen = new THREE.MeshBasicMaterial({
      color: 0x42ff80,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const glowMatWhite = new THREE.MeshBasicMaterial({
      color: 0xfaf5e8,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    // Deterministic small PRNG (mulberry32) seeded by booth index
    // so bottle selection is stable across re-wraps.
    const mulberry32 = (seed: number) => {
      let s = seed | 0;
      return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    // ── Bucket bottle pool ────────────────────────────────────
    // All bottles are built via the shared buildPickupVisual()
    // method so the booth shows the exact same silhouettes as
    // the runway pickups (champagne foil + green label + dark
    // glass, vodka with screw cap, vodka shot glass). Each entry
    // has a per-spec scale to fit the bottles into a bucket
    // (runway pickups are gameplay-prop-sized, ~3× real bottle
    // height; booth bottles are scaled to read like real bottles
    // sitting in a real ice bucket).
    //
    // Water is included as a small decorative prop at 0.2× of its
    // runway size (per design request — water is a tiny refresher
    // bottle among the bigger alcohol).
    type BottleKind =
      | 'champagne'
      | 'magnum'
      | 'methuselah'
      | 'vodkaBottle'
      | 'vodkaMini'
      | 'water';
    // Bottle scales bumped another 20% over the previous round
    // (last round was 0.55 / 0.50 / 0.85 / 0.20; now 0.66 / 0.60 /
    // 1.02 / 0.24). Water still tracks the "80% smaller than the
    // runway pickup" intent — 0.24 = 0.20 × 1.2 is the smallest
    // change here, since the user's "+20%" instruction is uniform.
    const bottleScales: Record<BottleKind, number> = {
      champagne: 0.66,
      magnum: 0.60,
      methuselah: 0.66, // hero single-bottle case
      vodkaBottle: 0.66,
      vodkaMini: 1.02,  // shot glasses are small — keep readable
      water: 0.24,      // small refresher prop
    };
    const pickBottles = (seed: number): BottleKind[] => {
      const rng = mulberry32(seed);
      // 12% chance the bucket holds a single methuselah (huge
      // bottle takes the whole bucket).
      if (rng() < 0.12) return ['methuselah'];
      // Otherwise 2–4 smaller bottles in random combination.
      const count = 2 + Math.floor(rng() * 3); // 2, 3, or 4
      // Weighted pool — champagne dominates, vodka common, water
      // rare so it reads as an accent rather than a frequent prop.
      const pool: BottleKind[] = [
        'champagne',
        'champagne',
        'champagne',
        'magnum',
        'vodkaBottle',
        'vodkaBottle',
        'vodkaMini',
        'water',
      ];
      const out: BottleKind[] = [];
      for (let i = 0; i < count; i++) {
        out.push(pool[Math.floor(rng() * pool.length)]);
      }
      return out;
    };

    const makeBottle = (kind: BottleKind): THREE.Group => {
      const spec = PICKUPS[kind];
      return this.buildPickupVisual(spec, bottleScales[kind]);
    };

    // ── Booth geometry — shared dims across all instances ───
    // Cumulative scale factors over the original design:
    //   Sofas — 1.2× (this round, bumped from baseline 1.0)
    //   Tables — 1.44× (1.2 × 1.2 over two rounds)
    //   Buckets — 1.8× (1.5 × 1.2 over two rounds)
    const SOFA_W = 4.4 * 1.2;        // along Z (5.28 m)
    const SOFA_BACK_H = 1.2 * 1.2;   // (1.44 m)
    const SOFA_BACK_DEPTH = 0.3 * 1.2; // perpendicular to wall (0.36 m)
    const SOFA_SEAT_H = 0.5 * 1.2;   // (0.60 m)
    const SOFA_SEAT_DEPTH = 1.0 * 1.2; // (1.20 m)
    const SOFA_SIDE_DEPTH = 1.0 * 1.2; // (1.20 m)
    const SOFA_SIDE_H = 0.7 * 1.2;   // (0.84 m)
    const SOFA_SIDE_W = 0.3 * 1.2;   // along Z (0.36 m)
    const TABLE_W = 1.2 * 1.44;      // along Z (1.728 m)
    const TABLE_DEPTH = 1.0 * 1.44;  // perpendicular to wall (1.44 m)
    const TABLE_H = 0.4 * 1.44;      // (0.576 m)
    const BUCKET_R = 0.22 * 1.8;     // (0.396 m)
    const BUCKET_H = 0.26 * 1.8;     // (0.468 m)

    // Pre-built shared geometries — one allocation, all booths
    // share to keep draw-state simple.
    const backrestGeo = new THREE.BoxGeometry(
      SOFA_BACK_DEPTH,
      SOFA_BACK_H,
      SOFA_W,
    );
    const seatGeo = new THREE.BoxGeometry(SOFA_SEAT_DEPTH, SOFA_SEAT_H, SOFA_W);
    const sideGeo = new THREE.BoxGeometry(
      SOFA_SIDE_DEPTH,
      SOFA_SIDE_H,
      SOFA_SIDE_W,
    );
    const tableGeo = new THREE.BoxGeometry(TABLE_DEPTH, TABLE_H, TABLE_W);
    const bucketGeo = new THREE.CylinderGeometry(
      BUCKET_R,
      BUCKET_R * 0.85,
      BUCKET_H,
      14,
    );
    // Glow disc — small flat plane sitting above the bucket rim
    // (inside-the-bucket suggestion) and another under the bucket
    // (light spill onto the table).
    const innerGlowGeo = new THREE.CircleGeometry(BUCKET_R * 0.9, 16);
    const underGlowGeo = new THREE.CircleGeometry(BUCKET_R * 1.4, 16);

    for (let side = 0; side < 2; side++) {
      // sideSign: -1 for left (x < 0), +1 for right
      const sideSign = side === 0 ? -1 : 1;
      // X position of the sofa centre (a bit inside the wall)
      const baseX = sideSign * (wallX - 1.2);
      // Booth components face inward toward the runway centre.
      // sofa back hugs the wall side, table sits closer to runway.
      // For the LEFT booth (sideSign = -1): wall is at -X, runway
      // is at +X, so backrest at MORE NEGATIVE X (further -X),
      // table at LESS NEGATIVE X (closer to runway). Sign math:
      //   backrestX = baseX + sideSign * 1.0
      //   tableX    = baseX - sideSign * 0.6

      for (let i = 0; i < NUM_PER_WALL; i++) {
        const z = BOOTH_OFFSET_Z - i * BOOTH_SPACING_Z;
        // Booth group — single root we can scroll + wrap.
        const booth = new THREE.Group();

        // ── Sofa: backrest against wall ──────────────────────
        const backrest = new THREE.Mesh(backrestGeo, sofaMat);
        backrest.position.set(
          sideSign * 1.0,
          SOFA_BACK_H / 2,
          0,
        );
        booth.add(backrest);
        // Seat in front of backrest (closer to runway centre)
        const seat = new THREE.Mesh(seatGeo, sofaMat);
        seat.position.set(
          sideSign * 0.35,
          SOFA_SEAT_H / 2,
          0,
        );
        booth.add(seat);
        // Two side returns — short bookends at each end of the
        // seat (Z extremes)
        for (const sideZ of [-SOFA_W / 2 + SOFA_SIDE_W / 2,
                              SOFA_W / 2 - SOFA_SIDE_W / 2]) {
          const sideRet = new THREE.Mesh(sideGeo, sofaMat);
          sideRet.position.set(
            sideSign * 0.35,
            SOFA_SIDE_H / 2,
            sideZ,
          );
          booth.add(sideRet);
        }

        // ── Gold cocktail table ──────────────────────────────
        const table = new THREE.Mesh(tableGeo, tableMat);
        const tableY = TABLE_H / 2;
        const tableX = -sideSign * 0.55; // toward runway centre
        table.position.set(tableX, tableY, 0);
        booth.add(table);

        // ── Bucket of bottles on the table ───────────────────
        const bucket = new THREE.Mesh(bucketGeo, bucketMat);
        const bucketY = TABLE_H + BUCKET_H / 2;
        bucket.position.set(tableX, bucketY, 0);
        booth.add(bucket);

        // Glow disc inside the bucket rim — facing up.
        const isGreen = (i + side) % 2 === 0;
        const glowMat = isGreen ? glowMatGreen : glowMatWhite;
        const innerGlow = new THREE.Mesh(innerGlowGeo, glowMat);
        innerGlow.position.set(tableX, TABLE_H + BUCKET_H - 0.005, 0);
        innerGlow.rotation.x = -Math.PI / 2;
        booth.add(innerGlow);
        // Glow disc under the bucket on the table top — facing up.
        const underGlow = new THREE.Mesh(underGlowGeo, glowMat);
        underGlow.position.set(tableX, TABLE_H + 0.001, 0);
        underGlow.rotation.x = -Math.PI / 2;
        booth.add(underGlow);

        // Bottles in the bucket. Seed by booth global index
        // (side × NUM_PER_WALL + i) so left/right at same Z get
        // different bottles.
        const seed = (side * NUM_PER_WALL + i) * 7919 + 13;
        const bottleKinds = pickBottles(seed);
        const rngPos = mulberry32(seed + 1);
        const bottleY = TABLE_H + BUCKET_H * 0.45;
        if (bottleKinds.length === 1) {
          // Single methuselah-style bottle — centered.
          const b = makeBottle(bottleKinds[0]);
          b.position.set(tableX, bottleY, 0);
          booth.add(b);
        } else {
          // Multiple smaller bottles — arrange in a circle inside
          // the bucket radius, slight random offset per bottle.
          const ringR = BUCKET_R * 0.55;
          for (let bi = 0; bi < bottleKinds.length; bi++) {
            const ang =
              (bi / bottleKinds.length) * Math.PI * 2 +
              (rngPos() - 0.5) * 0.4;
            const b = makeBottle(bottleKinds[bi]);
            b.position.set(
              tableX + Math.cos(ang) * ringR,
              bottleY,
              Math.sin(ang) * ringR,
            );
            // Slight random tilt so bottles look casually placed,
            // not lined up like soldiers.
            b.rotation.z = (rngPos() - 0.5) * 0.15;
            b.rotation.x = (rngPos() - 0.5) * 0.10;
            booth.add(b);
          }
        }

        booth.position.set(baseX, 0, z);
        this.scene.add(booth);
        this.vipBooths.push(booth);
      }
    }
  }

  private buildLEDCeiling() {
    const CEILING_W = 16;        // wide enough to span runway + podiums
    const CEILING_LENGTH = 200;  // matches ground length
    const CEILING_Y = 8.5;       // well above cage tops (3.5 m), reads as
                                 // proper club ceiling height
    const CEILING_Z = -90;       // matches ground centre

    // Grid resolution — 40 dots across × 200 along ≈ 8,000 lights.
    // Aspect roughly matches the world space (4 dots/m × 4 dots/m)
    // so dots stay round in world-space units.
    const GRID_X = 40;
    const GRID_Y = 200;

    const geo = new THREE.PlaneGeometry(CEILING_W, CEILING_LENGTH);
    // PlaneGeometry's default normal is +Z. Rotate -π/2 around X
    // to lay it flat with the normal pointing DOWN (−Y) — the
    // emissive side faces the player below.
    geo.rotateX(-Math.PI / 2);

    const vertexShader = /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    // 4-anchor hue cycle in the fragment shader — same anchors as
    // the JS `cycleLEDColor` helper for podium LEDs, so the
    // ceiling matches the podiums visually.
    const fragmentShader = /* glsl */ `
      uniform float uTime;
      uniform float uBrightness;
      uniform vec2 uGrid;
      // Total scrolled distance in metres. Fed by tickClubLights
      // each frame so the dot grid pattern moves toward the camera
      // at the same speed as the floor stripes / podiums / ropes,
      // rather than sitting locked to the player's overhead.
      uniform float uScroll;
      varying vec2 vUv;

      vec3 cycleHue(float phase) {
        float p = fract(phase);
        // Three darker anchors — moody nightclub palette, no
        // bright light pink, no white-clipping. Saturated but
        // low-luminance so the additive blending glows over the
        // dark scene without bleaching it.
        float seg = p * 3.0;
        float idx = floor(seg);
        float t = seg - idx;
        vec3 colors[3];
        colors[0] = vec3(0.30, 0.06, 0.55);   // deep purple
        colors[1] = vec3(0.06, 0.10, 0.50);   // deep midnight blue
        colors[2] = vec3(0.55, 0.05, 0.10);   // deep crimson red
        int i = int(idx);
        int j = int(mod(idx + 1.0, 3.0));
        vec3 a = colors[i];
        vec3 b = colors[j];
        return mix(a, b, t);
      }

      void main() {
        // Offset the cell grid by the world scroll so dots appear
        // to flow toward the camera. The plane is 200 m long and
        // there are uGrid.y dots along its length, so 1 m of scroll
        // = uGrid.y / 200 cells. Adding to the .y component (which
        // maps to world -Z after the X-axis flip in geometry rotation)
        // makes the cells slide in the same direction as floor
        // stripes scrolling toward +Z.
        float scrollCells = uScroll * (uGrid.y / 200.0);
        vec2 cell = vec2(vUv.x * uGrid.x, vUv.y * uGrid.y + scrollCells);
        vec2 cellId = floor(cell);
        vec2 local = fract(cell) - 0.5;
        float d = length(local);
        // Sharp dot with anti-aliased edge
        float dotMask = smoothstep(0.32, 0.26, d);

        // Phase = position-walk along Z + a slow time sweep + a
        // wider sinusoidal "wave" so colour cascades along the
        // ceiling rather than changing uniformly.
        float wave =
          sin(uTime * 0.5 + cellId.y * 0.18 + cellId.x * 0.07) * 0.5 + 0.5;
        float phase =
          uTime * 0.05 +
          cellId.y * 0.015 +
          cellId.x * 0.025 +
          wave * 0.25;
        vec3 color = cycleHue(phase);

        // Per-cell breathing intensity so dots flicker subtly.
        float breathe =
          0.55 + 0.45 *
          (0.5 + 0.5 * sin(uTime * 1.8 + cellId.x * 0.9 + cellId.y * 0.35));

        // Depth fade — dim the distant end of the ceiling so the
        // grid recedes into dark fast. After the geometry's
        // rotateX(-π/2), vUv.y = 0 is the NEAR end (just behind
        // the camera) and vUv.y = 1 is the FAR end (z = -190).
        // smoothstep(0.55, 0.95, 1 - vUv.y) means:
        //   - vUv.y ≤ 0.05 → fully bright (only the nearest dots)
        //   - vUv.y ≥ 0.45 → fully dark (over half the plane is gone)
        //   - fade across vUv.y ∈ [0.05, 0.45]
        // pow(..., 2.0) makes the mid-fade non-linear so the dots
        // drop to near-black very quickly past the near band.
        float depthFade = pow(smoothstep(0.55, 0.95, 1.0 - vUv.y), 2.0);

        vec3 finalColor = color * breathe * uBrightness * depthFade;
        // Alpha mirrors the dot mask × depth fade so the gaps
        // between dots are fully transparent and the distant
        // dots fade out cleanly.
        gl_FragColor = vec4(finalColor, dotMask * depthFade);
      }
    `;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBrightness: { value: this.brightnessMultiplier },
        uGrid: { value: new THREE.Vector2(GRID_X, GRID_Y) },
        uScroll: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      // Additive blending = the dots stack over the dark backdrop
      // glowing bright, no flat plane darkening the room.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const ceiling = new THREE.Mesh(geo, mat);
    ceiling.position.set(0, CEILING_Y, CEILING_Z);
    this.scene.add(ceiling);
    this.ledCeilingMat = mat;
  }

  private buildVelvetRopes() {
    const POST_HEIGHT = 1.0;
    const POST_RADIUS = 0.04;
    const BASE_RADIUS = 0.15;
    const BASE_HEIGHT = 0.03;
    const CAP_RADIUS = 0.06;
    const ROPE_SPAN = 5.0; // matches floor-stripe spacing
    const ROPE_SAG = 0.15; // catenary dip at the midpoint
    const ROPE_RADIUS = 0.025;
    const SIDE_X = 3.75; // just outside the 7.2 m white-stripe band
    const ROPE_UNITS = 18; // mirrors floorStripes count

    // ── Shared geometries ─────────────────────────────────────
    // Post — slim cylinder. Translate so y=0 is its base instead
    // of its midpoint (Three.js cylinders are origin-centred).
    const postGeo = new THREE.CylinderGeometry(
      POST_RADIUS,
      POST_RADIUS,
      POST_HEIGHT,
      12,
    );
    postGeo.translate(0, POST_HEIGHT / 2, 0);
    // Base — flat disc, slightly wider at the bottom for stability
    // (real stanchions have a beveled cast base).
    const baseGeo = new THREE.CylinderGeometry(
      BASE_RADIUS,
      BASE_RADIUS * 1.1,
      BASE_HEIGHT,
      24,
    );
    baseGeo.translate(0, BASE_HEIGHT / 2, 0);
    // Cap — round finial where the rope attaches.
    const capGeo = new THREE.SphereGeometry(CAP_RADIUS, 16, 8);
    capGeo.translate(0, POST_HEIGHT + CAP_RADIUS * 0.3, 0);
    // Rope — a quadratic Bezier from this post's cap to where
    // the next post's cap will sit, with the control point
    // dropped ROPE_SAG below the line to produce a catenary-ish
    // sag. Local space (rope is a child of the unit Group).
    const ropeCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, POST_HEIGHT, 0),
      new THREE.Vector3(0, POST_HEIGHT - ROPE_SAG, -ROPE_SPAN / 2),
      new THREE.Vector3(0, POST_HEIGHT, -ROPE_SPAN),
    );
    const ropeGeo = new THREE.TubeGeometry(
      ropeCurve,
      16, // path segments — smooth-looking curve
      ROPE_RADIUS,
      6, // radial segments — 6 is enough for a thin tube
      false,
    );

    // ── Shared materials ──────────────────────────────────────
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37, // brass gold
      metalness: 0.85,
      roughness: 0.35,
    });
    const ropeMat = new THREE.MeshStandardMaterial({
      color: 0x8b0a0a, // deep velvet red
      metalness: 0.0,
      roughness: 0.85,
    });

    // ── Build the pool ────────────────────────────────────────
    for (let i = 0; i < ROPE_UNITS; i++) {
      for (const sideX of [-SIDE_X, SIDE_X]) {
        const unit = new THREE.Group();
        unit.add(new THREE.Mesh(baseGeo, goldMat));
        unit.add(new THREE.Mesh(postGeo, goldMat));
        unit.add(new THREE.Mesh(capGeo, goldMat));
        unit.add(new THREE.Mesh(ropeGeo, ropeMat));
        unit.position.set(sideX, 0, -i * 5);
        this.scene.add(unit);
        this.velvetRopes.push(unit);
      }
    }
  }

  /**
   * Build TAPE London's signature dancer podiums — a hollow cage
   * of LED tubes (4 vertical corners + 4 horizontal top rails)
   * mounted on a raised plinth, capped with a faintly glowing
   * square panel inside the top frame.
   *
   * Layout: just past the velvet rope on alternating L/R sides,
   * a podium every ~9 m of track (~1.5 s at start speed, ~0.65 s
   * at max speed).
   *
   * Anatomy of one podium (bottom → top):
   *
   *  - Plinth: low, slightly wider matte-black box (~1.0 m square,
   *    0.15 m tall) — the raised platform the cage sits on.
   *  - Hollow cage: 4 vertical red LED tubes rising from the
   *    plinth top to the cage top. Empty interior — a dancer
   *    character can be slotted in later without geometry conflict.
   *  - Top "lid": 4 horizontal red LED tubes forming a square
   *    frame at the cage top + a translucent emissive panel just
   *    inside the frame so the top reads as a closed, lit ceiling.
   *  - Floor glow: soft additive red disc on the floor around the
   *    plinth — light spilling out from the cage.
   *
   * Per-podium phase offset on the pulse creates a travelling
   * wave of brightness along the row — the podium nearest the
   * player breathes bright, then the next, then the next.
   *
   * Pool size mirrors the velvet rope wavelength (90 m) so the
   * two systems recycle in lockstep.
   */

  /**
   * Build (or rebuild) every world-decoration pool whose density is
   * admin-tunable: wall portraits, VIP booths, dancer podiums, wall
   * speakers, wall strobes. Called once from `init()` after the
   * admin's `world*SpacingZ` overrides have been applied, so the
   * first play already uses the correct spacings.
   *
   * Idempotent — guarded by `decorationsApplied` so duplicate
   * init() calls don't pile up extra meshes. A future "live
   * re-spawn on slider change" path would clear the existing pools
   * + reset the flag before calling here again.
   */
  private applyWorldDecorations() {
    if (this.decorationsApplied) return;
    const WALL_X = 10;
    this.buildWallArt(WALL_X);
    this.buildVIPBooths(WALL_X);
    this.buildDancerPodiums();
    this.buildWallSpeakers(WALL_X);
    this.buildWallStrobes(WALL_X);
    this.buildWallShots(WALL_X);
    // Floor text is async (font fetch). Fire-and-forget — the
    // pool pops in once the FontFace resolves, same pattern the
    // legacy horizon sign used.
    void this.buildFloorText();
    this.decorationsApplied = true;
  }

  /**
   * Wall-mounted speaker cabinets above the portraits — a row of
   * dark boxes with a circular grille on the front face, scrolling
   * in lockstep with the rest of the wall scenery (90 m wrap).
   *
   * Each speaker is a thin slab (depth 0.25 m) hugging the wall,
   * mounted just above the portraits at y ≈ 5.2 m. Admin-tunable
   * spacing controls density; spacing of 0 or less disables the
   * pool entirely (no speakers built).
   */
  private buildWallSpeakers(wallX: number) {
    const SPACING = this.worldWallSpeakerSpacingZ;
    if (!(SPACING > 0)) return; // 0 / negative = disabled
    const SPEAKER_SPACING_Z = Math.max(1.5, SPACING);
    const POOL_LENGTH = 90;
    const NUM_PER_WALL =
        Math.max(1, Math.floor(POOL_LENGTH / SPEAKER_SPACING_Z));
    // Speaker dimensions — raised again to make room for the
    // enlarged neon. Wall stack reads:
    //   booths → portraits → Shots Bitch → speakers → strobes
    // SIGN_Y = 5.5 with plane height 1.125 → top edge ≈ 6.0625.
    // Speaker centre at y = 7.0 with height 1.1 → bottom 6.45,
    // ~39 cm gap above the neon. Top 7.55 → ~36 cm below the
    // strobe at y = 8.0.
    const SPEAKER_W = 1.0;
    const SPEAKER_H = 1.1;
    const SPEAKER_D = 0.25;
    const SPEAKER_Y = 7.0;
    // Cone radius — front-face grille that reads as "speaker".
    const CONE_R = SPEAKER_W * 0.32;

    // Shared materials/geometries — one alloc, all instances share.
    const cabinetMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.85,
      metalness: 0.10,
    });
    const grilleMat = new THREE.MeshStandardMaterial({
      color: 0x18181c,
      roughness: 0.40,
      metalness: 0.55,
    });
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0x2c2c30,
      roughness: 0.45,
      metalness: 0.35,
    });
    const cabinetGeo = new THREE.BoxGeometry(SPEAKER_D, SPEAKER_H, SPEAKER_W);
    const grilleGeo = new THREE.PlaneGeometry(SPEAKER_W * 0.92, SPEAKER_H * 0.92);
    const coneGeo = new THREE.CircleGeometry(CONE_R, 18);
    const tweeterGeo = new THREE.CircleGeometry(CONE_R * 0.42, 14);

    for (let side = 0; side < 2; side++) {
      const sideSign = side === 0 ? -1 : 1;
      const sideX = sideSign * wallX;
      // Front face (the grille side) faces toward the runway centre.
      // For the LEFT wall (sideSign = -1), the runway is at +X, so
      // the grille is at slightly LESS NEGATIVE X (inward).
      const grilleOffsetX = -sideSign * (SPEAKER_D / 2 + 0.005);
      // Cabinet sits with its outer face flush to the wall (slightly
      // inset so it doesn't z-fight).
      const cabinetOffsetX = -sideSign * (SPEAKER_D / 2 - 0.01);
      // Grille rotation: rotate the plane to face inward.
      const grilleRotY = sideSign === -1 ? Math.PI / 2 : -Math.PI / 2;
      // Offset the row so it interleaves between portraits — half a
      // portrait spacing offset means the speakers sit BETWEEN
      // portraits, not directly above them. Reads cleaner.
      const portraitOffsetZ = -this.worldPortraitSpacingZ * 0.5;
      for (let i = 0; i < NUM_PER_WALL; i++) {
        const z = portraitOffsetZ - i * SPEAKER_SPACING_Z;
        const unit = new THREE.Group();

        // Cabinet box hugging the wall.
        const cabinet = new THREE.Mesh(cabinetGeo, cabinetMat);
        cabinet.position.set(cabinetOffsetX, 0, 0);
        unit.add(cabinet);

        // Grille panel — slightly inside the cabinet front face.
        const grille = new THREE.Mesh(grilleGeo, grilleMat);
        grille.position.set(grilleOffsetX, 0, 0);
        grille.rotation.y = grilleRotY;
        unit.add(grille);

        // Two stacked driver cones (woofer + tweeter) so the
        // silhouette reads as a 2-way cabinet from distance.
        const woofer = new THREE.Mesh(coneGeo, coneMat);
        woofer.position.set(
            grilleOffsetX - sideSign * 0.001, -SPEAKER_H * 0.15, 0);
        woofer.rotation.y = grilleRotY;
        unit.add(woofer);
        const tweeter = new THREE.Mesh(tweeterGeo, coneMat);
        tweeter.position.set(
            grilleOffsetX - sideSign * 0.001, SPEAKER_H * 0.30, 0);
        tweeter.rotation.y = grilleRotY;
        unit.add(tweeter);

        unit.position.set(sideX, SPEAKER_Y, z);
        this.scene.add(unit);
        this.wallSpeakers.push(unit);
      }
    }
  }

  /**
   * Wall-mounted strobe lights interleaved with the speakers — a
   * row of small emissive panels whose brightness is animated in
   * the update loop for the classic club-strobe pulse. Each strobe
   * has a per-instance phase offset so the row doesn't blink in
   * unison (which looks like a bug rather than a strobe pattern).
   *
   * Spacing of 0 or less disables the pool entirely.
   */
  private buildWallStrobes(wallX: number) {
    const SPACING = this.worldWallStrobeSpacingZ;
    if (!(SPACING > 0)) return;
    const STROBE_SPACING_Z = Math.max(1.0, SPACING);
    const POOL_LENGTH = 90;
    const NUM_PER_WALL =
        Math.max(1, Math.floor(POOL_LENGTH / STROBE_SPACING_Z));
    const STROBE_W = 0.40;
    const STROBE_H = 0.18;
    const STROBE_D = 0.10;
    // Sit ABOVE the speakers (centred at y = 7.0, top edge ≈ 7.55).
    // y = 8.0 leaves a ~36 cm gap above the speakers and ~41 cm
    // clearance below the LED ceiling at y = 8.5 (strobe top ≈
    // 8.09 — well clear).
    const STROBE_Y = 8.0;

    const cabinetMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.70,
      metalness: 0.20,
    });
    const cabinetGeo = new THREE.BoxGeometry(STROBE_D, STROBE_H, STROBE_W);
    const panelGeo = new THREE.PlaneGeometry(STROBE_W * 0.85, STROBE_H * 0.7);

    for (let side = 0; side < 2; side++) {
      const sideSign = side === 0 ? -1 : 1;
      const sideX = sideSign * wallX;
      const panelOffsetX = -sideSign * (STROBE_D / 2 + 0.005);
      const cabinetOffsetX = -sideSign * (STROBE_D / 2 - 0.01);
      const panelRotY = sideSign === -1 ? Math.PI / 2 : -Math.PI / 2;
      for (let i = 0; i < NUM_PER_WALL; i++) {
        const z = -i * STROBE_SPACING_Z;
        const unit = new THREE.Group();

        // Cabinet — small dark box on the wall.
        const cabinet = new THREE.Mesh(cabinetGeo, cabinetMat);
        cabinet.position.set(cabinetOffsetX, 0, 0);
        unit.add(cabinet);

        // Emissive front panel — unique material per strobe so we
        // can animate each one's emissive intensity independently
        // for the staggered flash pattern.
        const panelMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        });
        const panel = new THREE.Mesh(panelGeo, panelMat);
        panel.position.set(panelOffsetX, 0, 0);
        panel.rotation.y = panelRotY;
        unit.add(panel);

        unit.position.set(sideX, STROBE_Y, z);
        this.scene.add(unit);
        // Per-instance phase: derive from index + side so the two
        // walls don't blink in mirror lockstep. The +0.5 offset for
        // side=1 gives 180° out-of-phase between the two walls.
        const phase = (i / NUM_PER_WALL) * Math.PI * 2 + side * Math.PI;
        this.wallStrobes.push({ group: unit, material: panelMat, phase });
      }
    }
  }

  /**
   * Pink-neon "Shots Bitch" cursive signs mounted on the side walls.
   * Sits ABOVE the portraits (portraits top ≈ y=4.51) and below the
   * speakers (raised to y=7.0 to make room for the enlarged neon) —
   * the band a bar marquee would naturally hang at in a real club,
   * high enough to read from across the room but below the
   * ceiling-mounted lighting rig.
   *
   * The text is rendered onto a shared CanvasTexture (one texture,
   * applied to N planes) with a 3-pass neon glow: outer magenta
   * halo → mid hot-pink → bright pink core. Default browser
   * 'cursive' family chain so the rendering picks the best
   * available script font per platform — Snell Roundhand on iOS /
   * macOS, Brush Script MT on Windows, system fallback otherwise.
   * All readable; we sized the canvas + adaptive font loop large
   * enough that any of those faces fit clean.
   *
   * Capitalisation preserved EXACTLY ("Shots Bitch", S+B uppercase,
   * rest lowercase) per the spec — no toUpperCase shenanigans.
   *
   * Spacing admin-tunable via `worldWallShotsSpacingZ`; ≤ 0
   * disables the pool entirely. Default 24 m = ~4 signs per wall
   * in the 90 m wrap.
   */
  private buildWallShots(wallX: number) {
    const SPACING = this.worldWallShotsSpacingZ;
    if (!(SPACING > 0)) return;
    const SHOTS_SPACING_Z = Math.max(2.0, SPACING);
    const POOL_LENGTH = 90;
    const NUM_PER_WALL =
        Math.max(1, Math.floor(POOL_LENGTH / SHOTS_SPACING_Z));

    // ── Build the shared neon texture ──────────────────────────
    const PIXEL_W = 1280;
    const PIXEL_H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = PIXEL_W;
    canvas.height = PIXEL_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, PIXEL_W, PIXEL_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Adaptive font sizing — start large, shrink until the cursive
    // text fits inside the 1280-px canvas with margin. Cursive
    // metrics vary wildly between platforms (Snell is narrow,
    // Brush Script is wide), so a loop is safer than a fixed value.
    const TEXT = 'Shots Bitch';
    const SIDE_MARGIN = 80;
    const MAX_TEXT_W = PIXEL_W - 2 * SIDE_MARGIN;
    // CSS font-family chain: prefer well-known readable cursive
    // faces, fall back to the generic 'cursive' family which the
    // browser maps to a sensible system script. `italic` requests
    // italicised variants where the family has them — most cursive
    // faces don't change much, but the request is harmless.
    const FONT_FAMILY =
        '"Brush Script MT", "Lucida Handwriting", "Snell Roundhand", "Apple Chancery", cursive';
    let fontSize = 200;
    ctx.font = `bold italic ${fontSize}px ${FONT_FAMILY}`;
    while (ctx.measureText(TEXT).width > MAX_TEXT_W && fontSize > 50) {
      fontSize -= 6;
      ctx.font = `bold italic ${fontSize}px ${FONT_FAMILY}`;
    }

    // 3-pass neon glow — outer wide halo, mid halo, bright core.
    // Each pass writes the text on top of the previous with a
    // tighter shadow blur, so the result reads as a glowing tube.
    ctx.shadowColor = '#ff00aa';
    ctx.shadowBlur = 56;
    ctx.fillStyle = '#ff44cc';
    ctx.fillText(TEXT, PIXEL_W / 2, PIXEL_H / 2);
    ctx.shadowBlur = 28;
    ctx.fillStyle = '#ff88dd';
    ctx.fillText(TEXT, PIXEL_W / 2, PIXEL_H / 2);
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffcfeb';
    ctx.fillText(TEXT, PIXEL_W / 2, PIXEL_H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;

    // ── Build the pool ─────────────────────────────────────────
    // Plane scaled 50% larger than the previous 3.75 × 0.75 m (and
    // 125% larger than the original 2.5 × 0.5 m) — reads as a big
    // bar-marquee neon from across the runway.
    const PLANE_W = 5.625;
    const PLANE_H = 1.125;
    // y=5.5 sits in the gap between portrait tops (≈ 4.51) and the
    // new speaker height (y=7.0). Plane half-height 0.5625 → top
    // 6.0625, bottom 4.9375 — ~43 cm clearance below to the
    // portraits, ~94 cm above to the speaker bottoms.
    const SIGN_Y = 5.5;
    const planeGeo = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
    const planeMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      // Pink neon stays vivid regardless of distance — fog would
      // wash it out long before the player got close.
      fog: false,
    });

    for (let side = 0; side < 2; side++) {
      const sideSign = side === 0 ? -1 : 1;
      const sideX = sideSign * wallX;
      // Inset 2 cm off the wall toward the runway centre so the
      // neon plane composites cleanly without z-fighting with the
      // wall geometry behind it.
      const offsetX = -sideSign * 0.02;
      // Plane default normal is +Z. Rotate ±π/2 on Y so the front
      // face points inward toward the runway.
      const rotY = sideSign === -1 ? Math.PI / 2 : -Math.PI / 2;
      // Stagger the two walls by half a spacing so a player jogging
      // down the centre sees signs alternate left/right, not pass
      // in mirror lockstep.
      const sideOffsetZ = side === 1 ? -SHOTS_SPACING_Z * 0.5 : 0;
      for (let i = 0; i < NUM_PER_WALL; i++) {
        const z = sideOffsetZ - i * SHOTS_SPACING_Z;
        const mesh = new THREE.Mesh(planeGeo, planeMat);
        mesh.position.set(sideX + offsetX, SIGN_Y, z);
        mesh.rotation.y = rotY;
        this.scene.add(mesh);
        this.wallShots.push(mesh);
      }
    }
  }

  private buildDancerPodiums() {
    const POOL_LENGTH = 90;        // matches floor-stripe / rope wavelength
    // Spacing admin-tunable via worldDancerSpacingZ. Default 9 m
    // (10 podiums spread across the 90 m wrap). Smaller value =
    // more podiums; larger = fewer. Floored at 2 m so they don't
    // overlap.
    const SPACING_Z = Math.max(2.0, this.worldDancerSpacingZ);
    const SIDE_X = 5.25;           // 1.5 m past the rope at X = ±3.75
    // ── Plinth dimensions ────────────────────────────────────
    const PLINTH_W = 1.3;          // square footprint, slightly wider than the cage
    const PLINTH_H = 0.50;         // substantial — reads as "raised stage" the
                                   // way Tape's real venue installs them. 3.3×
                                   // the original 0.15 m starter height.
    // ── Cage (hollow) dimensions ─────────────────────────────
    const CAGE_W = 0.9;            // square footprint — wider than v1 (was 0.7)
                                   // so the cage reads as a real stage you can
                                   // imagine standing on, not a slim pillar
    const CAGE_H = 3.0;            // tall enough to dwarf the 1.8 m runner
    const LED_RADIUS = 0.055;      // thin glow tubes — bumped proportionally
                                   // with the wider cage so the LEDs still
                                   // read clearly at speed
    const PLINTH_TOP = PLINTH_H;   // y of cage base
    const CAGE_TOP = PLINTH_H + CAGE_H;
    // ── Misc ─────────────────────────────────────────────────
    const GLOW_RADIUS = 1.6;       // bumped for the wider plinth so the glow
                                   // disc still extends past the plinth edge
    // TAPE red — slightly warm magenta-red.
    const LED_COLOR_BASE = 0xff0033;

    // ── Shared geometries ─────────────────────────────────────
    // Plinth: low box. Origin-centred → translate up by half so
    // y=0 sits on the floor.
    const plinthGeo = new THREE.BoxGeometry(PLINTH_W, PLINTH_H, PLINTH_W);
    plinthGeo.translate(0, PLINTH_H / 2, 0);
    // Vertical LED tube — base at y=0 (we position each via the
    // mesh, not the geometry, since 4 corners share this geo).
    const ledVertGeo = new THREE.CylinderGeometry(
      LED_RADIUS,
      LED_RADIUS,
      CAGE_H,
      8,
    );
    ledVertGeo.translate(0, CAGE_H / 2, 0);
    // Horizontal LED rail — length = cage width. Default cylinder
    // axis is Y, so rotate to Z for two of the four top rails;
    // the other two get rotated to X. We build one shared
    // "horizontal along X" geometry and just rotate the meshes
    // 90° on Y for the perpendicular pair (cheap, no new geom).
    const ledHorizGeo = new THREE.CylinderGeometry(
      LED_RADIUS,
      LED_RADIUS,
      CAGE_W,
      8,
    );
    ledHorizGeo.rotateZ(Math.PI / 2); // axis Y → axis X
    // Top "lid" panel: thin square inside the top frame, parallel
    // to the floor.
    const panelGeo = new THREE.PlaneGeometry(CAGE_W * 0.95, CAGE_W * 0.95);
    panelGeo.rotateX(-Math.PI / 2); // face downward (visible from below)
    // Floor glow: same as before.
    const glowGeo = new THREE.CircleGeometry(GLOW_RADIUS, 24);
    glowGeo.rotateX(-Math.PI / 2);
    glowGeo.translate(0, 0.012, 0); // just above the floor stripes

    // ── Shared plinth material ────────────────────────────────
    // One material for every plinth. PBR slightly metallic black —
    // catches a faint sheen from the rig so it doesn't look like a
    // black hole at the base.
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      metalness: 0.35,
      roughness: 0.55,
    });

    // ── Build the pool ────────────────────────────────────────
    const halfW = CAGE_W / 2;
    const corners: [number, number][] = [
      [-halfW, -halfW],
      [ halfW, -halfW],
      [-halfW,  halfW],
      [ halfW,  halfW],
    ];
    const count = Math.floor(POOL_LENGTH / SPACING_Z); // 10 podiums total
    for (let i = 0; i < count; i++) {
      const sideX = (i % 2 === 0) ? -SIDE_X : SIDE_X;
      const z = -i * SPACING_Z;
      const unit = new THREE.Group();

      // ── Plinth ─────────────────────────────────────────────
      unit.add(new THREE.Mesh(plinthGeo, plinthMat));

      // ── LED material (shared across all 8 LEDs of THIS podium)
      // MeshBasicMaterial = unlit. toneMapped:false so pure red
      // doesn't get desaturated by the renderer's tone mapper.
      // One material per podium so each podium can pulse on its
      // own phase (mutated in tickDancerPodiums).
      const ledMat = new THREE.MeshBasicMaterial({
        color: LED_COLOR_BASE,
        toneMapped: false,
      });

      // ── 4 vertical corner LED tubes (cage frame) ───────────
      // Each runs from the plinth top up to the cage top.
      for (const [cx, cz] of corners) {
        const led = new THREE.Mesh(ledVertGeo, ledMat);
        led.position.set(cx, PLINTH_TOP, cz);
        unit.add(led);
      }

      // ── 4 horizontal top-frame LED rails (the "lid" frame) ─
      // Two run along the X-axis (front + back of the top
      // square), two along the Z-axis (left + right of the top
      // square). ledHorizGeo is pre-rotated to lie along X; the
      // two Z-axis rails rotate the mesh 90° on Y to repurpose
      // the shared geometry.
      // Top front + back (along X)
      for (const cz of [-halfW, halfW]) {
        const rail = new THREE.Mesh(ledHorizGeo, ledMat);
        rail.position.set(0, CAGE_TOP, cz);
        unit.add(rail);
      }
      // Top left + right (along Z) — rotate the X-axis geometry
      // 90° around Y to point it along Z.
      for (const cx of [-halfW, halfW]) {
        const rail = new THREE.Mesh(ledHorizGeo, ledMat);
        rail.position.set(cx, CAGE_TOP, 0);
        rail.rotation.y = Math.PI / 2;
        unit.add(rail);
      }

      // ── Top "lid" panel ────────────────────────────────────
      // Thin translucent emissive square just inside the top
      // frame, faces downward so it reads as a lit ceiling from
      // the player's angle. Lower opacity than the LED tubes so
      // the frame is the brightness anchor and the panel is fill.
      const panelMat = new THREE.MeshBasicMaterial({
        color: LED_COLOR_BASE,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      });
      const panel = new THREE.Mesh(panelGeo, panelMat);
      // Sit just below the top frame so the rails read as the
      // edges of a closed lid.
      panel.position.set(0, CAGE_TOP - LED_RADIUS, 0);
      unit.add(panel);

      // ── Floor glow disc ────────────────────────────────────
      const glowMat = new THREE.MeshBasicMaterial({
        color: LED_COLOR_BASE,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      unit.add(glow);

      unit.position.set(sideX, 0, z);
      this.scene.add(unit);

      // Phase offset per podium → travelling wave of pulse.
      this.dancerPodiums.push({
        group: unit,
        ledMat,
        panelMat,
        glowMat,
        phase: i * 0.45,
      });
    }
  }

  /**
   * Per-frame intensity pulse for the dancer podiums. Each podium
   * breathes between dim (0.55) and full (1.0) on a ~2.5 s cycle,
   * with the per-podium phase offset producing a wave that
   * travels along the row. Brightness multiplier is folded in
   * here (same place as `tickClubLights`) so admin brightness
   * tweaks affect podiums too.
   *
   * 8 LED tubes per podium (4 vertical corners + 4 horizontal
   * top rails) share `ledMat`, so we mutate ONE material per
   * podium and every LED on it updates in lockstep — they're all
   * part of the same physical fixture, they should breathe
   * together.
   *
   * `panelMat` (the translucent top lid) is modulated separately
   * via opacity so it brightens with the pulse but never matches
   * the LED tubes (the frame stays the brightness anchor).
   */
  private tickDancerPodiums(t: number) {
    const brightness = this.brightnessMultiplier;
    // 2.5 s breathing period → 2π / 2.5 ≈ 2.513 rad/s
    const omega = (2 * Math.PI) / 2.5;
    // Slow rainbow cycle through the 4 anchor hues: pink → purple
    // → blue → red → back to pink. 16 s per full rotation reads as
    // a clear gradual shift without feeling busy.
    const CYCLE_PERIOD = 16;
    const cyclePhase = (t / CYCLE_PERIOD) % 1;
    for (const p of this.dancerPodiums) {
      const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * omega + p.phase));
      // Per-podium colour offset so the row reads as a flowing
      // wave of hue, not all-in-sync. Reuse the pulse-phase value
      // (in radians) as a fractional cycle offset — gives ~60 %
      // of cycle spread across the 10 podiums.
      const localCycle = (cyclePhase + p.phase / (2 * Math.PI)) % 1;
      const [r, g, b] = cycleLEDColor(localCycle);
      // Modulate brightness by pulse × brightness, clamped at 1
      // so admin brightness > 1 doesn't white-clip the hue.
      const v = Math.min(1, pulse * brightness);
      // All 8 LED tubes on this podium share one material — single
      // mutation updates verticals + top rails together.
      p.ledMat.color.setRGB(r * v, g * v, b * v);
      // Top lid panel: hue matches the LED tubes (panel sits
      // immediately above them). Brightness lives in opacity
      // instead — keep the panel from out-glowing the frame.
      p.panelMat.color.setRGB(r, g, b);
      p.panelMat.opacity = 0.30 + 0.25 * pulse;
      // Floor glow disc — same hue as the LEDs, lower opacity.
      p.glowMat.color.setRGB(r, g, b);
      p.glowMat.opacity = 0.20 + 0.25 * pulse;
    }
  }

  /**
   * Load `dancer_animated.glb` and place one cloned instance inside
   * each podium cage.
   *
   * The GLB is a fully-baked rigged+animated asset produced by
   * `tools/build_dancer_anim.mjs` — Tripo mesh + Mixamo skeleton +
   * skin attribute + "Arms Hip Hop Dance" clip, all merged into one
   * file with the fit-to-mesh scale × display-size multiplier baked
   * into the root node. Same standard glTF rig pattern as the
   * runner / jump / fall characters, so Three.js's GLTFLoader sets
   * up the SkinnedMesh natively and the runtime path is trivially
   * robust (no manual bind() / IBM construction).
   *
   * Per-podium work:
   *   • SkeletonUtils.clone() — produces an independent rig
   *     (separate skeleton state) sharing the source GLB's
   *     geometry + materials + textures.
   *   • Add to podium.group with the runway-facing rotation.
   *   • Per-clone AnimationMixer playing the bundled clip, with a
   *     staggered start time so adjacent dancers aren't on the
   *     same beat.
   *
   * Failure-silent: a 404 on the GLB leaves the cages empty.
   */
  private async loadDancerVisuals() {
    try {
      // Two dancer variants — Mixamo auto-rigs from different
      // Tripo3D source meshes. Each podium randomly picks one so
      // the row reads as a mix of personalities, not 10 clones.
      // Loaded in parallel; if either 404s, the variant just
      // isn't used (the array filter below handles missing).
      const loader = new GLTFLoader();
      const [blondeGltf, darkGltf] = await Promise.all([
        loader.loadAsync('/models/dancer_animated.glb').catch(() => null),
        loader.loadAsync('/models/dancer_animated_dark.glb').catch(() => null),
      ]);

      const plinthTop = 0.5;
      // Shared positioning constants — applied to both variants so
      // their visible size + plinth alignment match exactly. The
      // bbox-derived `dancerScale` per variant guarantees both end
      // up at DANCER_HEIGHT on screen even if their bind-pose bboxes
      // differ slightly.
      const DANCER_HEIGHT = 1.7 * 1.35;
      const DANCER_LIFT = 0.8;
      const DANCER_INWARD = 1.0;

      // Pre-compute scale + feet-offset for each variant so we
      // don't redo the bbox calc per podium. Variants that failed
      // to load are filtered out — random pick draws from whatever
      // landed.
      //
      // `inward` is per-variant because the Mixamo bind poses for
      // the two characters differ slightly — the dark dancer sits
      // 1 m further back than the blonde to compensate for her
      // wider stance / different starting frame.
      type Variant = {
        scene: THREE.Object3D;
        clip: THREE.AnimationClip;
        scale: number;
        offsetY: number;
        inward: number;
      };
      const variants: Variant[] = [];
      const sources: Array<[unknown, number]> = [
        [blondeGltf, DANCER_INWARD],
        [darkGltf, DANCER_INWARD - 1.0],
      ];
      for (const [g, inward] of sources) {
        const gltf = g as { scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null;
        if (!gltf) continue;
        const clip = gltf.animations[0];
        if (!clip) continue;
        const bbox = new THREE.Box3().setFromObject(gltf.scene);
        const height = Math.max(bbox.max.y - bbox.min.y, 0.001);
        const scale = DANCER_HEIGHT / height;
        const offsetY =
          plinthTop - bbox.min.y * scale - DANCER_HEIGHT + DANCER_LIFT;
        variants.push({ scene: gltf.scene, clip, scale, offsetY, inward });
      }
      if (variants.length === 0) return; // both failed to load

      for (let i = 0; i < this.dancerPodiums.length; i++) {
        const podium = this.dancerPodiums[i];

        // Random variant pick per podium. Math.random() is fine —
        // assignment is stable for the lifetime of the game session
        // (we only run this once at init). Players see a different
        // mix across runs which keeps the row from feeling static.
        const variant = variants[Math.floor(Math.random() * variants.length)];

        // Deep clone preserving bone references + skinned-mesh
        // bindings. The shared geometry + materials live on the
        // source gltf.scene; SkeletonUtils.clone gives each podium
        // a fresh skeleton hierarchy so animation state is per-
        // instance.
        const clone = cloneSkinned(variant.scene);

        // Apply the per-variant scale + feet-on-plinth offset.
        // Mixamo's clean skin weights handle uniform parent scale
        // without bind-matrix distortion.
        clone.scale.setScalar(variant.scale);
        clone.position.y = variant.offsetY;
        const isLeftSide = podium.group.position.x < 0;
        const sideSign = isLeftSide ? -1 : 1;
        // Nudge toward the runway centre. The podium positions are
        // already set; this is a local-space tweak on top of them.
        // Per-variant inward distance so each character lands at
        // a position that matches her bind-pose / dance stance.
        clone.position.x = -sideSign * variant.inward;
        // Face the runway. Mixamo's bind pose faces -Z, so a
        // left-side dancer (X < 0) needs +π/2 around Y to look
        // at +X (toward the runway centre); right-side gets -π/2.
        clone.rotation.y = isLeftSide ? Math.PI / 2 : -Math.PI / 2;
        // Disable frustum culling on all SkinnedMeshes — the dance
        // pose can extend past the bind-pose bounding sphere
        // (arms raised, etc.) and we don't want them to disappear
        // when that happens.
        clone.traverse((obj) => {
          if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
        });
        podium.group.add(clone);

        // Per-clone AnimationMixer + clip action. Mixer targets the
        // clone (not gltf.scene) so each one ticks independently.
        const mixer = new THREE.AnimationMixer(clone);
        const action = mixer.clipAction(variant.clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        // Stagger clip times so the 10 dancers spread evenly across
        // the 21.96 s loop (~2.2 s apart, never two on the same beat).
        mixer.setTime(i * 1.4);

        this.dancerVisuals.push({
          root: clone,
          mixer,
          sideSign,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[runner] dancer load failed', e);
    }
  }

  /**
   * Drive each dancer's AnimationMixer by `dt`. Mixers are
   * independent per dancer so they stay at their own clip-time
   * offset; the staggered start positions (set in load) plus a
   * shared dt keep adjacent dancers visibly out of sync.
   */
  private tickDancers(dt: number) {
    if (this.dancerVisuals.length === 0) return;
    for (const d of this.dancerVisuals) {
      d.mixer.update(dt);
    }
  }

  private buildPlayerVisualPlaceholder(gender: string) {
    // ── Dispose any existing visual ───────────────────────────
    this.disposePlayerVisualResources();

    this.isPlaceholderPlayer = true;

    const isFemale = gender === 'female';
    const visual = new THREE.Group();

    // Shared materials — neutral skin tone + dark hair regardless
    // of gender. Players can be any race; we pick a warm-neutral
    // skin tone for the placeholder.
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xd9a878,
      roughness: 0.55,
      metalness: 0.0,
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: 0x16110c,
      roughness: 0.75,
      metalness: 0.05,
    });
    const shoeMat = new THREE.MeshStandardMaterial({
      color: 0x040404,
      roughness: 0.45,
      metalness: 0.25,
    });

    const H = PLAYER.HEIGHT; // 1.8
    const W = PLAYER.WIDTH; // 1.0

    let armL: THREE.Mesh;
    let armR: THREE.Mesh;
    let legL: THREE.Mesh;
    let legR: THREE.Mesh;

    if (isFemale) {
      // ── Female: little-black-dress silhouette ────────────────
      // Slim upper body + dress flaring at the hip. Bare arms +
      // bare neck/décolletage. Long hair (ellipsoid behind head).
      // Gold necklace torus at the collarbone.
      const dressMat = new THREE.MeshStandardMaterial({
        color: 0x141014,
        roughness: 0.40,
        metalness: 0.20,
      });
      const goldMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        roughness: 0.30,
        metalness: 0.85,
      });

      // Upper body — slim cylinder, slightly narrower at waist.
      const upperH = H * 0.32;
      const upperR = W * 0.16;
      const upper = new THREE.Mesh(
        new THREE.CylinderGeometry(upperR * 0.94, upperR * 1.05, upperH, 14),
        dressMat,
      );
      upper.position.y = H * 0.55;
      visual.add(upper);

      // Dress flare — wide cone from waist outward to hem.
      const flareH = H * 0.30;
      const flare = new THREE.Mesh(
        new THREE.CylinderGeometry(upperR * 0.94, upperR * 1.55, flareH, 16),
        dressMat,
      );
      flare.position.y = H * 0.40 - flareH / 2 + upperH / 2 + 0.01;
      // Equivalently: flare top sits right under upper bottom.
      flare.position.y = H * 0.55 - upperH / 2 - flareH / 2;
      visual.add(flare);

      // Necklace — thin gold ring at the collarbone.
      const necklace = new THREE.Mesh(
        new THREE.TorusGeometry(upperR * 0.92, 0.012, 6, 18),
        goldMat,
      );
      necklace.rotation.x = Math.PI / 2;
      necklace.position.y = H * 0.55 + upperH / 2 - 0.04;
      visual.add(necklace);

      // Head — slightly smaller sphere (skin tone).
      const headR = W * 0.18;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(headR, 16, 14),
        skinMat,
      );
      head.position.y = H * 0.78;
      visual.add(head);

      // Hair — flowing ellipsoid that drapes past the shoulders.
      // Constructed as a scaled sphere so it's wider and longer
      // than the head, sitting slightly behind it.
      const hairGeo = new THREE.SphereGeometry(headR * 1.18, 16, 14);
      const hair = new THREE.Mesh(hairGeo, hairMat);
      hair.scale.set(1.0, 1.6, 0.85);
      hair.position.set(0, H * 0.73, -headR * 0.18);
      visual.add(hair);

      // Arms — bare skin (matches head), slim, stylish stance.
      const armH = H * 0.40;
      const armR_ = W * 0.05;
      const armGeo = new THREE.CapsuleGeometry(armR_, armH * 0.7, 3, 8);
      const armOffsetX = W * 0.21;
      const armY = H * 0.55;
      armL = new THREE.Mesh(armGeo, skinMat);
      armL.position.set(-armOffsetX, armY, 0);
      armL.rotation.z = 0.10;
      visual.add(armL);
      armR = new THREE.Mesh(armGeo, skinMat);
      armR.position.set(armOffsetX, armY, 0);
      armR.rotation.z = -0.10;
      visual.add(armR);

      // Legs — bare skin (the dress hem cuts above the knees).
      const legH = H * 0.22;
      const legR_ = W * 0.07;
      const legGeo = new THREE.CapsuleGeometry(legR_, legH * 0.55, 3, 8);
      const legOffsetX = W * 0.08;
      const legY = H * 0.15;
      legL = new THREE.Mesh(legGeo, skinMat);
      legL.position.set(-legOffsetX, legY, 0);
      visual.add(legL);
      legR = new THREE.Mesh(legGeo, skinMat);
      legR.position.set(legOffsetX, legY, 0);
      visual.add(legR);

      // Heels — small dark wedges at the bottom of each leg.
      const heelGeo = new THREE.BoxGeometry(W * 0.10, 0.06, W * 0.18);
      const heelL = new THREE.Mesh(heelGeo, shoeMat);
      heelL.position.set(-legOffsetX, 0.03, W * 0.04);
      visual.add(heelL);
      const heelR = new THREE.Mesh(heelGeo, shoeMat);
      heelR.position.set(legOffsetX, 0.03, W * 0.04);
      visual.add(heelR);
    } else {
      // ── Male / default: tailored suit silhouette ─────────────
      // Slim suit jacket + trousers, with a white shirt triangle
      // visible at the neckline. Broad shoulders, narrower waist.
      const suitMat = new THREE.MeshStandardMaterial({
        color: 0x14181f,
        roughness: 0.55,
        metalness: 0.10,
      });
      const shirtMat = new THREE.MeshStandardMaterial({
        color: 0xeae6dd,
        roughness: 0.65,
        metalness: 0.0,
      });

      // Torso — capsule with shoulders sharper than the female
      // upper body. Slight taper bottom-to-top.
      const torsoH = H * 0.50;
      const torsoR = W * 0.21;
      const torso = new THREE.Mesh(
        new THREE.CapsuleGeometry(torsoR, torsoH * 0.65, 4, 14),
        suitMat,
      );
      torso.position.y = H * 0.50;
      visual.add(torso);

      // Shirt — flat triangle visible at the neckline (V-shape
      // formed by the open suit jacket). Implemented as a thin
      // wedge box parented in front of the torso, top-centered.
      const shirt = new THREE.Mesh(
        new THREE.BoxGeometry(torsoR * 0.6, torsoH * 0.30, 0.04),
        shirtMat,
      );
      shirt.position.set(0, H * 0.62, torsoR * 0.92);
      visual.add(shirt);

      // Head — skin tone sphere.
      const headR = W * 0.18;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(headR, 14, 12),
        skinMat,
      );
      head.position.y = H * 0.82;
      visual.add(head);

      // Hair — short, flat cap atop the head. Scaled sphere so
      // it hugs the top of the head and doesn't cover the face.
      const hairTopGeo = new THREE.SphereGeometry(
        headR * 0.95,
        14,
        10,
        0,
        Math.PI * 2,
        0,
        Math.PI / 2,
      );
      const hairTop = new THREE.Mesh(hairTopGeo, hairMat);
      hairTop.position.y = H * 0.83;
      visual.add(hairTop);

      // Arms — in suit sleeves (dark), slim. Slightly out from
      // the torso so the shoulders read.
      const armH = H * 0.42;
      const armR_ = W * 0.07;
      const armGeo = new THREE.CapsuleGeometry(armR_, armH * 0.7, 3, 10);
      const armOffsetX = W * 0.27;
      const armY = H * 0.52;
      armL = new THREE.Mesh(armGeo, suitMat);
      armL.position.set(-armOffsetX, armY, 0);
      armL.rotation.z = 0.16;
      visual.add(armL);
      armR = new THREE.Mesh(armGeo, suitMat);
      armR.position.set(armOffsetX, armY, 0);
      armR.rotation.z = -0.16;
      visual.add(armR);

      // Legs — dress trousers (suit colour), full length.
      const legH = H * 0.38;
      const legR_ = W * 0.11;
      const legGeo = new THREE.CapsuleGeometry(legR_, legH * 0.65, 3, 10);
      const legOffsetX = W * 0.13;
      const legY = H * 0.18;
      legL = new THREE.Mesh(legGeo, suitMat);
      legL.position.set(-legOffsetX, legY, 0);
      visual.add(legL);
      legR = new THREE.Mesh(legGeo, suitMat);
      legR.position.set(legOffsetX, legY, 0);
      visual.add(legR);

      // Dress shoes — wider than feet, polished black.
      const shoeGeo = new THREE.BoxGeometry(W * 0.13, 0.07, W * 0.22);
      const shoeL = new THREE.Mesh(shoeGeo, shoeMat);
      shoeL.position.set(-legOffsetX, 0.035, W * 0.05);
      visual.add(shoeL);
      const shoeR = new THREE.Mesh(shoeGeo, shoeMat);
      shoeR.position.set(legOffsetX, 0.035, W * 0.05);
      visual.add(shoeR);
    }

    // Offset the whole group down by half the collider height so
    // the feet land on the ground when the collider sits at
    // PLAYER.BASE_Y. (Collider origin is its centre.)
    visual.position.y = -PLAYER.HEIGHT / 2;
    this.player.add(visual);
    this.playerVisual = visual;
    this.playerLimbs = { armL, armR, legL, legR };
  }

  /**
   * Tear down any current player visual (placeholder Group OR
   * loaded GLB scene) + the AnimationMixer that drove it. Called
   * before rebuilding for a gender swap or before bringing a
   * freshly-loaded GLB online.
   */
  private disposePlayerVisualResources() {
    if (this.playerMixer) {
      this.playerMixer.stopAllAction();
      this.playerMixer.uncacheRoot(this.playerMixer.getRoot());
      this.playerMixer = undefined;
      this.playerRunAction = undefined;
    }
    // Cached bone refs are per-character; clear them so the next
    // load's `cacheJumpPoseBones` re-finds them on the new visual.
    this.jumpPoseBones = [];
    // The jump character (`playerJumpVisual`) is intentionally
    // NOT cleared here — it's parented under `this.player` (the
    // collider), independent of the running visual, and survives
    // gender swaps of the running character. (If we add a female
    // jump FBX later we'll handle that as part of that flow.)
    if (this.playerVisual) {
      this.playerVisual.removeFromParent();
      this.playerVisual.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
          else this.disposeMaterial(m);
        }
      });
    }
  }

  /**
   * Material disposer that also frees the textures on it. Plain
   * Mesh.dispose() doesn't dispose textures, so a SkinnedMesh
   * from a GLB would otherwise leak `map`, `normalMap`, etc on
   * every gender swap.
   */
  private disposeMaterial(mat: THREE.Material) {
    const m = mat as THREE.Material & {
      map?: THREE.Texture;
      normalMap?: THREE.Texture;
      roughnessMap?: THREE.Texture;
      metalnessMap?: THREE.Texture;
      emissiveMap?: THREE.Texture;
    };
    m.map?.dispose();
    m.normalMap?.dispose();
    m.roughnessMap?.dispose();
    m.metalnessMap?.dispose();
    m.emissiveMap?.dispose();
    mat.dispose();
  }

  /**
   * Try to load a rigged character model from
   * `/models/runner_<gender>.<ext>`. Tries FBX first (Mixamo's
   * direct download format — no conversion needed) then GLB
   * (smaller, in case the operator manually converts later).
   *
   * On success, disposes the placeholder visual and replaces it
   * with the loaded scene + an AnimationMixer that plays the run
   * clip in a loop. On failure (404 / parse error for both
   * formats), silently stays on the capsule placeholder.
   *
   * File requirements:
   *   - With Skin (Mixamo's default export option)
   *   - One or more animations included; we prefer any clip
   *     whose name contains "run" / "running"; otherwise we
   *     fall back to the first clip.
   *   - Origin at the character's feet (Mixamo default).
   */
  private async tryLoadGltfPlayer(gender: string) {
    const suffix = gender === 'female' ? 'female' : 'male';
    // Compressed GLB pipeline: Mixamo FBX → FBX2glTF → gltf-transform
    // resize 1024 + webp. Final files are 17-22× smaller than the
    // raw Mixamo FBX exports (~3 MB vs ~50 MB) with no visible
    // quality loss at runtime.
    let scene: THREE.Group | undefined;
    let animations: THREE.AnimationClip[] = [];
    try {
      const gltf: GLTF = await new GLTFLoader().loadAsync(
        `/models/runner_${suffix}.glb`,
      );
      scene = gltf.scene;
      animations = gltf.animations;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug(`[runner] runner_${suffix}.glb load failed`, e);
    }

    if (!scene) {
      // Both candidates failed — placeholder stays in use. Still
      // counts as "asset settled" so the loading overlay can
      // clear and the user can play with the capsule fallback.
      this.playerAssetReady = true;
      this.checkAssetsReady();
      return;
    }

    // If a newer call to buildPlayerVisual ran while we awaited
    // (e.g. init() arrived twice with different genders), bail.
    // The placeholder for that newer call has already been built;
    // its own tryLoadGltfPlayer will handle its model swap.
    if (gender === 'female' && this.playerGender !== 'female') return;
    if (gender !== 'female' && this.playerGender === 'female') return;

    // Tear down the placeholder + any previously-loaded model.
    this.disposePlayerVisualResources();

    const model = scene;

    // Skinned meshes inside the GLB sometimes get frustum-culled
    // even when they're on-screen because their bounding sphere
    // tracks the bind pose, not the deformed pose. Disable it
    // defensively so the player doesn't pop out of view at lane
    // edges.
    model.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) {
        obj.frustumCulled = false;
      }
    });

    // Scale to fit the collider height. Mixamo exports are
    // ~1 unit = 1 metre, so a 1.75m character is 1.75 tall and we
    // gently scale up to PLAYER.HEIGHT = 1.8.
    const bbox = new THREE.Box3().setFromObject(model);
    const rawHeight = Math.max(0.01, bbox.max.y - bbox.min.y);
    const scale = PLAYER.HEIGHT / rawHeight;
    model.scale.setScalar(scale);

    // Mixamo characters face +Z by default (toward camera in the
    // Mixamo preview). In our scene the camera looks toward -Z,
    // so a default-rotated character would be looking at the
    // player. We want them running INTO the screen, so face -Z.
    model.rotation.y = Math.PI;

    // Parent into the collider with a rough initial position; we'll
    // refine vertical alignment using the actual foot-bone position
    // below, which is the only reliable signal for a SkinnedMesh
    // (Box3.setFromObject ignores bone transforms and returns the
    // bind-pose vertex bounds, which often don't match where the
    // mesh actually renders).
    model.position.y = -PLAYER.HEIGHT / 2;
    this.player.add(model);
    model.updateMatrixWorld(true);

    // Find the lowest "foot" / "toe" / "ankle" bone in the skeleton
    // — that's where the character's feet actually appear when
    // rendered. Mixamo names these like mixamorigLeftToeBase /
    // mixamorigRightToeBase; we match on any bone whose name contains
    // "toe", "foot", or "ankle" (case-insensitive) to handle other
    // rigs too.
    let lowestFootWorldY: number | null = null;
    const probePos = new THREE.Vector3();
    model.traverse((obj) => {
      if (obj instanceof THREE.Bone) {
        const n = obj.name.toLowerCase();
        if (n.includes('toe') || n.includes('foot') || n.includes('ankle')) {
          obj.getWorldPosition(probePos);
          if (lowestFootWorldY === null || probePos.y < lowestFootWorldY) {
            lowestFootWorldY = probePos.y;
          }
        }
      }
    });

    if (lowestFootWorldY !== null) {
      // Shift the model so the lowest foot bone sits at the ground
      // plane (world y = 0). The collider's centre is at world
      // y = PLAYER.BASE_Y so its bottom is at PLAYER.BASE_Y - HEIGHT/2
      // = 0.1; we target 0 (the ground plane itself) so the character
      // visually touches the floor.
      const targetFootWorldY = 0;
      const shift = targetFootWorldY - lowestFootWorldY;
      model.position.y += shift;
    } else {
      // No bone names matched — fall back to using the world-space
      // bbox after the model is in the scene. Imperfect for
      // SkinnedMesh but better than nothing.
      model.updateMatrixWorld(true);
      const worldBbox = new THREE.Box3().setFromObject(model);
      model.position.y += -worldBbox.min.y;
    }
    this.playerVisual = model;
    this.isPlaceholderPlayer = false;

    // Set up the animation mixer + play the run clip.
    if (animations.length > 0) {
      this.playerMixer = new THREE.AnimationMixer(model);
      const runClip = this.pickRunClip(animations);
      this.playerRunAction = this.playerMixer.clipAction(runClip);
      this.playerRunAction.setLoop(THREE.LoopRepeat, Infinity);
      this.playerRunAction.play();
    }
    // Look up the bone refs the procedural jump pose modifies.
    // Runs after the visual is in place so traverse finds the
    // FBX-loaded bones, not the placeholder Group's children.
    this.cacheJumpPoseBones();
    // Player asset has settled — flag it so the loading overlay
    // can clear if the jump character has also settled.
    this.playerAssetReady = true;
    this.checkAssetsReady();
  }

  /**
   * Pick a run-cycle clip from a GLB's animation list. Mixamo
   * names them "Running" / "Run"; we also accept "Walk" as a
   * fallback for characters that ship without a run animation.
   * If nothing matches, returns the first clip — better to play
   * something than show a T-pose.
   */
  private pickRunClip(animations: THREE.AnimationClip[]): THREE.AnimationClip {
    const keywords = ['run', 'running', 'jog', 'walk'];
    let clip: THREE.AnimationClip | undefined;
    for (const k of keywords) {
      clip = animations.find((c) => c.name.toLowerCase().includes(k));
      if (clip) break;
    }
    clip = clip ?? animations[0];
    return this.stripRootForwardMotion(clip);
  }

  /**
   * Strip the X + Z keyframes from any position track on the
   * character's root bone, so the character runs IN PLACE even
   * if the animation was exported without Mixamo's "In Place"
   * checkbox. Keeps the Y component intact so natural hip bob
   * is preserved.
   *
   * Matches anything that looks like a root: "Hips", "mixamorigHips",
   * "Root", "Armature|root", etc. — broad enough to cover Mixamo +
   * most other rigging conventions without false positives on
   * non-root bones (knees, ankles, shoulders never contain "hip"
   * or "root" in their canonical names).
   */
  private stripRootForwardMotion(
    clip: THREE.AnimationClip,
  ): THREE.AnimationClip {
    const isRootPositionTrack = (name: string): boolean => {
      if (!name.endsWith('.position')) return false;
      const bone = name.split('.')[0].toLowerCase();
      return bone.includes('hip') || bone === 'root' || bone.endsWith('|root');
    };
    // Clone keyframe values so we don't mutate a shared buffer.
    const newTracks = clip.tracks.map((t) => {
      if (!isRootPositionTrack(t.name)) return t;
      const values = new Float32Array(t.values);
      for (let i = 0; i < values.length; i += 3) {
        values[i] = 0;       // X — strip forward/back
        values[i + 2] = 0;   // Z — strip side-to-side drift
        // values[i+1] (Y) is left alone — natural hip bob preserved
      }
      return new THREE.VectorKeyframeTrack(t.name, Array.from(t.times), Array.from(values));
    });
    return new THREE.AnimationClip(
      clip.name + '_inplace',
      clip.duration,
      newTracks,
    );
  }

  // ── Input ───────────────────────────────────────────────────────

  private swipeStart: { x: number; y: number } | null = null;
  private swipeCommitted = false;
  private static MIN_SWIPE = 30;

  private attachInput() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.swipeStart = { x: e.clientX, y: e.clientY };
      this.swipeCommitted = false;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.swipeStart || this.swipeCommitted) return;
      const dx = e.clientX - this.swipeStart.x;
      const dy = e.clientY - this.swipeStart.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax > ay && ax > RunnerGame.MIN_SWIPE) {
        if (dx < 0) this.swipeLeft();
        else this.swipeRight();
        this.swipeCommitted = true;
      } else if (ay > ax && ay > RunnerGame.MIN_SWIPE) {
        if (dy < 0) this.jump();
        // (slide on swipe down — wired in next commit alongside
        // duck-under obstacles like a low-hanging disco ball)
        this.swipeCommitted = true;
      }
    });
    this.canvas.addEventListener('pointerup', () => {
      this.swipeStart = null;
      this.swipeCommitted = false;
    });
    this.canvas.addEventListener('pointercancel', () => {
      this.swipeStart = null;
      this.swipeCommitted = false;
    });

    // Keyboard — for desktop dev iteration.
    window.addEventListener('keydown', (e) => {
      if (this.gameOver) return;
      if (e.key === 'ArrowLeft' || e.key === 'a') this.swipeLeft();
      else if (e.key === 'ArrowRight' || e.key === 'd') this.swipeRight();
      else if (e.key === 'ArrowUp' || e.key === ' ' || e.key === 'w')
        this.jump();
    });
  }

  private attachResize() {
    const onResize = () => {
      this.resize();
      this.camera.aspect = this.aspect();
      // Recompute base FOV — keeps lane edges visible on narrow
      // aspect ratios (e.g. rotating phone from landscape → portrait).
      this.baseFov = this.computeBaseFov();
      // Don't write camera.fov here — the update() loop layers the
      // buzz offset on top of baseFov each frame and assigns then.
      this.camera.updateProjectionMatrix();
    };
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', onResize);
      return;
    }
    this.resizeObserver = new ResizeObserver(onResize);
    this.resizeObserver.observe(this.canvas);
  }

  private swipeLeft() {
    if (this.gameOver || !this.running || !this.assetsReady) return;
    this.startGameIfNotStarted();
    if (this.playerLane > 0) this.setLane(this.playerLane - 1);
  }
  private swipeRight() {
    if (this.gameOver || !this.running || !this.assetsReady) return;
    this.startGameIfNotStarted();
    if (this.playerLane < LANES.X.length - 1)
      this.setLane(this.playerLane + 1);
  }
  private setLane(lane: number) {
    this.playerLane = lane;
    this.laneChangeStartX = this.player.position.x;
    this.targetX = LANES.X[lane];
    this.laneChangeTime = 0;
    // Capture the effective duration now so buzz changes mid-swipe
    // don't suddenly speed-warp the player. Duration is the buzz-
    // scaled base value (slower at high buzz).
    const slow = this.buzz.getInterpolatedEffectParams().laneSlowFactor;
    this.laneChangeDuration = this.laneChangeBaseSeconds * slow;
    this.audio.play('lanechange');
  }
  private jump() {
    if (this.gameOver || !this.running || !this.assetsReady) return;
    this.startGameIfNotStarted();
    if (this.playerY > PLAYER.BASE_Y + 0.05) return; // already airborne
    this.playerVy = this.jumpVelocity;
    this.triggerJumpAnimation();
    this.audio.play('jump');
    // Silence the running loop while airborne — no footsteps in
    // mid-air. Resumed at the landing edge below.
    this.audio.pauseLoop('running');
  }

  /**
   * Crossfade run → jump on takeoff. No-op if the jump clip
   * hasn't loaded yet (procedural fallback in `applyAdditiveJumpPose`
   * picks up that case during update).
   *
   * `timeScale` is sized so the clip plays in roughly the actual
   * airtime: clipDuration ÷ predictedAirtime. With defaults
   * (vy=8 m/s, gravity -25 m/s²) airtime ≈ 0.64 s and the clip
   * is ~1.03 s, so timeScale ≈ 1.6.
   */
  private triggerJumpAnimation() {
    if (!this.playerJumpVisual || !this.playerJumpAction || !this.playerVisual) {
      return;
    }
    // Swap visibility — instantaneous. Frame 0 of the Mixamo Jump
    // animation is the takeoff stance which lines up well with the
    // running pose, so the snap reads as motion blur rather than a
    // jarring teleport.
    this.playerVisual.visible = false;
    this.playerJumpVisual.visible = true;

    // Restart the clip from frame 0 each jump. timeScale is sized
    // so the clip plays in roughly the predicted airtime — with
    // defaults (vy=8, gravity -25) airtime ≈ 0.64 s, clip ≈ 1.03 s,
    // so timeScale ≈ 1.6.
    const airtime = (2 * this.jumpVelocity) / Math.abs(PLAYER.GRAVITY);
    const safeAirtime = Math.max(0.2, airtime);
    this.playerJumpAction.timeScale =
      this.playerJumpClipDuration / safeAirtime;
    this.playerJumpAction.reset();
    this.playerJumpAction.play();
  }

  /**
   * Called by the swipe / jump handlers. The first call flips
   * `gameStarted` true (which un-freezes the world tick in
   * `update()`), resets `duration` so the run timer starts at 0,
   * and tells the HUD to fade out the input-hint overlay.
   * Subsequent calls are no-ops.
   */
  private startGameIfNotStarted() {
    if (this.gameStarted) return;
    this.gameStarted = true;
    this.duration = 0;
    this.distance = 0;
    this.score = 0;
    this.hud.hideInputHint();
    // Kick off the looping run SFX. Tied to first input so the loop
    // doesn't blare on the static start screen. AudioManager records
    // the intent even if the URL hasn't finished loading yet —
    // loadLoop()'s deferred-start branch will pick it up.
    this.audio.playLoop('running');
  }

  // ── Game loop ───────────────────────────────────────────────────

  private start() {
    this.clock.start();
    const loop = () => {
      const dt = Math.min(0.05, this.clock.getDelta());
      if (this.running) this.update(dt);
      // Even after the run ends, keep ticking the fall mixer so the
      // death animation plays through. `running` is false during the
      // fall — but `isFalling` gates this tick independently. When
      // the clip's `finished` event fires, postGameOverFromFall flips
      // `isFalling` false, after which this branch is a no-op.
      if (this.isFalling && this.playerFallMixer) {
        this.playerFallMixer.update(dt);
      }
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  private update(dt: number) {
    if (this.gameOver) return;

    // ── Pre-game: world is frozen, just animate the player + lights
    // so the runway doesn't look dead while the input-hint overlay
    // is up. `previewClock` is the cadence driver — independent of
    // `duration` (which feeds the validator's physics check, so it
    // must start at 0 the moment the player actually starts).
    if (!this.gameStarted) {
      this.previewClock += dt;
      this.tickClubLights(this.previewClock);
      // Pulse the podium LEDs in the pre-game state too, so the
      // scene reads as "live nightclub" while the swipe-to-start
      // overlay is up.
      this.tickDancerPodiums(this.previewClock);
      // Same goes for the dancer animation — keeps the clip
      // looping while the overlay is up. Without this they'd be
      // frozen on their bind pose until the player swipes.
      // Note: tickDancers takes `dt`, not the clock (it advances
      // each per-dancer AnimationMixer by the per-frame delta).
      this.tickDancers(dt);
      this.runPlayerIdleAnimation(this.previewClock, dt);
      return;
    }

    // ── World scroll + speed curve ────────────────────────────
    this.speed = Math.min(
      this.maxSpeed,
      this.startSpeed + this.distance * this.speedRamp,
    );
    this.distance += this.speed * dt;
    this.duration += dt;
    const scroll = this.speed * dt;
    // Distance contributes 1 pt/m to the score baseline.
    this.score += this.speed * dt;

    // ── Buzz tick (decay only) ────────────────────────────────
    // Blackout NO LONGER fires from just reaching L5 — see buzz.ts
    // `add()` return value. L5 is the "danger zone" the player can
    // sit in (and decay out of) until the next bottle tips them
    // over. So this tick is purely for the time-decay drop.
    this.buzz.tickDecay(dt);
    const buzzFx = this.buzz.getInterpolatedEffectParams();

    // ── Apply buzz visual effects to camera + canvas ──────────
    // The drunk effect is part of the core design — there's no
    // "reduce motion" opt-out anymore. Everyone gets the same game.
    // Camera sway: oscillate Z-roll at ~0.8 Hz scaled by amplitude.
    const swayPhase = this.duration * 0.8 * Math.PI * 2;
    this.camera.rotation.z = (Math.sin(swayPhase) * buzzFx.sway * Math.PI) / 180;
    // FOV tunnel — slight FOV increase at high buzz reads as
    // "the world closing in." Update projection matrix on change.
    const targetFov = this.baseFov + buzzFx.fovOffset;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
    // Buzz blur — via HUD's backdrop-filter overlay (works on iOS
    // WKWebView; `filter: blur()` on the WebGL canvas does NOT).
    this.hud.setBlur(buzzFx.blur);

    // ── Lane interpolation (eased) ────────────────────────────
    if (this.laneChangeTime < this.laneChangeDuration) {
      this.laneChangeTime += dt;
      const t = Math.min(1, this.laneChangeTime / this.laneChangeDuration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      this.player.position.x =
        this.laneChangeStartX +
        (this.targetX - this.laneChangeStartX) * eased;
    } else {
      this.player.position.x = this.targetX;
    }

    // ── Jump arc + run-bob ────────────────────────────────────
    if (this.playerY > PLAYER.BASE_Y || this.playerVy !== 0) {
      this.playerVy += PLAYER.GRAVITY * dt;
      this.playerY += this.playerVy * dt;
      if (this.playerY <= PLAYER.BASE_Y) {
        this.playerY = PLAYER.BASE_Y;
        this.playerVy = 0;
      }
      this.player.position.y = this.playerY;
    }
    const grounded = this.playerY <= PLAYER.BASE_Y + 0.01;
    // Landing edge — fires once on the frame the player touches
    // down. Swap visibility back to the running character and
    // resume the running-loop SFX that was paused on takeoff.
    if (grounded && this.wasInAir) {
      this.wasInAir = false;
      if (this.playerJumpVisual && this.playerVisual) {
        this.playerJumpVisual.visible = false;
        this.playerVisual.visible = true;
      }
      this.audio.resumeLoop('running');
    }
    if (!grounded) this.wasInAir = true;
    if (grounded) {
      const bobPhase = this.duration * (this.speed / this.startSpeed) * 8;
      this.player.position.y =
        PLAYER.BASE_Y + Math.sin(bobPhase) * 0.07;
    }
    if (this.isPlaceholderPlayer) {
      // Manual limb-swing for the capsule fallback. When a Mixamo
      // GLB is in use, `playerMixer.update(dt)` below drives the
      // skeleton instead and this block is skipped.
      if (grounded) {
        const stridePhase =
          this.duration * (this.speed / this.startSpeed) * 5.5;
        const armSwing = Math.sin(stridePhase) * 0.55;
        const legSwing = Math.sin(stridePhase) * 0.45;
        this.playerLimbs.armL.rotation.x = armSwing;
        this.playerLimbs.armR.rotation.x = -armSwing;
        this.playerLimbs.legL.rotation.x = -legSwing;
        this.playerLimbs.legR.rotation.x = legSwing;
      } else {
        // In the air — tuck legs forward, arms back. Keeps a clean
        // jump pose instead of mid-stride limbs frozen.
        this.playerLimbs.legL.rotation.x = -0.6;
        this.playerLimbs.legR.rotation.x = -0.6;
        this.playerLimbs.armL.rotation.x = 0.5;
        this.playerLimbs.armR.rotation.x = 0.5;
      }
    }
    // Advance the running character's mixer continuously — the
    // run animation is permanently looping regardless of whether
    // the runner is the currently-visible character. Cheap to
    // keep ticking and means the run is at a sensible frame the
    // moment we swap back to it on landing.
    this.playerMixer?.update(dt);
    // Advance the jump character's mixer only while it's the
    // visible one. While the runner is visible, the jump action
    // sits at frame 0 (we reset() it on each takeoff anyway).
    if (this.playerJumpVisual?.visible && this.playerJumpMixer) {
      this.playerJumpMixer.update(dt);
    }
    // Procedural fallback for when the jump character FBX hasn't
    // loaded (e.g. fetch failed). Only fires if we have NO jump
    // visual — when the visual is in place, swapping it handles
    // everything.
    if (!grounded && !this.playerJumpVisual) {
      this.applyAdditiveJumpPose();
    }

    // ── Scroll floor stripes ──────────────────────────────────
    for (const s of this.floorStripes) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }
    // ── Scroll velvet-rope stanchions (same rhythm as stripes)
    for (const u of this.velvetRopes) {
      u.position.z += scroll;
      if (u.position.z > 4) u.position.z -= 90;
    }
    // ── Scroll dancer podiums (same 90 m wavelength as ropes)
    for (const p of this.dancerPodiums) {
      p.group.position.z += scroll;
      if (p.group.position.z > 4) p.group.position.z -= 90;
    }
    // ── Scroll wall portraits (same 90 m wavelength)
    for (const p of this.wallPortraits) {
      p.position.z += scroll;
      if (p.position.z > 4) p.position.z -= 90;
    }
    // ── Scroll VIP booths (same 90 m wavelength)
    for (const b of this.vipBooths) {
      b.position.z += scroll;
      if (b.position.z > 4) b.position.z -= 90;
    }
    // ── Scroll wall speakers (same 90 m wavelength)
    for (const s of this.wallSpeakers) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }
    // ── Scroll floor-text bands (same 90 m wavelength)
    for (const f of this.floorTexts) {
      f.position.z += scroll;
      if (f.position.z > 4) f.position.z -= 90;
    }
    // ── Scroll wall "Shots Bitch" neon signs (same 90 m wavelength)
    for (const s of this.wallShots) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }
    // ── Scroll wall strobes (same 90 m wavelength) + per-frame
    // pulse: each strobe modulates its emissive panel opacity on a
    // sin-wave keyed to (gameTime + phase). The ABS converts the
    // sine into a sawtooth-like pulse (0 → 1 → 0 over each half
    // wavelength), and POWER concentrates the on-time so most of
    // the cycle is dark with a brief bright flash — the classic
    // club strobe feel rather than a smooth pulse.
    for (const s of this.wallStrobes) {
      s.group.position.z += scroll;
      if (s.group.position.z > 4) s.group.position.z -= 90;
      // Frequency ~ 2.5 Hz total cycle (2 * 2.5 = 5 flashes/sec when
      // squared). Tweak the multiplier for faster/slower if needed.
      const t = this.duration * 5.0 + s.phase;
      const pulse = Math.pow(Math.max(0, Math.sin(t)), 8.0);
      s.material.opacity = pulse;
    }

    // ── Animate club lights + dancer podium LED pulse + dance loops
    this.tickClubLights(this.duration);
    this.tickDancerPodiums(this.duration);
    // tickDancers takes `dt` (advances each dancer's mixer by the
    // per-frame delta), unlike the time-clock-driven LED pulse.
    this.tickDancers(dt);

    // ── Scroll pickups, check collection / pass ────────────────
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      // Save pre-scroll z for the swept-CCD collision check. At
      // high speed (max 22 m/s) per-frame scroll can exceed the
      // combined collision window (~0.64 m for the smallest
      // pickup) and the pickup would otherwise tunnel through the
      // player without registering a hit.
      const prevZ = p.mesh.position.z;
      p.mesh.position.z += scroll;
      // (No pickup rotation — the bottle silhouettes scroll past
      // facing the camera so labels stay readable. Champagne badges
      // specifically would orbit around the bottle centre under
      // rotation, swinging between visible and hidden.)

      if (
        !p.resolved &&
        this.intersectsPlayer(p.mesh, 0.6, false, prevZ)
      ) {
        this.collectPickup(p);
        p.resolved = true;
      }
      if (p.mesh.position.z > WORLD.DESPAWN_Z) {
        // Missing a bottle does NOT break the combo — combo is a
        // pure time mechanic now (`comboWindowSeconds`). The HUD
        // timer bar above the buzz meter is the visual contract:
        // it drains over the admin-tunable window, and the combo
        // breaks when the bar hits zero. Earlier we also broke on
        // any uncollected pickup, but that made the visual bar
        // disappear partway through and feel arbitrary.
        this.scene.remove(p.mesh);
        this.disposeMesh(p.mesh);
        this.pickups.splice(i, 1);
      }
    }

    // ── Scroll obstacles, check collisions ────────────────────
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      // Save pre-scroll z so the swept-CCD collision check can
      // catch the obstacle even when per-frame scroll exceeds the
      // collision window. Same tunneling risk as pickups, just
      // with the inverse player-impact (obstacle tunneling = lucky
      // escape for the player), and the user wants consistent
      // collision so high-speed obstacles register properly.
      const obsPrevZ = o.mesh.position.z;
      o.mesh.position.z += scroll;
      // Disco balls spin so the mirror-ball look feels alive — but
      // we spin only the BALL child, not the whole obstacle mesh
      // (the long hanging cable would visibly wobble if it rotated
      // along with the ball).
      if (o.spec.kind === 'discoBall') {
        const spinTarget = o.mesh.userData.spinTarget as
          | THREE.Object3D
          | undefined;
        if (spinTarget) spinTarget.rotation.y += dt * 1.4;
      }
      // Dancers + bouncers carry a per-instance AnimationMixer
      // driving their animation loop. Tick each independently.
      o.mixer?.update(dt);
      if (o.mesh.position.z > WORLD.DESPAWN_Z) {
        this.scene.remove(o.mesh);
        // Stop the mixer + uncache the root before disposing so
        // Three doesn't retain references in its action cache.
        if (o.mixer) {
          o.mixer.stopAllAction();
          o.mixer.uncacheRoot(o.mixer.getRoot());
        }
        // For GLB-cloned dancers + bouncers, geometry + materials
        // are SHARED across all clones via SkeletonUtils.clone.
        // Disposing them on one despawn would break every other
        // live instance. We only dispose the per-instance bits
        // (the invisible collider's BoxGeometry + its
        // MeshBasicMaterial) and let the shared GLTF resources
        // stay alive until game dispose.
        if (
          (o.spec.kind === 'dancer' || o.spec.kind === 'bouncer') &&
          o.mixer
        ) {
          o.mesh.geometry.dispose();
          const cm = o.mesh.material;
          if (Array.isArray(cm)) cm.forEach((m) => m.dispose());
          else cm.dispose();
        } else {
          this.disposeMesh(o.mesh);
        }
        this.obstacles.splice(i, 1);
        continue;
      }
      if (
        this.intersectsPlayer(
          o.mesh,
          1.0,
          o.spec.airOnly,
          obsPrevZ,
          o.spec.unjumpable,
        )
      ) {
        this.endGame(o.spec.failReason);
        return;
      }
    }

    // ── Combo expiry ──────────────────────────────────────────
    if (this.combo > 0) {
      this.comboTimer += dt;
      if (this.comboTimer >= this.comboWindowSeconds) {
        this.breakCombo();
      }
    }
    this.hud.setComboProgress(
      this.combo > 0
        ? 1 - this.comboTimer / Math.max(this.comboWindowSeconds, 0.001)
        : 0,
    );

    // ── Spawn pickups + obstacles ─────────────────────────────
    // Two stacked effects on each interval:
    //   1. TIME RAMP — linearly interpolate from base interval toward
    //      `*IntervalMinSeconds` over the first `*RampSeconds` of the
    //      run. Drives the "feels more intense as I go" curve while
    //      keeping the early-game forgiving.
    //   2. SPEED SCALE — multiply by `startSpeed / speed` so a faster
    //      world also gets denser spawns (preserves the original
    //      coupling — the spawner sees the same Z-space density even
    //      when speed ramps).
    //   3. FLOOR — final Math.max(intervalMin, ...) so high speed
    //      late in the run can't push spawns below the cap.
    this.spawnAccumPickup += dt;
    this.spawnAccumObstacle += dt;
    const speedScale = this.startSpeed / this.speed;
    const pickupRampT =
      this.pickupRampSeconds > 0
        ? Math.min(1, this.duration / this.pickupRampSeconds)
        : 0;
    const pickupBase =
      this.pickupIntervalSeconds * (1 - pickupRampT) +
      this.pickupIntervalMinSeconds * pickupRampT;
    const pickupInterval = Math.max(
      this.pickupIntervalMinSeconds,
      pickupBase * speedScale,
    );
    const obstacleRampT =
      this.obstacleRampSeconds > 0
        ? Math.min(1, this.duration / this.obstacleRampSeconds)
        : 0;
    const obstacleBase =
      this.obstacleIntervalSeconds * (1 - obstacleRampT) +
      this.obstacleIntervalMinSeconds * obstacleRampT;
    const obstacleInterval = Math.max(
      this.obstacleIntervalMinSeconds,
      obstacleBase * speedScale,
    );
    if (this.spawnAccumPickup >= pickupInterval) {
      this.spawnAccumPickup = 0;
      this.spawnPickup();
    }
    if (this.spawnAccumObstacle >= obstacleInterval) {
      this.spawnAccumObstacle = 0;
      this.spawnObstacle();
    }

    // ── HUD updates (cheap, per-frame) ────────────────────────
    this.hud.setScore(this.score);
    this.hud.setDistance(this.distance);
    this.hud.setSpeed(this.speed);
    this.hud.setBuzz(this.buzz.getLevel());
    this.hud.setVignette(buzzFx.vignette);
    // Combo HUD is set inside collectPickup() — the timed fade
    // happens via the HUD's internal timer, so we don't re-set
    // here every frame.
  }

  // ── Lighting animation ─────────────────────────────────────────

  /**
   * Pulse + drift each point light independently. Pulse uses a
   * scaled sine so intensity stays in [0.35, 1.15] × base — never
   * fully dark (a club rig doesn't black out mid-set) but with
   * enough swing to feel alive. Drift slides each light along Z
   * over time so the bright spot on the floor isn't static, which
   * adds a sense of motion separate from the world scroll.
   */
  private tickClubLights(t: number) {
    const brightness = this.brightnessMultiplier;
    for (const c of this.clubLights) {
      const phase = t * c.pulseHz * Math.PI * 2 + c.phase;
      const pulse = 0.75 + 0.40 * Math.sin(phase);
      // Fold the admin brightness multiplier in here — applying it
      // statically in init() would be overwritten on the next frame.
      c.light.intensity = c.baseIntensity * pulse * brightness;
      // Drift along Z — different phase so each light moves
      // independently. Range is small (driftAmp units), so lights
      // sweep over the runway gently rather than flying around.
      c.light.position.z =
        c.baseZ + Math.sin(t * c.pulseHz * 0.5 + c.phase) * c.driftAmp;
    }
    // LED ceiling: feed time + brightness + accumulated world
    // scroll distance to the shader. uScroll drives the cell
    // grid offset so the dot pattern flows toward the camera at
    // the same speed as the floor stripes / podiums / ropes
    // (which are scrolled by `speed * dt` per frame and recycle
    // at z = 4). `this.distance` accumulates speed × dt every
    // frame in the main update loop, so we just hand it through.
    // Ceiling uses the master brightness × its own per-feature
    // multiplier so admins can dim the ceiling without dimming
    // the rest of the room (Tape's ceiling is typically darker
    // than the floor / podium fixtures anyway).
    if (this.ledCeilingMat) {
      this.ledCeilingMat.uniforms.uTime.value = t;
      this.ledCeilingMat.uniforms.uBrightness.value =
        brightness * this.ceilingBrightnessMultiplier;
      this.ledCeilingMat.uniforms.uScroll.value = this.distance;
    }
  }

  /**
   * Pre-game idle animation: the player runs in place. Same
   * limb-swing + bob the in-game update uses, just with a fixed
   * cadence (no speed multiplier — the world isn't actually
   * moving yet). Keeps the runway feeling alive so the
   * "SWIPE TO START" overlay doesn't sit over a frozen tableau.
   */
  private runPlayerIdleAnimation(t: number, dt: number) {
    // Subtle bob — same range as the in-game run.
    const bobPhase = t * 8;
    this.player.position.y =
      PLAYER.BASE_Y + Math.sin(bobPhase) * 0.07;
    if (this.isPlaceholderPlayer) {
      const stridePhase = t * 5.5;
      const armSwing = Math.sin(stridePhase) * 0.45;
      const legSwing = Math.sin(stridePhase) * 0.40;
      this.playerLimbs.armL.rotation.x = armSwing;
      this.playerLimbs.armR.rotation.x = -armSwing;
      this.playerLimbs.legL.rotation.x = -legSwing;
      this.playerLimbs.legR.rotation.x = legSwing;
    } else {
      // Mixamo character — the run animation plays continuously
      // from the moment the GLB loads, so they're already
      // running in place. We just tick the mixer here too.
      this.playerMixer?.update(dt);
    }
  }

  // ── Spawning ────────────────────────────────────────────────────

  /**
   * Lazily build (and cache) the glowing shield-shape texture used
   * as the front label on champagne / magnum / methuselah pickups.
   * Drawn on a 256×320 canvas (~4:5 aspect, matching the real
   * Dom Pérignon Luminous shield). Path:
   *
   *   ┌──────┐    rounded-rectangle top portion
   *   │      │
   *   │      │    straight sides for the upper half
   *   ╲      ╱    curve inward
   *     ╲  ╱      meeting at a point at the bottom
   *
   * Filled with a bright neon green (matches the body's emissive
   * tone) plus a strong shadow-blur glow ring so the badge reads
   * as luminous through fog. A small dark star at the bottom
   * gestures toward the brand mark inside a real Dom Pérignon
   * label without committing to specific brand text.
   */
  private getChampagneLabelTexture(): THREE.CanvasTexture {
    if (this.champagneLabelTexture) return this.champagneLabelTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // Fallback: blank texture if canvas isn't available. Won't
      // happen in browsers but keeps TS happy.
      const t = new THREE.CanvasTexture(canvas);
      this.champagneLabelTexture = t;
      return t;
    }

    // Shield outline path — corners at top, taper to a point at
    // the bottom. The numbers map to canvas px.
    const drawShieldPath = () => {
      ctx.beginPath();
      ctx.moveTo(40, 30);
      ctx.lineTo(216, 30);
      ctx.lineTo(216, 140);
      ctx.quadraticCurveTo(216, 240, 128, 286);
      ctx.quadraticCurveTo(40, 240, 40, 140);
      ctx.closePath();
    };

    // Pass 1 — outer glow via shadowBlur.
    ctx.shadowColor = 'rgba(76, 255, 156, 0.9)';
    ctx.shadowBlur = 36;
    ctx.fillStyle = 'rgba(76, 255, 156, 0.95)';
    drawShieldPath();
    ctx.fill();

    // Pass 2 — solid fill without shadow for a crisp body.
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(76, 255, 156, 0.95)';
    drawShieldPath();
    ctx.fill();

    // Inner dark outline so the shield's edge reads against bright
    // backgrounds (club-light pulses can wash out the neon green).
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 60, 30, 0.55)';
    drawShieldPath();
    ctx.stroke();

    // Small dark star near the bottom of the shield — pure
    // decoration; reads as a brand mark from a distance.
    ctx.fillStyle = 'rgba(0, 50, 25, 0.7)';
    const cx = 128;
    const cy = 220;
    const r = 16;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.4;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    const t = new THREE.CanvasTexture(canvas);
    // Pixel-snap rendering off so the shield's curves don't look
    // jagged when scaled down to bottle size.
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    this.champagneLabelTexture = t;
    return t;
  }

  /**
   * Weighted-pick a pickup spec, honouring admin overrides in
   * `pickupWeightOverrides`. Weights of 0 (or missing keys after
   * override) disable that pickup entirely. If every weight ends
   * up at 0, falls back to water as the safe default.
   */
  private rollAdjustedPickup(): PickupSpec {
    const entries: { spec: PickupSpec; weight: number }[] = [];
    let total = 0;
    for (const spec of Object.values(PICKUPS)) {
      const w = this.pickupWeightOverrides[spec.kind] ?? spec.weight;
      if (w > 0) {
        entries.push({ spec, weight: w });
        total += w;
      }
    }
    if (total <= 0) return PICKUPS.water;
    let r = Math.random() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r <= 0) return e.spec;
    }
    return entries[entries.length - 1].spec;
  }

  /** Same weighted-pick logic for obstacles. */
  private rollAdjustedObstacle(): ObstacleSpec {
    const entries: { spec: ObstacleSpec; weight: number }[] = [];
    let total = 0;
    for (const spec of Object.values(OBSTACLES)) {
      const w = this.obstacleWeightOverrides[spec.kind] ?? spec.weight;
      if (w > 0) {
        entries.push({ spec, weight: w });
        total += w;
      }
    }
    if (total <= 0) return OBSTACLES.speaker;
    let r = Math.random() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r <= 0) return e.spec;
    }
    return entries[entries.length - 1].spec;
  }

  /** Pickup point value with admin override applied if set. */
  private getPickupScore(spec: PickupSpec): number {
    return this.pickupScoreOverrides[spec.kind] ?? spec.score;
  }

  /**
   * Combo multiplier for the given combo count, honouring the
   * admin-tunable `comboTiers` array. Picks the highest tier
   * whose threshold the combo satisfies; falls back to 1.0 below
   * the smallest threshold. Replaces the static `comboMultiplier`
   * function in tuning.ts (which is no longer wired into the
   * runtime — kept around as the default baseline).
   */
  private getComboMultiplier(combo: number): number {
    // Walk in reverse — tiers are sorted ascending, so the first
    // hit from the back is the highest applicable multiplier.
    for (let i = this.comboTiers.length - 1; i >= 0; i--) {
      const t = this.comboTiers[i];
      if (combo >= t.threshold) return t.multiplier;
    }
    return 1.0;
  }

  /**
   * Build the visible bottle/glass mesh for a pickup spec. Returns
   * a Group whose origin is at the bottle's BASE (y=0 inside the
   * group), so callers can position the group's `y` directly to
   * where the bottle should sit. No collider, no world placement —
   * pure geometry.
   *
   * `scale` uniformly multiplies the spec's radius + height. Used
   * by the runway pickup spawner at scale=1, and by the VIP booth
   * builder at smaller scales so the same bottle silhouettes
   * appear in both contexts without geometry duplication.
   */
  private buildPickupVisual(spec: PickupSpec, scale = 1): THREE.Group {
    const group = new THREE.Group();
    const r = spec.radius * scale;
    const h = spec.height * scale;
    const isChampagne =
      spec.kind === 'champagne' ||
      spec.kind === 'magnum' ||
      spec.kind === 'methuselah';

    // Default body material for the generic (vodka / water) bottles.
    // Overridden inside the isChampagne branch with dark Dom-Pérignon-
    // Luminous glass tones.
    const bodyMat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.30,
      metalness: 0.15,
      emissive: spec.color,
      emissiveIntensity: spec.kind === 'methuselah' ? 0.45 : 0.18,
    });

    if (isChampagne) {
      // Dom Pérignon Luminous-style silhouette: dark glass body
      // (almost black with a faint green tint) + sharp shoulder
      // cone + narrow neck + dark foil + black wire cage + glowing
      // GREEN label band around the middle of the body. The label
      // is what reads as "champagne" at a distance, since the body
      // colour itself is the same near-black as the foil. Tier
      // (champagne / magnum / methuselah) is signalled by size
      // and — for methuselah only — the gold halo torus.

      // Material overrides — dark glass body, dark foil, dark cage.
      // Tiny green emissive tint on the glass so the bottle's
      // silhouette reads against the dark fog even when the club
      // lights aren't directly hitting it.
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0x0c1a14,
        roughness: 0.20,
        metalness: 0.45,
        emissive: 0x143028,
        emissiveIntensity: 0.18,
      });
      const foilMat = new THREE.MeshStandardMaterial({
        color: 0x141414,
        roughness: 0.35,
        metalness: 0.70,
      });
      const cageMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        roughness: 0.55,
        metalness: 0.40,
      });

      const bodyH = h * 0.52;
      const shoulderH = h * 0.14;
      const neckH = h * 0.28;
      const foilH = neckH * 0.55;
      const corkH = h * 0.06;
      const neckR = r * 0.32;

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.96, r, bodyH, 18),
        glassMat,
      );
      body.position.y = bodyH / 2;
      group.add(body);

      // Glowing GREEN shield badge — a flat sprite parented at the
      // bottle's Y rotation axis (X=0, Z=0). Sprites always face the
      // camera, so the badge stays oriented to the player regardless
      // of how the bottle is spinning underneath. Placing it AT the
      // rotation axis means the spin doesn't translate the sprite
      // around the bottle's centre — it stays put on the front.
      //
      // The shield-shape texture is generated once on first call
      // and cached on the game instance.
      const labelTexture = this.getChampagneLabelTexture();
      const labelMat = new THREE.SpriteMaterial({
        map: labelTexture,
        transparent: true,
        // Normal depth testing — sprite sits in front of the bottle
        // body but behind anything between it and the camera (player,
        // closer obstacles). depthWrite off so the sprite's quad
        // doesn't punch a hole in the depth buffer for objects
        // behind it.
        depthTest: true,
        depthWrite: false,
      });
      const label = new THREE.Sprite(labelMat);
      // Sprite scale = world-space dimensions of the rendered quad.
      // Width ≈ 1.4 × body radius keeps the badge inside the bottle's
      // silhouette from the front. Height is wider × the canvas
      // aspect ratio (320/256 = 1.25).
      const labelWidth = r * 1.4;
      const labelHeight = labelWidth * 1.25;
      label.scale.set(labelWidth, labelHeight, 1);
      // Sit slightly in FRONT of the bottle (+Z, the camera-facing
      // side) so it composites cleanly over the body without
      // depth-fighting through the cylinder wall. The bottle no
      // longer rotates per-frame so this position stays on the
      // front face for the whole approach.
      label.position.set(0, bodyH * 0.5, r + 0.02);
      group.add(label);

      // Shoulder — sharp taper from body radius down to neck radius.
      const shoulder = new THREE.Mesh(
        new THREE.CylinderGeometry(neckR, r * 0.96, shoulderH, 18),
        glassMat,
      );
      shoulder.position.y = bodyH + shoulderH / 2;
      group.add(shoulder);

      // Neck — slim cylinder above the shoulder.
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(neckR * 0.96, neckR, neckH, 12),
        glassMat,
      );
      neck.position.y = bodyH + shoulderH + neckH / 2;
      group.add(neck);

      // Foil — DARK metallic wrap covering the upper neck.
      // Slightly wider than the neck so it visually layers on top.
      const foil = new THREE.Mesh(
        new THREE.CylinderGeometry(neckR * 1.12, neckR * 1.08, foilH, 12),
        foilMat,
      );
      foil.position.y = bodyH + shoulderH + neckH - foilH / 2;
      group.add(foil);

      // Wire cage / cork mushroom — dark grey (Dom Pérignon uses
      // a black wire cage over the cork, our placeholder is a
      // textureless solid).
      const cork = new THREE.Mesh(
        new THREE.CylinderGeometry(neckR * 1.20, neckR * 0.98, corkH, 12),
        cageMat,
      );
      cork.position.y = bodyH + shoulderH + neckH + corkH / 2;
      group.add(cork);
    } else {
      // Non-champagne pickups now branch on kind so each kind has
      // a recognisable silhouette instead of "same bottle, different
      // cap colour".
      if (spec.kind === 'vodkaMini') {
        // ── Vodka shot — short squat tumbler with visible liquid.
        const glassMat = new THREE.MeshStandardMaterial({
          color: 0xf0f0f0,
          roughness: 0.05,
          metalness: 0.15,
          transparent: true,
          opacity: 0.40,
        });
        const liquidMat = new THREE.MeshStandardMaterial({
          color: 0xf6f5ec,
          roughness: 0.2,
          metalness: 0.0,
          emissive: 0xb0a890,
          emissiveIntensity: 0.30,
        });
        const rimMat = new THREE.MeshStandardMaterial({
          color: 0xe6e6ea,
          roughness: 0.15,
          metalness: 0.25,
        });
        // Shot glass: slightly tapered (top wider than base). Real
        // shot glasses are roughly 1:1 ratio; ours is a touch taller
        // than wide so it still reads as a glass + liquid sandwich.
        const rTop = r * 1.05;
        const rBottom = r * 0.78;
        const glassH = h;
        const glass = new THREE.Mesh(
          new THREE.CylinderGeometry(rTop, rBottom, glassH, 16),
          glassMat,
        );
        glass.position.y = glassH / 2;
        group.add(glass);
        // Liquid sits inside the glass, fills ~65% of height.
        const liqH = glassH * 0.65;
        const liquid = new THREE.Mesh(
          new THREE.CylinderGeometry(rTop * 0.90, rBottom * 0.90, liqH, 16),
          liquidMat,
        );
        liquid.position.y = liqH / 2 + 0.01;
        group.add(liquid);
        // Rim — thin metallic torus along the top edge so the glass
        // has visible mass even with the translucent walls.
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(rTop * 0.97, 0.012, 6, 18),
          rimMat,
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = glassH * 0.99;
        group.add(rim);
      } else if (spec.kind === 'vodkaBottle') {
        // ── Vodka bottle (Grey-Goose / Absolut style):
        // straight cylindrical body + short sharp shoulder + straight
        // narrow neck + WIDE FLAT silver screw cap.
        const capMat = new THREE.MeshStandardMaterial({
          color: 0xc4c4c8,
          roughness: 0.35,
          metalness: 0.75,
        });
        const bodyH = h * 0.62;
        const shoulderH = h * 0.05;
        const neckH = h * 0.22;
        const capH = h * 0.11;
        const neckR = r * 0.36;

        // Body — no taper.
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, bodyH, 16),
          bodyMat,
        );
        body.position.y = bodyH / 2;
        group.add(body);
        // Sharp shoulder — short, almost-angular taper.
        const shoulder = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, r, shoulderH, 16),
          bodyMat,
        );
        shoulder.position.y = bodyH + shoulderH / 2;
        group.add(shoulder);
        // Straight neck — no taper.
        const neck = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, neckR, neckH, 12),
          bodyMat,
        );
        neck.position.y = bodyH + shoulderH + neckH / 2;
        group.add(neck);
        // Wide flat screw cap — squat, much wider than neck.
        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR * 1.30, neckR * 1.30, capH, 12),
          capMat,
        );
        cap.position.y = bodyH + shoulderH + neckH + capH / 2;
        group.add(cap);
      } else {
        // ── Water sport bottle: curvy body + smooth shoulder +
        // short neck + DOMED pull-cap. The shape is the main
        // differentiator from the vodka bottle.
        const capMat = new THREE.MeshStandardMaterial({
          color: 0x2b6fb3,
          roughness: 0.4,
          metalness: 0.30,
        });
        const bottomH = h * 0.30;
        const topH = h * 0.32;
        const shoulderH = h * 0.10;
        const neckH = h * 0.10;
        const capBaseH = h * 0.10;
        const capDomeH = h * 0.08;
        const neckR = r * 0.42;

        // Lower body — slight inward taper at the base.
        const bottom = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r * 0.85, bottomH, 16),
          bodyMat,
        );
        bottom.position.y = bottomH / 2;
        group.add(bottom);
        // Upper body — slight outward taper for the curvy silhouette.
        const top = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 0.95, r, topH, 16),
          bodyMat,
        );
        top.position.y = bottomH + topH / 2;
        group.add(top);
        // Smooth shoulder — generous taper down to a wider neck.
        const shoulder = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, r * 0.95, shoulderH, 16),
          bodyMat,
        );
        shoulder.position.y = bottomH + topH + shoulderH / 2;
        group.add(shoulder);
        // Short neck (wide opening for sport drinking).
        const neck = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, neckR, neckH, 12),
          bodyMat,
        );
        neck.position.y = bottomH + topH + shoulderH + neckH / 2;
        group.add(neck);
        // Cap base — wider than the neck, blue plastic.
        const capBase = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR * 1.10, neckR * 1.10, capBaseH, 12),
          capMat,
        );
        capBase.position.y =
          bottomH + topH + shoulderH + neckH + capBaseH / 2;
        group.add(capBase);
        // Dome top — half-sphere for the sport flip-cap profile.
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(neckR * 0.85, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
          capMat,
        );
        dome.position.y =
          bottomH + topH + shoulderH + neckH + capBaseH + 0.005;
        group.add(dome);
        // Tiny pull-spout on the dome.
        const spout = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR * 0.18, neckR * 0.22, capDomeH * 0.55, 8),
          capMat,
        );
        spout.position.y =
          bottomH + topH + shoulderH + neckH + capBaseH + capDomeH * 0.30;
        group.add(spout);
      }
    }

    // Methuselah halo — emissive ring around the body. Sells the
    // "rare pickup" feel even from a distance, before the player
    // can read the bottle silhouette.
    if (spec.kind === 'methuselah') {
      const ringGeo = new THREE.TorusGeometry(
        r * 1.55,
        r * 0.07,
        12,
        24,
      );
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffd45a,
        transparent: true,
        opacity: 0.7,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = h * 0.4;
      group.add(ring);
    }

    return group;
  }

  private spawnPickup() {
    const spec = this.rollAdjustedPickup();
    const group = this.buildPickupVisual(spec);

    // ── Collider mesh (invisible — Group can't carry geometry for
    // intersectsPlayer's BoxGeometry / CylinderGeometry inspection).
    // We use a hidden cylinder with the spec's nominal dimensions
    // so existing collision logic Just Works.
    const colliderGeo = new THREE.CylinderGeometry(
      spec.radius,
      spec.radius,
      spec.height,
      8,
    );
    const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
    const mesh = new THREE.Mesh(colliderGeo, colliderMat);
    mesh.add(group);
    // Group sits at y=0 relative to mesh; mesh.position.y handles
    // the world Y placement. Re-centre the group so body+neck+cap
    // align around the collider's centre.
    group.position.y = -spec.height / 2;

    const lane = Math.floor(Math.random() * LANES.X.length);
    mesh.position.set(LANES.X[lane], spec.height / 2 + 0.15, WORLD.SPAWN_Z);
    this.scene.add(mesh);
    this.pickups.push({ mesh, spec, resolved: false });
  }

  private spawnObstacle() {
    const spec = this.rollAdjustedObstacle();
    const built = this.buildObstacleMesh(spec);
    const lane = Math.floor(Math.random() * LANES.X.length);
    built.mesh.position.set(LANES.X[lane], spec.baseY, WORLD.SPAWN_Z);
    this.scene.add(built.mesh);
    this.obstacles.push({
      mesh: built.mesh,
      spec,
      mixer: built.mixer,
    });
  }

  /**
   * Build the visible + collidable mesh for an obstacle. Each kind
   * uses a single "collider" mesh that intersectsPlayer reads for
   * AABB / sphere math; decorative children hang off it as visual
   * additions that don't affect collision.
   *
   * - speaker: dark cabinet box + raised front panel + woofer cone
   *   + tweeter cone, all facing +Z (player-camera-side).
   * - bouncer: dark red box (placeholder — real bouncer geometry
   *   when we move beyond placeholders).
   * - discoBall: INVISIBLE collider sphere with two visible
   *   children — the spinning mirror ball and a static long cable
   *   going up off-screen. Spin only touches the ball child so the
   *   cable stays vertical.
   */
  private buildObstacleMesh(spec: ObstacleSpec): {
    mesh: THREE.Mesh;
    mixer?: THREE.AnimationMixer;
  } {
    if (spec.kind === 'discoBall') {
      // Invisible collider sphere — geometry only used for
      // intersectsPlayer's radius read.
      const colliderGeo = new THREE.SphereGeometry(spec.width / 2, 8, 6);
      const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
      const mesh = new THREE.Mesh(colliderGeo, colliderMat);

      // Visible mirror ball — this is the only thing that spins.
      const ballGeo = new THREE.SphereGeometry(spec.width / 2, 20, 14);
      const ballMat = new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.15,
        metalness: 0.9,
        emissive: 0xffffff,
        emissiveIntensity: 0.12,
      });
      const ball = new THREE.Mesh(ballGeo, ballMat);
      mesh.add(ball);

      // Long cable — extends well above the camera's frustum so it
      // reads as "hanging from the ceiling." Static (not spinning).
      // 12 units is more than enough to fly off the top of any
      // viewport at this camera height + FOV.
      const cableLen = 12;
      const cableGeo = new THREE.CylinderGeometry(0.025, 0.025, cableLen, 6);
      const cableMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
      const cable = new THREE.Mesh(cableGeo, cableMat);
      cable.position.y = spec.width / 2 + cableLen / 2;
      mesh.add(cable);

      // Stash the spinning child so update() can find it without
      // assuming a specific children[] index.
      mesh.userData.spinTarget = ball;
      return { mesh };
    }

    if (spec.kind === 'speaker') {
      // Cabinet — slightly lighter than before so the silver rims
      // pop against it. Real club PA cabinets are matte black; we
      // ride a touch lighter (0x252525) for visibility in fog.
      const cabinetGeo = new THREE.BoxGeometry(
        spec.width,
        spec.height,
        spec.depth,
      );
      const cabinetMat = new THREE.MeshStandardMaterial({
        color: 0x252525,
        roughness: 0.7,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(cabinetGeo, cabinetMat);

      // Front faceplate — darker than the cabinet so the cones'
      // silver rims contrast against it.
      const panelGeo = new THREE.BoxGeometry(
        spec.width * 0.92,
        spec.height * 0.92,
        0.04,
      );
      const panelMat = new THREE.MeshStandardMaterial({
        color: 0x0e0e0e,
        roughness: 0.55,
        metalness: 0.35,
      });
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.position.z = spec.depth / 2 + 0.02;
      mesh.add(panel);

      // Driver rim material — SILVER, prominent enough to read at
      // distance through fog. Thick torus tube so the rim has
      // visible mass instead of looking like a hairline.
      const rimMat = new THREE.MeshStandardMaterial({
        color: 0x9a9a9a,
        roughness: 0.4,
        metalness: 0.85,
      });
      // Cone (the actual speaker membrane) — pure matte black so
      // the rim's silver clearly outlines it.
      const coneMat = new THREE.MeshStandardMaterial({
        color: 0x040404,
        roughness: 0.95,
        metalness: 0.0,
      });
      // Dust cap — silver dome at the centre of each driver.
      const dustCapMat = new THREE.MeshStandardMaterial({
        color: 0x707070,
        roughness: 0.45,
        metalness: 0.7,
      });

      // Driver Z plane — pushed further forward (0.10 in front of
      // the cabinet face) so the rims cast a clear silhouette edge
      // against the panel even at oblique camera angles.
      const driverZ = spec.depth / 2 + 0.08;

      // Woofer (large driver, ~60% of width, lower half of front).
      const wooferR = spec.width * 0.30;
      const wooferY = -spec.height * 0.15;
      const wooferRim = new THREE.Mesh(
        // Thicker tube — 0.075 vs the old 0.045 — so the rim reads
        // as a chunky bezel instead of disappearing.
        new THREE.TorusGeometry(wooferR, 0.075, 10, 28),
        rimMat,
      );
      wooferRim.position.set(0, wooferY, driverZ);
      mesh.add(wooferRim);
      const wooferCone = new THREE.Mesh(
        new THREE.CircleGeometry(wooferR * 0.94, 24),
        coneMat,
      );
      wooferCone.position.set(0, wooferY, driverZ - 0.03);
      mesh.add(wooferCone);
      const wooferDust = new THREE.Mesh(
        new THREE.SphereGeometry(wooferR * 0.22, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        dustCapMat,
      );
      wooferDust.rotation.x = -Math.PI / 2;
      wooferDust.position.set(0, wooferY, driverZ + 0.005);
      mesh.add(wooferDust);

      // Tweeter (smaller driver, ~25% of width, upper area).
      const tweeterR = spec.width * 0.13;
      const tweeterY = spec.height * 0.28;
      const tweeterRim = new THREE.Mesh(
        new THREE.TorusGeometry(tweeterR, 0.05, 8, 20),
        rimMat,
      );
      tweeterRim.position.set(0, tweeterY, driverZ);
      mesh.add(tweeterRim);
      const tweeterCone = new THREE.Mesh(
        new THREE.CircleGeometry(tweeterR * 0.92, 18),
        coneMat,
      );
      tweeterCone.position.set(0, tweeterY, driverZ - 0.025);
      mesh.add(tweeterCone);
      const tweeterDust = new THREE.Mesh(
        new THREE.SphereGeometry(tweeterR * 0.32, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        dustCapMat,
      );
      tweeterDust.rotation.x = -Math.PI / 2;
      tweeterDust.position.set(0, tweeterY, driverZ + 0.005);
      mesh.add(tweeterDust);

      // Power-LED — bigger (radius 0.045 vs 0.025), MeshBasicMaterial
      // so it's bright through fog. Sits in the bottom-right of the
      // faceplate — classic PA-amp position.
      const ledGeo = new THREE.CircleGeometry(0.045, 12);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xff4030 });
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(
        spec.width * 0.34,
        -spec.height * 0.40,
        driverZ + 0.005,
      );
      mesh.add(led);

      return { mesh };
    }

    if (spec.kind === 'dancer' || spec.kind === 'bouncer') {
      // GLB-backed humanoid obstacle — preferred path when the
      // cached GLTF is loaded. Each spawn gets its own
      // SkeletonUtils.clone so its animation runs on an
      // independent skeleton + AnimationMixer (otherwise all
      // dancers/bouncers would loop in perfect sync, which looks
      // unnervingly mechanical).
      //
      // Two flavours of this branch:
      //   - 'dancer' uses runner_dancer.glb (dancefloor character,
      //     was previously called "bouncer" — the GLB shows the
      //     dance, not a real bouncer pose)
      //   - 'bouncer' uses runner_bouncer.glb (the actual,
      //     arms-crossed bouncer character)
      // Same collision + alignment logic; differs only by which
      // GLTF is cloned in.
      const gltf =
        spec.kind === 'dancer' ? this.dancerObstacleGltf : this.bouncerGltf;
      if (gltf) {
        const colliderGeo = new THREE.BoxGeometry(
          spec.width,
          spec.height,
          spec.depth,
        );
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        const mesh = new THREE.Mesh(colliderGeo, colliderMat);

        // SkeletonUtils.clone produces an independent copy of the
        // SkinnedMesh + its skeleton — required for per-instance
        // animation. (A plain `gltf.scene.clone()` shares the
        // skeleton, so every clone would play the dance at the
        // same frame.)
        const visual = cloneSkinned(gltf.scene);

        // SkinnedMesh frustum culling is unreliable — its bounding
        // sphere is computed from the bind-pose vertices and doesn't
        // expand to account for animation. A dancing bouncer can
        // travel well outside that sphere and get clipped to nothing.
        // Disable per-skinned-mesh so the parent collider's draw call
        // owns the cull decision.
        visual.traverse((obj) => {
          if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
        });

        // Face the camera (running player approaches from +Z) so
        // the animation reads from the front. `visualRotationY`
        // overrides per spec — Mixamo bind poses can vary, so the
        // bouncer FBX (already facing +Z) uses 0 while the dancer
        // FBX (facing -Z) uses the default π.
        visual.rotation.y = spec.visualRotationY ?? Math.PI;

        // Parent into the collider first so getWorldPosition reflects
        // the full chain (collider → visual → Armature → bone).
        mesh.add(visual);

        // ── Bone-based height + ground alignment ───────────────
        // Do NOT use Box3.setFromObject on a SkinnedMesh — its bbox
        // reflects the bind-pose vertex positions transformed by the
        // mesh's matrixWorld, ignoring both the bone skinning AND any
        // weird Armature rotation. For Mixamo's GLB export the
        // Armature has scale=0.01 + a 90° X tilt, so the bind-pose
        // mesh is "lying on its back" and Box3 returns the depth as
        // the height → wildly wrong scale factor (≈500× over-scale,
        // hence the "giant boots filling the screen" symptom).
        //
        // Instead, walk the bone tree and use the world-Y of the
        // lowest foot/toe/ankle bone and the highest head/top bone.
        // Bone world positions already include the Armature scale,
        // rotation, and the bone hierarchy — they're the same Y
        // coordinates the skinned vertices end up near.
        visual.updateMatrixWorld(true);
        let lowFootY = Infinity;
        let highHeadY = -Infinity;
        const probe = new THREE.Vector3();
        visual.traverse((obj) => {
          if (!(obj instanceof THREE.Bone)) return;
          const n = obj.name.toLowerCase();
          obj.getWorldPosition(probe);
          if (
            n.includes('toe') ||
            n.includes('foot') ||
            n.includes('ankle')
          ) {
            if (probe.y < lowFootY) lowFootY = probe.y;
          }
          if (
            n.includes('headtop') ||
            n.endsWith(':head') ||
            n.endsWith('head_end') ||
            n === 'head'
          ) {
            if (probe.y > highHeadY) highHeadY = probe.y;
          }
        });

        // Default scale: assume the rig is already roughly 1.7 m tall
        // in world space if we can't measure it. Otherwise fit the
        // measured head-to-feet span into spec.height.
        let scaleFactor = 1;
        if (
          isFinite(lowFootY) &&
          isFinite(highHeadY) &&
          highHeadY - lowFootY > 0.2
        ) {
          const measuredH = highHeadY - lowFootY;
          scaleFactor = spec.height / measuredH;
        }
        // Extra per-spec scale on top of the auto-fit (defaults to
        // 1.0). Lets a spec render visually larger than its
        // collision profile — e.g. a 2× bouncer that still has a
        // jump-clearable hitbox.
        const visualExtraScale = spec.visualScale ?? 1.0;
        visual.scale.setScalar(scaleFactor * visualExtraScale);
        visual.updateMatrixWorld(true);

        // Re-measure foot Y after scaling so we can drop the model
        // onto the floor of the collider box. Collider box centre is
        // at the obstacle's world position (handled by the caller),
        // so its floor in the local frame is y = -spec.height/2.
        let newLowFootY = Infinity;
        visual.traverse((obj) => {
          if (!(obj instanceof THREE.Bone)) return;
          const n = obj.name.toLowerCase();
          if (
            !n.includes('toe') &&
            !n.includes('foot') &&
            !n.includes('ankle')
          ) {
            return;
          }
          obj.getWorldPosition(probe);
          if (probe.y < newLowFootY) newLowFootY = probe.y;
        });
        if (isFinite(newLowFootY)) {
          // The collider mesh's local origin is at the collider's centre.
          // We want the feet at world Y = (collider centre Y) - spec.height/2,
          // i.e. at local Y = -spec.height/2 relative to the collider.
          // newLowFootY is the world Y when visual.position.y is 0, so
          // adjust by (target - newLowFootY).
          // The collider is added to the scene later at obstacle baseY,
          // but for this measurement what matters is the OFFSET of the
          // feet relative to the collider's local origin — which is
          // currently `newLowFootY - mesh.position.y`. Since the
          // collider hasn't been added to the scene yet, mesh world Y
          // equals its local Y (defaults to 0), so newLowFootY IS the
          // current foot offset in collider-local space.
          visual.position.y = -spec.height / 2 - newLowFootY;
        } else {
          // No foot bones matched — fall back to half-height shift.
          visual.position.y = -spec.height / 2;
        }
        // Per-spec manual Y nudge for models whose bone-based foot
        // alignment lands them slightly wrong (e.g. the bouncer
        // floats without an offset to compensate).
        visual.position.y += spec.visualOffsetY ?? 0;

        // Optional 3-step black staircase under the character —
        // bouncer stands at the top. Attached to the collider mesh
        // so it scrolls with the obstacle. The visual is positioned
        // above (via visualOffsetY) so its feet land on the top step.
        //
        // Each step extends ALL THE WAY DOWN to the ground (height =
        // STEP_RISE × (i + 1)), so the negative space under the
        // staircase is filled — no floating risers. The top step is
        // a wider PLATFORM (2× depth) for the bouncer to stand on.
        // Steps stack from front to back, accumulated z-positions
        // so variable depths work cleanly.
        if (spec.hasStaircase) {
          const NUM_STEPS = 3;
          const STEP_RISE = 0.3;    // each step's vertical rise
          const STEP_W = 1.5;
          const RISER_DEPTH = 0.4;  // depth of each of the lower steps
          const PLATFORM_DEPTH = 0.8; // top step is a wider platform
          // Black matte material with the faintest metalness so the
          // colored point-light rig catches on the step faces —
          // pure 0x000000 reads as a hole-in-the-scene at the dark
          // nightclub lighting levels.
          const stepMat = new THREE.MeshStandardMaterial({
            color: 0x050505,
            roughness: 0.6,
            metalness: 0.25,
          });
          // Per-step depths, front (index 0) to back (top).
          const depths: number[] = [];
          for (let i = 0; i < NUM_STEPS; i++) {
            depths.push(i === NUM_STEPS - 1 ? PLATFORM_DEPTH : RISER_DEPTH);
          }
          const totalDepth = depths.reduce((a, b) => a + b, 0);
          // Run a Z cursor from the front edge (+totalDepth/2) back
          // toward -Z; each step's centre is cursor − depth/2.
          let zCursor = totalDepth / 2;
          for (let i = 0; i < NUM_STEPS; i++) {
            const stepDepth = depths[i];
            // Tall block extending from ground up to this step's
            // top — fills the negative space under the staircase.
            const stepHeight = STEP_RISE * (i + 1);
            const stepGeo = new THREE.BoxGeometry(
              STEP_W,
              stepHeight,
              stepDepth,
            );
            const step = new THREE.Mesh(stepGeo, stepMat);
            // Centre Y so the box bottom sits on the world ground
            // (which is local y = -spec.baseY).
            step.position.y = -spec.baseY + stepHeight / 2;
            step.position.z = zCursor - stepDepth / 2;
            mesh.add(step);
            zCursor -= stepDepth;
          }
        }

        // Manual Z-offset for the rigged visual — used by the
        // bouncer to step back onto the platform.
        visual.position.z += spec.visualOffsetZ ?? 0;

        // Random start offset so every bouncer is at a different
        // point in the dance loop. Otherwise the lineup of
        // bouncers across spawns looks like a synced chorus.
        if (gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(visual);
          const clip = gltf.animations[0];
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
          // Advance to a random point in the loop so multiple
          // bouncers on screen aren't all in sync.
          mixer.setTime(Math.random() * clip.duration);
          // Force one mixer evaluation so the first rendered frame
          // shows the dance pose, not the bind pose.
          mixer.update(0);
          return { mesh, mixer };
        }
        return { mesh };
      }

      // ── Procedural fallback ─────────────────────────────────
      // No GLB available yet (still loading, or load failed).
      // Broad-shouldered humanoid in a dark suit with arms
      // crossed in front. The collider stays a simple invisible
      // Box (spec.width × spec.height × spec.depth) so
      // intersectsPlayer's AABB math is unchanged.
      const colliderGeo = new THREE.BoxGeometry(
        spec.width,
        spec.height,
        spec.depth,
      );
      const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
      const mesh = new THREE.Mesh(colliderGeo, colliderMat);

      const W = spec.width;
      const H = spec.height;

      // Suit — near-black with the faintest cool tint so it doesn't
      // crush to pure 0,0,0 against the dark fog.
      const suitMat = new THREE.MeshStandardMaterial({
        color: 0x0a0d14,
        roughness: 0.55,
        metalness: 0.15,
      });
      const skinMat = new THREE.MeshStandardMaterial({
        color: 0xc8a070,
        roughness: 0.6,
        metalness: 0.0,
      });
      const hairMat = new THREE.MeshStandardMaterial({
        color: 0x080604,
        roughness: 0.8,
        metalness: 0.05,
      });
      const shoeMat = new THREE.MeshStandardMaterial({
        color: 0x050505,
        roughness: 0.35,
        metalness: 0.3,
      });

      const visual = new THREE.Group();

      // Torso — broad capsule. Wider than the player's so the
      // bouncer reads as imposing.
      const torsoH = H * 0.50;
      const torsoR = W * 0.32;
      const torso = new THREE.Mesh(
        new THREE.CapsuleGeometry(torsoR, torsoH * 0.65, 4, 14),
        suitMat,
      );
      torso.position.y = H * 0.50;
      visual.add(torso);

      // Head — slightly tucked into the shoulders for the "no neck"
      // bouncer silhouette.
      const headR = W * 0.18;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(headR, 14, 12),
        skinMat,
      );
      head.position.y = H * 0.82;
      visual.add(head);

      // Hair — close-cropped flat cap.
      const hair = new THREE.Mesh(
        new THREE.SphereGeometry(
          headR * 0.95,
          12,
          8,
          0,
          Math.PI * 2,
          0,
          Math.PI / 2,
        ),
        hairMat,
      );
      hair.position.y = H * 0.83;
      visual.add(hair);

      // Crossed arms — two horizontal capsules over the chest,
      // offset slightly forward (+Z) so they read as "in front
      // of" the torso. The lower arm is shifted ~5cm down so the
      // pair looks crossed instead of stacked.
      const armLen = W * 0.45;
      const armR = W * 0.10;
      const armGeo = new THREE.CapsuleGeometry(armR, armLen * 0.55, 3, 10);
      const upperArm = new THREE.Mesh(armGeo, suitMat);
      upperArm.rotation.z = Math.PI / 2;
      upperArm.position.set(0, H * 0.55, torsoR * 0.85);
      visual.add(upperArm);
      const lowerArm = new THREE.Mesh(armGeo, suitMat);
      lowerArm.rotation.z = Math.PI / 2;
      lowerArm.position.set(0, H * 0.50, torsoR * 0.92);
      visual.add(lowerArm);

      // Legs — slim suit trousers below the torso.
      const legH = H * 0.36;
      const legR = W * 0.13;
      const legGeo = new THREE.CapsuleGeometry(legR, legH * 0.65, 3, 10);
      const legOffsetX = W * 0.16;
      const legY = H * 0.18;
      const legL = new THREE.Mesh(legGeo, suitMat);
      legL.position.set(-legOffsetX, legY, 0);
      visual.add(legL);
      const legR_ = new THREE.Mesh(legGeo, suitMat);
      legR_.position.set(legOffsetX, legY, 0);
      visual.add(legR_);

      // Polished dress shoes.
      const shoeGeo = new THREE.BoxGeometry(W * 0.16, 0.07, W * 0.26);
      const shoeL = new THREE.Mesh(shoeGeo, shoeMat);
      shoeL.position.set(-legOffsetX, 0.035, W * 0.06);
      visual.add(shoeL);
      const shoeR = new THREE.Mesh(shoeGeo, shoeMat);
      shoeR.position.set(legOffsetX, 0.035, W * 0.06);
      visual.add(shoeR);

      // Earpiece — tiny dark sphere on the right side of the head
      // with a thin curling wire down to the collar. The wire is
      // a slightly bent capsule; for placeholder geometry we just
      // use a short cylinder offset to suggest the cable.
      const earpiece = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 8, 8),
        new THREE.MeshStandardMaterial({
          color: 0x121212,
          roughness: 0.4,
          metalness: 0.5,
        }),
      );
      earpiece.position.set(headR * 0.92, H * 0.82, headR * 0.3);
      visual.add(earpiece);

      // Visual group is parented to the collider mesh. Offset down
      // by half the collider height so feet sit on the ground.
      visual.position.y = -H / 2;
      mesh.add(visual);
      return { mesh };
    }

    // Fallback — any future floor obstacle without specific geometry.
    const geo = new THREE.BoxGeometry(spec.width, spec.height, spec.depth);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.5,
      metalness: 0.05,
    });
    return { mesh: new THREE.Mesh(geo, mat) };
  }

  // ── Pickup collection ─────────────────────────────────────────

  private collectPickup(p: ActivePickup) {
    const spec = p.spec;
    if (spec.kind === 'water') {
      // Water is always safe — even at max buzz, drinking water
      // drops a level (and returns false from add()).
      this.buzz.add(spec.buzzDelta); // -1
      this.watersUsed++;
      // Water doesn't extend combo (no score from it).
      this.hud.flashPickup(spec, 0);
      this.audio.play('water');
    } else {
      // Combo bump + score with multiplier.
      const prevMult = this.getComboMultiplier(this.combo);
      this.combo++;
      this.peakCombo = Math.max(this.peakCombo, this.combo);
      this.comboTimer = 0;
      const mult = this.getComboMultiplier(this.combo);
      // Use admin-tunable score (override map ?? spec default).
      const earned = Math.round(this.getPickupScore(spec) * mult);
      this.score += earned;
      this.bottlesCollected++;
      this.hud.flashPickup(spec, earned, mult, this.combo);
      this.hud.setCombo(this.combo, mult);
      // Tier transition (multiplier jumped) gets the combo SFX —
      // otherwise it's just a regular pickup ding. Avoids spamming
      // the celebratory sound on every bottle inside a tier.
      if (mult > prevMult) {
        this.audio.play('combo');
      } else {
        this.audio.play('pickup');
      }
      // Last — apply the buzz delta. If we were already at max, this
      // is the bottle that tips us over → blackout.
      const blackedOut = this.buzz.add(spec.buzzDelta);
      // Hide the mesh before ending so the player at least sees
      // they DID grab the bottle that killed them (vs feeling like
      // it was lost / dropped through the floor).
      p.mesh.visible = false;
      if (blackedOut) {
        this.endGame('blackout');
        return;
      }
    }
    // Hide the mesh immediately on collection so the player feels
    // the take. We don't bother with a fancy pickup animation in
    // the spike; the HUD flash does the heavy lifting.
    p.mesh.visible = false;
  }

  private breakCombo() {
    if (this.combo === 0) return;
    this.combo = 0;
    this.comboTimer = 0;
    this.hud.setCombo(0, 1);
  }

  // ── Collision ─────────────────────────────────────────────────

  /**
   * AABB collision check on X+Z, with a Y gate based on `airOnly`:
   *   - airOnly=false (default): collide only when player is grounded.
   *     Used for floor obstacles + pickups — jumping is the dodge.
   *   - airOnly=true: collide only when player is airborne. Used for
   *     ceiling-hung obstacles (disco ball) — running under is the
   *     dodge; jumping into it kills.
   *
   * `paddingScale` lets pickups (forgiving) use a wider collision
   * than obstacles (tighter) — bottles easy to grab, speakers easy
   * to dodge.
   */
  private intersectsPlayer(
    mesh: THREE.Mesh,
    paddingScale: number,
    airOnly = false,
    prevZ?: number,
    unjumpable = false,
  ): boolean {
    const oGeo = mesh.geometry as
      | THREE.BoxGeometry
      | THREE.CylinderGeometry
      | THREE.SphereGeometry;
    let halfX: number;
    let halfZ: number;
    if (oGeo instanceof THREE.BoxGeometry) {
      halfX = (oGeo.parameters.width / 2) * WORLD.COLLISION_PADDING;
      halfZ = (oGeo.parameters.depth / 2) * WORLD.COLLISION_PADDING;
    } else if (oGeo instanceof THREE.SphereGeometry) {
      // Sphere — radius is the same in X and Z.
      const r = oGeo.parameters.radius * WORLD.COLLISION_PADDING;
      halfX = r;
      halfZ = r;
    } else {
      // Cylinder — use radius for both X and Z.
      const r = oGeo.parameters.radiusTop * WORLD.COLLISION_PADDING;
      halfX = r;
      halfZ = r;
    }
    halfX *= paddingScale;
    halfZ *= paddingScale;
    const pHalfX = (PLAYER.WIDTH / 2) * WORLD.COLLISION_PADDING;
    const pHalfZ = (PLAYER.DEPTH / 2) * WORLD.COLLISION_PADDING;
    const dx = Math.abs(mesh.position.x - this.player.position.x);
    if (dx > halfX + pHalfX) return false;
    // Z check — swept if `prevZ` is supplied (continuous-collision-
    // detection mode, used by the pickup loop). Otherwise discrete.
    //
    // Why swept matters: at high speed the per-frame z scroll
    // (speed × dt) can exceed the combined collision window
    // (pickupHalfZ + playerHalfZ ≈ 0.32 m on each side for the
    // smallest pickup). The pickup then jumps from "approaching" to
    // "past" in one frame and the discrete check fires at neither
    // sample point — a missed collection. Caller passes the pickup's
    // pre-scroll z; we check whether the swept range [prevZ, currZ]
    // intersects the player's z window at all.
    const playerZ = this.player.position.z;
    const playerMinZ = playerZ - pHalfZ - halfZ;
    const playerMaxZ = playerZ + pHalfZ + halfZ;
    if (prevZ !== undefined) {
      const lo = Math.min(prevZ, mesh.position.z);
      const hi = Math.max(prevZ, mesh.position.z);
      if (hi < playerMinZ) return false;
      if (lo > playerMaxZ) return false;
    } else {
      if (mesh.position.z < playerMinZ) return false;
      if (mesh.position.z > playerMaxZ) return false;
    }
    const airborne = this.player.position.y > 2.0;
    if (unjumpable) {
      // No Y gate — collide whether grounded or airborne. Used
      // for blocking obstacles (e.g. the staircase bouncer) that
      // are too solid / too tall to clear with a jump.
    } else if (airOnly) {
      // Disco-ball rule: only collide when airborne (jumped into it).
      if (!airborne) return false;
    } else {
      // Default floor rule: jumping clears the obstacle.
      if (airborne) return false;
    }
    return true;
  }

  private disposeMesh(mesh: THREE.Mesh) {
    // Traverse — pickups are composite Groups (body/neck/cap + halo)
    // parented under the collider mesh; obstacles are flat meshes.
    // This handles both.
    mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
        else m.dispose();
      }
    });
  }

  // ── Public bridge surface (called by page.tsx) ────────────────

  /** Called by Flutter once the WebView mounts. */
  init(payload: InitPayload) {
    // userId + playerGender only update when the payload EXPLICITLY
    // provides them. There are two callers of init():
    //
    //   1. Flutter sends `{userId, playerGender, settings}` once
    //      the WebView fires its `ready` message.
    //   2. page.tsx sends `{settings}` (no userId, no playerGender)
    //      when the getRunnerSettings Cloud Function fetch
    //      resolves.
    //
    // These two race. If the Cloud-Function fetch resolves AFTER
    // Flutter's init, and we treat `payload.playerGender ?? ''` as
    // "set gender to empty", we clobber Flutter's 'female' back to
    // '' (which the rest of the pipeline maps to 'male'). That's
    // the intermittent "female sometimes shows as male" bug.
    //
    // Skip the field entirely when it's undefined on the payload
    // — then both callers can co-exist without one resetting the
    // other's value.
    if (payload.userId !== undefined) this.userId = payload.userId;
    if (payload.playerGender !== undefined) {
      const newGender = payload.playerGender.toLowerCase();
      if (newGender !== this.playerGender) {
        this.playerGender = newGender as PlayerGender;
        this.buildPlayerVisual(newGender);
      }
    }
    if (payload.settings) {
      const s = payload.settings;
      if (typeof s.startSpeed === 'number') {
        this.startSpeed = s.startSpeed;
        this.speed = s.startSpeed;
      }
      if (typeof s.maxSpeed === 'number') this.maxSpeed = s.maxSpeed;
      if (typeof s.speedRamp === 'number') this.speedRamp = s.speedRamp;
      if (typeof s.tipsyDecaySeconds === 'number') {
        this.buzz.setDecaySeconds(s.tipsyDecaySeconds);
      }

      // ── Buzz scale (max-level) ──────────────────────────────
      // Number of buzz levels (sober → danger). The HUD meter
      // generates that many cells; the effects table linearly
      // interpolates between L0 (sober) and Lmax (danger).
      if (typeof s.maxTipsyLevel === 'number' && s.maxTipsyLevel >= 2) {
        this.buzz.setMaxLevel(s.maxTipsyLevel);
        this.hud.setBuzzMaxLevel(s.maxTipsyLevel);
      }

      // ── Drunk-effect intensity multiplier ───────────────────
      // Scales the visual side of buzz only (vignette, blur,
      // sway, FOV-offset). 1.0 = stock, 0 = HUD-only buzz with
      // no drunk visuals, > 1 = stronger drunk feel. Lane-change
      // slowdown stays untouched — that's gameplay, not visuals.
      if (typeof s.buzzEffect === 'number') {
        this.buzz.setEffectMultiplier(s.buzzEffect);
      }

      // ── Scene brightness ────────────────────────────────────
      // Scales BOTH the dim baseline (ambient + directional house
      // light) AND the pulsing colored club lights. Earlier we only
      // scaled the dim pair — but those contribute ~5% of the scene
      // illumination; the club rig's point lights at intensity 12-18
      // dominate, so scaling only the ambient pair had no visible
      // effect. The club-light scale is applied inside tickClubLights
      // (it pulses every frame; static mutation here would be
      // overwritten next frame).
      //
      // Clamped to [0.1, 5]. At 5x the colored rig hits intensity
      // 60-90 — bright but not white-clipping the brand palette.
      if (typeof s.brightness === 'number' && Number.isFinite(s.brightness)) {
        const b = Math.max(0.1, Math.min(5, s.brightness));
        this.brightnessMultiplier = b;
        this.ambientLight.intensity = this.ambientBaseIntensity * b;
        this.houseLight.intensity = this.houseBaseIntensity * b;
      }
      // Per-feature ceiling LED brightness on top of the master
      // multiplier. Default 0.7 (slightly darker than the rest of
      // the room). Range 0..2 — 0 = ceiling off, 2 = blown out.
      if (
        typeof s.ceilingBrightness === 'number' &&
        Number.isFinite(s.ceilingBrightness)
      ) {
        this.ceilingBrightnessMultiplier = Math.max(
          0,
          Math.min(2, s.ceilingBrightness),
        );
      }

      // ── Sound effects ──────────────────────────────────────
      // Master switch + volume. Default sfxEnabled = true so an
      // unseeded doc still ships sound (if URLs are also set);
      // explicit false hides the HUD mute button AND silences play().
      const sfxEnabled = s.sfxEnabled !== false;
      this.audio.setEnabledByAdmin(sfxEnabled);
      this.hud.setMuteVisible(sfxEnabled);
      if (typeof s.sfxVolume === 'number' && Number.isFinite(s.sfxVolume)) {
        this.audio.setMasterVolume(s.sfxVolume);
      }
      // Per-event volume multipliers. Final play volume per clip is
      // `sfxVolume * sfx<Event>Volume`. Missing values default to 1.0
      // (no per-event attenuation). Setting any value here updates
      // live loops immediately so admin slider tweaks audition on
      // the next snapshot tick.
      const setVol = (key: string, v: unknown): void => {
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.audio.setKeyVolume(key, v);
        }
      };
      setVol('jump', s.sfxJumpVolume);
      setVol('pickup', s.sfxPickupVolume);
      setVol('water', s.sfxWaterVolume);
      setVol('combo', s.sfxComboVolume);
      setVol('gameover', s.sfxGameOverVolume);
      setVol('lanechange', s.sfxLaneChangeVolume);
      setVol('running', s.sfxRunningVolume);
      // Per-event URLs. Empty / missing strings drop any existing
      // pool for that key (silent fallback). The AudioManager
      // skips re-loading if the URL hasn't changed.
      if (typeof s.sfxJumpUrl === 'string') this.audio.load('jump', s.sfxJumpUrl);
      if (typeof s.sfxPickupUrl === 'string') this.audio.load('pickup', s.sfxPickupUrl);
      if (typeof s.sfxWaterUrl === 'string') this.audio.load('water', s.sfxWaterUrl);
      if (typeof s.sfxComboUrl === 'string') this.audio.load('combo', s.sfxComboUrl);
      if (typeof s.sfxGameOverUrl === 'string') this.audio.load('gameover', s.sfxGameOverUrl);
      if (typeof s.sfxLaneChangeUrl === 'string') this.audio.load('lanechange', s.sfxLaneChangeUrl);
      // Running loop — single dedicated element, marked loop=true.
      // Starts on first player input (startGameIfNotStarted) so we
      // don't blare the loop on a static start screen.
      if (typeof s.sfxRunningUrl === 'string') this.audio.loadLoop('running', s.sfxRunningUrl);

      // ── Combo tier overrides ───────────────────────────────
      // Preferred path: `comboTiers` array (admin-tunable length).
      // Each entry must have a positive integer threshold (≥ 1) and
      // a positive multiplier. Invalid entries are silently dropped
      // — the goal is robustness against half-edited docs, not
      // strictness.
      //
      // Threshold gate is ≥ 1 because combo starts at 0 and ticks
      // to 1 on the first scoring pickup, so 1 means "fires on the
      // first bottle". 0 would mean "always fires" which is
      // degenerate.
      if (Array.isArray(s.comboTiers) && s.comboTiers.length > 0) {
        const next: Array<{ threshold: number; multiplier: number }> = [];
        for (const raw of s.comboTiers) {
          if (
            raw &&
            typeof raw === 'object' &&
            typeof raw.threshold === 'number' &&
            raw.threshold >= 1 &&
            typeof raw.multiplier === 'number' &&
            raw.multiplier > 0
          ) {
            next.push({
              threshold: Math.floor(raw.threshold),
              multiplier: raw.multiplier,
            });
          }
        }
        if (next.length > 0) {
          // Sort ascending so getComboMultiplier()'s reverse walk
          // returns the right tier.
          next.sort((a, b) => a.threshold - b.threshold);
          this.comboTiers = next;
        }
      } else {
        // Legacy fallback — read the three fixed-tier fields if
        // the array form isn't present. Preserves behaviour for
        // unmigrated Firestore docs. Once admins re-save through
        // the new UI, this branch is skipped.
        const legacy: Array<{ threshold: number; multiplier: number }> = [];
        const pushLegacy = (t: unknown, m: unknown) => {
          if (
            typeof t === 'number' &&
            t >= 1 &&
            typeof m === 'number' &&
            m > 0
          ) {
            legacy.push({ threshold: Math.floor(t), multiplier: m });
          }
        };
        pushLegacy(s.comboTier2Threshold, s.comboTier2Multiplier);
        pushLegacy(s.comboTier3Threshold, s.comboTier3Multiplier);
        pushLegacy(s.comboTier4Threshold, s.comboTier4Multiplier);
        if (legacy.length > 0) {
          legacy.sort((a, b) => a.threshold - b.threshold);
          this.comboTiers = legacy;
        }
      }

      // ── World decoration densities ─────────────────────────
      // Admin sliders on /runnerAdmin → Tuning → World. The five
      // pools (dancers, booths, portraits, wall speakers, wall
      // strobes) all share the same 90 m wrap; the spacing
      // controls how many units fit into that wrap. Negative or
      // zero spacing on a NEW pool (speakers, strobes) disables
      // that pool entirely. The two original pools (booths,
      // portraits) and the dancer podium pool clamp to a tiny
      // floor so an admin can never accidentally produce zero
      // entries — those have always rendered and removing them
      // by setting spacing = 0 would be a footgun.
      if (typeof s.worldDancerSpacingZ === 'number' && s.worldDancerSpacingZ > 0) {
        this.worldDancerSpacingZ = s.worldDancerSpacingZ;
      }
      if (typeof s.worldBoothSpacingZ === 'number' && s.worldBoothSpacingZ > 0) {
        this.worldBoothSpacingZ = s.worldBoothSpacingZ;
      }
      if (typeof s.worldPortraitSpacingZ === 'number' && s.worldPortraitSpacingZ > 0) {
        this.worldPortraitSpacingZ = s.worldPortraitSpacingZ;
      }
      if (typeof s.worldWallSpeakerSpacingZ === 'number') {
        this.worldWallSpeakerSpacingZ = s.worldWallSpeakerSpacingZ;
      }
      if (typeof s.worldWallStrobeSpacingZ === 'number') {
        this.worldWallStrobeSpacingZ = s.worldWallStrobeSpacingZ;
      }
      if (typeof s.worldFloorTextSpacingZ === 'number') {
        this.worldFloorTextSpacingZ = s.worldFloorTextSpacingZ;
      }
      if (typeof s.worldWallShotsSpacingZ === 'number') {
        this.worldWallShotsSpacingZ = s.worldWallShotsSpacingZ;
      }

      // ── Spawn pacing ────────────────────────────────────────
      // Clamp to a sane floor (0.1s) so an admin who accidentally
      // sets the interval to 0 doesn't kick off an infinite spawn.
      if (typeof s.pickupIntervalSeconds === 'number' && s.pickupIntervalSeconds >= 0.1) {
        this.pickupIntervalSeconds = s.pickupIntervalSeconds;
      }
      if (typeof s.obstacleIntervalSeconds === 'number' && s.obstacleIntervalSeconds >= 0.1) {
        this.obstacleIntervalSeconds = s.obstacleIntervalSeconds;
      }
      // Progressive-density ramp. Ramp seconds can be 0 (disabled);
      // min intervals share the same 0.1s floor as the base intervals.
      // After parsing, clamp min ≤ base so the ramp can't run backward
      // (e.g. admin sets base=0.9, min=1.5 by mistake).
      if (typeof s.pickupRampSeconds === 'number' && s.pickupRampSeconds >= 0) {
        this.pickupRampSeconds = s.pickupRampSeconds;
      }
      if (
        typeof s.pickupIntervalMinSeconds === 'number' &&
        s.pickupIntervalMinSeconds >= 0.1
      ) {
        this.pickupIntervalMinSeconds = s.pickupIntervalMinSeconds;
      }
      if (typeof s.obstacleRampSeconds === 'number' && s.obstacleRampSeconds >= 0) {
        this.obstacleRampSeconds = s.obstacleRampSeconds;
      }
      if (
        typeof s.obstacleIntervalMinSeconds === 'number' &&
        s.obstacleIntervalMinSeconds >= 0.1
      ) {
        this.obstacleIntervalMinSeconds = s.obstacleIntervalMinSeconds;
      }
      // Defensive: an admin shouldn't be able to set min > base
      // (would make the ramp go the wrong direction — slower over
      // time). Clamp on the way in so the spawn math is monotonic.
      this.pickupIntervalMinSeconds = Math.min(
        this.pickupIntervalMinSeconds,
        this.pickupIntervalSeconds,
      );
      this.obstacleIntervalMinSeconds = Math.min(
        this.obstacleIntervalMinSeconds,
        this.obstacleIntervalSeconds,
      );

      // ── Combo + player feel ─────────────────────────────────
      if (typeof s.comboWindowSeconds === 'number' && s.comboWindowSeconds > 0) {
        this.comboWindowSeconds = s.comboWindowSeconds;
      }
      if (typeof s.jumpVelocity === 'number' && s.jumpVelocity > 0) {
        this.jumpVelocity = s.jumpVelocity;
      }
      if (typeof s.laneChangeSeconds === 'number' && s.laneChangeSeconds >= 0.05) {
        this.laneChangeBaseSeconds = s.laneChangeSeconds;
      }

      // ── Pickup weight overrides ─────────────────────────────
      // Each is optional. A weight of 0 disables that pickup
      // entirely; negative values are treated as 0 in the roller.
      const pickupWeightKeys: Array<[PickupKind, keyof typeof s]> = [
        ['water', 'waterWeight'],
        ['vodkaMini', 'vodkaMiniWeight'],
        ['vodkaBottle', 'vodkaBottleWeight'],
        ['champagne', 'champagneWeight'],
        ['magnum', 'magnumWeight'],
        ['methuselah', 'methuselahWeight'],
      ];
      for (const [kind, key] of pickupWeightKeys) {
        const v = s[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.pickupWeightOverrides[kind] = Math.max(0, v);
        }
      }

      // ── Pickup score overrides ──────────────────────────────
      // Water is excluded — it's always 0 (its value comes from
      // the buzz reduction, not points).
      const pickupScoreKeys: Array<[PickupKind, keyof typeof s]> = [
        ['vodkaMini', 'vodkaMiniScore'],
        ['vodkaBottle', 'vodkaBottleScore'],
        ['champagne', 'champagneScore'],
        ['magnum', 'magnumScore'],
        ['methuselah', 'methuselahScore'],
      ];
      for (const [kind, key] of pickupScoreKeys) {
        const v = s[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.pickupScoreOverrides[kind] = Math.max(0, v);
        }
      }

      // ── Obstacle weight overrides ───────────────────────────
      const obstacleWeightKeys: Array<[ObstacleKind, keyof typeof s]> = [
        ['speaker', 'speakerWeight'],
        ['dancer', 'dancerWeight'],
        ['bouncer', 'bouncerWeight'],
        ['discoBall', 'discoBallWeight'],
      ];
      for (const [kind, key] of obstacleWeightKeys) {
        const v = s[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.obstacleWeightOverrides[kind] = Math.max(0, v);
        }
      }

      // ── Game-over copy overrides ────────────────────────────
      // Each pair (headline + subtitle) is independently optional.
      // Empty strings are treated as "not set" so an admin can clear
      // a previously-saved override by saving '' without losing the
      // built-in fallback.
      const deathCopyKeys: Array<
        [keyof typeof DEATH_COPY, keyof typeof s, keyof typeof s]
      > = [
        ['blackout', 'gameOverBlackoutHeadline', 'gameOverBlackoutSubtitle'],
        ['speakerHit', 'gameOverSpeakerHeadline', 'gameOverSpeakerSubtitle'],
        ['dancerHit', 'gameOverDancerHeadline', 'gameOverDancerSubtitle'],
        ['bouncerHit', 'gameOverBouncerHeadline', 'gameOverBouncerSubtitle'],
        [
          'discoBallHit',
          'gameOverDiscoBallHeadline',
          'gameOverDiscoBallSubtitle',
        ],
      ];
      for (const [reason, headKey, subKey] of deathCopyKeys) {
        const headRaw = s[headKey];
        const subRaw = s[subKey];
        const head =
          typeof headRaw === 'string' && headRaw.trim().length > 0
            ? headRaw
            : undefined;
        const sub =
          typeof subRaw === 'string' && subRaw.trim().length > 0
            ? subRaw
            : undefined;
        if (head || sub) {
          this.deathCopyOverrides[reason] = {
            headline: head,
            subtitle: sub,
          };
        }
      }
    }
    postToFlutter({
      type: 'log',
      level: 'info',
      message:
        `init applied: gender=${this.playerGender} ` +
        `start=${this.startSpeed} max=${this.maxSpeed} ` +
        `ramp=${this.speedRamp}`,
    });

    // Build the admin-tunable world decorations now that every
    // `world*SpacingZ` field has been applied. Guarded inside the
    // method so multiple `init()` ticks (page.tsx + Flutter) only
    // produce one set of meshes.
    this.applyWorldDecorations();
  }

  pause() {
    this.running = false;
    // Silence any active loops without forgetting them — the
    // running loop should pick up exactly where it left off when
    // the app comes back to the foreground.
    this.audio.pauseLoops();
  }

  resume() {
    if (this.gameOver) return;
    this.clock.getDelta(); // reset delta so resume doesn't ff
    this.running = true;
    this.audio.resumeLoops();
  }

  /** Force-end the current run (used for spike testing). */
  forceGameOver() {
    if (!this.gameOver) this.endGame('manual');
  }

  /**
   * Reset all game state for a fresh run WITHOUT re-loading any
   * assets. Called from the bridge when the Flutter "Play again"
   * button is tapped — saves the ~10–15 MB of GLB re-downloads
   * (player + jump + fall + obstacle + podium dancer characters)
   * we'd otherwise pay for a full WebView reload.
   *
   * Reset surface:
   *  - Game-over / gameStarted flags
   *  - Score, distance, duration, combo, buzz peaks
   *  - Player position (lane center, ground level)
   *  - Speed back to startSpeed
   *  - All spawned pickups + obstacles disposed
   *  - Run animation rewinds + plays
   *  - HUD counters zeroed, input hint shown again
   *
   * Preserved:
   *  - Loaded character + jump character + bouncer model
   *  - Admin tunables from the most recent init()
   *  - Renderer, scene, lighting rig
   *  - Asset-ready flags (we don't need to re-load)
   */
  restart() {
    // Game flags
    this.gameOver = false;
    this.gameStarted = false;
    this.running = true;

    // Counters
    this.score = 0;
    this.bottlesCollected = 0;
    this.watersUsed = 0;
    this.combo = 0;
    this.peakCombo = 0;
    this.comboTimer = 0;
    this.distance = 0;
    this.duration = 0;
    this.previewClock = 0;
    this.speed = this.startSpeed;

    // Player position + lane
    this.playerY = PLAYER.BASE_Y;
    this.playerVy = 0;
    this.playerLane = 1;
    this.targetX = LANES.X[1];
    this.laneChangeStartX = LANES.X[1];
    this.laneChangeTime = 0;
    this.wasInAir = false;
    this.player.position.set(LANES.X[1], PLAYER.BASE_Y, 0);

    // Buzz state
    this.buzz.reset();

    // Spawn accumulators (so a fresh batch fires at the new
    // pickup/obstacle interval rather than spawning immediately).
    this.spawnAccumPickup = 0;
    this.spawnAccumObstacle = 0;

    // Tear down every spawned pickup + obstacle.
    for (const p of this.pickups) {
      this.scene.remove(p.mesh);
      this.disposeMesh(p.mesh);
    }
    this.pickups = [];
    for (const o of this.obstacles) {
      this.scene.remove(o.mesh);
      if (o.mixer) {
        o.mixer.stopAllAction();
        o.mixer.uncacheRoot(o.mixer.getRoot());
      }
      if (
        (o.spec.kind === 'dancer' || o.spec.kind === 'bouncer') &&
        o.mixer
      ) {
        // Shared GLTF — only dispose the invisible collider's
        // per-instance geometry + material (mirrors the despawn
        // path's logic).
        o.mesh.geometry.dispose();
        const cm = o.mesh.material;
        if (Array.isArray(cm)) cm.forEach((m) => m.dispose());
        else cm.dispose();
      } else {
        this.disposeMesh(o.mesh);
      }
    }
    this.obstacles = [];

    // Restart the run animation cleanly.
    if (this.playerRunAction) {
      this.playerRunAction.reset();
      this.playerRunAction.enabled = true;
      this.playerRunAction.play();
    }
    // Swap visibility back to the running character (in case
    // game over happened mid-jump or the fall animation was still
    // playing when Flutter pre-loaded the next run).
    if (this.playerVisual) this.playerVisual.visible = true;
    if (this.playerJumpVisual) {
      this.playerJumpVisual.visible = false;
      if (this.playerJumpAction) {
        this.playerJumpAction.stop();
        this.playerJumpAction.reset();
      }
    }
    // Wipe any in-flight fall animation so the next death plays
    // from frame 0 instead of resuming the last collapse.
    this.isFalling = false;
    this.pendingGameOver = undefined;
    if (this.playerFallVisual) {
      this.playerFallVisual.visible = false;
      if (this.playerFallAction) {
        this.playerFallAction.stop();
        this.playerFallAction.reset();
      }
    }

    // HUD: zero the score/distance/combo, drop buzz overlay,
    // and bring the swipe-to-start hint back so the user knows
    // the new run is waiting on their first input.
    this.hud.setScore(0);
    this.hud.setDistance(0);
    this.hud.setCombo(0, 1);
    this.hud.setBuzz(0);
    this.hud.setBlur(0);
    this.hud.setVignette(0);
    this.hud.showInputHint();
  }

  private endGame(reason: GameOverMessage['reason']) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.running = false;
    // Drop the buzz blur overlay so the fall animation reads crisp.
    this.hud.setBlur(0);
    // Silence the run loop the instant the player dies, regardless
    // of whether the fall animation plays. Forgets the intent, so
    // a subsequent restart()->first-swipe re-starts cleanly.
    this.audio.stopLoop('running');
    // Fire the game-over SFX immediately — independent of whether
    // the fall animation plays. Plays once even if endGame is called
    // re-entrantly (gameOver latch above guards against that).
    this.audio.play('gameover');
    const copy = this.resolveDeathCopy(reason);
    // Build the payload now so all per-run counters (score, distance,
    // peak combo/buzz, etc.) reflect the moment the run ended, not
    // the moment the fall animation finishes.
    const payload: GameOverMessage = {
      type: 'gameOver',
      score: Math.floor(this.score),
      distance: Math.floor(this.distance),
      duration: Math.floor(this.duration),
      bottlesCollected: this.bottlesCollected,
      watersUsed: this.watersUsed,
      peakCombo: this.peakCombo,
      peakBuzz: this.buzz.getPeak(),
      speed: this.speed,
      reason,
      headline: copy.headline,
      subtitle: copy.subtitle,
    };

    // If the fall character is loaded, play the death animation
    // first — Flutter only learns the run ended after the clip's
    // `finished` event fires (handled by `postGameOverFromFall`).
    //
    // If the fall character failed to load or never existed,
    // post immediately so the play-again sheet still surfaces.
    if (this.playerFallVisual && this.playerFallAction && this.playerFallMixer) {
      this.pendingGameOver = payload;
      this.isFalling = true;
      // Swap visibility: hide the runner + jump character, show
      // the fall character. The collider's transform is unchanged
      // — same lane, same Y — so the death plays at the player's
      // last in-game position.
      if (this.playerVisual) this.playerVisual.visible = false;
      if (this.playerJumpVisual) this.playerJumpVisual.visible = false;
      this.playerFallVisual.visible = true;
      // Reset + play. clampWhenFinished holds the last pose until
      // restart() flips visibility back.
      this.playerFallAction.reset();
      this.playerFallAction.play();
    } else {
      postToFlutter(payload);
    }
  }

  /**
   * Mixer 'finished' callback for the fall animation. Ships the
   * stashed `pendingGameOver` payload to Flutter — which surfaces
   * the play-again sheet — and clears the falling latch so the
   * rAF loop stops ticking the fall mixer.
   *
   * Idempotent: a stray 'finished' event without a stashed payload
   * is a no-op.
   */
  private postGameOverFromFall() {
    if (!this.pendingGameOver) return;
    const payload = this.pendingGameOver;
    this.pendingGameOver = undefined;
    this.isFalling = false;
    postToFlutter(payload);
  }

  /**
   * Pick the headline+subtitle pair to ship to Flutter for the given
   * death reason. Admin override (set via init.settings) wins; else
   * the built-in DEATH_COPY default; else (theoretically impossible
   * given the union type, but kept defensive) the blackout default.
   */
  private resolveDeathCopy(reason: GameOverMessage['reason']): {
    headline: string;
    subtitle: string;
  } {
    const fallback = DEATH_COPY[reason] ?? DEATH_COPY.blackout;
    const override = this.deathCopyOverrides[reason];
    return {
      headline: override?.headline ?? fallback.headline,
      subtitle: override?.subtitle ?? fallback.subtitle,
    };
  }

  /** Called by page.tsx on unmount. */
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.hud.dispose();
    this.audio.dispose();
    // Tear down the player visual + AnimationMixer + any loaded
    // GLB textures BEFORE the scene-wide traverse so the mixer's
    // bone references are released cleanly.
    this.disposePlayerVisualResources();
    // The jump + fall characters live under `this.player` (the
    // collider) and own their own SkinnedMesh geometry / materials
    // / textures. Dispose explicitly so the scene-wide traverse
    // below can't see a SkinnedMesh that's already been removed
    // (which it would skip and leak).
    this.disposeJumpCharacter();
    this.disposeFallCharacter();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
        // Sprites don't have geometry but do have material.
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
        else m.dispose();
      } else if (obj instanceof THREE.SkinnedMesh) {
        // Any stray SkinnedMesh that wasn't caught by the player
        // disposer (shouldn't be any, but defensive).
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
        else this.disposeMaterial(m);
      }
    });
    // The cached champagne-label canvas texture is shared across all
    // bottle sprites; dispose it explicitly once the scene traversal
    // can't (since we hand the same texture to multiple materials).
    this.champagneLabelTexture?.dispose();
    // Dispose the shared dancer/bouncer obstacle GLTFs. By this
    // point all their clones have been removed from the scene, so
    // there's nothing left referencing the shared resources.
    for (const gltfRef of [
      { get: () => this.dancerObstacleGltf, clear: () => {
        this.dancerObstacleGltf = undefined;
      } },
      { get: () => this.bouncerGltf, clear: () => {
        this.bouncerGltf = undefined;
      } },
    ]) {
      const gltf = gltfRef.get();
      if (!gltf) continue;
      gltf.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
          else this.disposeMaterial(m);
        }
      });
      gltfRef.clear();
    }
    this.renderer.dispose();
  }
}
