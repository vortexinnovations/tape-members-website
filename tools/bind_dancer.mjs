// Procedurally bind the Tripo3D static-mesh dancer to the Mixamo
// skeleton + animation from "Arms Hip Hop Dance.fbx".
//
// Approach:
//   1. Load both GLBs.
//   2. Compute the Mixamo skeleton's T-pose world positions via FK.
//   3. Define a "skin-eligible" subset of 20 major bones (drop fingers
//      + toes — they're noisy + the dance doesn't animate them).
//   4. Define per-bone "segments" (bone origin → child's origin)
//      that we'll use for vertex-to-bone distance.
//   5. Compute an affine fit between the Mixamo skeleton's bbox
//      and the Tripo mesh's bbox (uniform scale + Y offset).
//   6. For each Tripo vertex, compute its distance to each of the
//      20 fitted bone segments. Take the closest 4. Assign weights
//      as 1 / (d² + ε), normalized.
//   7. Build a new GLB:
//        - Base: copy of the anim GLB (already has skeleton + clip).
//        - Wrap the skeleton root in a parent Node carrying the
//          scale + offsetY transform so the fitted skeleton aligns
//          with the mesh in its native 1m-tall coordinate frame.
//        - Add a copy of the Tripo mesh (geometry + materials +
//          textures) into the doc.
//        - Add a Skin object listing the 20 bones + their
//          inverse-bind-matrices (computed from the fitted T-pose).
//        - Add a node that uses the mesh + skin (the SkinnedMesh).
//        - Add JOINTS_0 + WEIGHTS_0 vertex attributes from the
//          per-vertex weighting we just computed.
//   8. Write final GLB.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync, writeFileSync } from 'node:fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ── Load ───────────────────────────────────────────────────────────
const animDoc = await io.read('../public/models/dance_anim.glb');
const meshDoc = await io.read('../public/models/dancer_female.glb');

// ── Vec3/Quat helpers ──────────────────────────────────────────────
const vec3 = (x, y, z) => [x, y, z];
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vLen = (a) => Math.sqrt(vDot(a, a));

function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// ── Walk the anim doc's scene, compute world TRS for every node ───
const worldByName = new Map();
const animScene = animDoc.getRoot().listScenes()[0];
function walkAnim(node, parentPos, parentRot) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const tWorld = quatRotate(parentRot, t);
  const pos = vAdd(parentPos, tWorld);
  const rot = quatMul(parentRot, r);
  worldByName.set(node.getName(), { node, pos, rot });
  for (const child of node.listChildren()) walkAnim(child, pos, rot);
}
for (const top of animScene.listChildren()) {
  walkAnim(top, [0, 0, 0], [0, 0, 0, 1]);
}

// ── 20 major bones for skin weighting ──────────────────────────────
// Order matters — this is the joint index order in JOINTS_0.
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

// Bone segment definitions. Each segment is [bone, endpoint-bone]
// where the "endpoint" is the child bone whose world position
// defines the bone's terminal point. For tip bones (Head, Hand,
// Foot) we use HeadTop_End / a finger / ToeEnd as the endpoint —
// these are present in the Mixamo skeleton.
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

// Get unfitted bone world positions + segments (in anim's native scale).
const rawBones = MAJOR_BONES.map((name) => {
  const start = worldByName.get(name)?.pos;
  const endName = SEGMENT_ENDPOINTS[name];
  const end = worldByName.get(endName)?.pos;
  if (!start || !end) throw new Error(`Missing bone position for ${name} or ${endName}`);
  return { name, start, end };
});

// ── Compute Mixamo skeleton bbox (using major-bone positions) ─────
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

// ── Tripo mesh bbox + vertex extraction ────────────────────────────
const meshRoot = meshDoc.getRoot();
const meshObj = meshRoot.listMeshes()[0];
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

console.log('Skeleton bbox:', sklMin.map(v => v.toFixed(3)), 'to', sklMax.map(v => v.toFixed(3)));
console.log('Mesh bbox    :', meshMin.map(v => v.toFixed(3)), 'to', meshMax.map(v => v.toFixed(3)));

// ── Fit: scale skeleton uniformly to match mesh height, offset so feet align
const sklHeight = sklMax[1] - sklMin[1];
const meshHeight = meshMax[1] - meshMin[1];
const scale = meshHeight / sklHeight;
const offsetY = meshMin[1] - sklMin[1] * scale;
console.log(`Fit: scale=${scale.toFixed(4)}, offsetY=${offsetY.toFixed(4)}`);

// Fitted bone segments.
const fittedBones = rawBones.map(({ name, start, end }) => ({
  name,
  start: [start[0] * scale, start[1] * scale + offsetY, start[2] * scale],
  end: [end[0] * scale, end[1] * scale + offsetY, end[2] * scale],
}));

// ── Distance from point to line segment ────────────────────────────
function distToSegment(p, a, b) {
  const ab = vSub(b, a);
  const ap = vSub(p, a);
  const t = Math.max(0, Math.min(1, vDot(ap, ab) / vDot(ab, ab)));
  const closest = vAdd(a, vScale(ab, t));
  return vLen(vSub(p, closest));
}

// ── Per-vertex weighting ───────────────────────────────────────────
console.log(`Computing weights for ${vertCount} vertices...`);
const joints0 = new Uint16Array(vertCount * 4);
const weights0 = new Float32Array(vertCount * 4);
const EPS = 0.0005;
const distsTmp = new Array(MAJOR_BONES.length);
for (let v = 0; v < vertCount; v++) {
  const px = positions[v * 3];
  const py = positions[v * 3 + 1];
  const pz = positions[v * 3 + 2];
  const p = [px, py, pz];
  for (let b = 0; b < fittedBones.length; b++) {
    distsTmp[b] = { idx: b, d: distToSegment(p, fittedBones[b].start, fittedBones[b].end) };
  }
  distsTmp.sort((x, y) => x.d - y.d);
  // Top 4 inverse-square weights
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

// ── Save the JOINTS_0 + WEIGHTS_0 arrays + fit data to JSON+bin
// We'll consume these in the next step (rebuilding the GLB).
writeFileSync('../public/models/dance_skin_joints.bin', Buffer.from(joints0.buffer));
writeFileSync('../public/models/dance_skin_weights.bin', Buffer.from(weights0.buffer));
writeFileSync('../public/models/dance_skin_meta.json', JSON.stringify({
  vertCount,
  scale,
  offsetY,
  bones: MAJOR_BONES,
  fittedBones,
}, null, 2));
console.log('Wrote dance_skin_joints.bin, dance_skin_weights.bin, dance_skin_meta.json to public/models/');
