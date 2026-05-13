// Fix the cm/m units bug from ImageToStl.com's FBX→GLB conversion.
// The mesh vertices come out in metres but bones + IBMs + animation
// translation keyframes stay in centimetres. Multiplying the bone-
// side translations by 0.01 makes the whole rig internally consistent
// in metres.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import path from 'node:path';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node fix_units.mjs <input.glb> <output.glb>');
  process.exit(1);
}

const SCALE = 0.01;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inputPath);
const root = doc.getRoot();

// 1) Scale ALL node translations. Bones get rescaled; the mesh
// nodes are at origin so 0 * 0.01 = 0 (no-op for them).
for (const node of root.listNodes()) {
  const t = node.getTranslation();
  node.setTranslation([t[0] * SCALE, t[1] * SCALE, t[2] * SCALE]);
}

// 2) Scale the translation column of every inverse bind matrix.
// glTF stores 4x4 matrices column-major: [m00,m01,m02,m03,
// m10,m11,m12,m13, m20,m21,m22,m23, m30,m31,m32,m33]. The
// translation column is the FOURTH column → indices 12,13,14
// within each 16-float block.
for (const skin of root.listSkins()) {
  const ibm = skin.getInverseBindMatrices();
  if (!ibm) continue;
  const src = ibm.getArray();
  if (!src) continue;
  const out = new Float32Array(src);
  for (let i = 0; i < out.length; i += 16) {
    out[i + 12] *= SCALE;
    out[i + 13] *= SCALE;
    out[i + 14] *= SCALE;
  }
  ibm.setArray(out);
}

// 3) Scale every animation translation keyframe by 0.01. We don't
// touch rotation or scale channels — those are unit-less. The
// translation sampler's output has 3 floats per keyframe (or 9
// for CUBICSPLINE: in-tangent + value + out-tangent), and scaling
// linearly works for both since tangents scale with values.
let translationChannels = 0;
for (const anim of root.listAnimations()) {
  for (const channel of anim.listChannels()) {
    if (channel.getTargetPath() !== 'translation') continue;
    const sampler = channel.getSampler();
    if (!sampler) continue;
    const output = sampler.getOutput();
    if (!output) continue;
    const src = output.getArray();
    if (!src) continue;
    const out = new Float32Array(src);
    for (let i = 0; i < out.length; i++) out[i] *= SCALE;
    output.setArray(out);
    translationChannels++;
  }
}

await io.write(outputPath, doc);
console.log(
  `OK — wrote ${path.basename(outputPath)} with ` +
    `${root.listNodes().length} nodes rescaled, ` +
    `${root.listSkins().length} skin IBM(s) rescaled, ` +
    `${translationChannels} animation translation channel(s) rescaled.`,
);
