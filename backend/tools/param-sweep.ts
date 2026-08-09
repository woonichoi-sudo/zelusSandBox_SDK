/**
 * setParams 전수 측정 — 어느 필드가 실제로 물리를 바꾸는가 (ISSUE-014 1안).
 *
 *   node --experimental-strip-types tools/param-sweep.ts
 *   node --experimental-strip-types tools/param-sweep.ts --frames 60 --fields gravityY,subStep
 *
 * 왜 필요한가: `setParams`는 22개 필드를 전부 받아 `getParams`로 그대로
 * 되돌려준다. 그러나 **쓴 값이 물리를 바꾸는 것은 별개의 명제다.** 게이트웨이
 * 스모크 373건이 왕복만 검증하고 이걸 놓쳤다(ISSUE-014). 죽은 필드를 모르고
 * 슬라이더로 내보내면 사용자는 "값을 바꿨는데 옷이 안 변한다"만 보게 된다.
 *
 * 판정 방식:
 *
 *   ① 같은 파라미터로 기준선을 N회 돌려 **지터 바닥**을 잰다. 솔버가
 *      결정적이지 않아 실행마다 결과가 미세하게 다르다(ISSUE-014 실측 ~1%).
 *      이 바닥을 모르면 노이즈를 "반영됨"으로 오독한다.
 *   ② 필드마다 값을 하나 바꿔 돌리고, 기준선과 **정점별로** 비교한다.
 *      AABB 비교로는 부족하다는 것이 ISSUE-011에서 실증됐다 — 쿼터니언을
 *      잘못 읽어도 박스는 0.036cm밖에 안 흔들렸다. 여기서는 "점이 어디에
 *      놓이는가"를 직접 본다.
 *   ③ 변위가 바닥의 MARGIN배를 넘으면 살아있음(alive), 아니면 죽음(dead).
 *
 * 실행마다 워커를 새로 띄운다. 파라미터가 세션에 남아 다음 측정을 오염시키는
 * 경로를 원천 차단하는 값이 기동 비용(~3s)보다 크다.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SimulationParams } from '../src/sdk/protocol.ts';
import { Session, type DecodedPattern } from '../src/sdk/session.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const EXE = resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');

// ISSUE-014를 드러낸 씬을 그대로 쓴다. sample.zls는 드레이프 상태가 아니라
// 중력·충돌 계열의 차이가 덜 드러난다.
const ZLS = resolve(ROOT, 'backend/data/incoming/W_Bra top & Leggings.zls');

/** 기준선 반복 횟수. 최소 2회여야 지터 바닥이 나온다. */
const BASELINE_RUNS = 3;

/** 지터 바닥의 몇 배를 넘어야 "반영됨"으로 볼 것인가. */
const MARGIN = 5;

// ── 변주 값 ─────────────────────────────────────────────────
//
// 필드마다 후보를 여러 개 둔다. 기준선 값과 같은 값을 걸면 측정이 무의미해지므로
// **기준선과 다른 첫 후보**를 고른다. 실제로 건 값은 결과 표에 남는다.
//
// 값 선택 기준: 물리가 그 필드를 본다면 100프레임 안에 눈에 띄어야 하는 크기.
// 미지근한 변화는 지터에 묻혀 살아있는 필드를 죽었다고 오판하게 만든다.
const VARIANTS: Record<keyof SimulationParams, unknown[]> = {
  timeStep:              [90, 45],
  subStep:               [8, 4],
  drapingTime:           [3.0, 0],
  gravityY:              [0, -980],
  groundPlane:           [true, false],
  groundFriction:        [0.9, 0.0],
  groundMargin:          [5.0, 0.1],
  useWind:               [true, false],
  windMagnitude:         [500, 0],
  solverType:            [1, 0, 2],
  preconditioner:        [1, 0, 2],
  nonlinearIterations:   [10, 1],
  maxSolverIterations:   [5, 500],
  solverTolerance:       [1e-1, 1e-6],
  useIEQS:               [true, false],
  staticCouplingMethod:  [1, 0, 2],
  dynamicCouplingMethod: [1, 0, 2],
  dynCouplingStiffness:  [0, 1e5],
  dynCouplingDamping:    [0, 1e5],
  untanglingStiffness:   [0, 1e5],
  untanglingDamping:     [0, 1e5],
  meshingEdgeLength:     [4.0, 0.5],
};

/**
 * 짝으로만 의미가 있는 조합. `windMagnitude`는 `useWind`가 꺼져 있으면
 * 원리상 아무 일도 안 한다 — 단독 결과가 "죽음"으로 나와도 그것이 필드가
 * 무효라는 뜻은 아니다. 둘을 같이 걸어 그 혼동을 가른다.
 */
const PAIRED: { label: string; params: Partial<SimulationParams> }[] = [
  { label: 'useWind+windMagnitude', params: { useWind: true, windMagnitude: 500 } },
];

// ── 비교 ────────────────────────────────────────────────────

interface Diff {
  /** 정점별 변위의 평균 (cm) */
  mean: number;
  /** 정점별 변위의 최대 (cm) */
  max: number;
  /** 토폴로지가 달라져 정점별 비교가 불가능했다 */
  reshaped: boolean;
  note: string;
}

/**
 * 두 지오메트리를 uuid로 맞춰 정점별 거리를 잰다.
 *
 * 정점 수나 패턴 구성이 달라지면 정점별 비교 자체가 성립하지 않는다.
 * 그런데 그것은 실패가 아니라 **가장 강한 증거다** — 리메싱이 일어났다는
 * 뜻이므로 그 필드는 확실히 살아 있다. reshaped로 구분해 보고한다.
 */
function compare(a: DecodedPattern[], b: DecodedPattern[]): Diff {
  const byUuid = new Map(b.map((p) => [p.uuid, p]));

  if (a.length !== b.length) {
    return { mean: Infinity, max: Infinity, reshaped: true, note: `패턴 수 ${a.length}→${b.length}` };
  }

  let sum = 0;
  let count = 0;
  let max = 0;

  for (const pa of a) {
    const pb = byUuid.get(pa.uuid);
    if (!pb) {
      return { mean: Infinity, max: Infinity, reshaped: true, note: `패턴 ${pa.uuid.slice(0, 8)} 사라짐` };
    }
    if (pa.positions.length !== pb.positions.length) {
      return {
        mean: Infinity,
        max: Infinity,
        reshaped: true,
        note: `정점 수 ${pa.vertices}→${pb.vertices}`,
      };
    }

    // 길이가 같은 것은 위에서 확인했고 3의 배수로만 훑으므로 범위를 벗어나지
    // 않는다. noUncheckedIndexedAccess가 그걸 모를 뿐이다.
    for (let i = 0; i + 2 < pa.positions.length; i += 3) {
      const dx = pa.positions[i]! - pb.positions[i]!;
      const dy = pa.positions[i + 1]! - pb.positions[i + 1]!;
      const dz = pa.positions[i + 2]! - pb.positions[i + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      sum += d;
      count++;
      if (d > max) max = d;
    }
  }

  return { mean: count ? sum / count : 0, max, reshaped: false, note: '' };
}

// ── 한 회차 ─────────────────────────────────────────────────

interface RunResult {
  geometry: DecodedPattern[];
  params: SimulationParams;
  seconds: number;
  frames: number;
  /** pause가 실제로 걸린 프레임. 회차 간 비교의 전제다 */
  stoppedAt: number;
}

/**
 * `--reset`용. setParams 뒤 start 전에 reset을 한 번 건다.
 *
 * 왜 필요한가: 0cm이 나온 필드가 **무효한 것**과 **로드/초기화 시점에만 읽히는 것**은
 * 다른 사실이고, #16에서 다른 처리를 받아야 한다(전자는 스키마에서 빼고, 후자는
 * "다시 초기화해야 적용" 표시를 단다). 이 갈래 없이는 둘을 가를 수 없다.
 */
async function run(
  label: string,
  params: Partial<SimulationParams>,
  frames: number,
  withReset = false,
): Promise<RunResult> {
  const t0 = Date.now();
  const session = await Session.create({ exePath: EXE });

  try {
    await session.load(ZLS);

    // 순서가 중요하다: 로드 뒤, start 전. ISSUE-014를 드러낸 실험과 같은 순서다.
    if (Object.keys(params).length > 0) {
      const r = await session.setParams(params);
      if (r.unknown?.length) throw new Error(`${label}: 모르는 키 ${r.unknown.join(',')}`);
    }

    // 워커가 실제로 무엇을 들고 있는지 되읽는다. 값이 안 걸렸는데 "죽음"으로
    // 기록하면 원인을 엉뚱한 데서 찾게 된다.
    const applied = await session.getParams();

    if (withReset) await session.reset();

    await session.start();
    const reached = await session.waitForFrame(frames);
    await session.pause();

    // 실제로 어느 프레임에서 멈췄는지 워커에게 되묻는다. waitForFrame은
    // "N에 도달했다"만 보장하고, pause가 도착하기까지 시뮬이 더 나갈 수 있다.
    // 회차마다 정지 프레임이 다르면 그 차이가 파라미터 효과로 둔갑한다 —
    // 지터 바닥 0cm을 믿으려면 이 값이 회차 간에 같아야 한다.
    const st = await session.status();

    const geometry = await session.geometry(false);
    return {
      geometry,
      params: applied,
      seconds: (Date.now() - t0) / 1000,
      frames: reached,
      stoppedAt: st.frame,
    };
  } finally {
    await session.dispose();
  }
}

// ── 본체 ────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 0.001) return n.toExponential(1);
  return n.toFixed(4);
}

async function main(): Promise<void> {
  for (const [label, p] of [['exe', EXE], ['씬', ZLS]] as const) {
    if (!existsSync(p)) {
      console.error(`${label}을 찾을 수 없습니다: ${p}`);
      process.exit(1);
    }
  }

  const frames = Number(arg('frames') ?? 100);
  const only = arg('fields')?.split(',').map((s) => s.trim()).filter(Boolean);
  const withReset = process.argv.includes('--reset');

  const allFields = Object.keys(VARIANTS) as (keyof SimulationParams)[];
  const fields = only ? allFields.filter((f) => only.includes(f)) : allFields;
  const paired = only ? [] : PAIRED;

  console.log('\n=== setParams 전수 측정 (ISSUE-014) ===\n');
  console.log(`씬      ${ZLS}`);
  console.log(`프레임  ${frames}`);
  console.log(`대상    ${fields.length}개 필드 + 짝 ${paired.length}개`);
  console.log(`갈래    setParams 뒤 ${withReset ? 'reset을 걸고' : 'reset 없이'} start`);
  console.log(`회차    기준선 ${BASELINE_RUNS} + ${fields.length + paired.length} = ${BASELINE_RUNS + fields.length + paired.length}\n`);

  // ── ① 지터 바닥 ─────────────────────────────────────────
  console.log('── 기준선 (파라미터를 걸지 않는다) ──');
  const baselines: RunResult[] = [];
  for (let i = 0; i < BASELINE_RUNS; i++) {
    const r = await run(`baseline#${i}`, {}, frames, withReset);
    baselines.push(r);
    console.log(
      `  기준선 ${i + 1}/${BASELINE_RUNS}  ${r.seconds.toFixed(1)}s  도달=${r.frames} 정지=${r.stoppedAt}  패턴 ${r.geometry.length}개`,
    );
  }

  const stops = new Set(baselines.map((b) => b.stoppedAt));
  if (stops.size > 1) {
    console.log(
      `\n  ⚠️ 기준선의 정지 프레임이 갈린다 (${[...stops].join(', ')}). ` +
        `이 상태의 변위는 파라미터 효과가 아니라 정지 시점 차이일 수 있다.`,
    );
  }

  const ref = baselines[0];
  if (!ref) throw new Error('기준선이 하나도 없다 — BASELINE_RUNS를 확인할 것');
  let floor = 0;
  let floorMax = 0;
  for (let i = 1; i < baselines.length; i++) {
    const d = compare(ref.geometry, baselines[i]!.geometry);
    console.log(`  기준선 1↔${i + 1}  평균 ${fmt(d.mean)}cm  최대 ${fmt(d.max)}cm`);
    if (d.mean > floor) floor = d.mean;
    if (d.max > floorMax) floorMax = d.max;
  }

  // 완전 결정적이면 바닥이 0이 된다. 그때는 float 오차 수준의 문턱을 쓴다.
  const threshold = Math.max(floor * MARGIN, 1e-4);
  console.log(`\n  지터 바닥 ${fmt(floor)}cm → 판정 문턱 ${fmt(threshold)}cm (바닥 ×${MARGIN})\n`);

  // ── ② 필드별 ────────────────────────────────────────────
  interface Row {
    field: string;
    from: unknown;
    to: unknown;
    diff: Diff;
    seconds: number;
    stuck: boolean;
    /** 기준선과 정지 프레임이 다르면 변위의 출처가 흐려진다 */
    stopDrift: number;
  }
  const rows: Row[] = [];

  console.log('── 필드별 ──');
  for (const field of fields) {
    const current = ref.params[field] as unknown;
    const candidates = VARIANTS[field];
    const value = candidates.find((c) => c !== current) ?? candidates[0];

    let row: Row;
    try {
      const r = await run(field, { [field]: value } as Partial<SimulationParams>, frames, withReset);
      const readBack = r.params[field] as unknown;
      // 부동소수 왕복으로 값이 미세하게 달라질 수 있으니 근사 비교한다.
      const stuck =
        typeof value === 'number' && typeof readBack === 'number'
          ? Math.abs(readBack - value) > Math.abs(value) * 1e-3 + 1e-6
          : readBack !== value;
      const diff = compare(ref.geometry, r.geometry);
      row = {
        field,
        from: current,
        to: value,
        diff,
        seconds: r.seconds,
        stuck,
        stopDrift: r.stoppedAt - ref.stoppedAt,
      };
    } catch (e) {
      row = {
        field,
        from: current,
        to: value,
        diff: { mean: NaN, max: NaN, reshaped: false, note: String((e as Error).message).slice(0, 60) },
        seconds: 0,
        stuck: false,
        stopDrift: 0,
      };
    }

    rows.push(row);
    const verdict = row.diff.reshaped
      ? '리메싱'
      : Number.isNaN(row.diff.mean)
        ? '오류'
        : row.diff.mean > threshold
          ? '살아있음'
          : '죽음';
    console.log(
      `  ${field.padEnd(22)} ${String(current).padStart(10)} → ${String(value).padEnd(10)}` +
        ` 평균 ${fmt(row.diff.mean).padStart(9)}cm  ${verdict}` +
        `${row.stuck ? '  ⚠️값이 안 걸림' : ''}` +
        `${row.stopDrift ? `  ⚠️정지 프레임 ${row.stopDrift > 0 ? '+' : ''}${row.stopDrift}` : ''}` +
        `${row.diff.note ? `  (${row.diff.note})` : ''}`,
    );
  }

  for (const p of paired) {
    const r = await run(p.label, p.params, frames, withReset);
    const diff = compare(ref.geometry, r.geometry);
    rows.push({
      field: p.label,
      from: '—',
      to: JSON.stringify(p.params),
      diff,
      seconds: r.seconds,
      stuck: false,
      stopDrift: r.stoppedAt - ref.stoppedAt,
    });
    const verdict = diff.reshaped ? '리메싱' : diff.mean > threshold ? '살아있음' : '죽음';
    console.log(`  ${p.label.padEnd(22)} ${JSON.stringify(p.params).padEnd(23)} 평균 ${fmt(diff.mean).padStart(9)}cm  ${verdict}`);
  }

  // ── ③ 표 ────────────────────────────────────────────────
  console.log('\n── 결과 (ISSUES.md에 붙일 형태) ──\n');
  console.log('| 필드 | 시도한 값 | 평균 변위 | 최대 변위 | 판정 |');
  console.log('|---|---|---|---|---|');

  const dead: string[] = [];
  const alive: string[] = [];

  for (const r of rows) {
    const verdict = r.diff.reshaped
      ? '**리메싱** (토폴로지가 바뀜)'
      : Number.isNaN(r.diff.mean)
        ? `오류 — ${r.diff.note}`
        : r.diff.mean > threshold
          ? '반영됨'
          : '**반영 안 됨**';
    if (!Number.isNaN(r.diff.mean)) {
      (r.diff.reshaped || r.diff.mean > threshold ? alive : dead).push(r.field);
    }
    console.log(
      `| \`${r.field}\` | ${String(r.from)} → ${String(r.to)} | ${fmt(r.diff.mean)}cm | ${fmt(r.diff.max)}cm | ${verdict}` +
        `${r.stuck ? ' ⚠️값이 안 걸림' : ''}` +
        `${r.stopDrift ? ` ⚠️정지 프레임 ${r.stopDrift > 0 ? '+' : ''}${r.stopDrift}` : ''} |`,
    );
  }

  console.log(`\n지터 바닥 ${fmt(floor)}cm (기준선 ${BASELINE_RUNS}회), 판정 문턱 ${fmt(threshold)}cm.`);
  console.log(`살아있음 ${alive.length}개: ${alive.join(', ')}`);
  console.log(`죽음 ${dead.length}개: ${dead.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
