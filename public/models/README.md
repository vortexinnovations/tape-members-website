# Tape Runner — Character Models

The Three.js runner game loads its characters from this folder at
runtime:

| File | Purpose | Size |
|---|---|---|
| `runner_male.glb` | Player when `playerGender: 'male'` (default) | ~3 MB |
| `runner_female.glb` | Player when `playerGender: 'female'` | ~870 KB |
| `runner_jump_male.glb` | Jump animation character (male) | ~3 MB |
| `runner_jump_female.glb` | Jump animation character (female) | ~880 KB |
| `runner_fall_male.glb` | Game-over fall animation character (male) | ~3 MB |
| `runner_fall_female.glb` | Game-over fall animation character (female) | ~925 KB |
| `runner_bouncer.glb` | Dancing-bouncer obstacle (shared across all sessions) | ~2.7 MB |
| `dancer_female.glb` | Static T-pose dancer inside each podium cage (cloned 10×, procedurally swayed) | ~2.9 MB |

If a player or jump file is missing, the game silently falls back
to the in-code capsule-stack placeholder character (player) or the
procedural additive-pose jump (jump). If the fall file is missing,
game-over fires immediately (no death animation) — same payload,
just no on-screen collapse before Flutter's play-again sheet
appears. No errors, no broken state in any of these fallback paths.

## Asset pipeline — converting from Mixamo

The raw Mixamo FBX exports are ~50 MB each because they ship with
~36 large uncompressed textures per character. We run them through
a 3-step pipeline to produce the small `.glb` files committed
here (17–22× reduction with no visible quality loss):

```bash
# 1. FBX → GLB (Facebook FBX2glTF binary, bundled via the fbx2gltf
#    npm package). Installs once at the repo root:
#      npm install --no-save fbx2gltf
#    Binary path on Windows:
#      node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe
node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe \
  -i /path/to/Mixamo.fbx \
  -o /tmp/step1 \
  -b

# 2. Resize textures to 1024×1024 max.
npx @gltf-transform/cli@latest resize \
  /tmp/step1.glb /tmp/step2.glb --width 1024 --height 1024

# 3. Re-encode textures to webp (much smaller than PNG/JPG for
#    this character art style).
npx @gltf-transform/cli@latest webp /tmp/step2.glb /tmp/final.glb
```

**Do NOT use** `gltf-transform optimize` or `flatten` or `join` —
those operations break SkinnedMesh bind poses. The two ops above
(resize + webp) are the only ones that preserve animation
correctly.

## Mixamo download checklist (free, no royalties)

1. Sign in at https://www.mixamo.com (free Adobe account)
2. **Pick a character** (or upload your own). For the male player
   we use a suited Mixamo character; for the female we use a
   dressed character.
3. **Animation** — click the **Animations** tab, search for the
   one you want (e.g. **"Running"** for the run loop, **"Jump"**
   for the jump). Pick one that loops cleanly for run; the jump
   should start + end on the takeoff/landing pose.
4. **In Place: ON** for run (checkbox in the right panel — the
   character runs on the spot, not drifting forward). For jump,
   leave it on too so the character stays at origin during the
   leap.
5. **Download settings**:
   - Format: **FBX Binary (.fbx)**
   - Skin: **With Skin** (critical — we need the textured mesh,
     not animation-only)
   - Frames per Second: **30**
   - Keyframe Reduction: **None**
6. Run the 3-step pipeline above
7. Drop the resulting `.glb` into this folder
8. Commit + deploy — `git add public/models/*.glb && vercel --prod`

## License notes

Mixamo characters and animations are free for personal and commercial
use under Adobe's terms (no royalties, no attribution required, no
subscription needed). The license forbids reselling the raw `.fbx` /
`.glb` as a standalone asset, but embedding it in a product (this
game) is the intended use case. See https://www.mixamo.com/faq for
details.

## Implementation notes (for future maintainers)

The loader (`game.ts` → `tryLoadGltfPlayer` for the running
character, `loadJumpCharacter` for the jump character,
`loadFallCharacter` for the fall character):

- auto-scales the model to match `PLAYER.HEIGHT` (1.8 m)
- offsets the feet to the ground using foot-bone world-Y detection
- rotates 180° around Y so the character faces away from the
  camera (running into the screen)
- picks the first animation clip whose name contains
  "run" / "running" / "jog" / "walk" for the player; uses
  `animations[0]` for the jump and the fall
- strips root-bone X+Z position keyframes at runtime
  (`stripRootForwardMotion`) so the character stays put while
  the world scrolls past

The jump and fall characters are rendered as **separate visible
entities**, not as clips retargeted onto the running character —
applying a Mixamo "without skin" clip to a "with skin" character
produces twisted joints due to subtle bind-pose orientation
differences. The three-characters approach (run + jump + fall)
sidesteps that entirely. Each GLB runs its own embedded animation
against its own native skeleton. Visibility flips between them on
jump trigger / landing / game-over.

Game-over flow specifically: `endGame()` builds the payload, stashes
it in `pendingGameOver`, flips `isFalling = true`, hides the runner,
shows the fall character, and starts the fall action (LoopOnce +
clampWhenFinished). The rAF loop keeps ticking `playerFallMixer`
even though `running` is false. When the clip's `finished` event
fires (`installFallCharacter` wires the listener), `postGameOverFromFall`
ships the stashed payload to Flutter — which is what surfaces the
play-again sheet. If the fall GLB never loaded, `endGame()` skips
the death animation and posts immediately.

## Dancer figures inside the podium cages

`dancer_female.glb` is a special case — it's a **static T-pose mesh
with NO skeleton**. Generated via Tripo3D, but Mixamo + AccuRIG both
refuse to auto-rig AI-generated topology, so we sidestep the
problem entirely: parent one clone inside each podium cage and
apply procedural sway in `tickDancers()`:

- Twist around vertical axis (±14°, period ~3.5 s) — torso checking out the crowd
- Vertical bob (±0.04 m, period ~1.6 s) — knee-bounce on the downbeat
- Side sway in X (±0.05 m, period ~5 s) — hip shift

Per-podium phase offsets so adjacent dancers are out of sync. At
the viewing distance (5+ m from camera) + speed (~1 second per
podium pass) + occluded by the LED cage bars, this reads
indistinguishably from full skeletal animation.

Asset pipeline note: the dancer GLB skips Mixamo entirely and is
processed via `FBX2glTF → gltf-transform resize 1024 → webp encode
→ gltf-transform simplify --ratio 0.1` to bring its 131k-tri
source down to ~13k tris (10 clones × 13k = 130k tris total,
well within mobile webview budget).

If a different character source is used (Quaternius, Kenney,
custom Blender export), make sure the model:

- exports as glTF Binary (`.glb`)
- has its pivot at the feet (Mixamo default)
- includes at least one animation clip per file
- ships with the skin baked in (the loaded scene should contain
  a `THREE.SkinnedMesh`)
