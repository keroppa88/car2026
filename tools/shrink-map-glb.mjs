// GLBのテクスチャを用途別に縮小してJPEG化する。メッシュ・マテリアル構成は変更しない。
//   使い方: node tools/shrink-map-glb.mjs <入力glb...> --out <出力フォルダ>
//   既存 map/*.glb（2026-07-30版）と同じ縮小率・同じJPEG設定を再現する。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const PYTHON = 'C:/Users/kaika/anaconda3/python.exe';

// 用途ごとの縮小率とJPEG品質。1x1 は「実質使わないので潰す」の意味。
const RULES = {
  baseColor: { divisor: 2, quality: 82 },
  normal: { divisor: 2, quality: 89 },
  occlusion: { divisor: 4, quality: 82 },
  metallicRoughness: { divisor: 4, quality: 82 },
  specularGlossiness: { divisor: 0, quality: 82 },
  unknown: { divisor: 2, quality: 82 },
};
// 同じ画像が複数の用途で参照されていたら、縮小の弱いほうを採用する
const PRIORITY = ['baseColor', 'normal', 'metallicRoughness', 'occlusion', 'specularGlossiness', 'unknown'];

function readGlb(file) {
  const glb = fs.readFileSync(file);
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: invalid GLB`);
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/\0+$/u, '').trimEnd());
    else if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error(`${file}: JSON/BIN chunk missing`);
  return { json, binary };
}

function writeGlb(file, json, binary) {
  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonChunk.length % 4) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(4 - (jsonChunk.length % 4), 0x20)]);
  let binChunk = binary;
  if (binChunk.length % 4) binChunk = Buffer.concat([binChunk, Buffer.alloc(4 - (binChunk.length % 4), 0)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]));
}

// マテリアルの参照をたどって各画像の用途を決める
function classifyImages(json) {
  const roles = new Array((json.images ?? []).length).fill(null);
  const assign = (texRef, role) => {
    if (!texRef || texRef.index === undefined) return;
    const source = json.textures?.[texRef.index]?.source;
    if (source === undefined) return;
    const current = roles[source];
    if (current === null || PRIORITY.indexOf(role) < PRIORITY.indexOf(current)) roles[source] = role;
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    assign(pbr.baseColorTexture, 'baseColor');
    assign(pbr.metallicRoughnessTexture, 'metallicRoughness');
    assign(material.normalTexture, 'normal');
    assign(material.occlusionTexture, 'occlusion');
    assign(material.emissiveTexture, 'baseColor');
    const sg = material.extensions?.KHR_materials_pbrSpecularGlossiness;
    if (sg) {
      assign(sg.diffuseTexture, 'baseColor');
      assign(sg.specularGlossinessTexture, 'specularGlossiness');
    }
  }
  return roles.map((role) => role ?? 'unknown');
}

const pyScript = `
import sys, json
from PIL import Image
jobs = json.load(open(sys.argv[1], encoding='utf-8'))
for job in jobs:
    im = Image.open(job['src'])
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB') if im.mode != 'LA' else im.convert('L')
    if job['divisor'] == 0:
        im = im.resize((1, 1), Image.BOX)
    elif job['divisor'] > 1:
        w = max(1, im.width // job['divisor'])
        h = max(1, im.height // job['divisor'])
        im = im.resize((w, h), Image.LANCZOS)
    im.save(job['dst'], 'JPEG', quality=job['quality'], progressive=True, optimize=True)
`;

function shrink(file, outDir) {
  const { json, binary } = readGlb(file);
  const roles = classifyImages(json);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'glbshrink-'));
  const jobs = [];

  (json.images ?? []).forEach((image, index) => {
    if (image.bufferView === undefined) return;
    const view = json.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    const data = binary.subarray(start, start + view.byteLength);
    const ext = image.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const src = path.join(work, `${index}${ext}`);
    const dst = path.join(work, `${index}_out.jpg`);
    fs.writeFileSync(src, data);
    const rule = RULES[roles[index]];
    jobs.push({ index, src, dst, divisor: rule.divisor, quality: rule.quality, role: roles[index], before: view.byteLength });
  });

  const jobFile = path.join(work, 'jobs.json');
  fs.writeFileSync(jobFile, JSON.stringify(jobs));
  const scriptFile = path.join(work, 'convert.py');
  fs.writeFileSync(scriptFile, pyScript);
  execFileSync(PYTHON, [scriptFile, jobFile], { stdio: 'inherit' });

  const replacement = new Map();
  for (const job of jobs) {
    const out = fs.readFileSync(job.dst);
    replacement.set(job.index, out);
  }

  // 画像bufferViewを差し替えてバッファを積み直す
  const imageViewOf = new Map();
  (json.images ?? []).forEach((image, index) => {
    if (image.bufferView !== undefined) imageViewOf.set(image.bufferView, index);
  });

  const chunks = [];
  let cursor = 0;
  json.bufferViews.forEach((view, viewIndex) => {
    const imageIndex = imageViewOf.get(viewIndex);
    let data;
    if (imageIndex !== undefined) {
      data = replacement.get(imageIndex);
      json.images[imageIndex].mimeType = 'image/jpeg';
    } else {
      const start = view.byteOffset ?? 0;
      data = binary.subarray(start, start + view.byteLength);
    }
    if (cursor % 4) {
      const pad = 4 - (cursor % 4);
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    view.byteOffset = cursor;
    view.byteLength = data.length;
    chunks.push(data);
    cursor += data.length;
  });

  const newBinary = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBinary.length }];
  const outFile = path.join(outDir, path.basename(file));
  writeGlb(outFile, json, newBinary);
  fs.rmSync(work, { recursive: true, force: true });

  const before = fs.statSync(file).size;
  const after = fs.statSync(outFile).size;
  console.log(`${path.basename(file)}: ${(before / 1048576).toFixed(2)}MB -> ${(after / 1024).toFixed(0)}KB (${(before / after).toFixed(1)}x)`);
  for (const job of jobs) {
    const out = replacement.get(job.index);
    console.log(`   [${job.index}] ${job.role} ${(job.before / 1024).toFixed(0)}KB -> ${(out.length / 1024).toFixed(0)}KB`);
  }
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : '.';
const inputs = args.filter((value, index) => index !== outIndex && index !== outIndex + 1);
fs.mkdirSync(outDir, { recursive: true });
for (const input of inputs) shrink(input, outDir);
