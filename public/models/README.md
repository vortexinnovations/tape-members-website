# Tape Runner — Character Models

The Three.js runner game loads its player character from this folder at runtime:

- `runner_male.glb` — used when the Flutter app sends `playerGender: 'male'` (default)
- `runner_female.glb` — used when `playerGender: 'female'`

If a file is missing, the game silently falls back to the in-code
capsule-stack placeholder character. No errors, no broken state —
the player just sees the simpler silhouette.

## Mixamo download checklist (free, no royalties)

1. Sign in at https://www.mixamo.com (free Adobe account)
2. **Character** — pick one:
   - Male: search **"Suit"** or **"Business Casual Man"** — the
     suit-and-tie options look best for Tape's vibe
   - Female: search **"Dress"** or **"Cocktail"** — pick a sleek
     evening-wear character
3. **Animation** — click the **Animations** tab, search **"Running"**.
   Pick one that loops cleanly (the preview shows it looping).
4. **In Place: ON** — this is critical. With the Running animation
   applied, check the **"In Place"** checkbox in the right-hand
   panel. The character should be running on the spot in the
   preview, not drifting forward. The game's world scrolls past a
   stationary player, so any forward translation in the animation
   would make the character fly off-screen.

   (As a belt-and-braces safety net, the loader in `game.ts` also
   strips X + Z root-bone position keyframes at runtime — see
   `stripRootForwardMotion` — but it's still simpler to download
   the right version.)
5. **Download settings**:
   - Format: **glTF Binary (.glb)**
   - Skin: **With Skin**
   - Frames per Second: **30**
   - Keyframe Reduction: **None**
6. Save as `runner_male.glb` / `runner_female.glb`
7. Drop both into this folder
8. Commit + deploy — `git add public/models/*.glb && vercel --prod`

## License notes

Mixamo characters and animations are free for personal and commercial
use under Adobe's terms (no royalties, no attribution required, no
subscription needed). The license forbids reselling the raw .glb as a
standalone asset, but embedding it in a product (this game) is the
intended use case. See https://www.mixamo.com/faq for details.

## Implementation notes (for future maintainers)

The loader (`game.ts` → `tryLoadGltfPlayer`) auto-scales the model
to match `PLAYER.HEIGHT` (1.8m), offsets the feet to the ground,
rotates 180° so the character faces away from the camera (running
into the screen), and picks the first animation clip whose name
contains "run" / "running" / "jog" / "walk" — falling back to the
first clip if none match.

If a different character source is used (Quaternius, Kenney, custom
Blender export), make sure the model:

- exports as glTF Binary (`.glb`)
- has its pivot at the feet (Mixamo default)
- includes at least one animation clip
- ships with the skin baked in (the `gltf.scene` should contain
  a `THREE.SkinnedMesh`)
