// Strip a Mixamo-exported GLB down to just the animation + bone
// hierarchy. The mesh + materials + textures account for almost all
// of the file size (a Mixamo character export with 4K textures is
// 50+ MB) but we only need the AnimationClip to apply to an
// already-loaded player's skeleton.
//
// Strategy:
//   1. Detach every node's `mesh` reference → mesh becomes orphan
//   2. Drop every skin → orphans the IBM accessor + joint refs
//   3. `prune` to garbage-collect orphans + their downstream
//      materials and textures
//
// At runtime, Three.js loads the file and gets:
//   - A Group containing the bone hierarchy (used only as a
//     dummy root for the AnimationClip)
//   - The AnimationClip(s) — what we actually want
//
// We extract animations[0] and bind it to the EXISTING player's
// skeleton via clipAction(clip, playerSkeletonRoot). The dummy
// Group from this file is discarded.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node strip_to_animation.mjs <input.glb> <output.glb>');
  process.exit(1);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inputPath);
const root = doc.getRoot();

// Detach meshes from nodes
let detachedMeshes = 0;
for (const node of root.listNodes()) {
  if (node.getMesh()) {
    node.setMesh(null);
    detachedMeshes++;
  }
}

// Drop skins entirely — the IBM accessor + joint refs go too.
// The joint NODES themselves stay in the hierarchy (they're plain
// nodes now, not joints of any skin) so the animation's channels
// (which target nodes by reference) continue to resolve.
let droppedSkins = 0;
for (const skin of root.listSkins()) {
  // Clear the skin reference from any nodes
  for (const node of root.listNodes()) {
    if (node.getSkin() === skin) node.setSkin(null);
  }
  skin.dispose();
  droppedSkins++;
}

// Drop materials (skinning was the only consumer that survived;
// now they're orphans).
let droppedMaterials = 0;
for (const m of root.listMaterials()) {
  m.dispose();
  droppedMaterials++;
}

// Final pass — `prune` removes orphan meshes, accessors,
// bufferViews, textures, buffers.
await doc.transform(prune());

await io.write(outputPath, doc);
console.log(
  `OK — wrote ${outputPath}`,
  `\n  meshes detached: ${detachedMeshes}`,
  `\n  skins dropped:   ${droppedSkins}`,
  `\n  materials dropped: ${droppedMaterials}`,
  `\n  remaining nodes:    ${root.listNodes().length}`,
  `\n  remaining textures: ${root.listTextures().length}`,
  `\n  remaining animations: ${root.listAnimations().length}`,
);
