// Offline bake of the full animated dancer GLB.
//
// Inputs (already in public/models/ from earlier passes):
//   • dancer_female.glb  — static T-pose mesh from Tripo3D, no skeleton
//   • dance_anim.glb     — Mixamo skeleton + "Arms Hip Hop Dance" clip,
//                          no mesh
//
// Output:
//   • dancer_animated.glb  — single rigged+animated GLB. mesh from
//                            Tripo, skeleton + clip from Mixamo, skin
//                            attribute computed via offline bone-
//                            proximity weighting, everything wrapped
//                            in a root node that bakes in the fit-to-
//                            mesh scale × the desired display size.
//
// Why bake this offline: the previous version did all of this at
// runtime, but Three.js's bind() + bindMatrix interaction with a
// scaled+rotated parent group produced compounding transform errors
// at any scale ≠ 1. By baking the skin + skeleton into a single
// glTF, Three.js's GLTFLoader handles the whole rig natively (same
// path as our runner/jump/fall characters which work flawlessly),
// and the runtime just needs to clone() per podium.
//
// To re-run after changing the mesh or animation, simply:
//   cd tools && node build_dancer_anim.mjs

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments } from '@gltf-transform/functions';
import * as THREE from 'three';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ── Tuning ──────────────────────────────────────────────────────────
// Display size multiplier on top of the auto fit-to-mesh scale.
// 1.0 = "match mesh's native height" (the offline-binding scale).
// 2.0 = double size. Adjustable here without affecting runtime.
const SIZE = 1.0;

// 20 major bones for skin weighting. Order matters — defines the
// joint index order in JOINTS_0. Same list as the original
// bind_dancer.mjs script.
const MAJOR_BONES = [
  'mixamorig:Hips',
  'mixamorig:Spine',
  'mixamorig:Spine1',
  'mixamorig:Spine2',
  'mixamorig:Neck',
  'mixamorig:Head',
  'mixamorig:LeftShoulder',
  'mixamorig:LeftArm',
  'mixamorig:LeftForeArm',
  'mixamorig:LeftHand',
  'mixamorig:RightShoulder',
  'mixamorig:RightArm',
  'mixamorig:RightForeArm',
  'mixamorig:RightHand',
  'mixamorig:LeftUpLeg',
  'mixamorig:LeftLeg',
  'mixamorig:LeftFoot',
  'mixamorig:RightUpLeg',
  'mixamorig:RightLeg',
  'mixamorig:RightFoot',
];

// For each bone, the child whose position we treat as the bone's
// "end" — used for the vertex-to-bone-segment distance metric.
const SEGMENT_ENDPOINTS = {
  'mixamorig:Hips': 'mixamorig:Spine',
  'mixamorig:Spine': 'mixamorig:Spine1',
  'mixamorig:Spine1': 'mixamorig:Spine2',
  'mixamorig:Spine2': 'mixamorig:Neck',
  'mixamorig:Neck': 'mixamorig:Head',
  'mixamorig:Head': 'mixamorig:HeadTop_End',
  'mixamorig:LeftShoulder': 'mixamorig:LeftArm',
  'mixamorig:LeftArm': 'mixamorig:LeftForeArm',
  'mixamorig:LeftForeArm': 'mixamorig:LeftHand',
  'mixamorig:LeftHand': 'mixamorig:LeftHandMiddle4',
  'mixamorig:RightShoulder': 'mixamorig:RightArm',
  'mixamorig:RightArm': 'mixamorig:RightForeArm',
  'mixamorig:RightForeArm': 'mixamorig:RightHand',
  'mixamorig:RightHand': 'mixamorig:RightHandMiddle4',
  'mixamorig:LeftUpLeg': 'mixamorig:LeftLeg',
  'mixamorig:LeftLeg': 'mixamorig:LeftFoot',
  'mixamorig:LeftFoot': 'mixamorig:LeftToe_End',
  'mixamorig:RightUpLeg': 'mixamorig:RightLeg',
  'mixamorig:RightLeg': 'mixamorig:RightFoot',
  'mixamorig:RightFoot': 'mixamorig:RightToe_End',
};

// ── Load both source GLBs ───────────────────────────────────────────
const animDoc = await io.read('../public/models/dance_anim.glb');
const meshDoc = await io.read('../public/models/dancer_female.glb');

// ── Walk the anim doc's bone tree, compute each node's bind-pose
// world matrix via FK. We need the full 4×4 (not just position) so
// we can invert it as an inverse-bind matrix later.
const worldByName = new Map();
const animScene = animDoc.getRoot().listScenes()[0];
function walkAnim(node, parentMatrix) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const localMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(t),
    new THREE.Quaternion().fromArray(r),
    new THREE.Vector3().fromArray(s),
  );
  const worldMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, localMatrix);
  worldByName.set(node.getName(), {
    node,
    worldMatrix,
    pos: new THREE.Vector3().setFromMatrixPosition(worldMatrix).toArray(),
  });
  for (const child of node.listChildren()) walkAnim(child, worldMatrix);
}
for (const top of animScene.listChildren()) {
  walkAnim(top, new THREE.Matrix4());
}

// ── Bone segments at native (unscaled) size ─────────────────────────
const rawBones = MAJOR_BONES.map((name) => {
  const start = worldByName.get(name)?.pos;
  const end = worldByName.get(SEGMENT_ENDPOINTS[name])?.pos;
  if (!start || !end) throw new Error(`Missing position for ${name}`);
  return { name, start, end };
});

// Skeleton bbox + mesh bbox → fit scale
const sklMin = [Infinity, Infinity, Infinity];
const sklMax = [-Infinity, -Infinity, -Infinity];
for (const { start, end } of rawBones) {
  for (const p of [start, end]) {
    for (let i = 0; i < 3; i++) {
      sklMin[i] = Math.min(sklMin[i], p[i]);
      sklMax[i] = Math.max(sklMax[i], p[i]);
    }
  }
}

const meshObj = meshDoc.getRoot().listMeshes()[0];
const meshPrim = meshObj.listPrimitives()[0];
const posAttr = meshPrim.getAttribute('POSITION');
const positions = posAttr.getArray();
const vertCount = posAttr.getCount();

const meshMin = [Infinity, Infinity, Infinity];
const meshMax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
  for (let k = 0; k < 3; k++) {
    meshMin[k] = Math.min(meshMin[k], positions[i + k]);
    meshMax[k] = Math.max(meshMax[k], positions[i + k]);
  }
}

const fitScale = (meshMax[1] - meshMin[1]) / (sklMax[1] - sklMin[1]);
const finalScale = fitScale * SIZE;
console.log(`Fit scale: ${fitScale.toFixed(4)} × SIZE ${SIZE} = ${finalScale.toFixed(4)}`);

// ── Skin-weight bone segments: fit-only (no SIZE) ──────────────────
// Skin weights are computed by comparing mesh vertex positions to
// bone segments. Both need to be in the SAME coordinate frame for the
// distance metric to be meaningful. The mesh stays at its native
// 1m-tall coords in the GLB (the runtime scale is applied at the
// dancerScaleRoot level), so we scale BONES into the mesh's frame —
// using `fitScale` only, NOT finalScale. A previous version of this
// script scaled mesh positions by finalScale too; at SIZE > 1 that
// caused bones to be twice as big as the mesh during weight comp,
// which silently assigned chest vertices to head bones, waist to
// chest bones, etc. — manifesting at runtime as an arched/bent body.
const fittedBonesForWeights = rawBones.map(({ name, start, end }) => ({
  name,
  start: start.map((v) => v * fitScale),
  end: end.map((v) => v * fitScale),
}));

function distToSegment(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const dot = apx * abx + apy * aby + apz * abz;
  const lenSq = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, Math.min(1, dot / lenSq));
  const cx = a[0] + abx * t, cy = a[1] + aby * t, cz = a[2] + abz * t;
  const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

console.log(`Computing weights for ${vertCount} vertices...`);
const joints0 = new Uint16Array(vertCount * 4);
const weights0 = new Float32Array(vertCount * 4);
const EPS = 0.0005;
const distsTmp = new Array(MAJOR_BONES.length);
for (let v = 0; v < vertCount; v++) {
  // Mesh positions in their NATIVE frame — compared against bones
  // also in the mesh's native frame (fittedBonesForWeights).
  const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  for (let b = 0; b < fittedBonesForWeights.length; b++) {
    distsTmp[b] = {
      idx: b,
      d: distToSegment(p, fittedBonesForWeights[b].start, fittedBonesForWeights[b].end),
    };
  }
  distsTmp.sort((x, y) => x.d - y.d);
  let sumW = 0;
  const top = [];
  for (let k = 0; k < 4; k++) {
    const w = 1 / (distsTmp[k].d * distsTmp[k].d + EPS);
    top.push({ idx: distsTmp[k].idx, w });
    sumW += w;
  }
  for (let k = 0; k < 4; k++) {
    joints0[v * 4 + k] = top[k].idx;
    weights0[v * 4 + k] = top[k].w / sumW;
  }
}
console.log('Weights done.');

// ── Compute IBMs in the SCALED frame ────────────────────────────────
// IBM_i = inverse(scaleMatrix × bone_i.worldMatrix_unscaled)
// = inverse(bone_i.worldMatrix_unscaled) × inverse(scaleMatrix)
// We just multiply the bone's unscaled world matrix by scaleMatrix
// and invert the result — Three.js Matrix4 handles uniform scale +
// rigid composites cleanly.
const scaleMatrix = new THREE.Matrix4().makeScale(finalScale, finalScale, finalScale);
const ibmFloats = new Float32Array(MAJOR_BONES.length * 16);
for (let i = 0; i < MAJOR_BONES.length; i++) {
  const boneName = MAJOR_BONES[i];
  const data = worldByName.get(boneName);
  if (!data) throw new Error(`Missing world data for ${boneName}`);
  // bone.worldMatrix_scaled = scaleMatrix × bone.worldMatrix_unscaled
  const worldScaled = new THREE.Matrix4().multiplyMatrices(scaleMatrix, data.worldMatrix);
  const ibm = new THREE.Matrix4().copy(worldScaled).invert();
  ibmFloats.set(ibm.elements, i * 16);
}
console.log('IBMs computed.');

// ── Merge: copy everything from meshDoc INTO animDoc ────────────────
// After merge, the mesh's geometry + materials + textures live in
// animDoc alongside the existing bone tree + animation clip. The
// nodes referencing the mesh need to be wired up to a new Skin.
mergeDocuments(animDoc, meshDoc);
console.log('Docs merged.');

// ── Find the mesh primitive in the merged doc ───────────────────────
// After merge there should be exactly one mesh (the dancer); the
// anim doc had no meshes of its own.
const allMeshes = animDoc.getRoot().listMeshes();
if (allMeshes.length !== 1) {
  throw new Error(`Expected 1 mesh after merge, got ${allMeshes.length}`);
}
const dancerMesh = allMeshes[0];
const dancerPrim = dancerMesh.listPrimitives()[0];

// ── Build JOINTS_0 + WEIGHTS_0 accessors ────────────────────────────
const jointsAccessor = animDoc
  .createAccessor('JOINTS_0')
  .setType('VEC4')
  .setArray(joints0);
const weightsAccessor = animDoc
  .createAccessor('WEIGHTS_0')
  .setType('VEC4')
  .setArray(weights0);
dancerPrim.setAttribute('JOINTS_0', jointsAccessor);
dancerPrim.setAttribute('WEIGHTS_0', weightsAccessor);

// ── Build the inverse bind matrices accessor ───────────────────────
const ibmAccessor = animDoc
  .createAccessor('inverseBindMatrices')
  .setType('MAT4')
  .setArray(ibmFloats);

// ── Find the bone nodes in the merged doc by name ──────────────────
const allNodes = animDoc.getRoot().listNodes();
const boneNodes = MAJOR_BONES.map((name) => {
  const node = allNodes.find((n) => n.getName() === name);
  if (!node) throw new Error(`Bone node not found in merged doc: ${name}`);
  return node;
});

// ── Create the Skin ────────────────────────────────────────────────
const skin = animDoc.createSkin('dancerSkin');
skin.setInverseBindMatrices(ibmAccessor);
for (const bone of boneNodes) {
  skin.addJoint(bone);
}

// ── Find the dancer mesh's containing Node, attach the skin ────────
const dancerNode = allNodes.find((n) => n.getMesh() === dancerMesh);
if (!dancerNode) throw new Error('Mesh node not found in merged doc');
dancerNode.setSkin(skin);
// Also clear any local transform on the mesh node — we want its
// world transform to come entirely from its parent chain (the
// scaled skeleton root we set up below).
dancerNode.setTranslation([0, 0, 0]);
dancerNode.setRotation([0, 0, 0, 1]);
dancerNode.setScale([1, 1, 1]);

// ── Wrap everything in a fit-scale parent + consolidate scenes ─────
// After mergeDocuments we have 2 root Scenes (one from each source).
// We need exactly 1 Scene in the output, with a single parent Node
// carrying the fit×size scale, and everything else (bone tree + the
// mesh node) as that parent's children.
//
// scaleParent.scale = finalScale → at render time
// bone.matrixWorld = scaleMatrix × chain × bone_local, which matches
// the frame we used to compute IBMs above. Same goes for the mesh
// node — it gets the same scale, keeping mesh + skeleton aligned.
const allScenes = animDoc.getRoot().listScenes();
const primaryScene = allScenes[0];
const scaleParent = animDoc
  .createNode('dancerScaleRoot')
  .setScale([finalScale, finalScale, finalScale]);

// Pull every top-level node out of every existing scene and re-parent
// it under scaleParent. Then dispose of the secondary scene(s).
for (const scene of allScenes) {
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    scaleParent.addChild(child);
  }
  if (scene !== primaryScene) scene.dispose();
}
primaryScene.addChild(scaleParent);

// ── Consolidate to a single buffer ─────────────────────────────────
// GLB format requires exactly 0 or 1 buffer. After mergeDocuments
// we have 2 (one from each source GLB), plus our newly-created
// accessors are bufferless. Move everything onto the first buffer
// and drop the rest.
const allBuffers = animDoc.getRoot().listBuffers();
const primaryBuffer = allBuffers[0];
for (const accessor of animDoc.getRoot().listAccessors()) {
  accessor.setBuffer(primaryBuffer);
}
for (let i = 1; i < allBuffers.length; i++) {
  allBuffers[i].dispose();
}

// ── Save ───────────────────────────────────────────────────────────
await io.write('../public/models/dancer_animated.glb', animDoc);
console.log('Wrote ../public/models/dancer_animated.glb');
