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
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  postToFlutter,
  type GameOverMessage,
  type InitPayload,
  type PlayerGender,
} from './bridge';
import { Buzz } from './buzz';
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
   * Standalone Jump AnimationClip, lazy-loaded from
   * `/models/runner_jump.glb` in parallel with the player.
   *
   * The GLB is stripped (mesh + materials + textures removed via
   * `strip_to_animation.mjs`), leaving only the bone hierarchy +
   * the 1.03-second jump clip — 148 KB on disk vs the original
   * 58 MB. The dummy hierarchy in the GLB is discarded at load
   * time; we keep only the clip, retarget its track-name prefix
   * to match the loaded player's skeleton (`mixamorig7:` for
   * male, `mixamorig:` for female), then bind it to the same
   * mixer as the run action.
   */
  private playerJumpClip?: THREE.AnimationClip;
  /**
   * One AnimationAction per SkinnedMesh in the player. A Mixamo
   * "with skin" FBX export is usually a single mesh, but body +
   * clothes as separate skinned meshes is possible. Each action
   * is bound with its SkinnedMesh as root so PropertyBinding
   * uses `skeleton.getBoneByName()` (unambiguous) instead of the
   * scene-graph name search (ambiguous — the player FBX has 5
   * Object3Ds all named `mixamorig7Hips`).
   */
  private playerJumpActions: THREE.AnimationAction[] = [];
  /**
   * Edge detector — true on the frame after takeoff, until the
   * frame the player lands. Used to fire the run↔jump crossfade
   * exactly once per landing instead of every frame the player
   * is airborne.
   */
  private wasInAir = false;
  /** True while we're showing the capsule fallback. Flips false
   *  once a GLB load completes successfully. */
  private isPlaceholderPlayer = true;
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
   * Cached canvas-texture used as the glowing shield badge on every
   * champagne / magnum / methuselah pickup. Lazily built on the
   * first champagne spawn; reused for the lifetime of the game,
   * disposed in dispose().
   */
  private champagneLabelTexture?: THREE.CanvasTexture;

  /**
   * Cached GLTF for the bouncer obstacle (dancing character). Loaded
   * once on construction, then SkeletonUtils.clone'd per spawn so
   * each bouncer instance has its own skeleton + independent
   * AnimationMixer. Undefined while the load is in flight or if
   * the file is missing — spawnObstacle falls back to the procedural
   * capsule-stack humanoid in that case.
   */
  private bouncerGltf?: GLTF;

  // HUD overlay (DOM) — created on construction, owns vignette + counters.
  private hud: HUD;

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
  // Combo window — seconds since the last pickup to keep the chain.
  private comboWindowSeconds: number = COMBO.WINDOW_S;
  // Combo multiplier tiers — three thresholds + multipliers above
  // the baseline (which is always 0/1.0). Defaults mirror the
  // historical hardcoded MULTIPLIERS table in tuning.ts: 5/×1.5,
  // 10/×2.0, 20/×3.0. Each is admin-overridable via init().
  private comboTier2Threshold = 5;
  private comboTier2Multiplier = 1.5;
  private comboTier3Threshold = 10;
  private comboTier3Multiplier = 2.0;
  private comboTier4Threshold = 20;
  private comboTier4Multiplier = 3.0;
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

    this.buildScene();
    this.hud = new HUD(canvas);
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
    // Kick off the async bouncer model load. It'll typically arrive
    // before the first bouncer spawns (~1.6s into the run); any
    // bouncers that spawn before it lands use the procedural
    // humanoid fallback automatically.
    this.loadBouncerModel();
    // Same pattern for the jump animation clip — typically arrives
    // before the player's first jump. If the player's still on the
    // capsule placeholder when this resolves, the clip is cached
    // and `setupJumpAction` runs from `tryLoadGltfPlayer` later.
    // If the player's already loaded by then, this immediately
    // attaches the action to the existing mixer.
    this.loadJumpClip();
  }

  /**
   * Load the standalone Jump animation clip. The GLB at
   * `/models/runner_jump.glb` has been stripped of its mesh,
   * materials, and textures (see `strip_to_animation.mjs`) — only
   * the bone hierarchy + the 1.033-second jump clip remain.
   *
   * We extract `animations[0]`, throw away the rest of the loaded
   * scene (mesh stripped already; the dummy bone tree in the GLB
   * isn't needed because the AnimationMixer binds tracks against
   * the PLAYER's existing skeleton — same Mixamo bone naming, so
   * with one prefix swap the same clip drives any character).
   *
   * Failure is silently swallowed — `setupJumpAction` becomes a
   * no-op and the player keeps the legacy behaviour (running-pose
   * frozen mid-air during a jump).
   */
  private async loadJumpClip() {
    try {
      const gltf = await new GLTFLoader().loadAsync('/models/runner_jump.glb');
      const raw = gltf.animations[0];
      if (!raw) {
        // eslint-disable-next-line no-console
        console.debug('[runner] jump glb has no animations');
        return;
      }
      // Strip ALL root-bone translation (X+Y+Z) so the clip is pure
      // pose change. Mixamo's Jump clip translates the Hips up + down
      // ~1m during the leap; our collider already moves up via
      // `playerY`. Without stripping, the two stack and the player
      // flies ~twice as high as intended.
      this.playerJumpClip = this.stripAllRootMotion(raw);
      // If the player loaded first, attach the jump action retro-
      // actively. (No-op if not — `tryLoadGltfPlayer` calls
      // `setupJumpAction` itself once the mixer exists.)
      if (this.playerMixer && this.playerVisual) {
        this.setupJumpAction();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug('[runner] jump clip load failed', e);
    }
  }

  /**
   * One-shot load of the bouncer character GLB. Failure is silently
   * swallowed — spawnObstacle's bouncer branch falls back to the
   * procedural humanoid (capsule torso + sphere head + crossed
   * arms) so the game keeps working without the model.
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
    // Fire-and-forget. If the GLB exists, it'll swap in shortly;
    // if not, the placeholder stays and the player is none the wiser.
    this.tryLoadGltfPlayer(gender);
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
      // Actions are mixer-owned — clearing the array is enough,
      // the mixer's stopAllAction + uncacheRoot above already
      // detach them. The CLIP (`playerJumpClip`) is intentionally
      // NOT cleared here because it survives gender swaps: it's
      // the raw clip data, fresh-bound per-character by
      // setupJumpAction.
      this.playerJumpActions = [];
    }
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
    // FBX first — that's what Mixamo gives you directly, no
    // conversion step required. GLB as a fallback for anyone who
    // converts later (smaller files; FBX is ~10-20MB, GLB ~3-5MB).
    const candidates: Array<{ url: string; format: 'fbx' | 'glb' }> = [
      { url: `/models/runner_${suffix}.fbx`, format: 'fbx' },
      { url: `/models/runner_${suffix}.glb`, format: 'glb' },
    ];

    let scene: THREE.Group | undefined;
    let animations: THREE.AnimationClip[] = [];
    for (const c of candidates) {
      try {
        if (c.format === 'glb') {
          const gltf: GLTF = await new GLTFLoader().loadAsync(c.url);
          scene = gltf.scene;
          animations = gltf.animations;
        } else {
          // FBXLoader returns the scene as a Group directly; animations
          // are on the returned object's `.animations` property.
          const fbx = await new FBXLoader().loadAsync(c.url);
          scene = fbx;
          animations = (fbx.animations as THREE.AnimationClip[]) ?? [];
        }
        break; // first one that loads wins
      } catch (e) {
        // 404 or parse error — try the next candidate. Expected for
        // the format the operator didn't drop in.
        // eslint-disable-next-line no-console
        console.debug(`[runner] no model at ${c.url}`, e);
      }
    }

    if (!scene) return; // both candidates failed; keep placeholder

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
      // If the jump clip already arrived (its load fires in
      // parallel with this one from the constructor), wire it as
      // a second action on the same mixer now. If it hasn't,
      // `loadJumpClip` will call back into setupJumpAction itself.
      this.setupJumpAction();
    }
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

  /**
   * Sibling of `stripRootForwardMotion` that zeros Y too. Used on
   * the jump clip because the collider already arcs vertically via
   * `playerY` — leaving the clip's hip-Y intact would compound the
   * two and the character would visibly fly twice as high.
   */
  private stripAllRootMotion(
    clip: THREE.AnimationClip,
  ): THREE.AnimationClip {
    const isRootPositionTrack = (name: string): boolean => {
      if (!name.endsWith('.position')) return false;
      const bone = name.split('.')[0].toLowerCase();
      return bone.includes('hip') || bone === 'root' || bone.endsWith('|root');
    };
    const newTracks = clip.tracks.map((t) => {
      if (!isRootPositionTrack(t.name)) return t;
      const values = new Float32Array(t.values);
      for (let i = 0; i < values.length; i += 3) {
        values[i] = 0;
        values[i + 1] = 0;
        values[i + 2] = 0;
      }
      return new THREE.VectorKeyframeTrack(
        t.name,
        Array.from(t.times),
        Array.from(values),
      );
    });
    return new THREE.AnimationClip(
      clip.name + '_static',
      clip.duration,
      newTracks,
    );
  }

  /**
   * Attach the cached jump clip as a second action on the player's
   * existing AnimationMixer. Safe to call multiple times — bails
   * cleanly if the action already exists.
   *
   * Called from BOTH `loadJumpClip` (if the player was already
   * loaded when the clip arrives) and `tryLoadGltfPlayer` (after
   * the mixer is created, if the clip was already cached). One of
   * those two paths fires; the other is a no-op.
   *
   * Both actions stay in the "playing" state so `crossFadeTo` can
   * lerp between them without re-priming. The jump action sits at
   * effectiveWeight=0 until `jump()` triggers the takeoff fade.
   */
  private setupJumpAction() {
    if (this.playerJumpActions.length > 0) return; // already wired
    if (!this.playerJumpClip || !this.playerMixer || !this.playerVisual) return;

    // Why this binds per-SkinnedMesh instead of per-mixer-root:
    //
    // The player FBX has FIVE Object3Ds named `mixamorig7Hips`
    // (and likewise duplicates for every other bone — confirmed
    // by a runtime diagnostic). AnimationMixer's default
    // `clipAction(clip)` does name lookup via
    // `findNode(mixerRoot, name)`, which returns the first
    // depth-first match. That tends to be a sibling locator /
    // scene-graph node rather than the SkinnedMesh's actual
    // deforming Bone — so the track DOES bind, but to an object
    // with zero effect on GPU skinning. Visible result: every
    // tracked bone falls back to bind pose (T-pose) the moment
    // run's weight drops to 0 and jump's weight comes up.
    //
    // Run animation works because FBXLoader wired its mixer
    // bindings AT PARSE TIME, holding direct Bone references —
    // it bypasses the name collision. Our externally-authored
    // jump clip needs an explicit unambiguous resolution path.
    //
    // The fix: pass each SkinnedMesh as the second arg to
    // `clipAction`. When the binding root has `.skeleton`,
    // PropertyBinding.findNode goes through
    // `skeleton.getBoneByName(...)` FIRST — which is the
    // unambiguous, GPU-bound bone. For Mixamo characters with
    // multiple skinned meshes (body + clothes), each gets its
    // own action so every mesh's skeleton receives the pose.
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    this.playerVisual.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) skinnedMeshes.push(obj);
    });
    if (skinnedMeshes.length === 0) {
      // eslint-disable-next-line no-console
      console.debug(
        '[runner/jump] no SkinnedMesh on player — cannot bind jump clip',
      );
      return;
    }

    for (const mesh of skinnedMeshes) {
      const action = this.playerMixer.clipAction(this.playerJumpClip, mesh);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true; // hold last frame after the leap
      // Pre-roll: action starts in the "playing" pool with weight 0
      // so fadeIn can lerp it up without a re-prime.
      action.play();
      action.setEffectiveWeight(0);
      this.playerJumpActions.push(action);
    }
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
    if (this.gameOver || !this.running) return;
    this.startGameIfNotStarted();
    if (this.playerLane > 0) this.setLane(this.playerLane - 1);
  }
  private swipeRight() {
    if (this.gameOver || !this.running) return;
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
  }
  private jump() {
    if (this.gameOver || !this.running) return;
    this.startGameIfNotStarted();
    if (this.playerY > PLAYER.BASE_Y + 0.05) return; // already airborne
    this.playerVy = this.jumpVelocity;
    this.triggerJumpAnimation();
  }

  /**
   * Crossfade the player's mixer from the run action into the jump
   * action. No-op if either action is missing (GLB still loading or
   * load failed) — `playerLimbs` fallback for the capsule covers
   * that case, and a Mixamo player without the jump clip just
   * keeps running in mid-air (the legacy behaviour).
   *
   * `timeScale` is tuned per-jump so the 1.033s jump clip fits the
   * predicted airtime exactly. Airtime depends on `jumpVelocity`
   * and `PLAYER.GRAVITY`; both are constants per-jump (jumpVelocity
   * is admin-tunable but doesn't change mid-run). With defaults
   * (vy=8, g=-25) airtime ≈ 0.64s → timeScale ≈ 1.6 → the leap
   * frames sync with the actual arc.
   */
  private triggerJumpAnimation() {
    const jumpActions = this.playerJumpActions;
    const runAction = this.playerRunAction;
    if (jumpActions.length === 0 || !runAction || !this.playerJumpClip) return;

    const airtime = (2 * this.jumpVelocity) / Math.abs(PLAYER.GRAVITY);
    // Floor airtime defensively — if an admin set jumpVelocity to
    // 0.0001 we don't want timeScale → infinity.
    const safeAirtime = Math.max(0.2, airtime);
    const timeScale = this.playerJumpClip.duration / safeAirtime;

    // Fade run out + every jump action in. Using fadeOut/fadeIn
    // instead of crossFadeTo because we have multiple destination
    // actions (one per SkinnedMesh) — crossFadeTo only pairs
    // exactly two actions at a time, but fadeOut + fadeIn run
    // independently, so concurrent multi-target fades work.
    runAction.fadeOut(0.10);
    for (const action of jumpActions) {
      action.timeScale = timeScale;
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.fadeIn(0.10);
    }
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
  }

  // ── Game loop ───────────────────────────────────────────────────

  private start() {
    this.clock.start();
    const loop = () => {
      const dt = Math.min(0.05, this.clock.getDelta());
      if (this.running) this.update(dt);
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
    // down. Crossfade jump → run so the mid-jump pose blends
    // smoothly back into the run cycle. Both actions stay in the
    // playing pool from `setupJumpAction`, so this is a pure
    // weight lerp — no re-prime needed.
    if (grounded && this.wasInAir) {
      this.wasInAir = false;
      const jumpActions = this.playerJumpActions;
      const runAction = this.playerRunAction;
      if (jumpActions.length > 0 && runAction) {
        // Run cycle has been looping behind weight 0 throughout
        // the jump — fade it back in while fading every jump
        // action out. fadeIn/fadeOut handle multi-target fades
        // independently (see triggerJumpAnimation).
        for (const action of jumpActions) action.fadeOut(0.10);
        runAction.fadeIn(0.10);
      }
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
    // Advance the Mixamo bone animation if we're on a rigged
    // GLB. Run animation is permanently looping; the jump arc
    // moves the whole collider so the running pose flying up
    // through the air reads OK for a placeholder integration.
    // (Replacing with a dedicated jump clip is a polish task.)
    this.playerMixer?.update(dt);

    // ── Scroll floor stripes ──────────────────────────────────
    for (const s of this.floorStripes) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }

    // ── Animate club lights ───────────────────────────────────
    this.tickClubLights(this.duration);

    // ── Scroll pickups, check collection / pass ────────────────
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.mesh.position.z += scroll;
      // (No pickup rotation — the bottle silhouettes scroll past
      // facing the camera so labels stay readable. Champagne badges
      // specifically would orbit around the bottle centre under
      // rotation, swinging between visible and hidden.)

      if (!p.resolved && this.intersectsPlayer(p.mesh, 0.6)) {
        this.collectPickup(p);
        p.resolved = true;
      }
      if (p.mesh.position.z > WORLD.DESPAWN_Z) {
        // If we passed it without collecting, the combo breaks.
        if (!p.resolved && p.spec.kind !== 'water') {
          this.breakCombo();
        }
        this.scene.remove(p.mesh);
        this.disposeMesh(p.mesh);
        this.pickups.splice(i, 1);
      }
    }

    // ── Scroll obstacles, check collisions ────────────────────
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
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
      // Bouncers carry a per-instance AnimationMixer driving their
      // dance loop. Tick each independently.
      o.mixer?.update(dt);
      if (o.mesh.position.z > WORLD.DESPAWN_Z) {
        this.scene.remove(o.mesh);
        // Stop the mixer + uncache the root before disposing so
        // Three doesn't retain references in its action cache.
        if (o.mixer) {
          o.mixer.stopAllAction();
          o.mixer.uncacheRoot(o.mixer.getRoot());
        }
        // For GLB-cloned bouncers, geometry + materials are SHARED
        // across all clones via SkeletonUtils.clone. Disposing them
        // on one despawn would break every other live bouncer.
        // We only dispose the per-instance bits (the invisible
        // collider's BoxGeometry + its MeshBasicMaterial) and let
        // the shared GLTF resources stay alive until game dispose.
        if (o.spec.kind === 'bouncer' && o.mixer) {
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
      if (this.intersectsPlayer(o.mesh, 1.0, o.spec.airOnly)) {
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

    // ── Spawn pickups + obstacles ─────────────────────────────
    this.spawnAccumPickup += dt;
    this.spawnAccumObstacle += dt;
    const pickupInterval =
      this.pickupIntervalSeconds * (this.startSpeed / this.speed);
    const obstacleInterval =
      this.obstacleIntervalSeconds * (this.startSpeed / this.speed);
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
   * three admin-tunable tier thresholds + multipliers. Picks the
   * highest tier whose threshold the combo satisfies; falls back
   * to 1.0 below tier 2. Replaces the static `comboMultiplier`
   * function in tuning.ts (which is no longer wired into the
   * runtime — kept around as the default baseline).
   */
  private getComboMultiplier(combo: number): number {
    if (combo >= this.comboTier4Threshold) return this.comboTier4Multiplier;
    if (combo >= this.comboTier3Threshold) return this.comboTier3Multiplier;
    if (combo >= this.comboTier2Threshold) return this.comboTier2Multiplier;
    return 1.0;
  }

  private spawnPickup() {
    const spec = this.rollAdjustedPickup();
    // Build the pickup as a Group, parented under an invisible
    // cylinder collider so collision / scrolling / pickup-flash
    // logic still treats it as a single object.
    const group = new THREE.Group();
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

      const bodyH = spec.height * 0.52;
      const shoulderH = spec.height * 0.14;
      const neckH = spec.height * 0.28;
      const foilH = neckH * 0.55;
      const corkH = spec.height * 0.06;
      const neckR = spec.radius * 0.32;

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(spec.radius * 0.96, spec.radius, bodyH, 18),
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
      const labelWidth = spec.radius * 1.4;
      const labelHeight = labelWidth * 1.25;
      label.scale.set(labelWidth, labelHeight, 1);
      // Sit slightly in FRONT of the bottle (+Z, the camera-facing
      // side) so it composites cleanly over the body without
      // depth-fighting through the cylinder wall. The bottle no
      // longer rotates per-frame so this position stays on the
      // front face for the whole approach.
      label.position.set(0, bodyH * 0.5, spec.radius + 0.02);
      group.add(label);

      // Shoulder — sharp taper from body radius down to neck radius.
      const shoulder = new THREE.Mesh(
        new THREE.CylinderGeometry(neckR, spec.radius * 0.96, shoulderH, 18),
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
        const rTop = spec.radius * 1.05;
        const rBottom = spec.radius * 0.78;
        const glassH = spec.height;
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
        const bodyH = spec.height * 0.62;
        const shoulderH = spec.height * 0.05;
        const neckH = spec.height * 0.22;
        const capH = spec.height * 0.11;
        const neckR = spec.radius * 0.36;

        // Body — no taper.
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(spec.radius, spec.radius, bodyH, 16),
          bodyMat,
        );
        body.position.y = bodyH / 2;
        group.add(body);
        // Sharp shoulder — short, almost-angular taper.
        const shoulder = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, spec.radius, shoulderH, 16),
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
        const bottomH = spec.height * 0.30;
        const topH = spec.height * 0.32;
        const shoulderH = spec.height * 0.10;
        const neckH = spec.height * 0.10;
        const capBaseH = spec.height * 0.10;
        const capDomeH = spec.height * 0.08;
        const neckR = spec.radius * 0.42;

        // Lower body — slight inward taper at the base.
        const bottom = new THREE.Mesh(
          new THREE.CylinderGeometry(spec.radius, spec.radius * 0.85, bottomH, 16),
          bodyMat,
        );
        bottom.position.y = bottomH / 2;
        group.add(bottom);
        // Upper body — slight outward taper for the curvy silhouette.
        const top = new THREE.Mesh(
          new THREE.CylinderGeometry(spec.radius * 0.95, spec.radius, topH, 16),
          bodyMat,
        );
        top.position.y = bottomH + topH / 2;
        group.add(top);
        // Smooth shoulder — generous taper down to a wider neck.
        const shoulder = new THREE.Mesh(
          new THREE.CylinderGeometry(neckR, spec.radius * 0.95, shoulderH, 16),
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
        spec.radius * 1.55,
        spec.radius * 0.07,
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
      ring.position.y = spec.height * 0.4;
      group.add(ring);
    }

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

    if (spec.kind === 'bouncer') {
      // GLB-backed bouncer — preferred path when the cached
      // bouncer GLTF is loaded. Each spawn gets its own
      // SkeletonUtils.clone so its dance animation runs on an
      // independent skeleton + AnimationMixer (otherwise all
      // bouncers would dance in perfect sync, which looks
      // unnervingly mechanical).
      const gltf = this.bouncerGltf;
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
        // the dance reads from the front.
        visual.rotation.y = Math.PI;

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
        visual.scale.setScalar(scaleFactor);
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
    } else {
      // Combo bump + score with multiplier.
      this.combo++;
      this.peakCombo = Math.max(this.peakCombo, this.combo);
      this.comboTimer = 0;
      const mult = this.getComboMultiplier(this.combo);
      // Use admin-tunable score (override map ?? spec default).
      const earned = Math.round(this.getPickupScore(spec) * mult);
      this.score += earned;
      this.bottlesCollected++;
      this.hud.flashPickup(spec, earned);
      this.hud.setCombo(this.combo, mult);
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
    const dz = Math.abs(mesh.position.z - this.player.position.z);
    if (dx > halfX + pHalfX) return false;
    if (dz > halfZ + pHalfZ) return false;
    const airborne = this.player.position.y > 2.0;
    if (airOnly) {
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
    this.userId = payload.userId;
    const newGender = (payload.playerGender ?? '').toLowerCase();
    // Rebuild the player visual when gender changes from the
    // current value (or when arriving for the first time after the
    // default empty-string build in buildScene).
    if (newGender !== this.playerGender) {
      this.playerGender = newGender as PlayerGender;
      this.buildPlayerVisual(newGender);
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

      // ── Combo tier overrides ───────────────────────────────
      // Three tiers above the baseline (which is always 0/×1.0).
      // Each is independently optional in Firestore; missing
      // values fall back to the instance defaults (5/×1.5,
      // 10/×2.0, 20/×3.0). Threshold gate is `>= 1` — combo starts
      // at 0 and increments to 1 on the first scoring pickup, so
      // 1 means "fires on the first bottle". 0 would mean "always
      // fires" which is degenerate; we reject that.
      if (
        typeof s.comboTier2Threshold === 'number' &&
        s.comboTier2Threshold >= 1
      ) {
        this.comboTier2Threshold = Math.floor(s.comboTier2Threshold);
      }
      if (typeof s.comboTier2Multiplier === 'number' && s.comboTier2Multiplier > 0) {
        this.comboTier2Multiplier = s.comboTier2Multiplier;
      }
      if (
        typeof s.comboTier3Threshold === 'number' &&
        s.comboTier3Threshold >= 1
      ) {
        this.comboTier3Threshold = Math.floor(s.comboTier3Threshold);
      }
      if (typeof s.comboTier3Multiplier === 'number' && s.comboTier3Multiplier > 0) {
        this.comboTier3Multiplier = s.comboTier3Multiplier;
      }
      if (
        typeof s.comboTier4Threshold === 'number' &&
        s.comboTier4Threshold >= 1
      ) {
        this.comboTier4Threshold = Math.floor(s.comboTier4Threshold);
      }
      if (typeof s.comboTier4Multiplier === 'number' && s.comboTier4Multiplier > 0) {
        this.comboTier4Multiplier = s.comboTier4Multiplier;
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
  }

  pause() {
    this.running = false;
  }

  resume() {
    if (this.gameOver) return;
    this.clock.getDelta(); // reset delta so resume doesn't ff
    this.running = true;
  }

  /** Force-end the current run (used for spike testing). */
  forceGameOver() {
    if (!this.gameOver) this.endGame('manual');
  }

  private endGame(reason: GameOverMessage['reason']) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.running = false;
    // Drop the buzz blur overlay so the game-over panel renders crisp.
    this.hud.setBlur(0);
    const copy = this.resolveDeathCopy(reason);
    postToFlutter({
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
    });
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
    // Tear down the player visual + AnimationMixer + any loaded
    // GLB textures BEFORE the scene-wide traverse so the mixer's
    // bone references are released cleanly.
    this.disposePlayerVisualResources();
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
    // Dispose the shared bouncer GLTF geometry/materials. By this
    // point all bouncer clones have been removed from the scene, so
    // there's nothing left referencing the shared resources.
    if (this.bouncerGltf) {
      this.bouncerGltf.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => this.disposeMaterial(mat));
          else this.disposeMaterial(m);
        }
      });
      this.bouncerGltf = undefined;
    }
    this.renderer.dispose();
  }
}
