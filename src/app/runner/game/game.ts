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
  postToFlutter,
  type GameOverMessage,
  type InitPayload,
  type PlayerGender,
} from './bridge';
import { Buzz } from './buzz';
import { HUD } from './hud';
import {
  COMBO,
  comboMultiplier,
  LANES,
  OBSTACLES,
  PICKUPS,
  PLAYER,
  rollObstacle,
  rollPickup,
  SPAWN,
  WORLD,
  type ObstacleSpec,
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
}

// ── Game class ─────────────────────────────────────────────────────

export class RunnerGame {
  // Three.js core
  private scene = new THREE.Scene();
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
    const ambient = new THREE.AmbientLight(0x2a1428, 0.55);
    this.scene.add(ambient);
    // Soft warm "house lights" overall directional — enough to read
    // the player and floor without washing out the colored rig.
    const house = new THREE.DirectionalLight(0xfff3e0, 0.35);
    house.position.set(0, 12, 2);
    this.scene.add(house);

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
  }

  /**
   * Build (or rebuild) the visible character meshes parented under
   * `this.player`. Owns `this.playerVisual` and `this.playerLimbs`.
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
  private buildPlayerVisual(gender: string) {
    // ── Dispose any existing visual ───────────────────────────
    if (this.playerVisual) {
      this.playerVisual.removeFromParent();
      this.playerVisual.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
          else m.dispose();
        }
      });
    }

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
    this.laneChangeDuration = PLAYER.LANE_CHANGE_BASE_S * slow;
  }
  private jump() {
    if (this.gameOver || !this.running) return;
    this.startGameIfNotStarted();
    if (this.playerY > PLAYER.BASE_Y + 0.05) return; // already airborne
    this.playerVy = PLAYER.JUMP_VY;
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
      this.runPlayerIdleAnimation(this.previewClock);
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
    if (grounded) {
      const bobPhase = this.duration * (this.speed / this.startSpeed) * 8;
      this.player.position.y =
        PLAYER.BASE_Y + Math.sin(bobPhase) * 0.07;
      // Run-cycle limb swing. Arms and legs swing opposite to each
      // other in pairs (left-arm + right-leg forward together, then
      // swap). Phase is tied to player speed so the cadence speeds
      // up as the world accelerates.
      const stridePhase =
        this.duration * (this.speed / this.startSpeed) * 5.5;
      const armSwing = Math.sin(stridePhase) * 0.55;
      const legSwing = Math.sin(stridePhase) * 0.45;
      // Arms swing on the X axis (forward/back).
      this.playerLimbs.armL.rotation.x = armSwing;
      this.playerLimbs.armR.rotation.x = -armSwing;
      // Legs swing opposite to arms.
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
      // Gentle pickup rotation for visual interest.
      p.mesh.rotation.y += dt * 1.6;

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
      if (o.mesh.position.z > WORLD.DESPAWN_Z) {
        this.scene.remove(o.mesh);
        this.disposeMesh(o.mesh);
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
      if (this.comboTimer >= COMBO.WINDOW_S) {
        this.breakCombo();
      }
    }

    // ── Spawn pickups + obstacles ─────────────────────────────
    this.spawnAccumPickup += dt;
    this.spawnAccumObstacle += dt;
    const pickupInterval =
      SPAWN.PICKUP_INTERVAL_BASE_S * (this.startSpeed / this.speed);
    const obstacleInterval =
      SPAWN.OBSTACLE_INTERVAL_BASE_S * (this.startSpeed / this.speed);
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
    for (const c of this.clubLights) {
      const phase = t * c.pulseHz * Math.PI * 2 + c.phase;
      const pulse = 0.75 + 0.40 * Math.sin(phase);
      c.light.intensity = c.baseIntensity * pulse;
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
  private runPlayerIdleAnimation(t: number) {
    const stridePhase = t * 5.5;
    const armSwing = Math.sin(stridePhase) * 0.45;
    const legSwing = Math.sin(stridePhase) * 0.40;
    this.playerLimbs.armL.rotation.x = armSwing;
    this.playerLimbs.armR.rotation.x = -armSwing;
    this.playerLimbs.legL.rotation.x = -legSwing;
    this.playerLimbs.legR.rotation.x = legSwing;
    // Subtle bob — same range as the in-game run.
    const bobPhase = t * 8;
    this.player.position.y =
      PLAYER.BASE_Y + Math.sin(bobPhase) * 0.07;
  }

  // ── Spawning ────────────────────────────────────────────────────

  private spawnPickup() {
    const spec = rollPickup();
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
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0x0c1a14,
        roughness: 0.20,
        metalness: 0.45,
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

      // Glowing GREEN label band — slightly wider than the body so
      // it visually layers on top. MeshBasicMaterial so it ignores
      // scene lighting and stays bright in the dark fog (mirrors
      // how Dom Pérignon Luminous bottles emit light from the
      // label region rather than reflecting it).
      const labelH = bodyH * 0.42;
      const labelR = spec.radius * 1.015;
      const labelMat = new THREE.MeshBasicMaterial({
        color: 0x4cff9c,
        transparent: true,
        opacity: 0.85,
      });
      const label = new THREE.Mesh(
        new THREE.CylinderGeometry(labelR * 0.98, labelR, labelH, 18, 1, true),
        labelMat,
      );
      // Centred on the body, slightly below middle to match the
      // real Dom Pérignon label position (lower 60% of the body).
      label.position.y = bodyH * 0.38;
      // Render after body so transparency composites cleanly.
      label.renderOrder = 1;
      group.add(label);

      // Faint inner glow caps — close the cylinder ends so the
      // label doesn't look hollow when viewed at oblique angles.
      // These are tiny ring discs at top + bottom of the band.
      const labelCapGeo = new THREE.RingGeometry(
        labelR * 0.92,
        labelR,
        18,
      );
      const labelCapTop = new THREE.Mesh(labelCapGeo, labelMat);
      labelCapTop.rotation.x = -Math.PI / 2;
      labelCapTop.position.y = bodyH * 0.38 + labelH / 2;
      group.add(labelCapTop);
      const labelCapBottom = new THREE.Mesh(labelCapGeo, labelMat);
      labelCapBottom.rotation.x = Math.PI / 2;
      labelCapBottom.position.y = bodyH * 0.38 - labelH / 2;
      group.add(labelCapBottom);

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
      // Generic bottle (water, vodka): gradual taper body + neck + cap.
      const neckMat = new THREE.MeshStandardMaterial({
        color: 0x141014,
        roughness: 0.4,
        metalness: 0.2,
      });
      const capMat = new THREE.MeshStandardMaterial({
        // Blue cap for water (sports-bottle convention), silver for
        // vodka — distinct enough to read from a distance.
        color: spec.kind === 'water' ? 0x2b6fb3 : 0xc4c4c8,
        roughness: 0.4,
        metalness: 0.6,
      });

      const bodyHeight = spec.height * 0.72;
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(spec.radius * 0.78, spec.radius, bodyHeight, 16),
        bodyMat,
      );
      body.position.y = bodyHeight / 2;
      group.add(body);

      const neckHeight = spec.height * 0.22;
      const neckRadius = spec.radius * 0.30;
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(neckRadius * 0.85, neckRadius, neckHeight, 12),
        neckMat,
      );
      neck.position.y = bodyHeight + neckHeight / 2;
      group.add(neck);

      const capHeight = spec.height * 0.06;
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(neckRadius * 1.05, neckRadius * 0.95, capHeight, 12),
        capMat,
      );
      cap.position.y = bodyHeight + neckHeight + capHeight / 2;
      group.add(cap);
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
    const spec = rollObstacle();
    const mesh = this.buildObstacleMesh(spec);
    const lane = Math.floor(Math.random() * LANES.X.length);
    mesh.position.set(LANES.X[lane], spec.baseY, WORLD.SPAWN_Z);
    this.scene.add(mesh);
    this.obstacles.push({ mesh, spec });
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
  private buildObstacleMesh(spec: ObstacleSpec): THREE.Mesh {
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
      return mesh;
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

      return mesh;
    }

    // Default — bouncer + any future floor obstacles. Plain box.
    const geo = new THREE.BoxGeometry(spec.width, spec.height, spec.depth);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.5,
      metalness: 0.05,
    });
    return new THREE.Mesh(geo, mat);
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
      const mult = comboMultiplier(this.combo);
      const earned = Math.round(spec.score * mult);
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
    });
  }

  /** Called by page.tsx on unmount. */
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.hud.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
        else m.dispose();
      }
    });
    this.renderer.dispose();
  }
}
