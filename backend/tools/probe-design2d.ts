/**
 * 디자인 기반 2D 실측 (D2-a) — **`atWorld` 가 정말 배치를 적용하는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-design2d.ts
 *
 * 테스트가 아니다. `probe-avatar.ts`·`probe-surface.ts` 와 같은 성격이다 —
 * 새 op `design2d` 가 무엇을 돌려주는지 눈으로 본다.
 *
 * ── ★ 이 프로브가 가르는 단 하나 ────────────────────────────
 *
 * `.zls` 를 직접 읽어 잰 사실: 제어점 909개의 범위가 **66.6 × 103.5cm** 인데
 * L-2a 가 잰 도면 전체는 **144.2 × 175.4cm** 다. 안 맞는다 = 커브가 패턴
 * 로컬 좌표라 각자 원점 근처에 겹쳐 있다는 뜻이다(#15 에서 `uvs` 가 정확히
 * 그랬다).
 *
 * 워커는 `CreateGeomCubicBezierCurve(uuid, atWorld=true)` 로 엔진에 배치를
 * 맡겼다. **그 플래그가 정말 배치를 적용하는지는 헤더로 알 수 없다.** 여기서
 * 범위를 재서 가른다:
 *
 *   ~66 × 103   → 로컬이다. atWorld 가 안 먹었다 → 화면에서 transform2d 를
 *                 곱해야 하고, #15 의 전치 함정이 되살아난다
 *   ~144 × 175  → 월드다. 전치 위험이 원리적으로 없다
 *
 * ⚠️ **박스만 보고 끝내지 않는다.** 이 프로젝트에서 세 번 데인 자리다
 *    (ISSUE-011 · #15 · L-2a). 범위가 맞아도 24개가 겹쳐 있을 수 있으므로
 *    **서피스별 상자의 겹침**을 따로 센다 — #15 가 82.2% → 2.5% 로 가른
 *    바로 그 판정이다.
 */

import { Worker } from '../src/sdk/index.ts';

const EXE = 'native/build/Release/zelusSandBoxd-demo.exe';
const SCENE = 'data/incoming/W_Bra top & Leggings.zls';

interface Curve { uuid: string; kind: string; isLine: boolean; cp: number[]; pts: number[] }
interface Surface { uuid: string; name: string; curves: Curve[] }
interface SeamPart { curve: string; surface: string; t0: number; t1: number; pts: number[] }
interface Seam { uuid: string; sides: SeamPart[][] }
interface Stitch { uuid: string; surface: string; color: number[]; curves: Curve[] }
interface Design2D { surfaces: Surface[]; seams: Seam[]; stitches: Stitch[] }

/** 점 배열의 상자. **박스가 아니라 점에서 만든다** — ISSUE-011 의 교훈 */
function box(pts: number[]) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!, y = pts[i + 1]!;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return { minx, maxx, miny, maxy };
}

const w = Worker.spawn({ exePath: EXE });
await new Promise<void>((r) => w.on('ready', () => r()));

await w.request('init');
console.log('씬을 로드하는 중… (138MB)');
await w.request('load', { path: SCENE });

const d = await w.request<Design2D>('design2d');

// ── ① 개수 ───────────────────────────────────────────────────
const allCurves = d.surfaces.flatMap((s) => s.curves);
const byKind = new Map<string, number>();
for (const c of allCurves) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);

console.log(`\n=== ① 개수 ===`);
console.log(`서피스 ${d.surfaces.length} · 커브 ${allCurves.length} · 봉제선 ${d.seams.length} · 스티치 ${d.stitches.length}`);
console.log(`커브 종류별:`);
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(n).padStart(4)}`);
}
// `.zls` 직접 실측과 대조한다. 어긋나면 op 이 일부를 빠뜨린 것이다.
console.log(`(.zls 직접 실측: 커브 280 · 봉제선 45 · 스티치 54 · 서피스 24)`);

// ── ② ★ 좌표계 ───────────────────────────────────────────────
const every = allCurves.flatMap((c) => c.pts);
if (every.length === 0) {
  console.log('\n⛔ 점이 하나도 없다. 여기서 끝난다.');
} else {
  const b = box(every);
  const wdt = b.maxx - b.minx;
  const hgt = b.maxy - b.miny;

  console.log(`\n=== ② ★ 좌표계 ===`);
  console.log(`  x: ${b.minx.toFixed(2)} .. ${b.maxx.toFixed(2)}   (폭  ${wdt.toFixed(2)} cm)`);
  console.log(`  y: ${b.miny.toFixed(2)} .. ${b.maxy.toFixed(2)}   (높이 ${hgt.toFixed(2)} cm)`);
  console.log(`  기준 — 로컬 66.6 × 103.5  /  월드(도면 전체) 144.2 × 175.4`);

  const nearLocal = Math.abs(wdt - 66.6) < 20 && Math.abs(hgt - 103.5) < 25;
  const nearWorld = Math.abs(wdt - 144.2) < 30 && Math.abs(hgt - 175.4) < 35;
  console.log(
    nearWorld ? '  ✅ 월드다 — atWorld 가 먹었다. 전치 함정이 원리적으로 없다'
    : nearLocal ? '  ⛔ 로컬이다 — atWorld 가 안 먹었다. 화면에서 transform2d 를 곱해야 한다'
    : '  ⚠️ 둘 다 아니다 — 예상 밖이다. 여기서 멈추고 사람이 볼 것',
  );

  // ── ③ 겹침 — 박스만 믿지 않는다 ────────────────────────────
  //
  // #15 의 판정을 그대로 쓴다. 24개가 각자 원점이면 서로 거의 다 겹치고,
  // 제대로 배치돼 있으면 AABB 쌍 겹침이 낮게 나온다.
  const boxes = d.surfaces
    .map((s) => ({ name: s.name, ...box(s.curves.flatMap((c) => c.pts)) }))
    .filter((x) => Number.isFinite(x.minx));

  let pairs = 0, overlap = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, c = boxes[j]!;
      pairs++;
      if (a.minx < c.maxx && c.minx < a.maxx && a.miny < c.maxy && c.miny < a.maxy) overlap++;
    }
  }
  console.log(`\n=== ③ 서피스 상자 겹침 ===`);
  console.log(`  ${overlap} / ${pairs} 쌍 = ${pairs ? ((overlap / pairs) * 100).toFixed(1) : '0'}%`);
  console.log(`  기준 — #15 실측: 로컬이면 82.2%, 배치가 맞으면 2.5%`);

  console.log(`\n  서피스별 상자 (앞 8개):`);
  for (const x of boxes.slice(0, 8)) {
    console.log(
      `    ${x.name.padEnd(20)} x ${x.minx.toFixed(1).padStart(7)}..${x.maxx.toFixed(1).padStart(7)}` +
      `   y ${x.miny.toFixed(1).padStart(7)}..${x.maxy.toFixed(1).padStart(7)}`,
    );
  }
}

// ── ④ 봉제선 ─────────────────────────────────────────────────
//
// 이미지의 점선이 이 대응이다. 양측이 **서로 다른 서피스**를 가리키는지가
// 핵심이다 — 같은 서피스끼리면 패턴 안쪽 봉제(다트 등)이고, 다르면 패턴을
// 가로지르는 선이 된다.
console.log(`\n=== ④ 봉제선 ${d.seams.length}개 ===`);
let cross = 0, within = 0, empty = 0;
for (const s of d.seams) {
  const a = s.sides[0]?.[0]?.surface;
  const b = s.sides[1]?.[0]?.surface;
  if (!a || !b) { empty++; continue; }
  if (a === b) within++; else cross++;
}
console.log(`  패턴을 가로지름 ${cross} · 같은 패턴 안 ${within} · 한쪽이 빔 ${empty}`);
for (const s of d.seams.slice(0, 5)) {
  const p0 = s.sides[0]?.[0], p1 = s.sides[1]?.[0];
  console.log(
    `  ${s.uuid.slice(0, 18).padEnd(20)} 측0 ${s.sides[0]?.length ?? 0}파트 t[${p0?.t0.toFixed(2)},${p0?.t1.toFixed(2)}]` +
    `  ↔  측1 ${s.sides[1]?.length ?? 0}파트 t[${p1?.t0.toFixed(2)},${p1?.t1.toFixed(2)}]`,
  );
}
// 방향 뒤집힘(t0 > t1)이 실제로 있는지. 있으면 화면이 대응선을 그을 때
// 순서를 뒤집어야 한다 — 없으면 그 코드를 안 써도 된다.
const reversed = d.seams.flatMap((s) => s.sides.flat()).filter((p) => p.t0 > p.t1).length;
console.log(`  방향 뒤집힌 파트(t0 > t1): ${reversed}개`);

// ── ⑤ 스티치 ─────────────────────────────────────────────────
//
// 이미지의 색 있는 변이 여기서 나오는지 대조할 재료다. 색이 몇 종류인지가
// 관건 — 한 가지뿐이면 이미지의 알록달록함은 스티치가 아니다.
console.log(`\n=== ⑤ 스티치 ${d.stitches.length}개 ===`);
const colors = new Map<string, number>();
for (const s of d.stitches) {
  const k = s.color.map((v) => v.toFixed(3)).join(',');
  colors.set(k, (colors.get(k) ?? 0) + 1);
}
console.log(`  색 ${colors.size}종:`);
for (const [k, n] of [...colors].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    [${k}]  ${n}개`);
}
console.log(
  colors.size <= 1
    ? '  ⚠️ 색이 한 종류다 — 이미지의 여러 색은 스티치가 아니다'
    : '  ✅ 색이 여러 종류다 — 이미지의 색이 여기서 나올 수 있다',
);

// ── ⑥ 페이로드 크기 ──────────────────────────────────────────
//
// 로드당 한 번이라 프레임 경로에 없지만, 몇 MB 인지는 알고 가야 한다.
const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
console.log(`\n=== ⑥ 페이로드 ${(bytes / 1024).toFixed(1)} KB ===`);
console.log(`  점 ${every.length / 2}개 · 커브당 평균 ${(every.length / 2 / Math.max(allCurves.length, 1)).toFixed(1)}점`);

await w.request('quit').catch(() => {});
setTimeout(() => process.exit(0), 300);
