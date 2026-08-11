/**
 * 아바타 메시 실측 (AM-1) — **몸이 나오는가, 그리고 어느 좌표계로 나오는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-avatarmesh.ts
 *
 * 테스트가 아니다. `smoke.ts` 가 단언으로 회귀를 잡는 물건이고, 이건 새 op
 * (`avatarMesh`)이 무엇을 돌려주는지 **눈으로 보고 전제를 재는** 물건이다.
 * `probe-avatar.ts` 와 같은 성격이다.
 *
 * ── 재는 것 넷 ──────────────────────────────────────────────
 *   ① 아바타·파트·정점·삼각형이 실제로 나오는가
 *   ② 크기 — 요청 조합별 응답 바이트
 *   ③ ★ **좌표계** — 월드인가 로컬인가. ISSUE-011 이 정확히 이 함정이었다
 *   ④ 체형을 바꾸면 정점이 실제로 달라지는가 (이 단위의 존재 이유)
 *
 * ── ③ 을 가르는 법 ─────────────────────────────────────────
 * 이 프로젝트의 확립된 방법은 **glTF 익스포트와 대조**하는 것이다. 익스포트
 * 산출물에는 노드 변환이 박혀 있으므로 그것이 정답지다.
 *
 * ⚠️ **박스만 비교하면 안 된다.** ISSUE-011 때 쿼터니언을 `[w,x,y,z]` 로
 *    잘못 읽어도 AABB 는 0.036cm 밖에 안 흔들려서 통과했다. 그래서 여기서는
 *    **정점 하나하나를 같은 순서로 대조**한다(최대 오차를 낸다).
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Worker } from '../src/sdk/index.ts';
import type { AvatarMeshResult } from '../src/sdk/protocol.ts';

const EXE = 'native/build/Debug/zelusSandBoxd-demo.exe';
const SCENE = 'data/incoming/W_Bra top & Leggings.zls';

const f = (n: number): string => n.toFixed(3);
const kb = (n: number): string => `${(n / 1024).toFixed(1)}KB`;

/** base64 → Float32Array. 워커가 float3 로 촘촘히 포장해 보낸다 */
const f32 = (b64: string): Float32Array => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

const w = Worker.spawn({ exePath: EXE });
await new Promise<void>((r) => w.on('ready', () => r()));

await w.request('init');
console.log('씬을 로드하는 중… (138MB)');
console.log('load →', JSON.stringify(await w.request('load', { path: SCENE })));

// ── ① 나오는가 ───────────────────────────────────────────────
console.log('\n=== ① avatarMesh(topology:true, normals:true) ===');
const t0 = Date.now();
const full = await w.request<AvatarMeshResult>('avatarMesh', { topology: true, normals: true });
const fullMs = Date.now() - t0;

console.log(`아바타 ${full.avatars.length}개 · 정점 ${full.totalVertices} · 삼각형 ${full.totalTriangles} · ${fullMs}ms`);

if (full.avatars.length === 0) {
  console.log('⛔ 아바타가 하나도 안 나왔다. 여기서 멈춘다.');
  await w.request('quit').catch(() => {});
  setTimeout(() => process.exit(1), 300);
}

for (const a of full.avatars) {
  console.log(`\n[${a.subType}] ${a.uuid}  current=${a.current}`);
  console.log(`  animation=${a.animation} time=${f(a.animationTime)} frameInfo=[${a.frameInfo.join(', ')}]`
    + `  → 끝났나: ${a.frameInfo[0] + 1 >= a.frameInfo[1]}`);
  if (a.bounds) {
    console.log(`  bounds(cm) min=[${a.bounds.min.map(f).join(', ')}] max=[${a.bounds.max.map(f).join(', ')}]`);
    const size = a.bounds.max.map((v, i) => v - a.bounds!.min[i]!);
    console.log(`  크기(cm)   ${size.map(f).join(' × ')}   ← 사람 키가 여기 보여야 한다`);
  }

  console.log(`  파트 ${a.parts.length}개`);
  console.log(`    ${'idx'.padEnd(4)}${'name'.padEnd(10)}${'verts'.padEnd(8)}${'tris'.padEnd(8)}pos/nrm/idx/uv/mat`);
  for (const p of a.parts) {
    const flags = [
      p.positions ? 'P' : '-',
      p.normals ? 'N' : '-',
      p.indices ? 'I' : '-',
      p.uvs ? 'U' : '-',
      p.material ? 'M' : '-',
    ].join('');
    console.log(`    ${String(p.index).padEnd(4)}${p.name.padEnd(10)}${String(p.vertices).padEnd(8)}${String(p.triangles).padEnd(8)}${flags}`);
  }

  // 머티리얼 (피부색). 화면이 몸을 무슨 색으로 칠할지의 출처다.
  const withMat = a.parts.filter((p) => p.material);
  if (withMat.length > 0) {
    console.log(`  머티리얼 ${withMat.length}개`);
    for (const p of withMat) {
      const m = p.material!;
      console.log(`    ${p.name.padEnd(10)} rgb=[${m.color.map((c) => c.toFixed(4)).join(', ')}]`
        + ` ${m.colorProfile} a=${f(m.opacity)} rough=${f(m.roughness)} metal=${f(m.metalness)}`);
    }
  }

  // ⚠️ 쓰레기 정점 검사 — 워커의 bounds 는 **인덱스가 가리키는 정점만** 센다.
  //    전체 정점으로 잰 상자와 다르면 참조되지 않는 정점이 섞여 있다는 뜻이고,
  //    화면이 positions 전체로 상자를 다시 재면 카메라가 어긋난다.
  for (const p of a.parts) {
    if (!p.positions || !a.bounds) continue;
    const pos = f32(p.positions);
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, pos[i + k]!);
        hi[k] = Math.max(hi[k]!, pos[i + k]!);
      }
    }
    const outside = lo.some((v, k) => v < a.bounds!.min[k]! - 1e-3)
      || hi.some((v, k) => v > a.bounds!.max[k]! + 1e-3);
    if (outside) {
      console.log(`  ⚠️ ${p.name}: 인덱스가 안 가리키는 정점이 상자 밖에 있다`
        + ` all=[${lo.map(f).join(',')}]~[${hi.map(f).join(',')}]`);
    }
  }
}

// ── ② 크기 ───────────────────────────────────────────────────
console.log('\n=== ② 응답 크기 (요청 조합별) ===');
const sizeOf = async (topology: boolean, normals: boolean): Promise<number> => {
  const t = Date.now();
  const r = await w.request<AvatarMeshResult>('avatarMesh', { topology, normals });
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  topology=${String(topology).padEnd(5)} normals=${String(normals).padEnd(5)} → ${kb(bytes).padStart(9)}  ${Date.now() - t}ms`);
  return bytes;
};
await sizeOf(true, true);
await sizeOf(true, false);
await sizeOf(false, true);
const liteBytes = await sizeOf(false, false);

// 비교 기준: 옷 한 프레임
const cloth = await w.request<{ patterns: unknown[] }>('meshData', { topology: false });
const clothBytes = Buffer.byteLength(JSON.stringify(cloth));
console.log(`  (비교) meshData topology=false → ${kb(clothBytes)}  = 옷 한 프레임`);
console.log(`  아바타 최소본이 옷 프레임의 ${(liteBytes / clothBytes).toFixed(1)}배`);

// ── ③ ★ 좌표계 — glTF 와 정점 단위로 대조 ─────────────────────
console.log('\n=== ③ 좌표계 — glTF 익스포트와 정점 단위 대조 ===');

const GLTF = 'data/probe-avatarmesh.gltf';
await w.request('export', { path: GLTF, format: 'gltf' });

interface GltfAccessor { bufferView: number; componentType: number; count: number; type: string; byteOffset?: number; min?: number[]; max?: number[] }
interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number }
interface GltfBuffer { uri?: string; byteLength: number }
interface GltfNode { name?: string; mesh?: number; scale?: number[]; translation?: number[]; rotation?: number[]; children?: number[] }
interface GltfDoc {
  nodes: GltfNode[];
  meshes: { name?: string; primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  buffers: GltfBuffer[];
}

if (!existsSync(GLTF)) {
  console.log(`⛔ 익스포트 산출물이 없다: ${GLTF}`);
} else {
  console.log(`  ${GLTF} — ${kb(statSync(GLTF).size)}`);
  const doc = JSON.parse(readFileSync(GLTF, 'utf8')) as GltfDoc;
  const base = dirname(resolve(GLTF));

  const bufBytes = new Map<number, Buffer>();
  const loadBuffer = (i: number): Buffer | null => {
    if (bufBytes.has(i)) return bufBytes.get(i)!;
    const uri = doc.buffers[i]?.uri;
    if (!uri) return null;
    let out: Buffer;
    if (uri.startsWith('data:')) {
      out = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    } else {
      const p = resolve(base, decodeURIComponent(uri));
      if (!existsSync(p)) return null;
      out = readFileSync(p);
    }
    bufBytes.set(i, out);
    return out;
  };

  const readVec3 = (accessorIdx: number): Float32Array | null => {
    const acc = doc.accessors[accessorIdx];
    if (!acc || acc.type !== 'VEC3' || acc.componentType !== 5126) return null;
    const view = doc.bufferViews[acc.bufferView];
    if (!view) return null;
    const buf = loadBuffer(view.buffer);
    if (!buf) return null;
    const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out = new Float32Array(acc.count * 3);
    for (let i = 0; i < acc.count * 3; i++) out[i] = buf.readFloatLE(off + i * 4);
    return out;
  };

  // 루트 노드의 스케일. 익스포터가 cm→m 로 0.01 을 여기 건다.
  const root = doc.nodes.find((n) => (n.children?.length ?? 0) > 0);
  console.log(`  루트 노드 scale = ${JSON.stringify(root?.scale)}  (cm→m 이면 0.01)`);

  // ⚠️ 익스포터가 이름 뒤에 파트 인덱스를 붙인다 — `zeta_body0`, `zeta_body1`…
  //    (`zwGltfExporterImpl.cpp` 의 ExportData 가 meshPartIndex 를 이어 붙인다).
  //    정확히 일치로 찾으면 0개가 나온다. 실제로 첫 실행에서 그랬다.
  const avatarNodes = doc.nodes.filter(
    (n) => n.name?.startsWith('zeta_body') || n.name?.startsWith('mannequin'),
  );
  const accessoryNodes = doc.nodes.filter((n) => n.name?.startsWith('zeta_accessory'));
  console.log(`  아바타 노드 ${avatarNodes.length}개 (zeta_body / mannequin)`);
  // ⓘ 액세서리(머리카락 등)는 이 op 이 **안 싣는다.** 익스포트에는 들어간다.
  if (accessoryNodes.length > 0) {
    console.log(`  ⓘ glTF 에는 액세서리 노드가 ${accessoryNodes.length}개 더 있다`
      + ` (${accessoryNodes.map((n) => n.name).join(', ')}) — avatarMesh 는 안 싣는다`);
  }

  // ⚠️ 노드 변환이 항등이 아니면 우리가 변환을 빠뜨린 것이다.
  const nonIdentity = avatarNodes.filter(
    (n) =>
      (n.translation?.some((v) => Math.abs(v) > 1e-9) ?? false)
      || (n.scale?.some((v) => Math.abs(v - 1) > 1e-9) ?? false)
      || (n.rotation?.slice(0, 3).some((v) => Math.abs(v) > 1e-9) ?? false),
  );
  console.log(
    nonIdentity.length === 0
      ? '  ✅ 아바타 노드 변환이 전부 항등 — 정점이 이미 월드다'
      : `  ⛔ 항등이 아닌 아바타 노드 ${nonIdentity.length}개: ${JSON.stringify(nonIdentity[0])}`,
  );

  // 우리 파트와 정점 단위로 대조한다. 익스포터도 우리와 같은 순서로
  // GetRenderMeshs() 를 돌므로 순서가 맞아야 한다.
  const ours = full.avatars.flatMap((a) => a.parts);
  const mine = ours.filter((p) => p.positions);

  console.log(`  워커 파트 ${mine.length}개 ↔ glTF 아바타 노드 ${avatarNodes.length}개`);

  let worst = 0;
  let worstWhere = '';
  let compared = 0;

  for (let i = 0; i < Math.min(mine.length, avatarNodes.length); i++) {
    const node = avatarNodes[i]!;
    const mesh = doc.meshes[node.mesh ?? -1];
    const posAcc = mesh?.primitives[0]?.attributes['POSITION'];
    if (posAcc === undefined) continue;
    const gp = readVec3(posAcc);
    const mp = f32(mine[i]!.positions!);
    if (!gp) {
      console.log(`    [${i}] ${mine[i]!.name}: glTF 버퍼를 못 읽었다 (uri=${doc.buffers[0]?.uri?.slice(0, 40)})`);
      continue;
    }
    if (gp.length !== mp.length) {
      console.log(`    [${i}] ${mine[i]!.name}: 정점 수가 다르다 — 워커 ${mp.length / 3} / glTF ${gp.length / 3}`);
      continue;
    }
    let d = 0;
    let at = 0;
    for (let k = 0; k < mp.length; k++) {
      const e = Math.abs(mp[k]! - gp[k]!);
      if (e > d) { d = e; at = k; }
    }
    compared++;
    if (d > worst) { worst = d; worstWhere = `${mine[i]!.name}[v${Math.floor(at / 3)}]`; }
    console.log(`    [${i}] ${mine[i]!.name.padEnd(10)} 정점 ${String(mp.length / 3).padStart(6)}  최대오차 ${d.toExponential(2)}cm`);
  }

  console.log(
    compared > 0 && worst < 1e-3
      ? `  ✅ 정점 ${compared}파트가 glTF 와 일치 (최대 ${worst.toExponential(2)}cm) — **월드 좌표다. 변환을 곱하면 안 된다**`
      : `  ⛔ 어긋난다 — 최대 ${worst.toExponential(2)}cm @ ${worstWhere} (대조 ${compared}파트)`,
  );
}

// ── ④ 체형을 바꾸면 정점이 달라지는가 ────────────────────────
console.log('\n=== ④ 체형 변경이 메시를 바꾸는가 (이 단위의 존재 이유) ===');

interface Body { hasAvatar: boolean; measurements?: Record<string, { real: number }> }
const body = await w.request<Body>('avatarBody');
const waist = body.measurements?.['WaistCircum']?.real;

if (waist === undefined) {
  console.log('⛔ WaistCircum 을 못 읽었다. 건너뛴다.');
} else {
  const want = waist + 8;
  console.log(`  WaistCircum ${f(waist)} → ${f(want)} cm  (Release 아님 — Debug 는 9배 느리다)`);

  const t = Date.now();
  const r = await w.request<{ applied: string[]; steps: number; simSteps: number }>(
    'setAvatarMeasurements',
    { measurements: { WaistCircum: want }, simulationIterations: 2, bodyDimensionStepCm: 4 },
  );
  console.log(`  applied=${JSON.stringify(r.applied)} steps=${r.steps} simSteps=${r.simSteps}  ${Date.now() - t}ms`);

  const after = await w.request<AvatarMeshResult>('avatarMesh', { topology: false, normals: false });

  const before = full.avatars[0]!;
  const now = after.avatars[0]!;

  console.log(`  정점 수: ${before.vertices} → ${now.vertices}`
    + (before.vertices === now.vertices ? '  (같다 = 토폴로지 불변)' : '  ⚠️ 달라졌다 — topology 를 다시 받아야 한다'));

  if (before.bounds && now.bounds) {
    const db = now.bounds.min.map((v, i) => v - before.bounds!.min[i]!);
    const dt = now.bounds.max.map((v, i) => v - before.bounds!.max[i]!);
    console.log(`  bounds Δmin=[${db.map(f).join(', ')}] Δmax=[${dt.map(f).join(', ')}]`);
  }

  let maxD = 0;
  let moved = 0;
  let total = 0;
  for (let i = 0; i < Math.min(before.parts.length, now.parts.length); i++) {
    const a = before.parts[i]!;
    const b = now.parts[i]!;
    if (!a.positions || !b.positions || a.vertices !== b.vertices) continue;
    const pa = f32(a.positions);
    const pb = f32(b.positions);
    for (let k = 0; k < pa.length; k += 3) {
      total++;
      const d = Math.hypot(pb[k]! - pa[k]!, pb[k + 1]! - pa[k + 1]!, pb[k + 2]! - pa[k + 2]!);
      if (d > 1e-4) moved++;
      if (d > maxD) maxD = d;
    }
  }
  console.log(`  움직인 정점 ${moved}/${total} (${((moved / Math.max(total, 1)) * 100).toFixed(1)}%) · 최대 ${f(maxD)}cm`);
  console.log(
    moved > 0
      ? '  ✅ 체형이 아바타 메시를 실제로 바꾼다 — 화면이 이 op 을 다시 부르면 몸이 바뀐다'
      : '  ⛔ 정점이 하나도 안 움직였다 — 화면을 갱신해도 같은 몸이 나온다',
  );

  // ⚠️ 씬 상태를 되돌린다. `.zls` 는 안 바뀌므로 재로드로 복구된다.
  console.log('\n  씬을 되돌리는 중 (재로드)…');
  await w.request('load', { path: SCENE });
  const restored = await w.request<Body>('avatarBody');
  const back = restored.measurements?.['WaistCircum']?.real;
  console.log(`  WaistCircum 복구: ${f(back ?? NaN)}  (원래 ${f(waist)})`);
}

await w.request('quit').catch(() => {});
setTimeout(() => process.exit(0), 500);
