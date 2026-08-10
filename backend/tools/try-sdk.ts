/**
 * SDK 사용 예제 — 손으로 돌려 보는 용도.
 *
 *   cd backend
 *   node --experimental-strip-types tools/try-sdk.ts
 *   node --experimental-strip-types tools/try-sdk.ts --scene sample --frames 30
 *
 * 테스트가 아니다. `smoke.ts`는 단언으로 회귀를 잡는 물건이고, 이건
 * **SDK가 무엇을 할 수 있는지 눈으로 보는** 물건이다. 실패해도 exit 0이며
 * 값을 사람이 읽기 좋게 찍는다.
 *
 * 여기서 쓰는 순서가 곧 SDK의 계약이다:
 *
 *   Session.create()  프로세스를 띄우고 ready를 기다린다 (autoInit이면 Initialize까지)
 *   load()            .zls를 연다. ⚠️ 형식 검증을 하지 않는다 — 없는 파일만 실패한다
 *   setParams()       시뮬 파라미터. **start 전에** 걸어야 한다
 *   start()           시뮬 시작
 *   waitForFrame(n)   n프레임 도달까지 대기
 *   meshData(true)    토폴로지 포함 지오메트리 (indices/uvs/transform/transform2d/material)
 *   dispose()         프로세스 종료
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Session } from '../src/sdk/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const EXE = resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');

const SCENES: Record<string, string> = {
  // 103MB. 패턴 5개. 색이 전부 흰색이라 재질 확인에는 약하다
  sample: resolve(ROOT, 'zelusSandBox_Cobalt/Zest/testing/sdk/sample.zls'),
  // 138MB. 패턴 24개, 민트/노랑. 2D 배치와 재질을 보려면 이쪽
  bra: resolve(ROOT, 'backend/data/incoming/W_Bra top & Leggings.zls'),
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function n(v: number, digits = 2): string {
  return v.toFixed(digits).padStart(9);
}

async function main(): Promise<void> {
  const sceneKey = arg('scene') ?? 'bra';
  const frames = Number(arg('frames') ?? 60);
  const zls = SCENES[sceneKey];

  if (!zls) {
    console.error(`--scene 은 ${Object.keys(SCENES).join(' | ')} 중 하나여야 합니다`);
    process.exit(1);
  }
  for (const [label, p] of [['워커 exe', EXE], ['씬', zls]] as const) {
    if (!existsSync(p)) {
      console.error(`${label}을 찾을 수 없습니다: ${p}`);
      console.error('워커가 없으면: cmake --build backend/native/build --config Release');
      process.exit(1);
    }
  }

  console.log(`\n씬     ${sceneKey} — ${zls}`);
  console.log(`프레임  ${frames}\n`);

  // ── 세션 ────────────────────────────────────────────────
  const t0 = Date.now();
  const session = await Session.create({ exePath: EXE });
  console.log(`세션 기동   ${Date.now() - t0}ms`);

  // 엔진이 stderr로 흘리는 말. 시뮬이 뭘 하는지 궁금할 때 켜면 된다.
  // session.on('engineMessage', (m) => console.log('  [엔진]', m));

  try {
    const v = await session.version();
    console.log(`엔진        Zelus ${v.zelus} / Lumia ${v.lumia}`);

    const t1 = Date.now();
    await session.load(zls);
    console.log(`로드        ${Date.now() - t1}ms`);

    // ── 파라미터 ──────────────────────────────────────────
    // ⚠️ 22개 중 2개(subStep·meshingEdgeLength)는 값이 걸려도 물리가 안 본다.
    //    ISSUES.md의 ISSUE-014 §전수 측정에 표가 있다.
    const params = await session.getParams();
    console.log(
      `파라미터    timeStep=${params.timeStep} gravityY=${params.gravityY} ` +
        `drapingTime=${params.drapingTime} solverType=${params.solverType}`,
    );

    // 바꿔 보고 싶으면 여기서. **start 전이어야 한다.**
    // await session.setParams({ drapingTime: 3 });

    // ── 시뮬 ──────────────────────────────────────────────
    const t2 = Date.now();
    await session.start();
    const reached = await session.waitForFrame(frames);
    await session.pause();
    console.log(`시뮬        ${frames}프레임 ${Date.now() - t2}ms (도달 ${reached})`);

    // ── 지오메트리 ────────────────────────────────────────
    // topology:true 여야 indices/uvs/transform/transform2d/material 이 실린다.
    // 프레임마다 바뀌는 것은 positions 뿐이라 나머지는 한 번만 온다.
    const mesh = await session.meshData(true);
    const total = mesh.patterns.reduce((s, p) => s + p.vertices, 0);
    console.log(`\n패턴 ${mesh.patterns.length}개 · 정점 ${total.toLocaleString()}\n`);

    console.log('  #  정점   색 (r,g,b)              직물 uuid        2D 배치 (x, y)');
    console.log('  ─────────────────────────────────────────────────────────────────');
    for (const [i, p] of mesh.patterns.slice(0, 8).entries()) {
      const c = p.material?.color;
      const color = c ? `${n(c[0], 3)},${n(c[1], 3)},${n(c[2], 3)}` : '   (없음)';
      const fab = p.material?.fabricUuid ? String(p.material.fabricUuid).slice(0, 14) : '-';
      const t2d = p.transform2d;
      const place = t2d ? `${n(t2d[2])}, ${n(t2d[5])}` : '(없음)';
      console.log(`  ${String(i).padStart(2)} ${String(p.vertices).padStart(5)}  ${color}  ${fab.padEnd(15)} ${place}`);
    }
    if (mesh.patterns.length > 8) console.log(`  … 나머지 ${mesh.patterns.length - 8}개 생략`);

    // 직물별로 묶어 본다 — 색이 몇 종인지가 이걸로 보인다
    const byFabric = new Map<string, number>();
    for (const p of mesh.patterns) {
      const k = String(p.material?.fabricUuid ?? '없음');
      byFabric.set(k, (byFabric.get(k) ?? 0) + 1);
    }
    console.log(`\n직물 ${byFabric.size}종:`);
    for (const [k, cnt] of byFabric) console.log(`  ${k.slice(0, 24)} → 패턴 ${cnt}개`);

    // ── 익스포트 ──────────────────────────────────────────
    // 지금 포즈를 glTF로 낸다. ⚠️ 시뮬을 돌린 뒤에 찍어야 옷이 입혀진다 —
    // 로드 직후에 찍으면 패턴이 펼쳐진 채로 나온다.
    const out = resolve(ROOT, `backend/data/try-sdk-${sceneKey}.gltf`);
    const t3 = Date.now();
    await session.export(out, 'gltf');
    console.log(`\n익스포트    ${out}  (${Date.now() - t3}ms)`);
  } finally {
    await session.dispose();
    console.log('\n세션 종료');
  }
}

main().catch((e) => {
  console.error('\n실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
