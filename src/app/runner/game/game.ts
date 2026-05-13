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
  private rafId: number | null = null;

  // Init values pushed from Flutter (may be undefined if loaded
  // in a regular browser tab).
  private playerGender: PlayerGender = '';
  private reduceMotion = false;
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
    const LANE_VISIBLE_HALF_X = 3.0; // ±2.4 lane + ±0.5 player + 0.1 margin
    const PLAYER_VIEW_DIST = 8.6;
    const aspect = Math.max(0.3, this.aspect());
    const hHalf = Math.atan(LANE_VISIBLE_HALF_X / PLAYER_VIEW_DIST);
    const vHalf = Math.atan(Math.tan(hHalf) / aspect);
    const vFov = (vHalf * 2 * 180) / Math.PI;
    return Math.min(72, Math.max(55, vFov));
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width || window.innerWidth;
    const h = r.height || window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  // ── Scene build ─────────────────────────────────────────────────

  private buildScene() {
    // Lighting — one directional + ambient + a magenta rim for
    // mild nightclub mood. Cheap, no shadows.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(2, 10, 4);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0xc34a8e, 0.35);
    rim.position.set(-4, 6, -8);
    this.scene.add(rim);

    // Ground — dark tinted plane far into -Z.
    const groundGeo = new THREE.PlaneGeometry(20, 200);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x140a0f,
      roughness: 0.9,
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

    // Player — placeholder rounded box. Real character (Mixamo
    // GLB with run animation) comes in a later commit.
    const playerGeo = new THREE.BoxGeometry(
      PLAYER.WIDTH,
      PLAYER.HEIGHT,
      PLAYER.DEPTH,
    );
    const playerMat = new THREE.MeshStandardMaterial({
      color: 0xb87333,
      roughness: 0.5,
      metalness: 0.05,
    });
    this.player = new THREE.Mesh(playerGeo, playerMat);
    this.player.position.set(LANES.X[1], PLAYER.BASE_Y, 0);
    this.scene.add(this.player);
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
    if (this.playerLane > 0) this.setLane(this.playerLane - 1);
  }
  private swipeRight() {
    if (this.gameOver || !this.running) return;
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
    if (this.playerY > PLAYER.BASE_Y + 0.05) return; // already airborne
    this.playerVy = PLAYER.JUMP_VY;
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
    // Camera sway: oscillate Z-roll at ~0.8 Hz scaled by amplitude.
    const swayPhase = this.duration * 0.8 * Math.PI * 2;
    const swayDeg = this.reduceMotion ? 0 : buzzFx.sway;
    this.camera.rotation.z = (Math.sin(swayPhase) * swayDeg * Math.PI) / 180;
    // FOV tunnel — slight FOV increase at high buzz reads as
    // "the world closing in." Update projection matrix on change.
    const targetFov = this.baseFov + buzzFx.fovOffset;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
    // Canvas CSS blur — cheap and effective.
    const blurPx = this.reduceMotion ? 0 : buzzFx.blur;
    this.canvas.style.filter = blurPx > 0 ? `blur(${blurPx.toFixed(2)}px)` : '';

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
    if (this.playerY <= PLAYER.BASE_Y + 0.01) {
      const bobPhase = this.duration * (this.speed / this.startSpeed) * 8;
      this.player.position.y =
        PLAYER.BASE_Y + Math.sin(bobPhase) * 0.07;
    }

    // ── Scroll floor stripes ──────────────────────────────────
    for (const s of this.floorStripes) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }

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
      if (o.mesh.position.z > WORLD.DESPAWN_Z) {
        this.scene.remove(o.mesh);
        this.disposeMesh(o.mesh);
        this.obstacles.splice(i, 1);
        continue;
      }
      if (this.intersectsPlayer(o.mesh, 1.0)) {
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

  // ── Spawning ────────────────────────────────────────────────────

  private spawnPickup() {
    const spec = rollPickup();
    const geo = new THREE.CylinderGeometry(
      spec.radius,
      spec.radius * 0.9,
      spec.height,
      14,
    );
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.35,
      metalness: 0.1,
      emissive: spec.color,
      emissiveIntensity: spec.kind === 'methuselah' ? 0.35 : 0.12,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const lane = Math.floor(Math.random() * LANES.X.length);
    mesh.position.set(LANES.X[lane], spec.height / 2 + 0.15, WORLD.SPAWN_Z);
    this.scene.add(mesh);
    this.pickups.push({ mesh, spec, resolved: false });
  }

  private spawnObstacle() {
    const spec = rollObstacle();
    const geo = new THREE.BoxGeometry(spec.width, spec.height, spec.depth);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.4,
      metalness: spec.kind === 'speaker' ? 0.3 : 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const lane = Math.floor(Math.random() * LANES.X.length);
    mesh.position.set(LANES.X[lane], spec.height / 2, WORLD.SPAWN_Z);
    this.scene.add(mesh);
    this.obstacles.push({ mesh, spec });
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
   * AABB collision check on X+Z, with a Y gate so jumping clears
   * floor-level obstacles. `paddingScale` lets pickups (forgiving)
   * use a wider collision than obstacles (tighter) — better game
   * feel: bottles are easy to grab, speakers are easy to dodge.
   */
  private intersectsPlayer(mesh: THREE.Mesh, paddingScale: number): boolean {
    const oGeo = mesh.geometry as
      | THREE.BoxGeometry
      | THREE.CylinderGeometry;
    let halfX: number;
    let halfZ: number;
    if (oGeo instanceof THREE.BoxGeometry) {
      halfX = (oGeo.parameters.width / 2) * WORLD.COLLISION_PADDING;
      halfZ = (oGeo.parameters.depth / 2) * WORLD.COLLISION_PADDING;
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
    // Y check — only collide if player is on/near the ground.
    if (this.player.position.y > 2.0) return false;
    return true;
  }

  private disposeMesh(mesh: THREE.Mesh) {
    mesh.geometry.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
    else m.dispose();
  }

  // ── Public bridge surface (called by page.tsx) ────────────────

  /** Called by Flutter once the WebView mounts. */
  init(payload: InitPayload) {
    this.userId = payload.userId;
    this.playerGender = payload.playerGender ?? '';
    this.reduceMotion = payload.reduceMotion === true;
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
    // Clean up any residual canvas filter so the game-over screen
    // is crisp.
    this.canvas.style.filter = '';
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
    this.canvas.style.filter = '';
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
