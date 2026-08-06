/**
 * SDK 스모크 테스트.
 *
 * 손으로 파이프에 밀어넣어 확인했던 시나리오를 Node에서 그대로 재현한다.
 * 같은 결과가 나오면 SDK 계층이 프로토콜을 제대로 감쌌다는 뜻이다.
 *
 *   node --experimental-strip-types src/sdk/smoke.ts
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { SessionPool } from './pool.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const EXE = resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');
const ZLS = resolve(ROOT, 'zelusSandBox_Cobalt/Zest/testing/sdk/sample.zls');

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  실패'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

function ms(t: number): string {
  return `${Math.round(t)}ms`;
}

async function main(): Promise<void> {
  for (const [label, p] of [['exe', EXE], ['sample.zls', ZLS]] as const) {
    if (!existsSync(p)) {
      console.error(`${label}을 찾을 수 없습니다: ${p}`);
      process.exit(1);
    }
  }

  console.log('\n=== SDK 스모크 테스트 ===\n');

  // idleTimeout을 켜서 프로세스 재사용 경로까지 태운다.
  const pool = new SessionPool({
    exePath: EXE,
    idleTimeout: 30_000,
    maxIdle: 2,
    onLog: () => {},   // 엔진 로그는 조용히
  });

  try {
    // ── 1. 기동 + 기본 왕복 ───────────────────────────────
    let t = performance.now();
    const session = await pool.acquire();
    const spawnMs = performance.now() - t;
    check('세션 기동', session.alive, ms(spawnMs));

    const pong = await session.ping();
    check('ping 왕복', pong.pong === true);

    // 버전은 init/load 없이 ready 직후 답해야 한다.
    // 값은 링크된 엔진에 따라 달라지므로 "비어있지 않음"만 본다.
    const ver = await session.version();
    check(
      'version 조회',
      typeof ver.zelus === 'string' && ver.zelus.length > 0
        && typeof ver.lumia === 'string' && ver.lumia.length > 0,
      `zelus=${JSON.stringify(ver.zelus)}, lumia=${JSON.stringify(ver.lumia)}`,
    );

    // ── 2. 씬 로드 ────────────────────────────────────────
    t = performance.now();
    await session.load(ZLS);
    const loadMs = performance.now() - t;
    check('씬 로드 (103MB)', session.loadedPath === ZLS, ms(loadMs));

    // ── 3. 파라미터 ───────────────────────────────────────
    const before = await session.getParams();
    const setRes = await session.setParams({
      gravityY: -500,
      subStep: 2,
      // 일부러 틀린 키를 섞는다. 조용히 삼키면 안 된다.
      nonExistentKey: 1,
    } as never);

    check(
      '파라미터 반영',
      setRes.applied.includes('gravityY') && setRes.applied.includes('subStep'),
      setRes.applied.join(', '),
    );
    check(
      '모르는 키를 보고',
      setRes.unknown.includes('nonExistentKey'),
      setRes.unknown.join(', '),
    );

    const after = await session.getParams();
    check(
      '값이 실제로 바뀜',
      before.gravityY === -980 && after.gravityY === -500 && after.subStep === 2,
      `gravityY ${before.gravityY} → ${after.gravityY}, subStep ${before.subStep} → ${after.subStep}`,
    );

    // ── 4. 시뮬레이션 ─────────────────────────────────────
    const frames: number[] = [];
    session.on('frame', (f) => frames.push(f));

    t = performance.now();
    await session.start();
    const reached = await session.waitForFrame(10, 120_000);
    const simMs = performance.now() - t;
    await session.pause();

    check('프레임 이벤트 수신', frames.length > 0, `${frames.length}개`);
    check('목표 프레임 도달', reached >= 10, `frame ${reached}, ${ms(simMs)}`);

    // ── 5. 지오메트리 ─────────────────────────────────────
    t = performance.now();
    const geo = await session.geometry(true);
    const geoMs = performance.now() - t;

    const totalV = geo.reduce((s, p) => s + p.vertices, 0);
    const totalT = geo.reduce((s, p) => s + p.triangles, 0);

    check('패턴 수', geo.length === 5, `${geo.length}개`);
    check('정점 수', totalV === 3022, `${totalV}`);
    check('삼각형 수', totalT === 5472, `${totalT}`);

    const first = geo[0];
    check(
      'positions 디코딩',
      first !== undefined && first.positions.length === first.vertices * 3,
      first ? `${first.positions.length} floats = ${first.vertices} × 3` : '패턴 없음',
    );
    check(
      'indices 디코딩',
      first?.indices !== undefined && first.indices.length === first.triangles * 3,
      first?.indices ? `${first.indices.length} ints` : '없음',
    );

    // 좌표가 3D인지 (Z가 평면이면 2D 패턴이라는 뜻)
    if (first) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 2; i < first.positions.length; i += 3) {
        const z = first.positions[i]!;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      check(
        '3D 드레이프 확인',
        maxZ - minZ > 1,
        `Z 범위 ${minZ.toFixed(1)} ~ ${maxZ.toFixed(1)}`,
      );
    }

    console.log(`         지오메트리 취득 ${ms(geoMs)}`);

    // ── 6. 세션 재사용 ────────────────────────────────────
    await session.clear();
    check('clear', session.loadedPath === null);

    await session.load(ZLS);
    const st = await session.status();
    check('같은 프로세스에서 재로드', st.loaded === true);

    const pid = session.worker.pid;
    await pool.release(session);

    t = performance.now();
    const reused = await pool.acquire();
    const reuseMs = performance.now() - t;
    check(
      '유휴 프로세스 재사용',
      reused.worker.pid === pid,
      `pid ${pid} 재사용, ${ms(reuseMs)}`,
    );
    await pool.release(reused);
  } finally {
    await pool.close();
  }

  console.log(
    failures === 0
      ? '\n전부 통과\n'
      : `\n${failures}건 실패\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n스모크 테스트 중 예외:', err);
  process.exit(1);
});
