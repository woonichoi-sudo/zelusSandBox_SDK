/**
 * 치수(cm)로 몸을 만드는 판단 (W-2) — **DOM 도 three 도 만지지 않는다.**
 *
 * `avatarBody.ts`(체형 29개, 값 보관)와 `draping.ts`(op 하나짜리 상태 기계)의
 * **둘 다**를 닮았다. 값을 들고 있으면서 왕복도 스스로 한다 — 그리는 것은
 * `ui/avatarMeasurePanel.ts`, 배선은 `main.ts` 다.
 *
 * ── ★ 왜 `avatarBody.ts` 에서 갈라 나왔나 ────────────────────
 *
 * 같은 아바타를 만지는 경로가 **둘**인데 성격이 정반대다:
 *
 * | | `setAvatarBody` (L-3a) | `setAvatarMeasurements` (W-2) |
 * |---|---|---|
 * | 어휘 | 셰이퍼 파라미터 29개, 정규화 0~1 | **치수 25개, cm** |
 * | 시간 | 즉시 | **10초 이상** (실측 Δ15cm = 15.4초) |
 * | 되읽기 | `avatar` (그 자리에서) | `measured` (이 op 만이 준다) |
 * | 치수에 미치는 영향 | **낡게 만든다** | **정본을 준다** |
 *
 * 시간이 갈리는 지점이 결정적이다. 체형 패널은 값을 담는 그릇이면 충분하지만
 * 이쪽은 **왕복 중** 이라는 상태를 화면에 말해야 하고, 실패 갈래도 따로 있다
 * (아래 `notSupported`). 한 모듈에 넣으면 슬라이더를 미는 동안에도 왕복
 * 상태 기계가 같이 돌게 된다.
 *
 * 대신 **낡음의 정본은 여기 하나**다. `setAvatarBody` 를 보낸 쪽이
 * `noteBodyParamsApplied()` 로 알려 주고(배선 한 줄), `measured` 가 오면
 * 스스로 풀린다.
 *
 * ── ★ `measurementsStale` 의 의미를 좁혔다 ───────────────────
 *
 * L-3a 의 그것은 *"체형을 한 번이라도 보낸 뒤로 참"* 이었고 **푸는 방법이
 * 없었다** — 화면은 "낡았다" 고 말만 하고 진짜 값을 보여줄 길이 없었다.
 * `measured` 라는 정본이 생기면서 한 번 좁혔고, **ISSUE-021 이 닫히면서
 * 한 번 더 좁혀졌다**(2026-08-12):
 *
 *   - `setAvatarBody` 를 보내면 → **응답의 `measurementSource` 가 가른다.**
 *     `live` 면 되읽은 값으로 표를 갱신하고 **거짓**, 아니면 참
 *   - `setAvatarMeasurements` 응답의 `measured` 를 받으면 **거짓** (25개 전부
 *     다시 잰 값이다)
 *   - 씬을 새로 읽으면 거짓 (로드 시점의 스냅샷이 곧 지금 몸이다)
 *
 * ⚠️ **플래그를 지우지 않는 이유가 남아 있다.** 제타가 아닌 아바타에는
 *    `GetMeasurement()` 경로가 없어 여전히 씬 데이터로 떨어지고, 그때는 체형을
 *    바꿔도 숫자가 안 움직인다. 옛 워커(필드를 안 보냄)도 같은 자리로 온다.
 *    **"안 움직일 수 있다" 를 기본으로 두는 편이 조심스러운 쪽이다.**
 *
 * ── ⚠️ `notSupported` 는 눌러 봐야 안다 ─────────────────────
 *
 * 워커가 `"이 아바타는 치수 변형을 지원하지 않습니다 (ztDesignZeta 아님)"`
 * 로 거절하는 아바타가 있다. **`avatarBody` 응답에는 그 사실이 실려 있지
 * 않다** — 즉 누르기 전에는 알 수 없다. 그래서 이 모듈은 (a) 처음에는 누를 수
 * 있게 두고, (b) 그 거절을 받으면 **아바타를 다시 읽을 때까지 기억해** 버튼을
 * 잠그고 이유를 화면 글자로 남긴다. 툴팁이 아니다 — 마우스를 올려야 보이는
 * 것은 보이는 게 아니다(#16 에서 확립).
 *
 * ★★ **[실측 2026-08-11] 씬의 성질이 아니라 "지금 아바타" 의 성질이다.**
 *    `sample.zls` 는 **드레이프 전에는 되고 드레이프 뒤에는 안 된다**:
 *
 *      sample.zls   드레이프 전 zeta ✅ → `loadDraping` → ⛔ NotZeta
 *      W_Bra …      드레이프 전후 모두 zeta ✅
 *
 *    `LoadDrapingItem` 이 `SetActiveDrapingItem` 으로 **현재 씬을 드레이핑
 *    아이템의 씬으로 갈아치우기** 때문이다. 그 씬의 아바타가 다른 종류일 수
 *    있다(sample 은 토폴로지까지 달라서 앱이 "포즈가 화면의 토폴로지와
 *    다릅니다" 를 이미 경고한다).
 *
 *    → 그래서 사유 문구를 **"이 씬은 안 된다" 로 쓰면 안 된다.** 사용자가
 *      씬을 다시 로드하면 되는데도 포기하게 만든다. 처음엔 그렇게 적었다가
 *      이 실측으로 고쳤다.
 *
 * ── ★ 목표에 정확히 안 맞는 것은 실패가 아니다 ──────────────
 *
 * **[실측]** 76.647 을 걸면 76.542 가 나온다(99.3%). 셰이퍼의 근사다. 화면이
 * 이걸 빨갛게 칠하면 정상 동작이 고장으로 보인다 — 차이는 **알리되 오류로
 * 만들지 않는다**(`draping.ts` 의 `noAutoItem` 과 같은 판단).
 */

import { t } from './i18n.ts';
import type {
  AvatarBodyResult,
  AvatarMeasurementTargets,
  SetAvatarMeasurementsResult,
} from '../protocol/index.ts';

// ── 시간 예측 ───────────────────────────────────────────────
//
// 워커가 목표까지 `bodyDimensionStepCm` 씩 쪼개 밀면서 단계마다
// `simulationIterations` 번 Step 을 부른다(`protocol.cpp` 의
// `ApplyAvatarMeasurements`). 단계 수는 **가장 많이 변하는 항목** 기준이다.

/** 워커의 기본값. ⚠️ 우리가 정하는 값이 아니라 **워커의 기본값을 적어 둔 것**이다 */
export const DEFAULT_SIM_ITERATIONS = 6;
export const DEFAULT_STEP_CM = 1.0;

/**
 * Step 1회의 실측 비용(초)과 왕복 고정비.
 *
 * **[실측 2026-08-11, Release]** Δ15cm = 단계 16 × 6회 = Step 96회 = 15.4초 /
 * Δ2cm = Step 3회 = 1.59초. 두 점이 `1.2 + 0.16 × simSteps` 위에 있다
 * (15.5 / 1.68). ⚠️ **Debug 는 9배 느리다** — 이 상수는 Release 기준이다.
 */
const FIXED_COST_SEC = 1.2;
const PER_STEP_SEC = 0.16;

/**
 * 게이트웨이가 워커 응답을 기다리는 한계(`backend/src/sdk/worker.ts:68`).
 * 이 위로는 우리가 기다려 봐야 게이트웨이가 먼저 포기한다.
 */
export const WORKER_TIMEOUT_MS = 120_000;

/**
 * ★ **이 op 의 요청 제한 시간. 워커의 한계보다 길게 잡는다.**
 *
 * `GatewayClient` 의 기본값은 60초인데, 그걸 그대로 쓰면 Δ가 클 때
 * **브라우저만 먼저 포기하고 워커는 계속 도는** 상태가 된다 — 화면은 "실패"
 * 라고 말하는데 몸은 바뀌고 있고, 그 뒤에 보낸 요청은 전부 그 뒤에 줄 선다.
 * 우리 쪽에서 취소할 방법이 없으므로(엔진에 취소가 없다) **짧은 제한은 상황을
 * 나쁘게만 만든다.**
 *
 * 그래서 워커의 120초 + 왕복 여유 5초로 둔다. 이 값이면 우리가 먼저 포기하는
 * 일이 없고, 실제로 오래 걸리면 **워커의 진짜 실패 문장**이 화면에 온다.
 * 대가는 "정말 멈춘 요청" 을 125초까지 기다리는 것인데, 그동안 화면은 경과
 * 초를 세며 예상 시간과 함께 무엇을 기다리는지 말한다(`view.text`).
 */
export const REQUEST_TIMEOUT_MS = WORKER_TIMEOUT_MS + 5_000;

/** 워커가 만들 단계 수. `protocol.cpp` 의 `(int)(maxDest / stepCm)` + 마지막 목표 단계 */
export function stepsFor(maxDeltaCm: number, stepCm = DEFAULT_STEP_CM): number {
  if (!(stepCm > 0) || !Number.isFinite(maxDeltaCm)) return 1;
  return Math.floor(Math.abs(maxDeltaCm) / stepCm) + 1;
}

/**
 * 이 변화량이 몇 초쯤 걸릴까. **[추론 위의 실측]** 위 두 상수 참고.
 *
 * 정확할 필요는 없다 — 쓰이는 곳은 (a) 화면이 "예상 16초" 라고 말하는 것과
 * (b) 워커 한계를 넘길 것 같으면 미리 경고하는 것 둘뿐이고, 제한 시간 자체는
 * 이 값을 **쓰지 않는다**(위 `REQUEST_TIMEOUT_MS` 주석).
 */
export function estimateSeconds(
  maxDeltaCm: number,
  iterations = DEFAULT_SIM_ITERATIONS,
  stepCm = DEFAULT_STEP_CM,
): number {
  return FIXED_COST_SEC + PER_STEP_SEC * stepsFor(maxDeltaCm, stepCm) * iterations;
}

// ── 값 검사 ─────────────────────────────────────────────────

/**
 * cm 값이 쓸 수 있는가. **상한은 두지 않는다** — `surfaceSize.ts` 와 같은
 * 판단이다(어떤 몸이 가능한지는 엔진이 알고, 우리가 흉내 내면 두 곳이 어긋난다).
 *
 * 하한만 막는다: 워커가 `-1 < value` 를 요구하고(`protocol.cpp`), 0 이하의
 * 치수는 어차피 몸이 아니다. 여기서 거르면 **그 키만 조용히 `rejected` 로
 * 돌아오는** 왕복 15초를 아낀다.
 */
export function validateMeasure(v: number): string | undefined {
  if (!Number.isFinite(v)) return t('valid.notNumber');
  if (v <= 0) return t('valid.notPositive');
  return undefined;
}

// ── 화면에 그릴 것 ──────────────────────────────────────────

/** 치수 한 줄. **전부 cm 다** */
export interface AvatarMeasureRow {
  /** 엔진 이름 그대로. **한국어 사전을 두지 않는다** — 아래 주석 참고 */
  key: string;
  /**
   * 지금 몸의 치수. 정본은 마지막 `measured` 이고, 안 걸었으면 `avatarBody` 가
   * 준 값이다 — **ISSUE-021 이후 그쪽도 살아 있는 값이라** 둘이 같은 곳에서
   * 온다. 제타가 아닌 아바타에서만 로드 시점 값이고, 그때는 `view.stale` 이 답한다.
   */
  current: number;
  /** 화면이 들고 있는 값. `current` 와 다르면 아직 안 보낸 편집이다 */
  value: number;
  dirty: boolean;
  /** 값이 유효하지 않으면 이유. **화면 글자가 된다** */
  invalid?: string;
  /** 마지막 적용에서 이 치수에 건 목표. 안 걸었으면 없다 */
  target?: number;
  /**
   * 목표와 실제로 잰 값의 차(cm). `target` 이 있을 때만 있다.
   * **오차가 아니라 셰이퍼의 근사다** — 화면이 오류로 칠하면 안 된다.
   */
  offset?: number;
  /** `.zls` 에 저장돼 있던 목표치. 지정된 적이 없으면 없다 */
  expected?: number;
  locked: boolean;
}

export type AvatarMeasurePhase =
  /** 소켓이 없다 */
  | 'disconnected'
  /** 붙었지만 워커에 씬이 없다 */
  | 'noScene'
  /** 씬에 아바타가 없다 */
  | 'noAvatar'
  /**
   * **지금 아바타**가 `ztDesignZeta` 가 아니다. **눌러 봐야 아는 사실이고,
   * 씬의 성질이 아니다** — 드레이프가 아바타를 갈아치울 수 있다(머리말)
   */
  | 'notSupported'
  /** 왕복 중 (10초 이상 걸린다) */
  | 'applying'
  /** 만질 수 있다 */
  | 'ready';

/** 마지막 왕복이 무엇으로 끝났는가. 아직 안 눌렀으면 null */
export type AvatarMeasureOutcome =
  /** 몸이 바뀌었다 */
  | 'applied'
  /** 성공했는데 바뀐 것이 없다 (전부 null/미지정). **오류가 아니다** */
  | 'noChange'
  /** 이 아바타가 치수 변형을 지원하지 않는다 */
  | 'notSupported'
  /** 요청이 실패했다 */
  | 'error';

export interface AvatarMeasureView {
  phase: AvatarMeasurePhase;
  /** 왜 못 쓰는지. `phase` 가 `ready`·`applying` 이 아닐 때만 있다 */
  reason?: string;
  rows: AvatarMeasureRow[];
  /** 아직 안 보낸 편집 수 */
  dirty: number;
  canApply: boolean;
  busy: boolean;
  outcome: AvatarMeasureOutcome | null;
  /** **화면 글자.** 비활성 사유든 진행이든 결과든 여기 한 줄로 나온다 */
  text: string;
  /** 이 글자가 오류인가. 근사 오차·"바뀐 것 없음" 은 **오류가 아니다** */
  isError: boolean;
  /** 지금 편집이 몇 초쯤 걸릴까. 편집이 없으면 null */
  estimateSec: number | null;
  /** 예상이 워커 한계를 넘는가. **막지는 않는다** (예측일 뿐이다) */
  overLimit: boolean;
  /**
   * 표의 숫자가 낡았는가 — **체형 슬라이더(`setAvatarBody`)를 보낸 뒤로 참**
   * 이고 `measured` 를 받으면 풀린다(머리말).
   */
  stale: boolean;
  lastError: Error | null;
}

export interface AvatarMeasureStats {
  calls: number;
  applied: number;
  noChange: number;
  notSupported: number;
  failures: number;
  /** 왕복 중이라 거절한 클릭 수 */
  rejected: number;
  /** 마지막 왕복이 실제로 걸린 시간(ms). 아직 없으면 null */
  lastMs: number | null;
}

// ── 밖에서 주입받는 것 ──────────────────────────────────────

/**
 * 워커에 op 을 보내는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * `DrapingPort`·`PlaybackPort` 와 같은 판단이라 어댑터가 필요 없다.
 */
export interface AvatarMeasurePort {
  readonly connected: boolean;
  setAvatarMeasurements(
    measurements: AvatarMeasurementTargets,
    opts?: { simulationIterations?: number; bodyDimensionStepCm?: number; timeoutMs?: number },
  ): Promise<SetAvatarMeasurementsResult>;
}

export interface AvatarMeasureHooks {
  /**
   * **몸이 실제로 바뀐 뒤**에만 부른다. 이 op 도 프레임 카운터를 -1 로
   * 되돌리므로(`frame:-1`) 화면 쪽은 여기서 **리셋과 같은 뒤처리**를 한다 —
   * `draping.ts` 의 `afterApplied` 와 **같은 자리이고 같은 구현을 재사용한다.**
   *
   * 던져도 op 을 실패로 만들지 않는다. 몸은 이미 바뀌었다.
   */
  afterApplied?: (res: SetAvatarMeasurementsResult) => Promise<void> | void;
  onChange?: (view: AvatarMeasureView) => void;
  log?: (line: string) => void;
}

export interface AvatarMeasureOptions {
  port: AvatarMeasurePort;
  hooks?: AvatarMeasureHooks;
  /** 시계. 테스트가 경과 시간을 못박을 수 있게 뚫어 둔다 */
  now?: () => number;
}

const IDLE_STATS: AvatarMeasureStats = {
  calls: 0, applied: 0, noChange: 0, notSupported: 0, failures: 0, rejected: 0, lastMs: null,
};

/**
 * 워커의 거절 문장에서 "이 아바타는 지원 안 함" 을 알아본다.
 *
 * ⚠️ **문자열 대조다.** 프로토콜에 그 갈래를 나타내는 필드가 없고
 * (`ok:false` + 문장 하나뿐이다), 워커를 고치는 것은 이번 단위 밖이다.
 * 정본은 `backend/native/src/protocol.cpp` 의 `MeasureApplyErrorText` 이고
 * 거기 있는 **타입 이름**(`ztDesignZeta`)을 본다 — 한국어 문구는 다듬어질 수
 * 있지만 타입 이름은 그 갈래의 정체 그 자체다. 못 알아보면 일반 오류로
 * 떨어질 뿐이라 화면이 거짓말을 하지는 않는다.
 */
function looksLikeNotZeta(message: string): boolean {
  return message.includes('ztDesignZeta');
}

export class AvatarMeasureController {
  readonly #port: AvatarMeasurePort;
  readonly #hooks: AvatarMeasureHooks;
  readonly #now: () => number;

  /** 워커가 마지막으로 말한 치수. `measured` 가 오면 통째로 덮인다 */
  #current: Record<string, number> = {};
  /**
   * ★ **로드 시점의 치수. `measured` 로 덮지 않는다** — 예측에만 쓴다.
   *
   * **[실측 2026-08-11]** 워커는 단계 수를 `measurementRealValues`(씬 데이터
   * 사본) 기준으로 센다. 그 값은 이 op 으로 **영영 안 움직이므로**(그래서
   * `measured` 가 필요했다) 두 번째 적용의 출발점도 여전히 로드 시점 값이다.
   * 허리 61.647 → 63.17 로 만든 뒤 70 을 걸었더니 워커가 센 단계는
   * (70−63.17)=7 이 아니라 **(70−61.647)=9** 였다. 지금 몸을 기준으로
   * 예측하면 그만큼 짧게 나온다.
   *
   * ⚠️ 이것은 **예측만의 문제가 아니다.** 안 건 치수들도 같은 사본에서
   *    다시 계산되므로 두 번째 적용은 누적이 아니라 **로드 시점 몸에서
   *    다시 만드는 것**에 가깝다(실측: 허리만 두 번 걸었는데 ArmLength 가
   *    57.08 → 56.70 → 56.67 로 움직였다). 워커/엔진 쪽 사실이고 이 단위가
   *    고칠 자리가 아니다 — 화면은 `measured` 를 그대로 보여줘 거짓말은 하지
   *    않는다.
   */
  #baseline: Record<string, number> = {};
  /** `.zls` 의 목표치·잠금. `avatarBody` 만이 준다 */
  #meta: Record<string, { expected?: number; locked: boolean }> = {};
  /** 아직 안 보낸 편집 (cm) */
  #edits = new Map<string, number>();
  /** 마지막 적용에서 건 목표. 근사 차이를 보여주는 데만 쓴다 */
  #targets = new Map<string, number>();

  #hasAvatar = false;
  #scene = false;
  #applying = false;
  #startedAt = 0;
  #outcome: AvatarMeasureOutcome | null = null;
  #last: SetAvatarMeasurementsResult | null = null;
  #notSupported = false;
  #stale = false;
  #lastError: Error | null = null;
  #stats: AvatarMeasureStats = { ...IDLE_STATS };

  constructor(opts: AvatarMeasureOptions) {
    this.#port = opts.port;
    this.#hooks = opts.hooks ?? {};
    this.#now = opts.now ?? (() => Date.now());
  }

  // ── 밖에서 미는 사실 ──────────────────────────────────────

  /**
   * `avatarBody()` 가 준 것으로 표를 세운다. 편집 중이던 값은 **버린다**
   * (`AvatarBodyPanel.setFromWorker` 와 같은 규약).
   *
   * ★ 여기서 낡음이 풀린다 — 방금 읽은 스냅샷이 곧 지금 몸이다.
   *
   * ★★ **`notSupported` 기억도 여기서 지운다.** 그것은 "지금 아바타" 의
   *    성질이고, 새 아바타를 읽는 순간이 바로 여기다.
   *    ⚠️ `setScene(true→true)` 만 믿으면 안 된다 — 씬 A 에서 씬 B 로 바로
   *    갈아타면 그 불리언은 안 바뀌어 기억이 살아남는다. **실측으로 잡았다
   *    (2026-08-11)**: 다른 씬으로 옮겨 적용에 성공했는데도 화면은 "이
   *    아바타는 치수 변형을 지원하지 않습니다" 라고 말하고 있었다 —
   *    막으려던 것과 정확히 반대 방향의 거짓말이다.
   */
  setFromWorker(res: AvatarBodyResult | null): void {
    this.#edits.clear();
    this.#targets.clear();
    this.#stale = false;
    this.#notSupported = false;
    this.#last = null;
    this.#outcome = null;
    this.#lastError = null;
    this.#current = {};
    this.#baseline = {};
    this.#meta = {};

    if (!res || !res.hasAvatar) {
      this.#hasAvatar = false;
      this.#emit();
      return;
    }
    this.#hasAvatar = true;
    for (const [k, m] of Object.entries(res.measurements ?? {})) {
      this.#current[k] = m.real;
      // 워커가 단계를 세는 기준선. 위 주석 참고 — `measured` 로 안 덮는다.
      this.#baseline[k] = m.real;
      this.#meta[k] = {
        ...(m.expected === undefined ? {} : { expected: m.expected }),
        locked: m.locked,
      };
    }
    this.#emit();
  }

  /**
   * 워커에 씬이 있는가. `DrapingPanel.setScene` 과 같은 자리다 — 이 모듈이
   * 스스로 알아낼 방법이 없고, 알아내려 들면 두 번째 폴링이 된다.
   *
   * 씬이 바뀌면 **`notSupported` 기억을 지운다.** 그 사실은 아바타에 딸린
   * 것이라 다음 씬에서는 다시 눌러 봐야 안다.
   */
  setScene(on: boolean): void {
    if (this.#scene === on) return;
    this.#scene = on;
    this.#notSupported = false;
    this.#emit();
  }

  /** 씬을 내렸다 */
  clear(): void {
    this.setFromWorker(null);
    this.#notSupported = false;
  }

  /** 소켓이 끊겼거나 새 워커가 붙었다. 지난 결과는 죽은 세션의 것이다 */
  reset(): void {
    this.#scene = false;
    this.#applying = false;
    this.#notSupported = false;
    this.setFromWorker(null);
  }

  /**
   * **체형 슬라이더(`setAvatarBody`)를 보냈다.** 워커가 되읽어 준 아바타를
   * 함께 넘긴다(`setAvatarBody` 응답의 `avatar`).
   *
   * ── ★ ISSUE-021 이 닫히면서 이 자리의 답이 뒤집혔다 ─────────
   *
   * 예전에는 **무조건 낡음**이었다. 셰이퍼가 몸을 바꿔도 우리가 읽던 숫자가
   * 씬 데이터 사본이라 안 움직였기 때문이다. 이제 `avatarBody` 가 살아 있는
   * `ztDesignZeta` 에서 직접 재므로(`measurementSource: 'live'`) **되읽은 값이
   * 곧 지금 몸이다** — 실측: `height` 0.5 → 0.9 에 25개 중 19개가 따라 움직인다.
   *
   * 그래서 갈래가 둘이다:
   *   · `live`      → 표를 새 값으로 갱신하고 낡음을 **푼다**
   *   · 그 외/없음  → 옛 동작 그대로 낡음을 **건다** (제타가 아닌 아바타,
   *                   그리고 이 필드를 안 보내는 옛 워커)
   *
   * ⚠️ **`setFromWorker` 를 부르지 않는다.** 저쪽은 편집·목표치까지 지우는
   *    "새 아바타를 읽었다" 용이라, 슬라이더를 미는 동안 사용자가 쳐 둔 cm
   *    입력이 사라진다. 여기서는 **현재값과 메타만** 덮는다.
   */
  noteBodyParamsApplied(res?: AvatarBodyResult | null): void {
    if (!this.#hasAvatar) return;

    const live = res?.hasAvatar === true && res.measurementSource === 'live';
    if (!live) {
      this.#stale = true;
      this.#emit();
      return;
    }

    for (const [k, m] of Object.entries(res?.measurements ?? {})) {
      this.#current[k] = m.real;
      // ★ 기준선도 함께 옮긴다. 워커가 단계 수를 이 값으로 세기 때문이다 —
      //   안 옮기면 "허리를 63 으로 만든 뒤 70 을 걸면 70−61.6 으로 잡힌다" 는
      //   ISSUE-021 의 누적 실패가 화면 쪽에 그대로 남는다.
      this.#baseline[k] = m.real;
      this.#meta[k] = {
        ...(m.expected === undefined ? {} : { expected: m.expected }),
        locked: m.locked,
      };
    }
    this.#stale = false;
    this.#emit();
  }

  // ── 사용자 조작 ───────────────────────────────────────────

  /**
   * 한 칸을 편집했다.
   *
   * 워커 값과 **같아지면 편집을 지운다** — 밀었다가 되돌린 것은 보낼 것이
   * 아니고, 안 지우면 dirty 수가 안 줄어 [적용] 이 켜진 채로 남는다
   * (`AvatarBodyPanel.edit` 과 같은 규약).
   */
  edit(key: string, value: number): void {
    if (!(key in this.#current)) return;
    if (this.#current[key] === value) this.#edits.delete(key);
    else this.#edits.set(key, value);
    this.#emit();
  }

  /** 화면의 편집을 버린다 */
  revert(): void {
    if (this.#edits.size === 0) return;
    this.#edits.clear();
    this.#emit();
  }

  /**
   * 보낼 페이로드. **바뀐 것만 담는다.**
   *
   * ★ 25개를 다 보낼 필요가 없다 — 워커는 **키가 없는 것과 `null` 을 같게
   *   다룬다**(둘 다 `skipped`, 셰이퍼가 자유롭게 계산). `setAvatarBody` 의
   *   "바뀐 값만 보낸다" 규약과 같은 자리다.
   *
   * 못 쓸 값(0 이하·비수)은 **빼고 보낸다.** 실어 보내면 15초를 기다린 끝에
   * 그 키만 `rejected` 로 돌아온다.
   */
  payload(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.#edits) {
      if (validateMeasure(v) === undefined) out[k] = v;
    }
    return out;
  }

  /**
   * 치수를 적용한다. **던지지 않는다** — 버튼 핸들러에서 도는 함수라, 던지면
   * `void` 로 삼켜져 화면에 아무 단서도 안 남는다(`DrapingPanel.apply` 와 같은
   * 규약). 결과는 `view.text` 와 돌려주는 값으로만 보인다.
   *
   * @returns **몸이 실제로 바뀌었는가.** "바꿀 것이 없었다" 도 `false` 다.
   */
  async apply(): Promise<boolean> {
    if (this.#applying) {
      // 연타다. 버튼이 이미 잠겨 있으므로 화면에 새로 말할 것이 없다.
      this.#stats.rejected += 1;
      return false;
    }
    if (!this.#port.connected) {
      // 이 사유는 `#text()` 를 지나 **화면 글자**가 된다 — 번역 대상이다 (I-1)
      this.#fail(new Error(t('err.notConnected')));
      return false;
    }
    if (!this.#scene || !this.#hasAvatar) {
      this.#fail(new Error(t('err.noAvatarScene')));
      return false;
    }
    const payload = this.payload();
    if (Object.keys(payload).length === 0) {
      // ⚠️ 게이트웨이가 빈 객체를 거절한다. 여기서 막으면 왕복이 아예 없다.
      this.#fail(new Error(t('err.noMeasureToSend')));
      return false;
    }

    this.#applying = true;
    this.#startedAt = this.#now();
    this.#lastError = null;
    this.#outcome = null;
    this.#targets = new Map(Object.entries(payload));
    this.#emit();

    this.#log(
      `치수 적용 시작 — ${Object.entries(payload).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}`
      + ` · 예상 ${this.#estimate(payload).toFixed(0)}초`,
    );

    let res: SetAvatarMeasurementsResult;
    try {
      res = await this.#port.setAvatarMeasurements(payload, { timeoutMs: REQUEST_TIMEOUT_MS });
      this.#stats.calls += 1;
    } catch (err: unknown) {
      this.#applying = false;
      this.#stats.calls += 1;
      this.#stats.lastMs = this.#now() - this.#startedAt;
      const e = err instanceof Error ? err : new Error(String(err));
      if (looksLikeNotZeta(e.message)) {
        // ★ **지금 아바타로는** 안 된다(영영이 아니다 — 머리말 참고).
        //   기억해 두고 버튼을 잠근다: 같은 15초를 다시 기다리게 하지 않는다.
        //   기억은 아바타를 다시 읽을 때 `setFromWorker` 가 지운다.
        this.#notSupported = true;
        this.#outcome = 'notSupported';
        this.#lastError = e;
        this.#stats.notSupported += 1;
        this.#targets.clear();
        this.#log('치수 — 지금 아바타는 치수 변형을 지원하지 않습니다 (ztDesignZeta 아님)'
          + ' · 드레이프를 적용한 뒤라면 씬을 다시 로드하십시오');
        this.#emit();
        return false;
      }
      this.#targets.clear();
      this.#fail(e);
      return false;
    }

    this.#applying = false;
    this.#stats.lastMs = this.#now() - this.#startedAt;
    this.#last = res;
    // 성공했다는 것 자체가 이 아바타가 지원한다는 증거다. 두 겹으로 지운다 —
    // 한쪽이 새면 화면이 "지원 안 함" 이라고 말하면서 값은 바뀌어 있다.
    this.#notSupported = false;

    // ★ 되읽기의 정본. **비어 있을 수 있다** — 적용된 것이 하나도 없으면
    //   워커가 다시 재지 않는다(실측: `skipped:25` 면 `measured` 는 `{}`).
    const measured = Object.entries(res.measured ?? {});
    if (measured.length > 0) {
      for (const [k, v] of measured) this.#current[k] = v;
      // 25개를 통째로 다시 잰 값이다. 이제 표는 낡지 않았다.
      this.#stale = false;
    }

    // 보낸 것은 반영됐으므로 그 편집만 비운다. 남기면 [적용] 이 켜진 채로
    // 남아 같은 요청을 한 번 더 보내게 된다(15초짜리다). **보낸 것만** 지우는
    // 이유는 못 쓸 값이라 빠진 칸이 있을 수 있어서다 — 그 칸은 여전히 고쳐야
    // 하는 편집이고, 지우면 사용자가 쓴 값이 소리 없이 사라진다.
    for (const k of Object.keys(payload)) this.#edits.delete(k);

    if (res.applied.length === 0) {
      this.#outcome = 'noChange';
      this.#stats.noChange += 1;
      this.#targets.clear();
      this.#log(`치수 — 바뀐 것이 없습니다 (건너뜀 ${res.skipped})`);
      this.#emit();
      return false;
    }

    this.#outcome = 'applied';
    this.#stats.applied += 1;
    this.#log(
      `치수 적용 — ${res.applied.join(', ')}`
      + ` · 단계 ${res.steps} · Step ${res.simSteps}회 · ${((this.#stats.lastMs ?? 0) / 1000).toFixed(1)}초`
      + (res.unknown.length > 0 ? ` · ⚠ 모르는 치수 ${res.unknown.join(', ')}` : '')
      + (res.rejected.length > 0 ? ` · ⚠ 못 쓴 값 ${res.rejected.join(', ')}` : '')
      + ' · 프레임 카운터가 -1 로 되돌아갔습니다',
    );

    try {
      // 리셋과 같은 뒤처리. 실패해도 몸은 이미 바뀌었다.
      await this.#hooks.afterApplied?.(res);
    } catch (err: unknown) {
      this.#log(`치수 적용 후 화면을 갱신하지 못했습니다: ${messageOf(err)}`);
    }

    this.#emit();
    return true;
  }

  // ── 관찰 ──────────────────────────────────────────────────

  get busy(): boolean {
    return this.#applying;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  get stats(): AvatarMeasureStats {
    return { ...this.#stats };
  }

  get phase(): AvatarMeasurePhase {
    if (this.#applying) return 'applying';
    if (!this.#port.connected) return 'disconnected';
    if (!this.#scene) return 'noScene';
    if (!this.#hasAvatar) return 'noAvatar';
    if (this.#notSupported) return 'notSupported';
    return 'ready';
  }

  get view(): AvatarMeasureView {
    const phase = this.phase;
    const rows = this.#rows();
    const dirty = this.#edits.size;
    const invalid = rows.some((r) => r.invalid !== undefined);
    const est = dirty > 0 ? this.#estimate(this.payload()) : null;
    const reason = this.#reason(phase);

    return {
      phase,
      ...(reason === undefined ? {} : { reason }),
      rows,
      dirty,
      canApply: phase === 'ready' && dirty > 0 && !invalid,
      busy: this.#applying,
      outcome: this.#outcome,
      text: this.#text(phase, est),
      // 근사 오차도 "바뀐 것 없음" 도 오류가 아니다 — 빨갛게 칠하면 정상
      // 동작이 고장으로 보인다(`draping.ts` 의 noAutoItem 과 같은 판단).
      isError: this.#outcome === 'error',
      estimateSec: est,
      overLimit: est !== null && est * 1000 > WORKER_TIMEOUT_MS,
      stale: this.#stale,
      lastError: this.#lastError,
    };
  }

  // ── 내부 ──────────────────────────────────────────────────

  #rows(): AvatarMeasureRow[] {
    return Object.entries(this.#current).map(([key, current]) => {
      const edit = this.#edits.get(key);
      const value = edit ?? current;
      const invalid = edit === undefined ? undefined : validateMeasure(edit);
      const target = this.#targets.get(key);
      const meta = this.#meta[key];
      return {
        // ⚠️ 치수에는 한국어 사전을 두지 않는다. cm 단위의 **실제 치수**라
        //    이름이 틀리면 사용자가 잘못된 부위를 잘못된 값으로 만든다 —
        //    엔진 이름을 그대로 두는 편이 안전하다(L-3a 와 같은 판단).
        key,
        current,
        value,
        dirty: edit !== undefined,
        ...(invalid === undefined ? {} : { invalid }),
        ...(target === undefined ? {} : { target, offset: current - target }),
        ...(meta?.expected === undefined ? {} : { expected: meta.expected }),
        locked: meta?.locked ?? false,
      };
    });
  }

  /**
   * 가장 많이 변하는 항목이 단계 수를 정한다 (`protocol.cpp` 의 `maxDest`).
   *
   * ★ **화면에 보이는 값이 아니라 `#baseline` 에서 잰다** — 워커가 그렇게
   *   세기 때문이다(위 `#baseline` 주석의 실측). 여기서 `#current` 를 쓰면
   *   두 번째 적용부터 예상이 짧게 나오고, 그 어긋남은 "왜 예상보다 오래
   *   걸리지" 로만 드러나 원인을 못 찾는다.
   */
  #estimate(payload: Record<string, number>): number {
    let max = 0;
    for (const [k, v] of Object.entries(payload)) {
      const from = this.#baseline[k] ?? this.#current[k];
      if (from === undefined) continue;
      max = Math.max(max, Math.abs(v - from));
    }
    return estimateSeconds(max);
  }

  #reason(phase: AvatarMeasurePhase): string | undefined {
    switch (phase) {
      case 'disconnected': return t('meas.disconnected');
      case 'noScene': return t('meas.noScene');
      case 'noAvatar': return t('avatar.none');
      case 'notSupported':
        // ★ 이 갈래를 글자로 말하지 않으면 "눌렀는데 아무 일도 없다" 가 된다.
        //
        // ⚠️ **"이 씬은 안 된다" 고 말하지 않는다.** 씬이 아니라 **지금 아바타**
        //    의 성질이고, 같은 씬에서도 드레이프 전에는 됐을 수 있다(머리말의
        //    실측 참고). 씬 탓으로 적으면 사용자가 되돌릴 수 있는데도 포기한다.
        return t('meas.notSupported');
      default: return undefined;
    }
  }

  /**
   * 표 위에 그대로 찍는 한 줄.
   *
   * **비활성 사유가 결과보다 먼저다** (`draping.ts` 와 같은 규약) — 씬을 내린
   * 뒤에도 "치수 적용됨" 이 남아 있으면 그 글자가 지금 화면의 몸을 가리키는
   * 것처럼 읽힌다.
   */
  #text(phase: AvatarMeasurePhase, est: number | null): string {
    if (phase === 'applying') {
      const sec = Math.max(0, (this.#now() - this.#startedAt) / 1000);
      const want = this.#estimate(Object.fromEntries(this.#targets));
      return t('meas.applying', { sec: sec.toFixed(0), want: want.toFixed(0) });
    }
    const reason = this.#reason(phase);
    if (reason !== undefined) return reason;

    switch (this.#outcome) {
      case 'applied': {
        const res = this.#last;
        const took = ((this.#stats.lastMs ?? 0) / 1000).toFixed(1);
        const worst = this.#worstOffset();
        // ⛔ `applied`·`unknown`·`rejected` 안의 이름은 **엔진이 준 부위명**
        //    (`WaistCircum` …)이라 번역하지 않는다.
        return t('meas.applied', {
          applied: res?.applied.join(', ') ?? '',
          sec: took,
          steps: res?.steps ?? 0,
        })
          // ★ 근사는 실패가 아니다. 그래도 조용히 넘기지 않는다 —
          //   숫자가 목표와 다른 이유를 화면이 말해 주지 않으면 사용자가
          //   "적용이 안 됐다" 고 읽는다.
          + (worst === null ? '' : t('meas.approx', { cm: worst.toFixed(2) }))
          + (res && res.unknown.length > 0 ? t('meas.unknown', { keys: res.unknown.join(', ') }) : '')
          + (res && res.rejected.length > 0 ? t('meas.rejected', { keys: res.rejected.join(', ') }) : '');
      }
      case 'noChange':
        return t('meas.noChange');
      case 'notSupported':
        // phase 가 notSupported 라 위에서 이미 걸린다. 씬이 바뀌어 기억이
        // 지워졌는데 결과만 남은 경우를 위해 남겨 둔다.
        return this.#reason('notSupported') as string;
      case 'error':
        return t('meas.failed', { why: this.#lastError?.message ?? t('err.unknown') });
      default:
        if (est === null) return '';
        return t('meas.edited', { n: this.#edits.size, sec: est.toFixed(0) })
          + (est * 1000 > WORKER_TIMEOUT_MS
            ? t('meas.tooLong', { limit: WORKER_TIMEOUT_MS / 1000 })
            : '');
    }
  }

  /** 목표와 가장 많이 어긋난 값(cm). 목표가 없으면 null */
  #worstOffset(): number | null {
    let worst: number | null = null;
    for (const [k, target] of this.#targets) {
      const now = this.#current[k];
      if (now === undefined) continue;
      const d = Math.abs(now - target);
      if (worst === null || d > worst) worst = d;
    }
    return worst;
  }

  #fail(err: Error): void {
    this.#outcome = 'error';
    this.#lastError = err;
    this.#stats.failures += 1;
    this.#emit();
  }

  #emit(): void {
    if (!this.#hooks.onChange) return;
    try {
      this.#hooks.onChange(this.view);
    } catch {
      // 화면을 그리다 던진 것이 조작을 죽이면 안 된다 (draping.ts 와 같다).
    }
  }

  #log(line: string): void {
    this.#hooks.log?.(line);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
