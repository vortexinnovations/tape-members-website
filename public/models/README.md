# Tape Runner — Character Models

The Three.js runner game loads its player character from this folder at runtime:

- `runner_male.fbx` (or `.glb`) — used when the Flutter app sends `playerGender: 'male'` (default)
- `runner_female.fbx` (or `.glb`) — used when `playerGender: 'female'`

If a file is missing, the game silently falls back to the in-code
capsule-stack placeholder character. No errors, no broken state —
the player just sees the simpler silhouette.

The loader (`game.ts` → `tryLoadGltfPlayer`) tries `.fbx` first,
falls back to `.glb` if no FBX is present. FBX is Mixamo's native
export format so there's no conversion step needed.

## Mixamo download checklist (free, no royalties)

1. Sign in at https://www.mixamo.com (free Adobe account)
2. **Character** — pick one:
   - Male: search **"Suit"** or **"Business Casual Man"** — the
     suit-and-tie options look best for Tape's vibe
   - Female: search **"Dress"** or **"Cocktail"** — pick a sleek
     evening-wear character
3. **Animation** — click the **Animations** tab, search **"Running"**.
   Pick one that loops cleanly (the preview shows it looping).
4. **In Place: ON** — check the **"In Place"** checkbox in the
   right-hand panel. The character should be running on the spot
   in the preview, not drifting forward.

   (As a belt-and-braces safety net, the loader in `game.ts` strips
   the X + Z root-bone position keyframes at runtime — see
   `stripRootForwardMotion` — so the character stays put even if
   you forget. But the preview is more accurate when In Place is on.)
5. **Download settings**:
   - Format: **FBX Binary (.fbx)**  ← Mixamo's default; no
     conversion required
   - Skin: **With Skin**
   - Frames per Second: **30**
   - Keyframe Reduction: **None**
6. Save as `runner_male.fbx` / `runner_female.fbx`
7. Drop both into this folder
8. Commit + deploy — `git add public/models/*.fbx && vercel --prod`

## Optional: convert FBX → GLB for smaller file size

FBX exports from Mixamo are usually 10–20MB per character. If you
want faster loading, convert to glTF Binary (GLB, ~3–5MB):

- **Easiest**: https://blackthread.io/gltf-converter/ — fully
  client-side (no upload to any server), drag the .fbx in, click
  Download GLB.
- **Alternative**: Blender → File → Import → FBX → File → Export →
  glTF 2.0 (.glb).

Save the result as `runner_male.glb` / `runner_female.glb` next to
(or instead of) the `.fbx` files. The loader prefers FBX if both
are present — to use GLB instead, just delete the FBX.

## License notes

Mixamo characters and animations are free for personal and commercial
use under Adobe's terms (no royalties, no attribution required, no
subscription needed). The license forbids reselling the raw .fbx /
.glb as a standalone asset, but embedding it in a product (this
game) is the intended use case. See https://www.mixamo.com/faq for
details.

## Implementation notes (for future maintainers)

The loader auto-scales the model to match `PLAYER.HEIGHT` (1.8m),
offsets the feet to the ground, rotates 180° around Y so the
character faces away from the camera (running into the screen),
and picks the first animation clip whose name contains "run" /
"running" / "jog" / "walk" — falling back to the first clip if
none match. Root-bone X+Z keyframes are zeroed so the character
stays put while the world scrolls past.

If a different character source is used (Quaternius, Kenney, custom
Blender export), make sure the model:

- exports as FBX Binary (.fbx) or glTF Binary (.glb)
- has its pivot at the feet (Mixamo default)
- includes at least one animation clip
- ships with the skin baked in (the loaded scene should contain
  a `THREE.SkinnedMesh`)
