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
import type { MeshDataResult } from './protocol.ts';
import { decodePatterns, Session } from './session.ts';
import { Worker } from './worker.ts';

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

  // ── 0. 기동 실패는 세션 하나의 실패다 (ISSUE-006) ─────
  // spawn 자체가 실패하면(exe 없음, 권한, fd 고갈) child_process는 'exit'이
  // 아니라 'error'를 낸다. 리스너가 없으면 EventEmitter가 unhandled로 승격시켜
  // **SDK를 쓰는 프로세스를 통째로 죽인다.**
  //
  // 게이트웨이 스모크가 이걸 502로 간접 확인하지만, SDK는 게이트웨이 없이도
  // 쓰이는 계층이다. "호스트 프로세스를 죽이지 않는다"는 SDK 자신의 계약이므로
  // 자기 층에서 지켜야 한다 — 게이트웨이가 풀 배선을 바꾸면 그 간접 그물은
  // 조용히 사라진다. 비용도 0이다: 없는 exe는 워커를 띄우지 않는다.
  {
    // 랜덤 이름이라 우연히 존재할 수 없다.
    const ghost = `${EXE}.no-such-worker-${process.pid}-${Date.now()}.exe`;

    // ① Worker 층 — 'exit'이 **정확히 한 번**, code=null로 나간다.
    //    'error'와 'exit'이 둘 다 오는 플랫폼에서도 한 번이어야 한다.
    //    두 번 나가면 이미 끝난 세션을 다시 정리하는 경로가 열린다.
    const logs: string[] = [];
    const w = Worker.spawn({ exePath: ghost, onLog: (l) => logs.push(l) });
    const exits: (number | null)[] = [];
    const firstExit = new Promise<void>((res) => w.once('exit', () => res()));
    w.on('exit', (c) => exits.push(c));

    await Promise.race([firstExit, new Promise((r) => setTimeout(r, 3_000))]);
    await new Promise((r) => setTimeout(r, 150)); // 두 번째 발화가 있으면 여기서 잡힌다

    check('없는 exe → exit 이벤트 정확히 1회', exits.length === 1, `${exits.length}회 ${JSON.stringify(exits)}`);
    check('exit code는 null (spawn 실패엔 exit이 없다)', exits[0] === null, `code=${String(exits[0])}`);
    check('worker.closed === true', w.closed === true);
    check(
      '실패 로그에 exe 경로가 있다',
      logs.some((l) => l.includes(ghost)),
      logs.join(' / ').slice(0, 160) || '로그 없음',
    );

    // ② Session 층 — create()가 매달리지 않고 reject 된다.
    //    ('ready'가 영영 안 오므로, exit이 그 대기를 깨우는 유일한 탈출구다)
    const failed = await Session.create({ exePath: ghost }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    check(
      'Session.create()가 reject (매달리지 않는다)',
      failed !== null && failed.includes('code=null'),
      failed ?? '성공해버렸다 — 없는 exe로 세션이 생겼다',
    );

    // ③ Pool 층 — acquire가 reject되고 세션을 세지 않는다.
    const badPool = new SessionPool({ exePath: ghost, idleTimeout: 0, onLog: () => {} });
    const rejected = await badPool.acquire().then(() => false, () => true);
    check(
      'pool.acquire()가 reject + 누수 없음',
      rejected && badPool.stats.total === 0,
      `rejected=${rejected}, stats=${JSON.stringify(badPool.stats)}`,
    );
    await badPool.close();

    // ④ 그리고 이 프로세스가 아직 살아 있다. 예전엔 ①에서 이미 죽었다 —
    //    여기까지 도달한 것 자체가 단언이고, 회귀하면 이 줄이 출력되지 않는다.
    check('기동 실패가 SDK 사용자 프로세스를 죽이지 않는다', true, `pid=${process.pid} 생존`);
  }

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

    // 구독 토글도 씬 로드 없이 ready 직후에 답해야 한다.
    // status가 실제로 그 상태를 들고 있는지가 핵심이다.
    const sub = await session.subscribe();
    const stSub = await session.status();
    check(
      'subscribe → 구독 켜짐',
      sub.subscribed === true && stSub.subscribed === true,
      `result=${sub.subscribed}, status=${stSub.subscribed}`,
    );

    const unsub = await session.unsubscribe();
    const stUnsub = await session.status();
    check(
      'unsubscribe → 구독 꺼짐',
      unsub.subscribed === false && stUnsub.subscribed === false,
      `result=${unsub.subscribed}, status=${stUnsub.subscribed}`,
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

    // 회귀 확인용. 이 구간은 §1에서 unsubscribe로 끝났으므로 비구독 상태다.
    // 구독을 켜기 전에 리스너를 떼야 §5.5의 프레임이 섞이지 않는다.
    let plainFrames = 0;
    let plainWithMesh = 0;
    const onPlainFrame = (_f: number, mesh?: MeshDataResult): void => {
      plainFrames++;
      if (mesh !== undefined) plainWithMesh++;
    };
    session.on('frame', onPlainFrame);

    t = performance.now();
    await session.start();
    const reached = await session.waitForFrame(10, 120_000);
    const simMs = performance.now() - t;
    await session.pause();

    check('프레임 이벤트 수신', frames.length > 0, `${frames.length}개`);
    check('목표 프레임 도달', reached >= 10, `frame ${reached}, ${ms(simMs)}`);

    // 구독하지 않았을 때 frame 이벤트는 이전과 같아야 한다 (mesh 없음).
    session.off('frame', onPlainFrame);
    check(
      '비구독 프레임에 mesh 없음',
      plainFrames > 0 && plainWithMesh === 0,
      `${plainFrames}개 중 mesh 실린 프레임 ${plainWithMesh}개`,
    );

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

    // ── 5.5 구독 중 프레임에 메시 ─────────────────────────
    // 씬 로드와 시뮬 실행이 있어야 성립하므로 ready 직후 그룹(§1)에 둘 수
    // 없다. §5 뒤에 두어 §4·§5의 기존 단언이 구독 상태에 노출되지 않게 한다.
    const WANT = 5;
    const subFrames: { frame: number; mesh: MeshDataResult | undefined }[] = [];
    const onSubFrame = (f: number, mesh?: MeshDataResult): void => {
      subFrames.push({ frame: f, mesh });
    };

    await session.subscribe();
    session.on('frame', onSubFrame);

    try {
      const target = session.worker.lastFrame + WANT;
      await session.start();
      await session.waitForFrame(target, 120_000);
    } finally {
      // 구독은 워커 수명 내내 유지된다. 켠 채로 나가면 이후 테스트와
      // 풀 재사용 세션까지 샌다.
      await session.pause();
      session.off('frame', onSubFrame);
      await session.unsubscribe();
    }

    check('구독 중 프레임 수신', subFrames.length >= WANT, `${subFrames.length}개 (목표 ${WANT})`);

    let bad: string | null = null;
    let patternsChecked = 0;
    for (const ev of subFrames) {
      if (!ev.mesh) {
        bad = `frame ${ev.frame}: mesh 없음`;
        break;
      }
      const pats = decodePatterns(ev.mesh);
      if (pats.length === 0) {
        bad = `frame ${ev.frame}: 패턴 0개`;
        break;
      }
      for (const p of pats) {
        patternsChecked++;
        if (p.positions.length !== p.vertices * 3) {
          bad = `frame ${ev.frame} / ${p.uuid}: positions ${p.positions.length} != ${p.vertices} × 3`;
          break;
        }
      }
      if (bad) break;
    }

    check(
      '각 프레임 positions.length == 정점수 × 3',
      bad === null,
      bad ?? `프레임 ${subFrames.length}개 / 패턴 ${patternsChecked}개 검사`,
    );

    const stAfterSub = await session.status();
    check('구독 정리됨', stAfterSub.subscribed === false, `subscribed=${stAfterSub.subscribed}`);

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
