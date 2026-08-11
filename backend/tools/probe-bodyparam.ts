/**
 * 치수 변형 · 자동 드레이핑 실측 — **회사 CLI 에서 옮겨 온 op 2개가 진짜 도는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-bodyparam.ts
 *
 * 테스트가 아니다. `probe-avatar.ts`·`probe-design2d.ts` 와 같은 성격이다 —
 * `setAvatarMeasurements`·`loadDraping` 이 무엇을 돌려주는지 눈으로 본다.
 *
 * ── 이 프로브가 가르는 것 ───────────────────────────────────
 *
 * ① **`dynamic_cast<ztDesignZeta*>` 가 성공하나.** 실패하면
 *    `setAvatarMeasurements` 전체가 죽은 코드다. 판별은 공짜로 된다 —
 *    **모르는 치수 이름 하나만** 보내면 캐스팅은 그 앞에서 일어나므로
 *      NotZeta  → 캐스팅 실패 (여기서 끝)
 *      NoChange → 캐스팅 성공 (그리고 아바타 데이터는 하나도 안 건드렸다)
 *    로 갈린다. 아바타를 실제로 바꾸지 않고 재는 유일한 방법이다.
 *
 * ② **실패 경로가 재생 중인 시뮬을 멈추나.** 위 ① 요청은 "에러"로 끝나는데,
 *    코드가 아바타를 찾기 **전에** `simManager->Pause()` 를 부른다. 회사 CLI 는
 *    1회성이라 무해했지만 우리는 상주 워커다. 프레임이 계속 오르는지로 잰다.
 *
 * ③ **`Step()` 이 헤드리스에서 도나 + 얼마나 걸리나.** 창 없이 시뮬이 도는 것은
 *    확인됐지만 이 경로(`simManager->Step(true)` 직접 호출)는 처음이다.
 *    게이트웨이 요청 타임아웃이 **120초**라 소요 시간이 설계 판단의 근거다.
 *
 * ④ **씬에 AUTO 드레이핑 아이템이 있나.** 없으면 `loadDraping` 을 검증할 씬이
 *    없다는 뜻이고, 그건 코드의 문제가 아니다.
 *
 * ⚠️ 이 프로브는 **Debug exe** 를 쓴다. 다른 프로브들이 쓰는 Release 에는
 *    두 op 이 아직 안 들어 있다(2026-08-11 기준 Release 는 16:42 빌드).
 */

import { Worker } from '../src/sdk/index.ts';

/** 기본은 Debug. `--exe Release` 로 Release 를 잰다 — 소요 시간이 구성마다 크게 다르다 */
const CONFIG = process.argv[process.argv.indexOf('--exe') + 1] ?? 'Debug';
const EXE = `native/build/${CONFIG === 'Release' ? 'Release' : 'Debug'}/zelusSandBoxd-demo.exe`;
/** `data/scenes/` 의 W_Bra top & Leggings.zls (138MB). 다른 프로브가 쓰는 것과 같은 파일 */
const SCENE = 'data/scenes/89b6c497c8d8365d0032e8a3b83e05bd.zls';

/**
 * 허리둘레를 몇 cm 밀어 볼 것인가. 10~20cm 구간이 실제 사용 범위다.
 * `--delta 4` 로 줄이면 빠르게 돌 수 있다 — 수정 후 재확인용.
 */
const WAIST_DELTA_CM = Number(process.argv[process.argv.indexOf('--delta') + 1]) || 15;

interface Measurement { real: number; expected?: number; locked: boolean }
interface AvatarBody {
  hasAvatar: boolean;
  uuid?: string;
  bodyParams?: Record<string, number>;
  measurements?: Record<string, Measurement>;
}
interface MeasureResult {
  applied: string[];
  unknown: string[];
  rejected: string[];
  steps: number;
  simSteps: number;
  frame: number;
  /** 적용 뒤 zeta 에서 **직접 잰** 치수. `avatar.measurements[*].real` 과 다르다 */
  measured?: Record<string, number>;
  avatar: AvatarBody;
}
interface Status { loaded: boolean; mode: string; frame: number; maxFrame: number }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 워커 기본 타임아웃은 120초다. 그 120초가 **우리가 재려는 값**이라
// 프로브에서는 넉넉히 늘려 놓고, 넘었는지 여부를 따로 판정한다.
const w = Worker.spawn({ exePath: EXE, requestTimeoutMs: 900_000 });
await new Promise<void>((r) => w.on('ready', () => r()));

/** `Op` 유니온에 아직 없는 op 을 부르기 위한 통로. 타입만 우회한다 */
const call = <T,>(op: string, payload: Record<string, unknown> = {}) =>
  w.request<T>(op as never, payload);

async function finish(code = 0): Promise<never> {
  await call('quit').catch(() => {});
  await sleep(500);
  process.exit(code);
}

await call('init');
console.log(`씬을 로드하는 중… ${SCENE}`);
console.log('load →', JSON.stringify(await call('load', { path: SCENE })));

// ── ⑦ `--geom` : 이 op 이 지오메트리를 바꾸긴 하는가 ─────────
//
// ③ 에서 `avatar.measurements[*].real` 도 `locked` 도 안 움직였다. 그런데
// 그 값들은 `qi->GetAvatarData()` → `ztDesignAvatarData.zetaData` 에서 읽고,
// 쓰기는 `ztDesignZeta::SetMeasurementParam` 으로 간다 — **읽는 곳과 쓰는 곳이
// 같은 객체라는 보장이 헤더에 없다.** 즉 응답만으로는 "몸이 안 변했다" 를
// 결론지을 수 없다(probe-avatar ③-b 에서 똑같이 데였다).
//
// 익스포트한 glTF 는 지금 씬의 **실제 지오메트리**라 그 구분이 선다.
// `simulationIterations=0` 으로 부르면 Step 을 한 번도 안 부르므로, 파일이
// 달라졌다면 그건 오직 몸이 다시 만들어졌기 때문이다.
if (process.argv.includes('--geom')) {
  const { readFileSync, existsSync, statSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const digest = (p: string) =>
    existsSync(p)
      ? `${createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12)} (${statSync(p).size}B)`
      : '없음';

  const A = 'data/probe-bodyparam-a.gltf';
  const B = 'data/probe-bodyparam-b.gltf';

  const a0 = await call<AvatarBody>('avatarBody');
  const base = a0.measurements?.['WaistCircum']?.real ?? 0;

  await call('export', { path: A, format: 'gltf' });
  const r = await call<MeasureResult>('setAvatarMeasurements', {
    measurements: { WaistCircum: base + 10 },
    bodyDimensionStepCm: 10,
    simulationIterations: 0,   // Step 을 아예 안 부른다 — 변수를 하나로 줄인다
  });
  await call('export', { path: B, format: 'gltf' });

  console.log('\n=== ⑦ 지오메트리 대조 (Step 없이 체형만) ===');
  console.log(`  steps ${r.steps} · simSteps ${r.simSteps} · applied ${JSON.stringify(r.applied)}`);
  const [da, db] = [digest(A), digest(B)];
  console.log(`  변경 전 : ${da}`);
  console.log(`  변경 후 : ${db}`);
  console.log(
    da !== db && da !== '없음'
      ? '  ✅ 몸이 실제로 다시 만들어졌다 — 응답의 real 이 안 움직인 것은 읽기 경로의 문제다'
      : '  ⛔ 지오메트리가 그대로다 — SetMeasurementParam 이 아무 일도 안 한다',
  );
  await finish(0);
}

// ── ⓪ 현재 아바타 ───────────────────────────────────────────
const before = await call<AvatarBody>('avatarBody');
console.log('\n=== ⓪ 아바타 ===');
console.log('hasAvatar :', before.hasAvatar, ' uuid :', before.uuid ?? '—');

if (!before.hasAvatar || !before.measurements) {
  console.log('⛔ 아바타가 없다. 여기서 끝난다.');
  await finish(0);
}

const ms = before.measurements!;
const names = Object.keys(ms);
console.log(`치수 ${names.length}개:`);
for (const [k, v] of Object.entries(ms)) {
  console.log(
    `  ${k.padEnd(24)} real ${v.real.toFixed(3).padStart(9)}`
    + `  expected ${v.expected === undefined ? '—' : v.expected.toFixed(3).padStart(9)}`
    + `  ${v.locked ? 'lock' : ''}`,
  );
}

// 이름이 통하는지의 기준점. 없으면 이름 어휘가 우리 생각과 다른 것이다.
const WAIST = 'WaistCircum';
const hasWaist = Object.prototype.hasOwnProperty.call(ms, WAIST);
console.log(
  `\n"${WAIST}" 이 있나 : ${hasWaist ? `✅ 있다 (real ${ms[WAIST]!.real.toFixed(3)})` : '⛔ 없다 — 위 목록에서 이름을 골라야 한다'}`,
);

// ── ④ 드레이핑 ──────────────────────────────────────────────
//
// 큰 시뮬을 돌리기 전에 싼 것부터. 이 op 은 씬을 읽기만 하거나
// Reset() 을 부를 뿐이라 뒤 단계에 방해가 되지 않는다.
console.log('\n=== ④ loadDraping ===');
const drape = await call<Record<string, unknown>>('loadDraping');
console.log(JSON.stringify(drape, null, 2));
console.log(
  drape['applied'] === true
    ? '✅ AUTO 아이템을 적용했다'
    : `⚠️ 적용 안 됨 — reason: ${String(drape['reason'] ?? '(없음)')} · count: ${String(drape['count'])}`,
);

// ── ① 캐스팅 + ② 실패 경로가 시뮬을 멈추나 ──────────────────
//
// 한 번의 요청으로 둘을 같이 잰다. 모르는 치수 이름만 보내면
// 캐스팅은 통과하고 measurements 루프에서 NoChange 로 끝난다 —
// **아바타 데이터를 하나도 안 건드린다.**
console.log('\n=== ①② 모르는 치수만 보낸다 (아바타 무변경) ===');

await call('start');
await sleep(4000);
const s0 = await call<Status>('status');
await sleep(2500);
const s1 = await call<Status>('status');
console.log(`  요청 전 : mode=${s1.mode} frame ${s0.frame} → ${s1.frame} (${s1.frame > s0.frame ? '오르는 중' : '안 오름'})`);

let castOk: boolean | null = null;
try {
  const r = await call<MeasureResult>('setAvatarMeasurements', {
    measurements: { __definitely_not_a_measure__: 50 },
  });
  console.log('  ⚠️ 예상 밖 — 성공했다:', JSON.stringify(r).slice(0, 300));
} catch (e) {
  const msg = (e as Error).message;
  console.log('  에러 :', msg);
  if (msg.includes('ztDesignZeta')) castOk = false;
  else if (msg.includes('적용할 치수가 없습니다')) castOk = true;
}

console.log(
  castOk === true  ? '  ✅ ① dynamic_cast<ztDesignZeta*> 성공 — op 이 살아 있다'
  : castOk === false ? '  ⛔ ① NotZeta — setAvatarMeasurements 는 이 씬에서 죽은 코드다'
  : '  ⚠️ ① 판별 불가 — 위 에러 문장을 사람이 볼 것',
);

const s2 = await call<Status>('status');
await sleep(2500);
const s3 = await call<Status>('status');
console.log(`  요청 후 : mode=${s3.mode} frame ${s2.frame} → ${s3.frame} (${s3.frame > s2.frame ? '오르는 중' : '안 오름'})`);
console.log(
  s1.frame > s0.frame && !(s3.frame > s2.frame)
    ? '  ⛔ ② 실패한 요청이 재생 중인 시뮬을 멈췄다 — Pause() 가 검증보다 앞에 있다'
    : s1.frame > s0.frame
      ? '  ✅ ② 실패한 요청이 재생을 안 건드렸다'
      : '  ⚠️ ② 판별 불가 — 요청 전에도 프레임이 안 올랐다',
);

if (castOk === false) {
  console.log('\n⛔ ① 이 실패했으므로 여기서 멈춘다. ③ 은 재지 않는다.');
  await finish(0);
}

// ── ③ 진짜 변형 + 소요 시간 ─────────────────────────────────
if (!hasWaist) {
  console.log(`\n⚠️ "${WAIST}" 이 없어 ③ 을 건너뛴다.`);
  await finish(0);
}

await call('pause');

const cur = ms[WAIST]!.real;
const want = cur + WAIST_DELTA_CM;
console.log(`\n=== ③ ${WAIST} ${cur.toFixed(2)} → ${want.toFixed(2)} cm (Δ${WAIST_DELTA_CM}) ===`);
console.log('    bodyDimensionStepCm=1.0 · simulationIterations=6 — 문서 기본값');
console.log('    ⏳ 오래 걸린다. 게이트웨이 타임아웃 120초를 넘는지가 관건이다…');

const t0 = performance.now();
let heavy: MeasureResult | null = null;
try {
  heavy = await call<MeasureResult>('setAvatarMeasurements', {
    measurements: { [WAIST]: want },
    bodyDimensionStepCm: 1.0,
    simulationIterations: 6,
  });
} catch (e) {
  console.log('  ⛔ 실패 :', (e as Error).message);
}
const secs = (performance.now() - t0) / 1000;

console.log(`\n  ⏱  ${secs.toFixed(1)} 초  ${secs > 120 ? '⛔ 게이트웨이 타임아웃(120초) 초과' : '✅ 120초 이내'}`);

if (heavy) {
  console.log(`  applied  : ${JSON.stringify(heavy.applied)}`);
  console.log(`  unknown  : ${JSON.stringify(heavy.unknown)}`);
  console.log(`  rejected : ${JSON.stringify(heavy.rejected)}`);
  console.log(`  steps ${heavy.steps} · simSteps ${heavy.simSteps} · frame ${heavy.frame}`);
  console.log(
    heavy.simSteps > 0
      ? `  ✅ ③ Step() 이 헤드리스에서 ${heavy.simSteps}번 돌았다 (크래시 없음)`
      : '  ⚠️ ③ Step 을 한 번도 안 불렀다',
  );

  // ★ 진짜 판정 — 실측치가 목표를 따라갔는가. 응답의 steps 는 "몇 번 시도했나"
  //   일 뿐이고, 몸이 실제로 변한 증거는 이 값이다.
  const after = heavy.avatar?.measurements?.[WAIST];
  console.log(`\n  ${WAIST} real : ${cur.toFixed(3)} → ${after?.real.toFixed(3) ?? '—'}   (목표 ${want.toFixed(3)})`);
  // 쓰기가 어디까지 갔는지 — `expected`/`locked` 가 붙었으면 SetMeasurementParam
  // 은 닿았고 `real` 을 되계산해 주지 않는다는 뜻이다(읽기 경로의 문제).
  // 셋 다 그대로면 쓰기 자체가 다른 객체로 갔다는 뜻이다.
  console.log(`  ${WAIST} 기록 : ${JSON.stringify(after)}`);
  const moved = after !== undefined && Math.abs(after.real - cur) > 1e-3;
  console.log(
    moved
      ? `  ✅ 몸이 변했다 (목표까지 ${(((after!.real - cur) / WAIST_DELTA_CM) * 100).toFixed(1)}%)`
      : '  ⛔ 실측치가 그대로다 — 값만 저장되고 메시가 안 만들어졌을 수 있다',
  );

  // ── 되읽기 경로 대조 ───────────────────────────────────────
  //
  // `measured` 는 쓴 객체에서 직접 잰 값이다
  // (`ztDesignZeta::GetMeasurement()->GetMeasuredLength(part)`).
  // `avatar.measurements[*].real` 은 씬 데이터의 **사본**이라 이 op 으로는
  // 안 움직인다. 둘을 나란히 찍어야 "어느 쪽이 정본인가" 가 눈에 보인다.
  const md = heavy.measured;
  console.log('\n  ── 되읽기 두 경로 대조 ──');
  if (md === undefined) {
    console.log('  ⛔ 응답에 measured 가 없다 — 워커가 옛 빌드다');
  } else {
    const mNow = md[WAIST];
    console.log(`  measured  (zeta 에서 직접) : ${cur.toFixed(3)} → ${mNow?.toFixed(3) ?? '—'}`);
    console.log(`  real      (씬 데이터 사본) : ${cur.toFixed(3)} → ${after?.real.toFixed(3) ?? '—'}`);
    const mMoved = mNow !== undefined && Math.abs(mNow - cur) > 1e-3;
    console.log(
      mMoved
        ? `  ✅ measured 가 갱신된다 — 되읽기 경로를 찾았다 (목표까지 ${(((mNow! - cur) / WAIST_DELTA_CM) * 100).toFixed(1)}%)`
        : '  ⛔ measured 도 안 움직인다 — 추론이 틀렸다. 더 파야 한다',
    );
  }

  // 같이 움직인 다른 치수 — **`measured` 로 본다.** `real` 은 어차피 안 변해서
  // 팔 버그(안 보낸 부위가 끌려가는 것) 같은 것을 원리적으로 검출 못 한다.
  let others = 0;
  for (const [k, v] of Object.entries(ms)) {
    if (k === WAIST) continue;
    const a = md?.[k];
    if (a !== undefined && Math.abs(a - v.real) > 1e-3) {
      if (others < 8) console.log(`    ${k.padEnd(24)} ${v.real.toFixed(3)} → ${a.toFixed(3)}`);
      others += 1;
    }
  }
  console.log(`  같이 움직인 치수 ${others}개`);
}

// ── ⑤ 기본값이 단계를 쪼개나 ────────────────────────────────
//
// `bodyDimensionStepCm` 를 **안 보낸다.** 회사 struct 기본값(100)이면
// `(int)(maxDest/100)=0` 이라 중간 단계가 사라지고 `steps` 가 1로 나온다 —
// 몸이 한 번에 변해 옷을 뚫는 그 상태다. 문서 기본값(1.0)이면 2 이상이 된다.
console.log('\n=== ⑤ 기본값으로 부른다 (stepCm·iterations 안 보냄) ===');
const base = heavy?.avatar?.measurements?.[WAIST]?.real ?? cur;
const small = base + 2;
const t1 = performance.now();
const def = await call<MeasureResult>('setAvatarMeasurements', {
  measurements: { [WAIST]: small },
});
console.log(`  ⏱ ${((performance.now() - t1) / 1000).toFixed(1)}초 · steps ${def.steps} · simSteps ${def.simSteps}`);
console.log(
  def.steps > 1
    ? `  ✅ 기본값이 단계를 쪼갠다 (Δ2cm → ${def.steps}단계, iterations ${def.simSteps / def.steps})`
    : `  ⛔ steps=${def.steps} — 기본값이 아직 회사 struct 값(100)이다`,
);

// ── ⑥ null 은 "지정 안 함" 이다 ─────────────────────────────
console.log('\n=== ⑥ null 처리 ===');

// ⑥-a 실제 클라이언트가 보낼 모양: 키 25개 전부 + 하나만 숫자
const mixed: Record<string, number | null> = {};
for (const k of names) mixed[k] = null;
mixed[WAIST] = def.avatar?.measurements?.[WAIST]?.real ?? small;
try {
  const r = await call<MeasureResult>('setAvatarMeasurements', {
    measurements: mixed, bodyDimensionStepCm: 100, simulationIterations: 0,
  });
  console.log(`  a) 25개 중 24개 null : applied ${JSON.stringify(r.applied)} · rejected ${JSON.stringify(r.rejected)} · skipped ${r.skipped}`);
  console.log(
    r.rejected.length === 0 && r.applied.length === 1
      ? '  ✅ null 을 조용히 건너뛴다 (rejected 에 안 들어간다)'
      : '  ⛔ null 이 아직 rejected 로 샌다',
  );
} catch (e) {
  console.log('  a) ⛔ 에러 :', (e as Error).message);
}

// ⑥-b 전부 null — "바꿀 것 없음" 이 실패인가
const allNull: Record<string, null> = {};
for (const k of names) allNull[k] = null;
try {
  const r = await call<MeasureResult>('setAvatarMeasurements', { measurements: allNull });
  console.log(`  b) 전부 null : applied ${JSON.stringify(r.applied)} · skipped ${r.skipped} · steps ${r.steps} · simSteps ${r.simSteps}`);
  console.log('  ✅ 에러가 아니다 — "바꿀 것 없음" 은 실패가 아니다');
} catch (e) {
  console.log('  b) ⛔ 에러 :', (e as Error).message);
}

// ⑥-c 진짜 잘못된 값은 여전히 rejected 여야 한다
try {
  const r = await call<MeasureResult>('setAvatarMeasurements', {
    measurements: { [WAIST]: 'wide' as unknown as number, Height: null },
  });
  console.log(`  c) 문자열 값 : applied ${JSON.stringify(r.applied)} · rejected ${JSON.stringify(r.rejected)} · skipped ${r.skipped}`);
} catch (e) {
  console.log('  c) 에러(기대함) :', (e as Error).message);
}

// ⚠️ 되돌리기. `.zls` 는 안 바뀌지만 이 워커 프로세스의 씬은 바뀌었다.
//    quit 으로 프로세스가 죽으므로 상태는 남지 않는다.
console.log('\n워커를 종료한다 (씬 상태는 프로세스와 함께 사라진다).');
await finish(0);
