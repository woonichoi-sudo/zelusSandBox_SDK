/**
 * 시뮬레이션 파라미터 스키마 (#16-a) — **DOM 도 three 도 만지지 않는다.**
 *
 * `playback.ts` 와 같은 규약이다. 위젯 22개를 손으로 쓰지 않고 **표 하나**가
 * 패널 렌더링(16-b) · `setParams` 페이로드 · 값 검증을 전부 덮는다. 표가 하나면
 * "화면에는 있는데 안 보내는 필드" 나 "보내는데 화면에 없는 필드" 가 표현
 * 불가능해진다 — `playback.ts` 가 상태를 파생시킨 것과 같은 이유다.
 *
 * ── ★ 이 스키마는 [ISSUE-014](../../../ISSUES.md#issue-014) 의 전수 측정 위에 선다 ──
 *
 * **[실측]** 2026-08-09, `backend/tools/param-sweep.ts` 로 22개 필드를 전수
 * 측정했다. 필드마다 워커를 새로 띄워 `W_Bra top & Leggings.zls` 를 100프레임
 * 돌리고 기준선과 **정점 하나하나**를 짝지어 비교했다. 기준선 3회가 비트 단위로
 * 같아 **지터 바닥이 0cm** 다 — 솔버가 결정적이므로 0.1cm 짜리 신호도 사실이다.
 *
 * 그 결과 22개가 셋으로 갈렸고, **`effect` 필드가 그 분류를 그대로 들고 간다:**
 *
 *   effective   (17) 값을 바꾸면 옷이 움직인다. 평범한 위젯
 *   conditional (3)  조건이 붙는다. `windMagnitude`(`useWind` 필요) ·
 *                    `groundPlane`·`groundFriction`(바닥에 닿는 씬 필요)
 *   dead        (2)  `subStep` · `meshingEdgeLength`. **엔진이 값을 보지 않는다**
 *
 * ── 죽은 필드를 왜 스키마에서 빼지 않는가 ──────────────────
 *
 * 빼면 **왜 없는지가 코드 어디에도 안 남는다.** 다음 사람이 프로토콜의
 * `SimulationParams` 를 보고 "필드가 22갠데 패널은 20개네, 빠뜨렸나" 하며 같은
 * 측정을 처음부터 다시 하게 된다. 남겨 두고 `effect: 'dead'` 로 표시하면
 * ① 화면이 "엔진 미지원" 이라고 **이유를 말하고**
 * ② `buildSetParamsPayload` 가 **페이로드에서 빼며**(워커는 성공 응답을 주지만
 *    아무 일도 안 하므로 보낼 이유가 없다)
 * ③ 엔진이 고쳐지면 `effect` 한 글자만 바꾸면 되살아난다.
 *
 * ⚠️ 회색으로만 만들고 이유를 안 적으면 그게 바로 #14 가 없애려던 거짓말이다.
 *    그래서 비활성 판정은 반드시 **이유와 함께** 돌려준다(`ParamDisabled`).
 *
 * ── ★ `solverType` 함정 — 데스크톱의 버그를 옮기지 않는다 ───
 *
 * 데스크톱은 "solver type"(적분기, `MainGUI.cpp:470`)과 "Collision solver"
 * (충돌 솔버, `MainGUI.cpp:642`)를 **같은 `solverType` 필드에 쓴다**
 * (PROJECT_ANALYSIS.md §9 ①). 충돌 솔버를 바꾸면 적분기가 조용히 손상되고
 * 정작 충돌 솔버는 설정되지 않는다. **우리 `solverType` 은 적분기 하나만
 * 가리킨다.** 충돌 솔버를 언젠가 노출하더라도 이 키를 재사용하지 말 것.
 *
 * ── min/max/step 과 열거형 라벨의 출처 ──────────────────────
 *
 * `source` 가 필드마다 그걸 말한다.
 *
 *   'code'  데스크톱 위젯이 실제로 그 범위를 쓴다 (`MainGUI.cpp` 행 번호를 주석에)
 *   'guess' 데스크톱에 위젯이 **없다.** 실측 기본값 주변의 추정이다
 *
 * ⚠️ **`step` 은 전부 추정이다** — 출처와 무관하다. ImGui 의 `SliderFloat`/
 *    `SliderInt` 는 연속 슬라이더라 스텝 개념이 없다. 화면에서 쓰기 좋은 값을
 *    골랐을 뿐이므로 `step` 을 근거로 무언가를 판단하지 말 것.
 *
 * 열거형 라벨은 넷 다 **코드 근거가 있다.** 라벨 문자열은 `MainGUI.cpp` 의 배열,
 * 숫자 값은 `Zest/Zelus/zsSimulation.h` 의 enum 이다. 값과 인덱스가 일치하는지
 * 확인했다(아래 각 필드 주석 참고) — 데스크톱이 콤보 인덱스를 그대로 대입하는
 * 자리가 있어서, 일치하지 않으면 라벨이 한 칸씩 밀린다.
 *
 * ── `fallback` 은 "기본값" 이 아니다 ────────────────────────
 *
 * 화면의 초기값은 **반드시 `getParams()` 에서 온다.** `fallback` 은 워커에 아직
 * 붙지 않았을 때 위젯을 그리기 위한 자리 채움이고, 값은 `W_Bra top &
 * Leggings.zls` 로드 직후의 **실측치**다.
 *
 * ⚠️ 엔진 구조체의 기본값(`Zest/scene/ztSceneData.h:91-160`)과 **다르다** —
 *    `.zls` 가 덮어쓰기 때문이다. 예: `timeStep` 30→45, `groundFriction`
 *    0.7→0.2, `groundMargin` 0.1→0.5, `dynCouplingStiffness` 7500→750,
 *    `meshingEdgeLength` 2→1. 즉 **씬마다 다르다.** "기본값으로 되돌리기" 를
 *    만든다면 이 상수가 아니라 **로드 직후 `getParams()` 를 스냅샷해서** 그리로
 *    되돌려야 한다. 이 상수로 되돌리면 다른 씬에서 남의 값을 심는다.
 */

import { t } from './i18n.ts';
import type { SimulationParams } from '../protocol/index.ts';

// ── 타입 ────────────────────────────────────────────────────

/** `SimulationParams` 에서 파생시킨다. 프로토콜에 필드가 늘면 여기가 먼저 안다 */
export type ParamKey = keyof SimulationParams;

export type ParamValue = number | boolean;

/** 부분 집합이 정상이다 — 사용자가 만진 것만 담긴다 */
export type ParamValues = Partial<Record<ParamKey, ParamValue>>;

export type ParamKind = 'float' | 'int' | 'bool' | 'enum';

/**
 * ISSUE-014 전수 측정의 세 분류. **이 필드가 이 스키마의 존재 이유다.**
 *
 * `conditional` 은 **비활성 사유가 아니다.** `windMagnitude` 만 `requires` 로
 * 판정 가능한 조건을 갖고, `groundPlane`·`groundFriction` 의 조건("바닥에 닿는
 * 씬")은 프런트가 알 수 없다 — 그래서 그 둘은 **끄지 않고 표식만 단다.**
 */
export type ParamEffect = 'effective' | 'conditional' | 'dead';

/** 데스크톱 UI 배치를 참고하되 웹에서 읽기 좋게 다시 묶었다 */
export type ParamGroup = 'general' | 'ground' | 'wind' | 'solver' | 'coupling' | 'meshing';

/** min/max 가 어디서 왔는가. **step 은 이것과 무관하게 전부 추정이다** */
export type ParamRangeSource = 'code' | 'guess';

export interface ParamEnumOption {
  readonly value: number;
  readonly label: string;
}

/**
 * 필드 하나의 서술. **선택 항목을 `?` 가 아니라 `null` 로 둔다** —
 * `?` 면 "안 적었다" 와 "없다고 정했다" 가 구분되지 않는데, 여기서는 범위가
 * 없다는 것 자체가 결정이다(`solverTolerance` 의 step 이 그렇다).
 */
export interface ParamField {
  readonly key: ParamKey;
  /** 화면에 그대로 찍는 한국어 라벨 */
  readonly label: string;
  readonly kind: ParamKind;
  readonly group: ParamGroup;
  /** ⚠️ 초기값이 아니다. 워커에 붙기 전의 자리 채움 (머리말 참고) */
  readonly fallback: ParamValue;
  /** 숫자 필드만. bool/자유입력은 null */
  readonly min: number | null;
  readonly max: number | null;
  /** **전부 추정이다** (머리말 참고). null 이면 자유 입력 */
  readonly step: number | null;
  /** enum 만. 값은 엔진 enum 의 숫자이고 순서는 데스크톱 콤보 순서다 */
  readonly options: readonly ParamEnumOption[] | null;
  readonly effect: ParamEffect;
  /** 이 bool 필드가 켜져야 의미가 있다. 꺼져 있으면 비활성 */
  readonly requires: ParamKey | null;
  /** `status.simInitialized` 가 true 면 잠근다 */
  readonly lockedWhenSimInit: boolean;
  readonly source: ParamRangeSource;
  /** 이 값이 무엇인가. 화면의 도움말로 그대로 쓴다 */
  readonly description: string;
  /** 측정에서 나온 단서. 화면에 작은 글씨로 붙인다. 없으면 null */
  readonly note: string | null;
}

// ── 필드 생성기 ─────────────────────────────────────────────
//
// 22개 × 14필드를 손으로 적으면 한 칸 빠뜨린 것을 아무도 못 본다. 공통값은
// 여기서 채우고, **분류·잠금·출처처럼 판단이 들어간 것만** 표에 적는다.

/*
 * ★ **글자가 이 표에 없다** (I-1). `label`·`description`·`note` 는
 *   `panels/i18n.ts` 의 `param.<key>.label` · `.desc` · `.note` 에서 온다.
 *
 *   이유는 두 가지다. ① 이 표는 모듈이 로드될 때 **한 번** 만들어지므로 글자를
 *   값으로 박으면 언어를 바꿔도 파라미터 22개가 통째로 한국어로 남는다.
 *   ② 키를 여기 또 적으면 `key` 와 사전 키가 두 곳이 되어, 한쪽만 고치는 날
 *   화면에 `param.timeStep.label` 이 그대로 뜬다. `key` 하나에서 파생시키면
 *   그런 어긋남이 원리적으로 생기지 않는다.
 *
 *   실제 글자는 아래 `localize()` 가 **게터로** 붙인다 — `f.label` 을 읽는
 *   쪽(`ui/paramsPanel.ts`, 스모크)은 예전 그대로 문자열을 받는다.
 */
interface Spec {
  key: ParamKey;
  group: ParamGroup;
  /** 생략하면 'effective' */
  effect?: ParamEffect;
  requires?: ParamKey;
  /** 생략하면 false */
  lockedWhenSimInit?: boolean;
  /** 생략하면 'code' */
  source?: ParamRangeSource;
  /** 부연(실측 기록 등)이 있는가. 글자는 사전의 `param.<key>.note` 다 */
  note?: boolean;
}

interface Range {
  fallback: number;
  min: number;
  max: number;
  /** null 이면 자유 입력 (스텝 개념이 없는 값) */
  step: number | null;
}

function common(spec: Spec): Omit<ParamField, 'kind' | 'fallback' | 'min' | 'max' | 'step' | 'options'> {
  return {
    key: spec.key,
    // 아래 `localize()` 가 게터로 덮는다. 자리를 비워 두지 않는 이유는 타입이
    // 요구해서일 뿐이고, 이 값이 화면에 나가는 일은 없다.
    label: '',
    group: spec.group,
    effect: spec.effect ?? 'effective',
    requires: spec.requires ?? null,
    lockedWhenSimInit: spec.lockedWhenSimInit ?? false,
    source: spec.source ?? 'code',
    description: '',
    note: null,
  };
}

/**
 * 글자 셋을 **게터로 덮는다** (I-1).
 *
 * ⚠️ **전개(`...`)로는 안 된다.** `{ ...common(spec) }` 은 게터를 그 자리에서
 *    한 번 읽어 값으로 굳혀 버린다 — 그래서 게터를 `common()` 이 아니라 전개가
 *    **끝난 뒤** 여기서 붙인다. `enumerable: true` 라 `JSON.stringify` 나
 *    `Object.keys` 로 보는 쪽도 예전과 같다.
 */
function localize(field: ParamField, spec: Spec): ParamField {
  Object.defineProperties(field, {
    label: {
      get: (): string => t(`param.${spec.key}.label`),
      enumerable: true,
      configurable: true,
    },
    description: {
      get: (): string => t(`param.${spec.key}.desc`),
      enumerable: true,
      configurable: true,
    },
    note: {
      get: (): string | null => (spec.note === true ? t(`param.${spec.key}.note`) : null),
      enumerable: true,
      configurable: true,
    },
  });
  return field;
}

function num(kind: 'float' | 'int', spec: Spec, range: Range): ParamField {
  return localize({ ...common(spec), kind, fallback: range.fallback, min: range.min, max: range.max, step: range.step, options: null }, spec);
}

function flag(spec: Spec, fallback: boolean): ParamField {
  return localize({ ...common(spec), kind: 'bool', fallback, min: null, max: null, step: null, options: null }, spec);
}

function choice(spec: Spec, fallback: number, options: readonly ParamEnumOption[]): ParamField {
  return localize({ ...common(spec), kind: 'enum', fallback, min: null, max: null, step: null, options }, spec);
}

// ── 열거형 라벨 ─────────────────────────────────────────────

/**
 * 적분기. **[코드 확인]** 라벨은 `MainGUI.cpp:469` 의 `solverTypes[]`,
 * 숫자는 `Zest/Zelus/zsSimulation.h:14-21` 의 `ZS_SOLVER_TYPE`.
 *
 * 데스크톱은 `solverMap`(같은 파일 `:463-467`)으로 콤보 인덱스를 enum 값으로
 * 옮기는데, 마침 0/1/2 라 **인덱스와 값이 같다.** 그래서 라벨이 밀리지 않는다.
 *
 * enum 에는 3·4(`..._DOUBLE_PRECISION`)도 있지만 **데스크톱이 노출하지 않아
 * 우리도 노출하지 않는다** — 배정밀도 솔버가 이 빌드에서 도는지 확인된 바 없다.
 */
/* `label` 이 게터인 이유는 `Spec` 위 주석과 같다 (I-1) — 표가 한 번만 만들어진다 */
const SOLVER_TYPES: readonly ParamEnumOption[] = [
  { value: 0, get label(): string { return t('param.solverType.opt.0'); } },
  { value: 1, get label(): string { return t('param.solverType.opt.1'); } },
  { value: 2, get label(): string { return t('param.solverType.opt.2'); } },
];

/**
 * 선형 솔버 전처리기. **[코드 확인]** 라벨은 `MainGUI.cpp:502` 의
 * `preconditioners[]`, 숫자는 `zsSimulation.h:100-106` 의
 * `ZS_LINEAR_SOLVER_PRECONDITIONER`(IDENTITY=0, JACOBI, BLOCK_JACOBI).
 *
 * ⚠️ 헤더의 이름(JACOBI/BLOCK_JACOBI)과 UI 라벨(Diagonal/Block-Diagonal)이
 *    다르다. **UI 라벨을 따랐다** — 사용자가 데스크톱에서 보던 말이다.
 *    데스크톱은 콤보 인덱스를 그대로 대입한다(`:506`)이므로 값=인덱스다.
 */
const PRECONDITIONERS: readonly ParamEnumOption[] = [
  { value: 0, get label(): string { return t('param.preconditioner.opt.0'); } },
  { value: 1, get label(): string { return t('param.preconditioner.opt.1'); } },
  { value: 2, get label(): string { return t('param.preconditioner.opt.2'); } },
];

/**
 * 커플링 방식. static·dynamic 이 **같은 표를 쓴다** — 데스크톱도 `couplings[]`
 * 배열 하나를 두 콤보에 쓴다(`MainGUI.cpp:512`, `:518`·`:523`).
 *
 * **[코드 확인]** 숫자는 `zsSimulation.h:63-70` 의 `ZS_SOLVER_COUPLING_METHOD`
 * (NONE=0, IMPLICIT, IMPLICIT_DIR, PENALTY, PROJECTIVE_CONSTRAINTS). 값과
 * 인덱스가 일치한다. 실측 기본값(static=4, dynamic=3)이 데스크톱 주석의
 * "권장"(static=Projective Constraints, dynamic=Penalty)과 정확히 맞아 떨어져
 * 매핑이 한 번 더 확인된다.
 */
const COUPLING_METHODS: readonly ParamEnumOption[] = [
  { value: 0, get label(): string { return t('param.coupling.opt.0'); } },
  { value: 1, get label(): string { return t('param.coupling.opt.1'); } },
  { value: 2, get label(): string { return t('param.coupling.opt.2'); } },
  { value: 3, get label(): string { return t('param.coupling.opt.3'); } },
  { value: 4, get label(): string { return t('param.coupling.opt.4'); } },
];

// ── ★ 스키마 ────────────────────────────────────────────────
//
// 순서는 데스크톱을 참고하되(General → Solver → Collision) 웹에서 읽기 좋게
// 다시 묶었다. 데스크톱은 커플링 **방식**이 "Solver" 헤더에, 그 **세기**가
// "Collision" 헤더 맨 밑에 흩어져 있는데(`MainGUI.cpp:512-524` vs `:736-739`)
// 둘은 같은 이야기라 여기서는 한 그룹으로 붙였다.

export const PARAM_FIELDS: readonly ParamField[] = [
  // ── 일반 ────────────────────────────────────────────────
  num('float', {
    key: 'timeStep',
    group: 'general',
    note: true,
  }, { fallback: 45, min: 1, max: 300, step: 1 }),
  // [코드 확인] 범위 1..300 은 `MainGUI.cpp:394` — SliderInt("timestep(Hz)", 1, 300).
  //
  // ★ **`kind` 는 데스크톱과 다르게 float 이다. 의도적이다.**
  //   데스크톱은 이 값을 정수로 다룬다:
  //
  //     int timestep = (int)simulationParam.timeStep;      // MainGUI.cpp:393
  //     ImGui::SliderInt("timestep(Hz)", &timestep, 1, 300);
  //     simulationParam.timeStep = (zsReal)timestep;       // MainGUI.cpp:395
  //
  //   그런데 이건 **데스크톱의 결함이다.** 대입이 조건 없이 매 프레임 일어나므로
  //   패널을 그리기만 해도 씬의 소수 타임스텝이 잘려 나간다 — 사용자가 만지지
  //   않아도 값이 변한다. 엔진·프로토콜의 실제 타입은 float 이고
  //   (`Zest/scene/ztSceneData.h:102` 의 `float timeStep`,
  //    `backend/native/src/protocol.cpp:129` 가 `F(p.timeStep)` 로 읽는다)
  //   우리가 int 로 두면 소수 타임스텝을 가진 씬에서 **사용자가 만지지도 않은
  //   값이 반올림돼 워커로 되돌아간다.**
  //
  //   CLAUDE.md 가 `solverType` 충돌을 두고 정한 원칙이 그대로 적용된다 —
  //   **데스크톱의 버그를 그대로 옮기지 않는다.** 대신 `step: 1` 로 두어
  //   슬라이더 조작감은 정수처럼 유지한다(스냅은 하지 않으므로 씬이 준 45.5 는
  //   45.5 로 남는다).

  num('int', {
    key: 'subStep',
    group: 'general',
    effect: 'dead',
    note: true,
  }, { fallback: 1, min: 1, max: 20, step: 1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:398`.
  // ⛔ 죽은 이유: `ZestManager::LoadZls` 가 로드 직후
  //    `simulationParams.useSubStepTargeting = false` 를 **강제한다**
  //    (`zelusSandBox_Cobalt/zelusSandBox/ZestManager.cpp:835`, `LoadDrapingItem`
  //    도 `:451` 에 같은 줄). [추론] 서브스텝 타게팅이 꺼져 있으면 이 값이
  //    쓰이지 않을 개연성이 높다. 회사 저장소라 그 줄을 고칠 수 없고,
  //    `useSubStepTargeting` 은 아직 우리 프로토콜에 없다.

  num('float', {
    key: 'drapingTime',
    group: 'general',
    note: true,
  }, { fallback: 0.4, min: 0, max: 10, step: 0.1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:404` — SliderFloat("draping time", 0, 10).

  num('float', {
    key: 'gravityY',
    group: 'general',
    note: true,
  }, { fallback: -980, min: -1000, max: 0, step: 1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:401` — SliderFloat("gravity(cm/s^2)", -1000, 0).
  // ⚠️ ISSUE-014 의 **첫 판정이 뒤집힌 필드다.** 첫 측정은 "~1% 지터" 라는
  //    틀린 문턱 때문에 0.22cm 를 노이즈로 삼켰다. 전수 측정에서 반영됨으로
  //    확정됐다. 다만 중력을 통째로 끈 것 치고 작은 이유는 미해결이다.

  // ── 바닥 ────────────────────────────────────────────────
  //
  // 셋 다 "이 씬에서는" 검증이 갈렸다. **[실측]** `backend/tools/ground-probe.ts`
  // 로 100프레임 뒤 옷의 월드 최저 Y 를 쟀더니 **9.27cm** 였고 `groundMargin` 이
  // 0.5 라 접촉까지 8.8cm 가 남는다. 닿지 않는 면의 마찰을 바꿔 아무 일도 안
  // 일어나는 것은 **필드가 죽은 것이 아니라 물리가 옳은 것이다.**
  flag({
    key: 'groundPlane',
    group: 'ground',
    effect: 'conditional',
    note: true,
  }, true),
  // [코드 확인] 데스크톱 위젯은 `MainGUI.cpp:407` (체크박스라 범위 없음).

  num('float', {
    key: 'groundFriction',
    group: 'ground',
    effect: 'conditional',
    source: 'guess',
    note: true,
  }, { fallback: 0.2, min: 0, max: 1, step: 0.01 }),
  // ⚠️ 범위 **근거 없음, 추정.** 데스크톱에 이 위젯이 없다(`MainGUI.cpp` 전체에
  //    groundFriction 을 쓰는 줄이 없다). 0..1 은 "마찰 계수" 라는 이름에서 온
  //    통상 범위일 뿐이고 엔진이 1을 넘는 값을 거부한다는 근거는 없다.

  num('float', {
    key: 'groundMargin',
    group: 'ground',
    source: 'guess',
    note: true,
  }, { fallback: 0.5, min: -10, max: 10, step: 0.1 }),
  // ⚠️ 범위 **근거 없음, 추정.** 데스크톱에 위젯이 없다.
  // ⚠️ ISSUE-014 의 미결 ① 이 이 필드다. 위 "바닥 접촉이 없다" 설명과 어긋난다 —
  //    접촉이 없다면 0.5 → 5 로 키워도(여전히 9.27cm 아래) 0cm 여야 한다.
  //    `groundPlane: false` 는 0cm 인데 이것만 움직인다는 점도 설명되지 않는다.
  //    그래서 `conditional` 이 아니라 `effective` 로 둔다 — 실제로 움직였다.

  // ── 바람 ────────────────────────────────────────────────
  flag({
    key: 'useWind',
    group: 'wind',
    source: 'guess',
    note: true,
  }, false),
  // ⚠️ 데스크톱에 위젯이 **없다.** 체크박스라 범위는 어차피 없지만, "데스크톱이
  //    이렇게 했다" 는 근거도 없다는 뜻이라 source 를 guess 로 둔다.

  num('float', {
    key: 'windMagnitude',
    group: 'wind',
    effect: 'conditional',
    requires: 'useWind',
    source: 'guess',
    note: true,
  }, { fallback: 30, min: 0, max: 500, step: 1 }),
  // ⚠️ 범위 **근거 없음, 추정.** 데스크톱에 위젯이 없다. 상한 500 은 측정에서
  //    실제로 걸어 본 값이라는 것 외에 근거가 없다.
  // ★ 이 필드가 `requires` 를 쓰는 **유일한 필드다.** 측정에서 단독 0cm →
  //    `useWind:true` 와 짝 7.19cm(useWind 단독의 63배)로 갈렸다. 즉 죽은 것이
  //    아니라 종속이었고, 기준선이 `useWind:false` 라 단독 변경이 무의미했다.

  // ── 솔버 ────────────────────────────────────────────────
  choice({
    key: 'solverType',
    group: 'solver',
    lockedWhenSimInit: true,
    note: true,
  }, 0, SOLVER_TYPES),
  // ★ `lockedWhenSimInit` 이 붙는 **유일한 필드다.**
  //    [코드 확인] `MainGUI.cpp:459` — `if (!mZestManager.IsSimulationInitialized())`
  //    안에서만 콤보를 그린다(`:470`). 데스크톱 주석: "Enable the following UI
  //    during simulation."(원문 그대로. 실제 동작은 그 반대다 — 시뮬이
  //    초기화되면 위젯이 **사라진다**). ImGui 의 `BeginDisabled` 를 쓰는 것이
  //    아니라 아예 렌더링하지 않는 방식이다.
  //    엔진 쪽 근거도 있다: `zsSimulationWorld.cpp:467-476` 이 시뮬 도중 IE↔PBD
  //    전환을 "not supported at the moment" 로 막는다.
  // ⚠️ 데스크톱의 `solverType` 필드 충돌(머리말 참고)을 옮기지 않았다. 여기
  //    라벨 3개는 전부 **적분기**이고, `MainGUI.cpp:642` 의 충돌 솔버 4개
  //    (Gauss-Seidel/Jacobi/GS atomic/ICA)는 이 스키마에 없다.

  choice({
    key: 'preconditioner',
    group: 'solver',
    note: true,
  }, 2, PRECONDITIONERS),

  num('int', {
    key: 'nonlinearIterations',
    group: 'solver',
    note: true,
  }, { fallback: 1, min: 1, max: 200, step: 1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:509` — SliderInt("non-linear iterations", 1, 200).

  num('int', {
    key: 'maxSolverIterations',
    group: 'solver',
    source: 'guess',
    note: true,
  }, { fallback: 600, min: 1, max: 2000, step: 1 }),
  // ⚠️ 범위 **근거 없음, 추정.** 데스크톱에 위젯이 없다. 상한 2000 은 실측
  //    기본값 600 의 여유를 잡은 것일 뿐이다.

  num('float', {
    key: 'solverTolerance',
    group: 'solver',
    note: true,
  }, { fallback: 1e-4, min: 1e-10, max: 1, step: null }),
  // [코드 확인] 하한만 코드 근거가 있다 — `MainGUI.cpp:491` 이
  //   `zsMAX(CGTolerance, 1e-10f)` 로 바닥을 친다. 데스크톱은 슬라이더가 아니라
  //   `InputText` 로 지수 문자열을 받는다(`:495`).
  // ⚠️ **상한 1 은 추정이다.** 데스크톱은 상한을 두지 않는다.
  // ★ `step` 이 null 인 이유: 1e-10..1 을 선형 스텝으로 훑는 것은 무의미하다.
  //   16-b 는 이 필드를 슬라이더가 아니라 **숫자 입력**으로 그려야 한다.

  flag({
    key: 'useIEQS',
    group: 'solver',
    note: true,
  }, false),
  // [코드 확인] 위젯은 `MainGUI.cpp:487` — Checkbox("Quasi-static").

  // ── 커플링 ──────────────────────────────────────────────
  choice({
    key: 'staticCouplingMethod',
    group: 'coupling',
    note: true,
  }, 4, COUPLING_METHODS),

  choice({
    key: 'dynamicCouplingMethod',
    group: 'coupling',
    note: true,
  }, 3, COUPLING_METHODS),

  num('float', {
    key: 'dynCouplingStiffness',
    group: 'coupling',
    note: true,
  }, { fallback: 750, min: 0, max: 20000, step: 10 }),
  // [코드 확인] 범위는 `MainGUI.cpp:736` — SliderFloat("Dynamic Penalty Stiffness", 0, 20000).

  num('float', {
    key: 'dynCouplingDamping',
    group: 'coupling',
    note: true,
  }, { fallback: 0.1, min: 0, max: 500, step: 0.1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:737` — SliderFloat("Dynamic Penalty Damping", 0, 500).
  // ⚠️ 실측 기본값이 0.1 인데 상한이 500 이다. 데스크톱 슬라이더로는 사실상
  //    맨 왼쪽에 붙어 있어 조작이 불가능하다. 범위는 코드 근거대로 두되
  //    step 을 0.1 로 잡아 키보드로는 만질 수 있게 했다.

  num('float', {
    key: 'untanglingStiffness',
    group: 'coupling',
    note: true,
  }, { fallback: 20000, min: 0, max: 20000, step: 10 }),
  // [코드 확인] 범위는 `MainGUI.cpp:738` — SliderFloat("Untangling Penalty Stiffness", 0, 20000).
  // ⚠️ 실측 기본값이 **상한과 같다.** 올릴 여지가 없는 슬라이더다. 데스크톱도
  //    같으므로 범위를 임의로 늘리지 않았다.

  num('float', {
    key: 'untanglingDamping',
    group: 'coupling',
    note: true,
  }, { fallback: 250, min: 0, max: 500, step: 1 }),
  // [코드 확인] 범위는 `MainGUI.cpp:739` — SliderFloat("Untangling Penalty Damping", 0, 500).

  // ── 메싱 ────────────────────────────────────────────────
  num('float', {
    key: 'meshingEdgeLength',
    group: 'meshing',
    effect: 'dead',
    source: 'guess',
    note: true,
  }, { fallback: 1, min: 0.5, max: 10, step: 0.1 }),
  // ⚠️ 범위 **근거 없음, 추정.** 데스크톱에 위젯이 없다.
  // ⛔ 죽은 **원인은 미확인이다.** [추론] 리메싱이 로드 시점에 끝나고 그 뒤에는
  //    값을 봐도 다시 메싱하지 않을 개연성이 있다 — 측정에서 정점 수가 그대로였고
  //    (리메싱이 일어났다면 정점 수가 바뀌어 정점별 비교 자체가 불가능해진다),
  //    `reset` 을 걸어 다시 재도 0cm 였다. **다만 이것은 추측이고, 엔진 코드에서
  //    확인한 것이 아니다.** `subStep` 처럼 강제로 끄는 줄을 찾지 못했다.
];

/**
 * 키로 바로 찾는 표. `PARAM_FIELDS` 에서 파생시키므로 둘이 어긋날 수 없다.
 *
 * ── ★ 프로토타입이 없는 객체다. 장식이 아니다 ───────────────
 *
 * 처음엔 `Object.fromEntries` 로 만들었는데 그 산물은 `Object.prototype` 을
 * 물고 있어서 **`Object.prototype` 의 이름이 전부 "스키마에 있는 필드" 로
 * 읽혔다.** 실제로 이렇게 샜다:
 *
 *   buildSetParamsPayload({ constructor: 1, nope: 2 })
 *     → payload { "undefined": 1 },  unknown ["nope"]
 *
 * `PARAM_BY_KEY['constructor']` 가 `Object` 생성자 함수라 `undefined !==
 * field` 검사를 통과하고, 그 "필드" 의 `key` 가 `undefined` 라서 **`"undefined"`
 * 라는 키가 워커로 나간다.** 동시에 `constructor` 는 `unknown` 에 담기지 않아
 * `buildSetParamsPayload` 가 약속한 "오타를 조용히 삼키지 않는다" 도 깨진다 —
 * 정확히 그 반대가 된다.
 *
 * `Object.create(null)` 로 만들면 물려받는 이름이 없어 이 계열이 통째로
 * 사라진다. 그 위에 조회 지점도 `Object.hasOwn` 으로 한 번 더 막는다
 * (`paramField()`) — 두 겹인 이유는 이 상수가 **공개 표면**이라
 * 바깥에서 `PARAM_BY_KEY[x]` 로 직접 읽을 수도 있기 때문이다.
 *
 * ⚠️ 지금 이 결함에 닿는 경로는 좁다. `readParamValues` 는 `PARAM_FIELDS` 를
 *    돌며 아는 키만 꺼내므로 오염된 키가 들어올 수 없다. **그러나 16-b 가
 *    위젯 상태 맵을 그대로 `buildSetParamsPayload` 에 넘기면 열린다** — 화면이
 *    만든 객체에 무엇이 들어 있는지는 이 모듈이 보장할 수 없다.
 */
export const PARAM_BY_KEY: Readonly<Partial<Record<ParamKey, ParamField>>> = (() => {
  const table = Object.create(null) as Partial<Record<ParamKey, ParamField>>;
  for (const f of PARAM_FIELDS) table[f.key] = f;
  return table;
})();

/**
 * 문자열 하나를 필드로 옮긴다. **스키마에 없으면 `null`.**
 *
 * `PARAM_BY_KEY[key]` 를 직접 쓰지 말고 이걸 쓴다. 이유는 위 상수의 주석에
 * 있다 — 조회하는 자리가 늘어날수록 한 군데만 맨손으로 읽어도 구멍이 되고,
 * 그 구멍은 "이상한 키가 워커로 나간다" 라는 **조용한** 형태로 드러난다.
 *
 * `Object.hasOwn` 을 쓰는 이유: `!== undefined` 만으로는 `Object.create(null)`
 * 을 나중에 누가 되돌렸을 때 이 함수가 같이 뚫린다. 소유 속성인지 묻는 편이
 * 상수의 만드는 방식과 무관하게 성립한다.
 */
export function paramField(key: string): ParamField | null {
  if (!Object.hasOwn(PARAM_BY_KEY, key)) return null;
  return PARAM_BY_KEY[key as ParamKey] ?? null;
}

/** 그룹 헤더에 그대로 찍는다. 순서도 이 객체의 순서를 쓴다 */
export const PARAM_GROUP_LABELS: Readonly<Record<ParamGroup, string>> = {
  // 게터인 이유는 `Spec` 위 주석과 같다 (I-1) — 표가 한 번만 만들어진다
  get general(): string { return t('param.group.general'); },
  get ground(): string { return t('param.group.ground'); },
  get wind(): string { return t('param.group.wind'); },
  get solver(): string { return t('param.group.solver'); },
  get coupling(): string { return t('param.group.coupling'); },
  get meshing(): string { return t('param.group.meshing'); },
};

export const PARAM_GROUP_ORDER: readonly ParamGroup[] =
  ['general', 'ground', 'wind', 'solver', 'coupling', 'meshing'];

/** 그룹 순서대로 묶는다. 빈 그룹은 내보내지 않는다 — 빈 헤더를 그릴 이유가 없다 */
export function paramGroups(): readonly { group: ParamGroup; label: string; fields: readonly ParamField[] }[] {
  const out: { group: ParamGroup; label: string; fields: readonly ParamField[] }[] = [];
  for (const group of PARAM_GROUP_ORDER) {
    const fields = PARAM_FIELDS.filter((f) => f.group === group);
    if (fields.length === 0) continue;
    out.push({ group, label: PARAM_GROUP_LABELS[group], fields });
  }
  return out;
}

/** 워커에 아직 못 물었을 때 쓸 한 벌. **초기값이 아니다** (머리말 참고) */
export function fallbackParamValues(): ParamValues {
  const out: ParamValues = {};
  for (const f of PARAM_FIELDS) out[f.key] = f.fallback;
  return out;
}

/**
 * `getParams()` 결과에서 **스키마가 아는 키만** 골라 낸다.
 *
 * 워커가 필드를 더 실어 보내도 화면이 모르는 값을 들고 다니지 않게 한다.
 * 반대로 워커가 필드를 빠뜨리면 그 키는 그냥 없다 — `fallback` 으로 메우지
 * 않는다. 없는 것을 있는 것처럼 그리면 그게 또 하나의 거짓말이다.
 */
export function readParamValues(raw: Readonly<Record<string, unknown>>): ParamValues {
  const out: ParamValues = {};
  for (const f of PARAM_FIELDS) {
    const v = raw[f.key];
    if (typeof v === 'number' || typeof v === 'boolean') out[f.key] = v;
  }
  return out;
}

// ── 값 검증 / 클램프 ────────────────────────────────────────

export interface ParamCoercion {
  /** **항상 그 필드에 유효한 값이다.** 못 고칠 입력이면 `fallback` 이 온다 */
  value: ParamValue;
  /**
   * 들어온 값이 손대지 않고 통과했는가.
   *
   * **`ok === (reason === null)` 이 항상 성립한다.** 고쳤는지를 묻는 코드는
   * 문구가 아니라 이걸 봐야 한다 — `reason` 은 사람이 읽는 글이라 언제든
   * 문장이 바뀔 수 있다.
   */
  ok: boolean;
  /**
   * 왜 바뀌었는가. 한국어. `ok` 면 null.
   *
   * **사유가 둘 이상일 수 있다** — 정수 필드에 `400.6` 이 오면 반올림과 클램프가
   * 함께 일어난다. 그때는 ` · ` 로 이어 붙인다. 하나만 남기면 사용자가 넣은
   * 소수가 어디로 갔는지 화면 어디에도 안 남는다.
   */
  reason: string | null;
}

function coerced(value: ParamValue, reason: string): ParamCoercion {
  return { value, ok: false, reason };
}

/**
 * 값 하나를 그 필드에 맞게 고친다. **던지지 않고, 항상 쓸 수 있는 값을 준다.**
 *
 * 던지지 않는 이유는 `playback.ts` 의 op 들과 같다 — 입력 이벤트 핸들러에서
 * 도는 함수라 던지면 화면에 아무 단서도 안 남는다. 대신 `ok:false` + `reason`
 * 으로 **무엇을 어떻게 고쳤는지** 화면이 말할 수 있게 한다.
 *
 * 규칙:
 *   bool  boolean 은 통과. 0/1 은 받아 준다(HTML 은 무엇이든 문자열로 준다).
 *         그 외는 fallback
 *   int   유한수만. 반올림 → 범위 클램프. **둘 다 일어나면 사유도 둘 다 남는다**
 *   float 유한수만. 범위 클램프. **step 으로 스냅하지 않는다** — step 은
 *         추정이라(머리말) 그걸로 사용자 입력을 깎으면 근거 없이 값을 바꾸는 것이 된다
 *   enum  options 에 있는 값만. 없으면 fallback (가까운 값으로 붙이지 않는다 —
 *         열거형에서 "가깝다"는 의미가 없다)
 */
export function coerceParamValue(field: ParamField, raw: unknown): ParamCoercion {
  if (field.kind === 'bool') {
    if (typeof raw === 'boolean') return { value: raw, ok: true, reason: null };
    if (raw === 1 || raw === 0) return coerced(raw === 1, t('coerce.numToBool'));
    return coerced(field.fallback, t('coerce.notBool', { fallback: String(field.fallback) }));
  }

  if (typeof raw === 'boolean') {
    return coerced(field.fallback, t('coerce.wantNumber', { fallback: String(field.fallback) }));
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return coerced(field.fallback, t('coerce.notNumber', { fallback: String(field.fallback) }));
  }

  if (field.kind === 'enum') {
    const options = field.options ?? [];
    if (options.some((o) => o.value === raw)) return { value: raw, ok: true, reason: null };
    return coerced(field.fallback, t('coerce.notAnOption', { raw }));
  }

  let value = raw;

  // ★ 사유를 **쌓는다.** 예전에는 `reason` 을 덮어써서 반올림과 클램프가 함께
  //   일어나면 뒤에 온 클램프만 남았다 — `nonlinearIterations: 400.6` 이 값
  //   200 으로 잘 고쳐지면서도 화면에는 "최댓값 200 위입니다" 만 뜨고 **반올림
  //   했다는 사실이 사라졌다.** 값은 옳았지만 화면이 절반만 말한 셈이라,
  //   사용자는 자기가 넣은 소수가 어디로 갔는지 알 길이 없었다.
  //
  //   ⚠️ `reason` 은 **사람이 읽는 문구다.** 코드가 판정에 쓰는 값이 아니므로
  //      이어 붙여도 되지만, `ok === (reason === null)` 대응은 그대로 지킨다 —
  //      "고쳤는가" 를 묻는 코드는 `ok` 를 본다.
  const reasons: string[] = [];

  if (field.kind === 'int' && !Number.isInteger(value)) {
    value = Math.round(value);
    reasons.push(t('coerce.rounded', { raw, value }));
  }
  if (field.min !== null && value < field.min) {
    value = field.min;
    reasons.push(t('coerce.belowMin', { min: field.min }));
  } else if (field.max !== null && value > field.max) {
    value = field.max;
    reasons.push(t('coerce.aboveMax', { max: field.max }));
  }

  return reasons.length === 0
    ? { value, ok: true, reason: null }
    : { value, ok: false, reason: reasons.join(' · ') };
}

// ── 비활성 판정 ─────────────────────────────────────────────

export type ParamDisabledCause =
  /** 엔진이 값을 보지 않는다 (ISSUE-014) */
  | 'dead'
  /** 종속된 스위치가 꺼져 있다 */
  | 'dependency'
  /** 시뮬이 초기화돼서 데스크톱과 같은 이유로 잠긴다 */
  | 'simInitialized';

export interface ParamDisabled {
  key: ParamKey;
  cause: ParamDisabledCause;
  /**
   * **화면에 그대로 찍는 이유.** 이 문자열이 이 모듈에서 가장 중요한 산출물이다 —
   * 이유 없이 회색만 되면 #14 가 없애려던 그 거짓말이 된다.
   */
  text: string;
}

/** 판정에 필요한 바깥 사실. 둘뿐이다 */
export interface ParamContext {
  /** 지금 화면이 들고 있는 값들. `requires` 판정에 쓴다 */
  values: ParamValues;
  /** `status.simInitialized`. 아직 안 물었으면 false 로 두면 된다 */
  simInitialized: boolean;
}

/**
 * 이 필드를 지금 만질 수 있는가. 만질 수 있으면 `null`.
 *
 * 우선순위는 **되돌릴 수 없는 것부터**다: `dead`(엔진을 고쳐야 한다) →
 * `simInitialized`(리셋해야 한다) → `dependency`(체크박스 하나면 된다).
 * 사용자에게 먼저 보여야 할 것이 먼저 온다.
 *
 * ⚠️ `effect: 'conditional'` **자체는 비활성 사유가 아니다.**
 *    `groundPlane`·`groundFriction` 의 조건은 "바닥에 닿는 씬" 인데 프런트가
 *    그걸 알 방법이 없다. 모르면서 끄면 사용자가 만질 수 있는 걸 못 만지게
 *    된다 — 그래서 그 둘은 켜 두고 `note` 로만 "이 씬에서 미검증" 을 말한다.
 */
export function paramDisabledReason(field: ParamField, ctx: ParamContext): ParamDisabled | null {
  if (field.effect === 'dead') {
    return {
      key: field.key,
      cause: 'dead',
      text: t('param.off.dead'),
    };
  }

  if (field.lockedWhenSimInit && ctx.simInitialized) {
    return {
      key: field.key,
      cause: 'simInitialized',
      text: t('param.off.simInit'),
    };
  }

  if (field.requires !== null) {
    const on = ctx.values[field.requires] === true;
    if (!on) {
      const gate = paramField(field.requires);
      const label = gate?.label ?? field.requires;
      return {
        key: field.key,
        cause: 'dependency',
        text: t('param.off.dependency', { label }),
      };
    }
  }

  return null;
}

/** 지금 비활성인 필드 전부. 16-b 가 한 번 돌려 화면에 뿌린다 */
export function disabledParams(ctx: ParamContext): readonly ParamDisabled[] {
  const out: ParamDisabled[] = [];
  for (const f of PARAM_FIELDS) {
    const d = paramDisabledReason(f, ctx);
    if (d !== null) out.push(d);
  }
  return out;
}

// ── setParams 페이로드 ──────────────────────────────────────

export interface ParamAdjustment {
  key: ParamKey;
  from: unknown;
  to: ParamValue;
  reason: string;
}

export interface ParamPayload {
  /** `client.setParams()` 에 그대로 넣는다 */
  payload: Record<string, number | boolean>;
  /** 죽은 필드라 뺐다. 화면이 "보내지 않았다" 고 말할 수 있어야 한다 */
  dropped: ParamKey[];
  /** 스키마에 없는 키라 뺐다. 오타를 조용히 삼키지 않는다 */
  unknown: string[];
  /** 범위·타입 때문에 고친 값들 */
  adjusted: ParamAdjustment[];
}

/**
 * 값 맵 → `setParams` 페이로드.
 *
 * ── 죽은 필드를 왜 빼는가 ───────────────────────────────────
 * 워커는 `subStep`·`meshingEdgeLength` 를 받아 **성공 응답을 준다**
 * (`applied` 배열에 들어간다). 그런데 물리는 그 값을 보지 않는다. 보내면
 * 화면이 "적용됨" 이라고 말할 근거를 얻는데 그 말이 거짓이다. 안 보내면
 * `dropped` 가 남고, 화면은 "엔진 미지원이라 보내지 않았다" 는 **참인 말**을
 * 할 수 있다.
 *
 * ── 종속 미충족은 왜 안 빼는가 ──────────────────────────────
 * `useWind` 가 꺼져 있어도 `windMagnitude` 는 **보낸다.** 값 자체는 정상으로
 * 걸리고(측정에서 `getParams` 가 그대로 되돌려줬다), 사용자가 나중에 바람을
 * 켜면 그 값이 곧바로 쓰인다. 여기서 빼면 켠 순간 옛 세기가 살아나 "방금 맞춘
 * 값이 아닌 것이 적용되는" 상황이 된다.
 *
 * ── 잠긴 필드도 보내는가 ────────────────────────────────────
 * **보낸다.** `lockedWhenSimInit` 은 위젯을 막는 규칙이지 전송 규칙이 아니고,
 * 워커가 실제로 그 시점에 무엇을 받아 주는지 우리는 측정하지 않았다. 화면이
 * 못 만들게 막은 값은 애초에 이 맵에 들어오지 않는다 — 두 겹으로 막으면
 * "왜 안 갔는지" 를 찾는 자리가 둘이 된다.
 */
export function buildSetParamsPayload(values: Readonly<Record<string, unknown>>): ParamPayload {
  const payload: Record<string, number | boolean> = {};
  const dropped: ParamKey[] = [];
  const unknown: string[] = [];
  const adjusted: ParamAdjustment[] = [];

  for (const [key, raw] of Object.entries(values)) {
    // ★ `PARAM_BY_KEY[key]` 로 직접 읽지 않는다 — `constructor` 같은 이름이
    //   필드로 둔갑해 `"undefined"` 키가 워커로 나가던 자리다(상수 주석 참고).
    const field = paramField(key);
    if (field === null) {
      unknown.push(key);
      continue;
    }
    if (field.effect === 'dead') {
      dropped.push(field.key);
      continue;
    }
    const c = coerceParamValue(field, raw);
    if (!c.ok && c.reason !== null) {
      adjusted.push({ key: field.key, from: raw, to: c.value, reason: c.reason });
    }
    payload[field.key] = c.value;
  }

  return { payload, dropped, unknown, adjusted };
}

/**
 * 바뀐 것만 골라 낸다. **`setParams` 는 부분 갱신이므로 전부 보낼 이유가 없다.**
 *
 * 22개를 매번 보내도 워커는 받아 주지만, 그러면 `SetParamsResult.applied` 가
 * 항상 22개라 응답에서 "무엇이 실제로 바뀌었는가" 를 읽을 수 없게 된다.
 *
 * `next` 에만 있고 `current` 에 없는 키는 **바뀐 것으로 본다** — 워커가 안 준
 * 필드를 우리가 처음 정하는 경우다.
 */
export function changedParams(current: ParamValues, next: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const f of PARAM_FIELDS) {
    const a = current[f.key];
    const b = next[f.key];
    if (b === undefined) continue;
    if (a !== b) out[f.key] = b;
  }
  return out;
}
