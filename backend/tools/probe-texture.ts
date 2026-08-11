/**
 * 텍스처 출처 실측 — **실시간 3D 뷰에 텍스처를 입히려면 워커가 그 이미지에
 * 어떻게 닿는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-texture.ts
 *
 * 테스트가 아니다. `smoke.ts` 가 단언으로 회귀를 잡는 물건이고, 이건 워커의
 * `textures:true` 가 무엇을 돌려주는지 **눈으로 보는** 물건이다.
 * `probe-avatarmesh.ts` 와 같은 성격이다.
 *
 * ── 왜 재는가 ───────────────────────────────────────────────
 * 실시간 뷰는 흰 몸 + 단색 옷인데 스냅샷(glTF)에는 피부·눈·직물 무늬가 다
 * 나온다. 그 차이가 **텍스처**다. 그리고 스냅샷 glTF 34.9MB 중 27.7MB(79%)가
 * 텍스처인데 **체형을 바꿔도 텍스처는 안 바뀐다** — 즉 스냅샷은 안 바뀌는
 * 27.7MB 를 매번 다시 보낸다(갱신 6.3초). 실시간에 한 번만 실으면 이후
 * 체형 변경은 25ms 다. 그래서 "닿을 수 있는가"가 설계를 가른다.
 *
 * ── 갈래 셋 ─────────────────────────────────────────────────
 *   A. 디스크 파일 — 문자열이 실재하는 경로   → 게이트웨이가 서빙. 제일 쉽다
 *   B. 원시 데이터 — isRawData 가 참          → 워커가 base64 로 전송
 *   C. 다른 데     — 비었거나 없는 경로       → 어디서 오는지 추가 조사
 *
 * 아바타와 옷에서 갈래가 다를 수 있어 따로 판정한다.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

const EXE = 'native/build/Debug/zelusSandBoxd-demo.exe';
const SCENE = 'data/scenes/89b6c497c8d8365d0032e8a3b83e05bd.zls'; // = W_Bra top & Leggings

const { Worker } = await import('../src/sdk/index.ts');

/** 워커가 실어 보내는 텍스처 문자열 한 칸. 길면 앞부분만, 바이너리면 hex. */
interface TexString {
  len: number;
  head?: string;
  truncated?: boolean;
  binary?: boolean;
  hex?: string;
}

interface TexDump {
  isRawData: boolean;
  isInMemory: boolean;
  isCustom: boolean;
  isZipperFabric: boolean;
  useCustomBaseColor: boolean;
  flipTextures: boolean;
  physicalWidth: number;
  physicalHeight: number;
  vectors: Record<string, TexString[]>;
  paths: Record<string, TexString>;
}

const SLOTS = [
  'basecolor', 'roughness', 'specular', 'metalness', 'normal',
  'alpha', 'displacement', 'anisotropyAngle', 'occlusion',
] as const;

// ── 경로처럼 보이는 문자열을 디스크에서 찾아본다 ──────────────
//
// 엔진이 어느 기준으로 상대경로를 푸는지 모르므로 후보 뿌리를 여러 개 둔다.
// 하나라도 맞으면 갈래 A 다.
//
// ★ 가장 중요한 뿌리는 **appdata** 다. 씬 안에 들어 있던 직물(`fabric_infile/…`)이
//   로드 때 여기로 풀린다 — `zwMaterialManager.cpp:954` 가 쓰는
//   `ztAssetManager::GetAppdataRoot(true) + "fabric_infile/"` 와 같은 자리다.
//   그 뿌리는 `%LOCALAPPDATA%\z-emotion\<exe 이름>\` 이고, 워커 이름이
//   `zelusSandBoxd-demo` 라 데스크톱 앱과 섞이지 않는다.
const APPDATA_ROOT = resolve(
  process.env.LOCALAPPDATA ?? '', 'z-emotion', 'zelusSandBoxd-demo');

const ROOTS = [
  APPDATA_ROOT,                                                     // ★ 씬에서 풀린 직물 + 아바타 텍스처
  resolve('native/build/Debug'),                                    // exe 옆 (media·appdata 사본)
  resolve('native/build/Debug/media'),
  resolve('native/build/Debug/appdata'),
  resolve('../zelusSandBox_Cobalt/zelusSandBox'),                   // 회사 저장소 (읽기 전용)
  resolve('../zelusSandBox_Cobalt/zelusSandBox/media'),
  resolve('data/scenes'),                                           // 씬 옆
];

interface Resolved { path: string; bytes: number }

function resolveOnDisk(s: string): Resolved | null {
  const tryOne = (p: string): Resolved | null => {
    try {
      if (!existsSync(p)) return null;
      const st = statSync(p);
      return st.isFile() ? { path: p, bytes: st.size } : null;
    } catch { return null; }
  };

  if (isAbsolute(s)) return tryOne(s);
  for (const root of ROOTS) {
    const hit = tryOne(resolve(root, s));
    if (hit) return hit;
  }
  return null;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)}MB`;

/** 문자열 한 칸을 사람이 읽는 한 줄로. 경로면 디스크 확인 결과까지 붙인다. */
function describe(t: TexString | undefined): string {
  if (!t || t.len === 0) return '(빈 칸)';
  if (t.binary) return `⚑ 바이너리 ${t.len}B (${mb(t.len)})  hex: ${t.hex}`;

  const s = t.head ?? '';
  const shown = t.truncated ? `${s}…(총 ${t.len}자)` : s;

  const hit = resolveOnDisk(s);
  if (hit) return `${shown}\n        → ✅ 실재 ${mb(hit.bytes)}  ${hit.path}`;
  // 경로처럼 안 생긴 짧은 이름일 수도 있다 — 있는 그대로 보인다
  return `${shown}\n        → ❌ 디스크에서 못 찾음`;
}

/** 머티리얼 하나의 텍스처 덤프를 통째로 찍는다. */
function dump(label: string, tx: TexDump | undefined): void {
  if (!tx) { console.log(`  ${label}: textures 없음`); return; }

  console.log(`  ${label}`);
  console.log(`    플래그  isRawData=${tx.isRawData} isInMemory=${tx.isInMemory}`
    + ` isCustom=${tx.isCustom} zipper=${tx.isZipperFabric}`
    + ` useCustomBaseColor=${tx.useCustomBaseColor} flip=${tx.flipTextures}`
    + `  물리크기 ${tx.physicalWidth}×${tx.physicalHeight}cm`);

  for (const slot of SLOTS) {
    const v = tx.vectors[slot] ?? [];
    const nonEmpty = v.filter((x) => x.len > 0);
    const p = tx.paths[slot];
    const hasPath = (p?.len ?? 0) > 0;
    if (nonEmpty.length === 0 && !hasPath) continue;   // 빈 슬롯은 안 찍는다

    console.log(`    [${slot}] 벡터 ${v.length}칸 (내용 있는 칸 ${nonEmpty.length})`);
    v.forEach((x, i) => {
      if (x.len === 0) return;
      console.log(`      v[${i}] ${describe(x)}`);
    });
    if (hasPath) console.log(`      path  ${describe(p)}`);
  }
}

/** 갈래 판정 — 모은 덤프들에서 A/B/C 를 고른다. */
function verdict(name: string, all: TexDump[]): void {
  const raw = all.filter((t) => t.isRawData).length;
  let onDisk = 0, missing = 0, empty = 0, binary = 0;

  for (const t of all) {
    for (const slot of SLOTS) {
      for (const x of t.vectors[slot] ?? []) {
        if (x.len === 0) { empty++; continue; }
        if (x.binary) { binary++; continue; }
        if (resolveOnDisk(x.head ?? '')) onDisk++; else missing++;
      }
      const p = t.paths[slot];
      if (p && p.len > 0) { if (!p.binary && resolveOnDisk(p.head ?? '')) onDisk++; else missing++; }
    }
  }

  console.log(`\n${name}: 머티리얼 ${all.length}개 · isRawData 참 ${raw}개`);
  console.log(`  칸 집계 — 빈칸 ${empty} / 디스크에 실재 ${onDisk} / 못 찾음 ${missing} / 바이너리 ${binary}`);

  let v: string;
  if (binary > 0 || raw > 0)      v = 'B. 원시 데이터 — 워커가 base64 로 전송해야 한다';
  else if (onDisk > 0 && missing === 0) v = 'A. 디스크 파일 — 게이트웨이 서빙 + 브라우저 캐시';
  else if (onDisk > 0)            v = 'A/C 혼합 — 일부만 디스크에 있다';
  else                            v = 'C. 다른 데 — 이 구조체로는 이미지에 닿지 못한다';
  console.log(`  ⇒ 갈래 ${v}`);
}

// ── 실행 ─────────────────────────────────────────────────────

const w = Worker.spawn({ exePath: EXE });
await new Promise<void>((r) => w.on('ready', () => r()));

await w.request('init');

// ── ⓪ 로드가 파일을 푸는가 ───────────────────────────────────
//
// 씬 안 직물이 appdata 로 풀린다면 **로드 때** 풀려야 한다. 로드 전후로 같은
// 파일의 mtime 을 재서 확인한다 — 두 번째 실행부터는 파일이 이미 있으므로
// "존재한다"만으로는 누가 언제 썼는지 알 수 없다.
const witness = resolve(APPDATA_ROOT, 'fabric_infile');
const stamp = (): string => {
  try {
    const st = statSync(witness);
    return st.mtime.toISOString();
  } catch { return '(없음)'; }
};
const beforeStamp = stamp();

console.log('씬을 로드하는 중… (138MB)');
console.log('load →', JSON.stringify(await w.request('load', { path: SCENE })));

console.log(`\n⓪ ${witness}`);
console.log(`   로드 전 mtime ${beforeStamp}`);
console.log(`   로드 후 mtime ${stamp()}   ← 달라지면 로드가 씬에서 푼 것이다`);

// ── ① 아바타 ─────────────────────────────────────────────────
console.log('\n=== ① 아바타 파트의 텍스처 필드 ===');

const av = await w.request<any>('avatarMesh',
  { topology: true, normals: false, textures: true });

const avatarTx: TexDump[] = [];
for (const a of av.avatars ?? []) {
  console.log(`\n[${a.subType}] ${a.uuid}  파트 ${a.parts.length}개`);
  for (const p of a.parts) {
    const tx = p.material?.textures as TexDump | undefined;
    if (tx) avatarTx.push(tx);
    const c = p.material?.color;
    const colorStr = c ? `색 [${c.map((x: number) => x.toFixed(3)).join(', ')}]` : '색 없음';
    dump(`파트 ${p.index} "${p.name}"  ${colorStr}`, tx);
  }
}

// ── ② 옷 ─────────────────────────────────────────────────────
console.log('\n=== ② 옷(패턴) 재질의 텍스처 필드 ===');

const cloth = await w.request<any>('meshData', { topology: true, textures: true });

// 패턴은 24개인데 직물 에셋은 2개다(노랑 16 / 민트 8). 같은 fabricUuid 는
// 한 번만 찍는다 — 같은 것을 24번 보면 무엇이 다른지 안 보인다.
const seen = new Map<string, TexDump>();
const clothTx: TexDump[] = [];
for (const p of cloth.patterns ?? []) {
  const tx = p.material?.textures as TexDump | undefined;
  if (!tx) continue;
  clothTx.push(tx);
  const key = p.material.fabricUuid as string;
  if (seen.has(key)) continue;
  seen.set(key, tx);

  const c = p.material.color;
  console.log(`\n[직물 ${key}] 색 [${c.map((x: number) => x.toFixed(3)).join(', ')}]`
    + `  (이 직물을 쓰는 패턴: ${(cloth.patterns as any[])
        .filter((q) => q.material?.fabricUuid === key).length}개)`);
  dump('front material', tx);
}

// ── ③ 판정 ───────────────────────────────────────────────────
console.log('\n=== ③ 갈래 판정 ===');
verdict('아바타', avatarTx);
verdict('옷', clothTx);

// ── ④ 크기 감각 ──────────────────────────────────────────────
//
// 갈래 A 라면 "게이트웨이가 몇 MB 를 서빙해야 하는가", B 라면 "워커 응답이
// 얼마나 커지는가"가 다음 판단의 입력이다. 중복 제거 후의 합을 낸다.
console.log('\n=== ④ 실제로 필요한 이미지 총량 ===');
const uniq = new Map<string, number>();
let rawBytes = 0;
for (const t of [...avatarTx, ...clothTx]) {
  for (const slot of SLOTS) {
    for (const x of t.vectors[slot] ?? []) {
      if (x.len === 0) continue;
      if (x.binary) { rawBytes += x.len; continue; }
      const hit = resolveOnDisk(x.head ?? '');
      if (hit) uniq.set(hit.path, hit.bytes);
    }
  }
}
if (uniq.size > 0) {
  let sum = 0;
  for (const [p, b] of [...uniq].sort((a, b) => b[1] - a[1])) {
    sum += b;
    console.log(`  ${mb(b).padStart(8)}  ${p}`);
  }
  console.log(`  ── 고유 파일 ${uniq.size}개 합계 ${mb(sum)}`);
} else {
  console.log('  디스크에서 찾은 이미지가 없다.');
}
if (rawBytes > 0) console.log(`  원시 데이터 합계 ${mb(rawBytes)}`);

await w.request('quit').catch(() => {});
setTimeout(() => process.exit(0), 300);
