// Tape Runner — Three.js game class (spike / placeholder content).
//
// Scope of THIS commit: prove the end-to-end architecture by
// rendering a minimal-but-functional 3-lane runner with cube
// obstacles. The art is intentionally placeholder — once the
// bridge + Flutter integration is verified, subsequent commits
// swap in real Mixamo characters, GLB obstacle models, audio,
// particles, post-processing, etc.
//
// Render frame:
//   - Top-down-ish perspective camera behind & above the player
//   - Floor extends into the distance (negative Z)
//   - Player is a copper rounded box on lane 1 (centre)
//   - Obstacles spawn at z = SPAWN_Z and translate toward camera
//     (positive Z) at the current speed
//   - Game ends on collision; gameOver message posted to Flutter
//
// Coordinate convention:
//   +X = right    -X = left
//   +Y = up
//   +Z = toward camera (the player runs in -Z direction
//        conceptually; in practice the world scrolls in +Z
//        past the player, who stays put)

import * as THREE from 'three';
import {
  postToFlutter,
  type InitPayload,
  type PlayerGender,
} from './bridge';

// ── Tunables (defaults — admin values override on init) ───────────
const LANE_X = [-2.4, 0, 2.4] as const;
const PLAYER_BASE_Y = 1;
const PLAYER_JUMP_VY = 8.0; // initial upward velocity
const GRAVITY = -18.0;
const SPAWN_Z = -70;
const DESPAWN_Z = 8;
const LANE_CHANGE_DURATION = 0.18; // seconds
const SPAWN_INTERVAL_BASE = 1.4; // seconds at base speed
const COLLISION_PADDING = 0.85; // tighter than visual bbox for fairness

// ── Game class ─────────────────────────────────────────────────────

export class RunnerGame {
  // Three.js core
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private resizeObserver: ResizeObserver | null = null;

  // Player + lane state
  private player!: THREE.Mesh;
  private playerLane = 1;
  // Explicit `number` annotations — without them TS infers the
  // literal type `0` from LANE_X[1] (because LANE_X is `as const`)
  // and rejects later assignment from -2.4 / +2.4 lanes.
  private targetX: number = LANE_X[1];
  private laneChangeTime = 0;
  private laneChangeStartX: number = LANE_X[1];
  private playerY = PLAYER_BASE_Y;
  private playerVy = 0;

  // Obstacle pool — simple cubes for the spike.
  private obstacles: THREE.Mesh[] = [];
  private spawnAccumulator = 0;

  // Floor stripes — give the player a sense of motion.
  private floorStripes: THREE.Mesh[] = [];

  // Game state
  private speed = 10;
  private startSpeed = 10;
  private maxSpeed = 22;
  private speedRamp = 0.01;
  private distance = 0;
  private duration = 0;
  private hits = 0;
  private water = 0;
  private coins = 0;

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

    this.camera = new THREE.PerspectiveCamera(
      55,
      this.aspect(),
      0.1,
      200,
    );
    this.camera.position.set(0, 4.5, 8);
    this.camera.lookAt(0, 1, -6);

    this.buildScene();
    this.attachInput();
    this.attachResize();
    this.start();
  }

  private aspect(): number {
    const r = this.canvas.getBoundingClientRect();
    return r.width / Math.max(1, r.height);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width || window.innerWidth;
    const h = r.height || window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  // ── Scene build ─────────────────────────────────────────────────

  private buildScene() {
    // Lighting — one directional + ambient. Cheap and reads well.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(2, 10, 4);
    this.scene.add(dir);
    // Faint magenta rim light to suggest nightclub ambience.
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

    // Lane separator strips. Slightly raised so they don't z-fight
    // with the ground.
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

    // Floor stripes — short bright bars that translate +Z each
    // frame to give a strong motion cue. Recycled in a small pool.
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
    // GLB with run animation) comes in the next commit.
    const playerGeo = new THREE.BoxGeometry(1.0, 1.8, 0.6);
    const playerMat = new THREE.MeshStandardMaterial({
      color: 0xb87333,
      roughness: 0.5,
      metalness: 0.05,
    });
    this.player = new THREE.Mesh(playerGeo, playerMat);
    this.player.position.set(LANE_X[1], PLAYER_BASE_Y, 0);
    this.scene.add(this.player);
  }

  // ── Input ───────────────────────────────────────────────────────

  private swipeStart: { x: number; y: number } | null = null;
  private swipeCommitted = false;
  private static MIN_SWIPE = 30;

  private attachInput() {
    // Touch / mouse — single pointer handling, follows the same
    // dominant-axis swipe rule the Flame version uses.
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
        dx < 0 ? this.swipeLeft() : this.swipeRight();
        this.swipeCommitted = true;
      } else if (ay > ax && ay > RunnerGame.MIN_SWIPE) {
        if (dy < 0) this.jump();
        // (slide on swipe down — wired in next commit)
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
      else if (e.key === 'ArrowUp' || e.key === ' ' || e.key === 'w') this.jump();
    });
  }

  private attachResize() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this.resize());
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.camera.aspect = this.aspect();
      this.camera.updateProjectionMatrix();
    });
    this.resizeObserver.observe(this.canvas);
  }

  private swipeLeft() {
    if (this.gameOver || !this.running) return;
    if (this.playerLane > 0) this.setLane(this.playerLane - 1);
  }
  private swipeRight() {
    if (this.gameOver || !this.running) return;
    if (this.playerLane < LANE_X.length - 1) this.setLane(this.playerLane + 1);
  }
  private setLane(lane: number) {
    this.playerLane = lane;
    this.laneChangeStartX = this.player.position.x;
    this.targetX = LANE_X[lane];
    this.laneChangeTime = 0;
  }
  private jump() {
    if (this.gameOver || !this.running) return;
    if (this.playerY > PLAYER_BASE_Y + 0.05) return; // already airborne
    this.playerVy = PLAYER_JUMP_VY;
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

    // Speed curve — same shape as the Flame version.
    this.speed = Math.min(
      this.maxSpeed,
      this.startSpeed + this.distance * this.speedRamp,
    );
    this.distance += this.speed * dt;
    this.duration += dt;

    // Lane interpolation (eased) — moves player.position.x from
    // laneChangeStartX toward targetX over LANE_CHANGE_DURATION.
    if (this.laneChangeTime < LANE_CHANGE_DURATION) {
      this.laneChangeTime += dt;
      const t = Math.min(1, this.laneChangeTime / LANE_CHANGE_DURATION);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      this.player.position.x =
        this.laneChangeStartX +
        (this.targetX - this.laneChangeStartX) * eased;
    } else {
      this.player.position.x = this.targetX;
    }

    // Jump arc — simple Euler integration with gravity.
    if (this.playerY > PLAYER_BASE_Y || this.playerVy !== 0) {
      this.playerVy += GRAVITY * dt;
      this.playerY += this.playerVy * dt;
      if (this.playerY <= PLAYER_BASE_Y) {
        this.playerY = PLAYER_BASE_Y;
        this.playerVy = 0;
      }
      this.player.position.y = this.playerY;
    }

    // Run-bob — small Y oscillation while grounded.
    if (this.playerY <= PLAYER_BASE_Y + 0.01) {
      const bobPhase = this.duration * (this.speed / this.startSpeed) * 8;
      this.player.position.y =
        PLAYER_BASE_Y + Math.sin(bobPhase) * 0.07;
    }

    // Scroll the floor stripes.
    const scroll = this.speed * dt;
    for (const s of this.floorStripes) {
      s.position.z += scroll;
      if (s.position.z > 4) s.position.z -= 90;
    }

    // Scroll obstacles + check collisions + despawn.
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      o.position.z += scroll;
      if (o.position.z > DESPAWN_Z) {
        this.scene.remove(o);
        this.obstacles.splice(i, 1);
        continue;
      }
      if (this.intersectsPlayer(o)) {
        this.endGame('blackout');
        return;
      }
    }

    // Spawner — drops obstacles at SPAWN_Z in a random lane.
    this.spawnAccumulator += dt;
    const interval =
        SPAWN_INTERVAL_BASE * (this.startSpeed / this.speed);
    if (this.spawnAccumulator >= interval) {
      this.spawnAccumulator = 0;
      this.spawnObstacle();
    }
  }

  private spawnObstacle() {
    const geo = new THREE.BoxGeometry(0.9, 1.6, 0.6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1f4d2a,
      roughness: 0.4,
    });
    const o = new THREE.Mesh(geo, mat);
    const lane = Math.floor(Math.random() * LANE_X.length);
    o.position.set(LANE_X[lane], 0.8, SPAWN_Z);
    this.scene.add(o);
    this.obstacles.push(o);
  }

  private intersectsPlayer(o: THREE.Mesh): boolean {
    // AABB on X+Z (Y collision skipped — jumping clears any
    // obstacle at the current spike's heights).
    const oGeo = o.geometry as THREE.BoxGeometry;
    const pGeo = this.player.geometry as THREE.BoxGeometry;
    const oHalfX = (oGeo.parameters.width / 2) * COLLISION_PADDING;
    const oHalfZ = (oGeo.parameters.depth / 2) * COLLISION_PADDING;
    const pHalfX = (pGeo.parameters.width / 2) * COLLISION_PADDING;
    const pHalfZ = (pGeo.parameters.depth / 2) * COLLISION_PADDING;
    const dx = Math.abs(o.position.x - this.player.position.x);
    const dz = Math.abs(o.position.z - this.player.position.z);
    if (dx > oHalfX + pHalfX) return false;
    if (dz > oHalfZ + pHalfZ) return false;
    // Y check — only collide if player is grounded or low in jump.
    if (this.player.position.y > 2.0) return false;
    this.hits++;
    return true;
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

  private endGame(reason: 'blackout' | 'speakerHit' | 'manual') {
    if (this.gameOver) return;
    this.gameOver = true;
    this.running = false;
    postToFlutter({
      type: 'gameOver',
      distance: Math.floor(this.distance),
      duration: Math.floor(this.duration),
      hits: this.hits,
      water: this.water,
      coins: this.coins,
      reason,
    });
  }

  /** Called by page.tsx on unmount. */
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
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
