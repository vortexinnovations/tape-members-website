# Tape Runner — Character Models

The Three.js runner game loads its characters from this folder at
runtime:

| File | Purpose | Size |
|---|---|---|
| `runner_male.glb` | Player when `playerGender: 'male'` (default) — Draco-compressed | ~1.2 MB |
| `runner_female.glb` | Player when `playerGender: 'female'` | ~870 KB |
| `runner_jump_male.glb` | Jump animation character (male) — Draco-compressed | ~1.2 MB |
| `runner_jump_female.glb` | Jump animation character (female) | ~880 KB |
| `runner_fall_male.glb` | Game-over fall animation character (male) — Draco-compressed | ~1.2 MB |
| `runner_fall_female.glb` | Game-over fall animation character (female) | ~925 KB |
| `runner_dancer.glb` | Dancing-character obstacle (variant 1) — picked randomly per spawn | ~2.7 MB |
| `runner_dancer_2.glb` | Dancing-character obstacle (variant 2, black-dress dancer) — picked randomly per spawn | ~2.7 MB |
| `runner_bouncer.glb` | Arms-crossed bouncer obstacle on a staircase platform | ~1.3 MB |
| `dancer_animated.glb` | Hip-hop podium dancer (blonde) cloned into each cage | ~1.3 MB |
| `dancer_animated_dark.glb` | Hip-hop podium dancer (dark hair) — random alt | ~1.4 MB |

If a player or jump file is missing, the game silently falls back
to the in-code capsule-stack placeholder character (player) or the
procedural additive-pose jump (jump). If the fall file is missing,
game-over fires immediately (no death animation) — same payload,
just no on-screen collapse before Flutter's play-again sheet
appears. No errors, no broken state in any of these fallback paths.

---

## ⭐ Future Claude — adding a Mixamo FBX to the game

**Self-note: this is the canonical happy path. Do it exactly this
way unless something has fundamentally changed. Do NOT improvise a
Node-based FBX→GLB pipeline; the binary tool below works and the
Node path is a swamp (textures fail to decode, jsdom polyfills go
stale, the GLTFExporter has Issues).**

### Step 0 — Verify the FBX is what you think it is

Confirm the FBX has the mesh + rig + animation embedded:

```bash
ls -la "/path/to/source.fbx"          # check size (~5–60 MB typical)
```

A 1–2 MB FBX is usually animation-only (downloaded from Mixamo with
"Without Skin"). For the game we need "With Skin" downloads which
are usually 8–60 MB.

### Step 1 — Install FBX2glTF (one-time, idempotent)

```bash
cd /c/projects/tape_members_website
npm install --no-save fbx2gltf
# Binary lands at: node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe
```

The `--no-save` keeps `package.json` clean — it's a build-time-only
tool. If `node_modules/@gltf-transform/*` gets nuked by this
install (it sometimes does), re-install both:
`npm install --no-save fbx2gltf @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions`.

### Step 2 — Run the 3-step asset pipeline

```bash
# A. FBX → GLB (preserves rig, animation, textures, materials).
"node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe" \
  -i "/absolute/path/to/source.fbx" \
  -o "/tmp/step1" \
  -b

# B. Downscale textures to 1024px max edge.
npx --yes @gltf-transform/cli@latest resize \
  /tmp/step1.glb /tmp/step2.glb \
  --width 1024 --height 1024

# C. Re-encode textures from PNG/JPEG → webp (3–5× smaller).
npx --yes @gltf-transform/cli@latest webp \
  /tmp/step2.glb /tmp/final.glb
```

Expected size trajectory for a typical Mixamo dancer FBX:
9 MB → 5.6 MB → 3.0 MB → **1.4 MB final**.

**Do NOT use** `gltf-transform optimize`, `flatten`, `join`, or
`simplify` on a skinned mesh — those operations break SkinnedMesh
bind poses. Resize + webp + draco + meshopt + resample are the
safe ops on rigged assets.

### Optional step D — Draco geometry compression (~60% reduction)

For meshes >2 MB, append a Draco pass. It re-encodes geometry
(positions/normals/UVs/joints/weights) into a quantised binary
form — fully lossless for the bind pose and skin weights, animations
untouched.

```bash
npx --yes @gltf-transform/cli@latest draco \
  /tmp/final.glb /tmp/final-draco.glb
```

Confirms the asset's `extensionsRequired` array gains
`KHR_draco_mesh_compression`. The runtime path
(`makeGltfLoader()` in `game.ts`) is already wired with a
DRACOLoader pointing at `https://www.gstatic.com/draco/v1/decoders/`,
so Draco GLBs and plain GLBs both load through the same loader.
First Draco load fetches the ~200 KB WASM decoder once,
cached aggressively by gstatic.

Mixamo "Suit Guy" trilogy (~9.3 MB) → ~3.6 MB after Draco.
Animations identical (channels/samplers/keyframes byte-for-byte
match).

### Step 3 — Verify the GLB

```bash
npx --yes @gltf-transform/cli@latest inspect /tmp/final.glb | tail -50
```

Confirm:
- 1 mesh with `JOINTS_0`, `WEIGHTS_0` vertex attributes (= rigged)
- ≥ 1 material with `baseColorTexture` slot
- ≥ 1 animation with non-trivial duration + channels

If the rig is missing (no `JOINTS_0`), the source FBX was
animation-only — re-download from Mixamo as "With Skin".

### Step 4 — Deploy

```bash
cp /tmp/final.glb /c/projects/tape_members_website/public/models/<TARGET>.glb
```

For the dancer: `dancer_animated.glb`. For a new runner character:
`runner_male.glb` / `runner_female.glb` etc. (overwrites are fine).

**Adding a NEW dancer-obstacle variant** (e.g. a third dancer that
mixes with the existing pool): pipeline the FBX exactly as above,
deploy as `runner_dancer_N.glb`, and add the new path to the
`urls` array in `loadDancerObstacleModel()` inside `game.ts`. The
spawn path already picks at random across whatever variants
loaded successfully — `Promise.allSettled` means a missing /
broken variant doesn't take down the others.

### Step 5 — Adjust runtime fit constants in `game.ts`

The dancer loader (`loadDancerVisuals`) auto-derives `dancerScale`
from the GLB's bbox so swapping the asset doesn't require touching
the scale formula. But you usually need to tune three constants
near the top of that function to match the new asset's
proportions + bind-pose quirks:

```typescript
const DANCER_HEIGHT = 1.7 * 1.5;   // target on-screen metres (= 1.5× human)
const DANCER_LIFT = 0.7;           // raise feet above plinth (Mixamo's bind pose bbox runs taller than visible)
const DANCER_INWARD = 0.8;         // step toward runway centre
```

Iterate with the user — they'll eyeball values and ask for
"+0.2 m higher", "+0.3 m inward", etc. Apply the deltas directly
to these constants. No need to re-bake or re-pipeline the GLB
for positional changes.

Rotation logic for facing direction:
```typescript
clone.rotation.y = isLeftSide ? Math.PI / 2 : -Math.PI / 2;
```
Sign flips this to face the opposite way (away vs toward runway).

### Step 6 — Commit + push

```bash
git -C /c/projects/tape_members_website add public/models/<TARGET>.glb src/app/runner/game/game.ts
git -C /c/projects/tape_members_website commit -m "Runner: replace <TARGET> with <description>"
git -C /c/projects/tape_members_website push origin master
```

Vercel auto-deploys on push to master. Live in ~1 minute.

---

## Pre-FBX: getting the dancer ready for Mixamo

The hard part is usually upstream of this repo — getting an FBX
that Mixamo's Auto-Rigger accepts. Workflow summary, in order of
preference:

### Preferred: Mixamo directly auto-rigs the Tripo3D static mesh

1. Generate the character in Tripo3D (https://tripo3d.ai). Settings:
   - **Topology: Quad** (better Mixamo joint detection)
   - **Polycount: 15,000–20,000** (sweet spot; 5K too low, 50K
     can choke the auto-rigger)
   - **PBR: ON**
   - **Texture: ON, 4K** (we downscale later)
   - **Critical: prompt must produce T-pose** — "T-pose, arms
     outstretched horizontally to the sides, palms down, standing
     upright". A-pose works sometimes; arms-by-sides never works.
2. Tripo3D downloads as GLB by default. For Mixamo, convert to FBX
   in Blender (`File → Import → glTF 2.0`, then
   `File → Export → FBX`). Use "Selected Objects" + "Apply
   Modifiers" + embed textures via the "Copy" + box-icon Path Mode.
3. Upload FBX to mixamo.com → Upload Character.
4. **Manual marker placement screen** appears — drag the 8 circles
   onto chin / wrists / elbows / knees / groin on the T-pose
   preview. Mixamo auto-rigs in ~60 s.
5. Search for animation → Download with: **FBX Binary**,
   **With Skin**, **30 FPS**, no keyframe reduction.

### Why Tripo3D → FBX direct is preferred over AccuRIG → strip → FBX

AccuRIG (Reallusion) produces its own rig with CC_Base_* bone
naming, which Mixamo's auto-rigger can't map → "**Sorry, unable to
map your existing skeleton**" error. We tried stripping the
AccuRIG armature in Blender and re-uploading — still failed because
of leftover vertex groups OR because the mesh became too dense
post-AccuRIG (1.3M verts, ~4× the Tripo3D source).

### Mixamo upload errors and fixes

| Error | Cause | Fix |
|---|---|---|
| "Unable to map your existing skeleton" | FBX has armature OR vertex groups Mixamo can't recognise | Strip armature in Blender (`X` on Armature row), delete all vertex groups (Object Data Properties → Vertex Groups → ⋮ → Delete All Groups), re-export |
| Same error after strip | Possibly polygon count too high | Decimate in Blender to ~30K polys before re-exporting |
| Same error persists | Skeleton metadata buried in FBX | Export as **OBJ + MTL + textures** instead, zip them together, upload the zip (OBJ format has no concept of skeletons, forces Mixamo to use Auto-Rigger) |
| Character is sideways / wrong orientation | FBX axis convention not Y-up | Blender export options: Forward = `-Z Forward`, Up = `Y Up` |
| Auto-Rigger placed bones outside body | Mesh isn't in T-pose | Re-pose in Blender or re-generate at Tripo3D with T-pose prompt |

---

## License notes (Mixamo)

Mixamo characters and animations are free for personal and commercial
use under Adobe's terms (no royalties, no attribution required, no
subscription needed). The license forbids reselling the raw `.fbx` /
`.glb` as a standalone asset, but embedding it in a product (this
game) is the intended use case. See https://www.mixamo.com/faq for
details.

---

## Runtime implementation notes

The runner / jump / fall loaders (`game.ts` → `tryLoadGltfPlayer`,
`loadJumpCharacter`, `loadFallCharacter`) all:

- auto-scale the model to match `PLAYER.HEIGHT` (1.8 m)
- offset feet to ground using foot-bone world-Y detection
- rotate 180° around Y so the character faces away from camera
- pick the first animation clip whose name contains
  "run" / "running" / "jog" / "walk" for the player; use
  `animations[0]` for jump and fall
- strip root-bone X+Z position keyframes at runtime
  (`stripRootForwardMotion`) so the character stays put while
  the world scrolls past

Jump and fall are rendered as **separate visible entities**, not
as clips retargeted onto the running character — applying a Mixamo
"without skin" clip to a "with skin" character produces twisted
joints due to subtle bind-pose orientation differences. Each GLB
runs its own embedded animation against its own native skeleton;
visibility flips between them on jump trigger / landing / game-over.

`endGame()` flow: builds the payload → stashes in
`pendingGameOver` → flips `isFalling = true` → hides runner →
shows fall character → starts fall action (LoopOnce +
clampWhenFinished). The rAF loop keeps ticking `playerFallMixer`
even though `running` is false. When the clip's `finished` event
fires, `postGameOverFromFall` ships the stashed payload to Flutter.
If the fall GLB never loaded, `endGame()` skips animation and posts
immediately.

### Dancer (loadDancerVisuals)

The dancer loader is more permissive — it computes scale + offset
from the GLB's bbox at load time:

```typescript
const srcBbox = new THREE.Box3().setFromObject(gltf.scene);
const srcHeight = bbox.max.y - bbox.min.y;
const DANCER_HEIGHT = 1.7 * 1.5;     // target on-screen height
const DANCER_LIFT = 0.7;             // taste-tune
const DANCER_INWARD = 0.8;           // toward runway centre
const dancerScale = DANCER_HEIGHT / srcHeight;
const feetOffsetY =
  plinthTop - srcBbox.min.y * dancerScale - DANCER_HEIGHT + DANCER_LIFT;
```

Uniform parent scale is safe on Mixamo-rigged GLBs because the
inverse bind matrices encode rest-pose transforms correctly. The
**SIZE > 1 stretch bug we used to fight** was specific to the
old procedurally-bound dancer (computed via
`tools/bind_dancer.mjs` using bone-distance heuristics — both
script and source asset have since been deleted, replaced by the
Mixamo auto-rig path).

---

## If a different character source is used

Quaternius, Kenney, Sketchfab, custom Blender export — the model
must:

- export as glTF Binary (`.glb`)
- have its pivot at the feet (Mixamo default; not always true for
  other sources — check by loading in https://gltf.report)
- include at least one animation clip
- ship with skin baked in (loaded scene should contain a
  `THREE.SkinnedMesh`, not just `THREE.Mesh`)
