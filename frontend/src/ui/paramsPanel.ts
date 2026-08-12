/**
 * 파라미터 패널의 **DOM 렌더링** (#16-b) — 판단은 한 줄도 없다.
 *
 * ── 왜 `panels/` 가 아니라 `ui/` 인가 ───────────────────────
 *
 * `panels/` 의 규약은 하나다: **DOM 도 three 도 만지지 않는다.** 그 규약 덕에
 * `params.ts`(109건) · `playback.ts` 가 Node 에서 통째로 돌아가고, 그게 이
 * 프로젝트에서 자동 테스트가 붙는 유일한 근거다. 위젯을 그리는 코드는 그 규약을
 * 만족할 수 없으므로 거기 들어갈 수 없다. 그렇다고 `main.ts` 에 두면 22개 ×
 * (슬라이더+숫자+체크+콤보) 를 배선하는 300줄이 들어가 배선 파일이 아니게 된다.
 * `viewer3d/` 는 three 전용이라 남의 집이다. 그래서 **DOM 만 만지는 계층**을
 * 새로 열었다 — `protocol/` · `panels/` · `viewer3d/` 와 같은 층위다.
 *
 * ── ★ 이 파일이 하지 않는 것 ────────────────────────────────
 *
 *   어느 필드가 비활성인가        → `disabledParams()`
 *   그 이유를 뭐라고 쓸 것인가    → `ParamDisabled.text`
 *   입력값이 유효한가             → `coerceParamValue()`
 *   무엇을 워커로 보낼 것인가     → `changedParams()` → `buildSetParamsPayload()`
 *
 * 전부 `panels/params.ts` 가 이미 답한다. 여기 있는 것은 **그 답을 글자와
 * 위젯으로 옮기는 일**뿐이다. 판단이 이 파일로 새면 Node 에서 검증할 수 없고,
 * 그게 ISSUE-009 가 났던 자리다.
 *
 * ── ★ 화면 규칙 세 가지 ─────────────────────────────────────
 *
 * ① **비활성에는 항상 이유가 글자로 남는다.** `title`(툴팁)에만 넣지 않는다 —
 *    마우스를 올려야 보이는 것은 "보인다" 가 아니다. 회색으로만 만들고 이유를
 *    안 적으면 그게 #14 가 없애려던 거짓말이다. `title` 은 덤으로만 붙인다.
 *
 * ② **값의 출처는 워커다.** 패널을 열거나 씬이 바뀌면 `getParams()` 로 실제
 *    값을 읽어 채운다. `fallback` 은 자리채움이지 초기값이 아니고, 씬마다
 *    값이 다르다(실측: `W_Bra top & Leggings.zls` 의 `timeStep` 45 vs
 *    `sample.zls` 30). 아직 못 읽었으면 **자리채움이라고 화면이 말한다.**
 *
 * ③ **보낸 뒤 되읽어 화면을 워커의 사실로 덮는다.** #14 가 확립한 규칙이다.
 *    워커가 다른 값을 들고 있으면 화면이 그걸 보여야 한다 — 되읽은 값이
 *    보낸 값과 다르면 로그에 남긴다(`#diff`).
 *
 * ── 재생 중에는 적용을 막는다 (측정되지 않은 영역) ──────────
 *
 * 시뮬이 도는 도중 파라미터를 바꾸면 어떻게 되는지 **측정한 적이 없다.**
 * 데스크톱은 `solverType` 만 막지만(`MainGUI.cpp:459`), 데스크톱은 매 프레임
 * 파라미터를 통째로 다시 밀어 넣는 구조라 우리와 전제가 다르다.
 *
 * 그래서 **위젯은 열어 두고 [적용] 버튼만 잠근다.** 고른 이유:
 *   - 안전한 쪽이다. 한 런의 프레임들이 서로 다른 파라미터로 계산되는 상태를
 *     만들지 않는다 — 그 런을 익스포트하면 무엇으로 만든 결과인지 말할 수 없다
 *   - 되돌릴 수 있다. [⏸ 정지] 한 번이면 풀린다. 사용자가 잠금을 스스로 푼다
 *   - 22개 위젯을 통째로 회색으로 만들지 않는다. 값을 미리 맞춰 두고 정지한
 *     뒤 한 번에 적용할 수 있다
 * 잠금 이유는 버튼 옆에 **글자로** 뜬다(위 규칙 ①과 같은 이유다).
 */

import {
  buildSetParamsPayload,
  changedParams,
  coerceParamValue,
  disabledParams,
  fallbackParamValues,
  paramField,
  paramGroups,
  PARAM_FIELDS,
  PARAM_GROUP_LABELS,
  readParamValues,
  t,
  type ParamDisabled,
  type ParamDisabledCause,
  type ParamField,
  type ParamGroup,
  type ParamKey,
  type ParamValue,
  type ParamValues,
} from '../panels/index.ts';
import type { SetParamsResult, SimulationParams } from '../protocol/index.ts';

// ── 포트 ────────────────────────────────────────────────────

/**
 * 워커에 묻는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * `PlaybackPort` 와 같은 규약이라 어댑터가 없다.
 *
 * `status()` 가 여기 있는 이유는 두 가지 사실이 거기서만 오기 때문이다:
 * `loaded`(씬이 없으면 파라미터를 읽을 수 없다)와 `simInitialized`
 * (`solverType` 잠금 조건). `PlaybackController` 는 둘 다 밖으로 내주지 않는다.
 */
export interface ParamsPort {
  readonly connected: boolean;
  status(): Promise<{ loaded: boolean; simInitialized: boolean }>;
  getParams(): Promise<SimulationParams>;
  setParams(params: Record<string, number | boolean>): Promise<SetParamsResult>;
}

export interface ParamsPanelHooks {
  /** `main.ts` 의 `log()`. 자세한 내역은 여기로 간다 */
  log?: (line: string) => void;
  /** `main.ts` 의 `status()`. 한 줄 요약만 여기로 간다 */
  status?: (text: string, isError?: boolean) => void;
}

export interface ParamsPanelOptions {
  /** 위젯을 그려 넣을 곳. 비우고 새로 채운다 */
  root: HTMLElement;
  /** `<summary>` 안의 작은 글씨. 접혀 있을 때도 상태가 보이게 한다 */
  badge?: HTMLElement | null;
  port: ParamsPort;
  hooks?: ParamsPanelHooks;
}

/**
 * 패널이 지금 무엇을 보여주고 있는가.
 *
 *   idle         아직 워커에 묻지 않았다 — **화면의 값은 자리채움이다**
 *   disconnected 소켓이 없다
 *   noScene      붙었지만 씬이 없다 — 파라미터는 씬에 딸려 있다
 *   loading      읽는 중
 *   ready        워커의 값을 들고 있다. **이때만 편집·적용이 열린다**
 *   error        읽지 못했다
 */
export type ParamsPhase = 'idle' | 'disconnected' | 'noScene' | 'loading' | 'ready' | 'error';

// ── 사유별 앞머리 ───────────────────────────────────────────
//
// `ParamDisabled.text` 를 바꾸지 않는다 — 문구의 정본은 `params.ts` 다.
// 여기서 붙이는 것은 **한눈에 종류를 가르는 표식**뿐이다.

const CAUSE_MARK: Readonly<Record<ParamDisabledCause, string>> = {
  dead: '⛔',
  simInitialized: '🔒',
  dependency: '⚠',
};

/**
 * 배지 글자의 **사전 키**. `effect` 를 화면에서 바로 읽히게 한다.
 *
 * 여기 값이 글자가 아니라 키인 이유는 이 표가 모듈 로드 때 한 번 만들어지기
 * 때문이다 (I-1) — 실제 글자는 `#buildRow()` 안의 `retext` 가 꺼낸다.
 */
const EFFECT_BADGE_KEY: Readonly<Record<string, string>> = {
  dead: 'param.badge.dead',
  conditional: 'param.badge.conditional',
};

// ── 행 하나 ─────────────────────────────────────────────────

interface Row {
  readonly field: ParamField;
  readonly root: HTMLElement;
  /** 위젯이 지금 들고 있는 날값. 숫자 칸이 비어 있으면 NaN 이다 */
  read(): unknown;
  /** 위젯에 값을 반영한다. **같으면 건드리지 않는다** — 커서가 튄다 */
  set(v: ParamValue): void;
  setDisabled(on: boolean): void;
  /**
   * 이 행의 **정적 글자를 지금 언어로 다시 쓴다** (I-1).
   *
   * 행은 생성자에서 한 번만 만들어지고 언어 전환은 행 구성을 바꾸지 않으므로,
   * 이 함수가 없으면 이름·배지·도움말·`<option>` 이 통째로 한국어로 남는다.
   * `#paintState()` 가 매번 부른다.
   */
  retext(): void;
  /** 비활성 사유 (규칙 ①) */
  readonly why: HTMLElement;
  /** 값 보정 사유 (`coerceParamValue`) */
  readonly fix: HTMLElement;
  /** "워커가 이 값을 주지 않았다" */
  readonly src: HTMLElement;
}

function line(cls: string): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  e.hidden = true;
  return e;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function labelOf(key: string): string {
  return paramField(key)?.label ?? key;
}

/**
 * 되읽은 값이 보낸 값과 같은가.
 *
 * ⚠️ **float 은 정확히 비교하지 않는다.** 엔진의 필드가 C++ `float`(32비트)라
 *    우리가 보낸 배정밀도 0.1 이 0.10000000149011612 로 되돌아온다. 정확히
 *    비교하면 "워커가 다른 값을 들고 있다" 경고가 매번 뜨는데, 그건 사실이
 *    아니라 표현 한계다 — 진짜 어긋남(클램프·거부)을 그 소음에 묻어 버린다.
 *    float32 의 상대 오차는 ~6e-8 이므로 1e-6 이면 넉넉하면서도 의미 있는
 *    차이는 놓치지 않는다. int·enum·bool 은 그대로 정확히 본다.
 */
function sameValue(field: ParamField, sent: ParamValue, got: ParamValue): boolean {
  if (field.kind !== 'float') return sent === got;
  if (typeof sent !== 'number' || typeof got !== 'number') return sent === got;
  return Math.abs(sent - got) <= Math.max(1e-9, Math.abs(sent) * 1e-6);
}

// ── 패널 ────────────────────────────────────────────────────

export class ParamsPanel {
  readonly #port: ParamsPort;
  readonly #hooks: ParamsPanelHooks;
  readonly #root: HTMLElement;
  readonly #badge: HTMLElement | null;

  readonly #rows = new Map<ParamKey, Row>();
  /** 그룹 제목. 언어 전환 때 다시 쓰려고 잡아 둔다 (I-1) */
  readonly #groupHeads: { group: ParamGroup; el: HTMLElement }[] = [];
  readonly #banner: HTMLElement;
  readonly #hint: HTMLElement;
  readonly #applyBtn: HTMLButtonElement;
  readonly #readBtn: HTMLButtonElement;

  /** 워커가 마지막으로 말한 값. **믿음이 아니라 사실이다** */
  #worker: ParamValues = {};
  /** 위젯이 지금 들고 있는 값. 워커로 보낼 후보다 */
  #pending: ParamValues = fallbackParamValues();
  /** 워커가 값을 주지 않은 키. 그 행은 자리채움을 보여 준다고 말한다 */
  readonly #missing = new Set<ParamKey>();
  #simInitialized = false;
  #phase: ParamsPhase = 'idle';
  #lastError: Error | null = null;
  #busy = false;
  #stale = true;
  /** 지금 적용하면 안 되는 이유(재생 중 등). null 이면 적용 가능 */
  #blocked: string | null = null;

  constructor(opts: ParamsPanelOptions) {
    this.#port = opts.port;
    this.#hooks = opts.hooks ?? {};
    this.#root = opts.root;
    this.#badge = opts.badge ?? null;

    this.#root.replaceChildren();

    // ── 위 줄: 버튼과 배너 ────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'pbar';

    // 글자·툴팁은 `#paintState()` 가 채운다 (I-1) — 생성자에서 찍으면 언어를
    // 바꿔도 이 상자만 한국어로 남는다.
    this.#applyBtn = document.createElement('button');
    this.#applyBtn.id = 'paramsApply';
    this.#applyBtn.addEventListener('click', () => void this.apply());

    this.#readBtn = document.createElement('button');
    this.#readBtn.id = 'paramsRead';
    this.#readBtn.addEventListener('click', () => void this.refresh());

    bar.append(this.#applyBtn, this.#readBtn);
    this.#root.append(bar);

    this.#banner = line('pbanner');
    this.#hint = line('phint');
    this.#root.append(this.#banner, this.#hint);

    // ── 그룹과 행 ─────────────────────────────────────────
    for (const g of paramGroups()) {
      const box = document.createElement('div');
      box.className = 'pgroup';
      const h = document.createElement('h4');
      h.textContent = g.label;
      // 그룹 제목도 언어를 따라와야 한다 (I-1). `paramGroups()` 를 다시 부르면
      // 순서·구성이 그대로이므로 제목만 짝지어 갈아 끼우면 된다.
      this.#groupHeads.push({ group: g.group, el: h });
      box.append(h);
      for (const f of g.fields) {
        const row = this.#buildRow(f);
        this.#rows.set(f.key, row);
        box.append(row.root);
      }
      this.#root.append(box);
    }

    this.#paintValues();
    this.#paintState();
  }

  // ── 관찰 ──────────────────────────────────────────────────

  get phase(): ParamsPhase {
    return this.#phase;
  }

  /** 값이 낡았을 수 있다. 접혀 있는 동안 씬이 바뀌면 켜진다 */
  get stale(): boolean {
    return this.#stale;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  /** 워커가 마지막으로 말한 값. 진단용 */
  get workerValues(): ParamValues {
    return { ...this.#worker };
  }

  /** 아직 안 보낸 변경 수. 0 이면 [적용] 이 잠긴다 */
  get dirty(): number {
    return Object.keys(changedParams(this.#worker, this.#pending)).length;
  }

  // ── 바깥이 밀어 넣는 사실 ─────────────────────────────────

  /**
   * 지금 적용하면 안 되는 이유. **재생 상태는 이 패널이 알 일이 아니다** —
   * `main.ts` 가 `playback.view` 를 보고 밀어 넣는다.
   */
  setBlocked(reason: string | null): void {
    if (this.#blocked === reason) return;
    this.#blocked = reason;
    this.#paintState();
  }

  /**
   * 값이 낡았다고 표시만 한다. **왕복을 만들지 않는다** — 패널이 접혀 있는데
   * 씬을 로드할 때마다 `status`+`getParams` 를 보낼 이유가 없다. 펼치는 순간
   * `main.ts` 가 `stale` 을 보고 `refresh()` 를 부른다.
   */
  markStale(): void {
    this.#stale = true;
    this.#paintState();
  }

  /**
   * 언어가 바뀌었다 (I-1). **값은 한 칸도 건드리지 않는다** — 사용자가 맞춰
   * 둔 숫자를 언어 때문에 잃으면 안 된다.
   *
   * ⚠️ 값 보정 사유(`.pfix`)는 **다시 쓰지 않는다.** 그 글자는 "방금 무엇을
   *    어떻게 고쳤는가" 의 기록이라 지금 값에서 다시 만들 수 없다(이미 고쳐진
   *    뒤다). 다음 편집에서 그때의 언어로 새로 찍힌다.
   */
  relabel(): void {
    for (const [key, row] of this.#rows) {
      row.src.textContent = this.#missing.has(key) ? t('params.row.missing') : '';
    }
    this.#paintState();
  }

  /**
   * **잠금 조건만** 다시 확인한다 (`status.simInitialized`). 값은 안 읽는다.
   *
   * ── 왜 `refresh()` 로 때우지 않는가 ─────────────────────────
   * `refresh()` 는 `getParams()` 까지 읽고 `#pending` 을 워커 값으로 되덮는다.
   * 재생 버튼을 눌렀다고 **사용자가 맞춰 둔 값을 지워 버리면** 그것대로
   * 나쁘다(재생 중에는 [적용] 이 잠기므로, 값을 미리 맞춰 두는 것이 정상 사용
   * 경로다). 그래서 여기서는 `status()` 한 번만 묻는다.
   *
   * ── 왜 필요한가 (잠금이 늦게 오던 결함) ─────────────────────
   * `simInitialized` 는 **재생을 시작하면 워커에서 켜진다.** 그런데 이 패널은
   * 값을 읽을 때만 그 사실을 다시 봤다. 그래서 재생으로 시뮬이 초기화된 뒤에도
   * [워커에서 읽기]·씬 로드 전까지 `solverType`(적분기)이 열려 있었다 —
   * **화면이 "만질 수 있다" 고 말하는데 실제로는 만지면 안 되는 상태**이고,
   * 이 단위가 없애려던 바로 그 거짓말이다. 데스크톱은 이 경우 위젯을 아예
   * 그리지 않는다(`MainGUI.cpp:459`).
   *
   * 부르는 자리는 `main.ts` 가 정한다 — **재생 상태 전이가 끝난 순간뿐이다.**
   * 폴링이 아니다.
   */
  async syncLock(): Promise<void> {
    // 읽는 중이면 그쪽이 어차피 `simInitialized` 를 갱신한다. 왕복을 겹치지 않는다.
    if (this.#busy || !this.#port.connected) return;
    let st: { loaded: boolean; simInitialized: boolean };
    try {
      st = await this.#port.status();
    } catch (err: unknown) {
      // 잠금 조건을 못 물은 것이 방금 성공한 재생을 실패로 만들지는 않는다.
      // 다만 조용히 넘기지도 않는다 — 잠금이 낡았을 수 있다는 사실이 남아야 한다.
      this.#hooks.log?.(`파라미터 잠금 조건을 되묻지 못했습니다: ${messageOf(err)}`);
      this.#stale = true;
      this.#paintState();
      return;
    }
    if (this.#simInitialized === st.simInitialized) return;

    this.#simInitialized = st.simInitialized;
    this.#hooks.log?.(
      st.simInitialized
        ? '시뮬레이션이 초기화됐습니다 — 적분기(solverType)를 잠급니다 (데스크톱도 같습니다)'
        : '시뮬레이션 초기화가 풀렸습니다 — 적분기(solverType)를 다시 만질 수 있습니다',
    );
    this.#revertNewlyLocked();
    this.#paintState();
  }

  /**
   * 방금 잠긴 필드의 **아직 안 보낸 편집을 되돌린다.**
   *
   * ★ `params.ts` 가 "잠긴 필드도 보낸다" 고 정한 근거가 **"화면이 못 만들게
   *   막은 값은 애초에 이 맵에 들어오지 않는다"** 다. 그 전제를 지키는 것이 이
   *   함수다 — 안 지키면 위젯은 회색인데 [적용] 이 그 값을 워커로 보낸다.
   *   잠금이 늦게 오던 결함을 한 칸 뒤로 미룬 것에 지나지 않게 된다.
   *
   * ⚠️ **`dependency` 는 되돌리지 않는다.** `windMagnitude` 는 `useWind` 가
   *    꺼져 있어도 보내는 것이 맞다(`buildSetParamsPayload` 머리말: 여기서
   *    빼면 바람을 켠 순간 옛 세기가 살아난다). 되돌리는 것은 **더 이상 보낼
   *    수 없게 된** `simInitialized` 잠금뿐이다.
   *
   * 되돌린 사실은 반드시 말한다. 사용자가 맞춰 둔 값이 조용히 사라지면 그게
   * 또 하나의 거짓말이다.
   */
  #revertNewlyLocked(): void {
    const reverted: string[] = [];
    for (const d of disabledParams({ values: this.#pending, simInitialized: this.#simInitialized })) {
      if (d.cause !== 'simInitialized') continue;
      const was = this.#worker[d.key];
      if (was === undefined || this.#pending[d.key] === was) continue;
      this.#pending[d.key] = was;
      this.#rows.get(d.key)?.set(was);
      reverted.push(labelOf(d.key));
    }
    if (reverted.length === 0) return;
    this.#hooks.log?.(
      `⚠ 아직 안 보낸 변경을 되돌렸습니다 (${reverted.join(', ')}) — 잠긴 값을 보내지 않기 위해서입니다`,
    );
    this.#hooks.status?.(
      `시뮬레이션이 초기화돼 ${reverted.join(', ')} 의 변경을 되돌렸습니다 — 바꾸려면 씬을 다시 로드하세요`,
      true,
    );
  }

  // ── 워커에서 읽기 ─────────────────────────────────────────

  /** ★ 화면의 값은 **여기서만** 만들어진다 (규칙 ②) */
  async refresh(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#stale = false;
    try {
      await this.#read();
    } finally {
      this.#busy = false;
      this.#paintValues();
      this.#paintState();
    }
  }

  async #read(): Promise<void> {
    if (!this.#port.connected) {
      this.#phase = 'disconnected';
      this.#worker = {};
      this.#missing.clear();
      return;
    }

    this.#phase = 'loading';
    this.#paintState();

    let st: { loaded: boolean; simInitialized: boolean };
    try {
      st = await this.#port.status();
    } catch (err: unknown) {
      this.#fail(err);
      return;
    }
    this.#simInitialized = st.simInitialized;

    if (!st.loaded) {
      // 파라미터는 씬에 딸려 있다. 씬이 없으면 **읽을 값 자체가 없다** —
      // 자리채움을 워커의 값인 척 보여주지 않는다.
      this.#phase = 'noScene';
      this.#worker = {};
      this.#missing.clear();
      this.#pending = fallbackParamValues();
      return;
    }

    let raw: SimulationParams;
    try {
      raw = await this.#port.getParams();
    } catch (err: unknown) {
      this.#fail(err);
      return;
    }

    this.#worker = readParamValues({ ...raw });
    this.#missing.clear();
    this.#pending = {};
    for (const f of PARAM_FIELDS) {
      const v = this.#worker[f.key];
      // 워커가 빠뜨린 키는 `readParamValues` 가 아예 안 담는다. 위젯은 그려야
      // 하므로 자리채움을 쓰되, **그 행이 자리채움이라고 말한다.**
      if (v === undefined) this.#missing.add(f.key);
      this.#pending[f.key] = v ?? f.fallback;
    }
    this.#phase = 'ready';
    this.#lastError = null;
  }

  #fail(err: unknown): void {
    this.#lastError = toError(err);
    this.#phase = 'error';
    this.#worker = {};
    this.#missing.clear();
    this.#hooks.log?.(`파라미터를 읽지 못했습니다: ${this.#lastError.message}`);
  }

  // ── 워커로 보내기 ─────────────────────────────────────────

  /**
   * **바뀐 것만** 보낸다 (규칙 ③). 순서는 하나뿐이다:
   *
   *   changedParams → buildSetParamsPayload → setParams → refresh
   *
   * 전부 보내면 죽은 필드가 섞이고(워커는 "적용됨" 이라 답한다) 사용자가 만지지도
   * 않은 값이 왕복한다. `dropped`·`unknown`·`adjusted` 는 **전부 사람에게
   * 말한다** — 특히 `adjusted` 는 사용자가 넣은 값이 조용히 바뀐 것이라
   * 가장 나쁜 거짓말이 될 수 있는 자리다.
   */
  async apply(): Promise<void> {
    if (this.#phase !== 'ready' || this.#busy) return;
    if (this.#blocked !== null) {
      this.#hooks.status?.(this.#blocked, true);
      return;
    }

    const next = changedParams(this.#worker, this.#pending);
    const built = buildSetParamsPayload(next);

    for (const a of built.adjusted) {
      this.#hooks.log?.(`⚠ 값 보정 — ${labelOf(a.key)}: ${a.reason}`);
    }
    if (built.adjusted.length > 0) {
      this.#hooks.status?.(
        `보내기 전에 값 ${built.adjusted.length}건을 범위에 맞춰 고쳤습니다 — 로그에 무엇을 어떻게 고쳤는지 있습니다`,
        true,
      );
    }
    if (built.dropped.length > 0) {
      this.#hooks.log?.(
        `보내지 않음 (엔진이 값을 보지 않는 필드): ${built.dropped.map(labelOf).join(', ')}`,
      );
    }
    if (built.unknown.length > 0) {
      // 여기 걸리면 화면이 스키마에 없는 키를 만든 것이다. 조용히 삼키지 않는다.
      this.#hooks.log?.(`보내지 않음 (스키마에 없는 키): ${built.unknown.join(', ')}`);
    }
    const firsts = [...this.#missing].filter((k) => Object.hasOwn(built.payload, k));
    if (firsts.length > 0) {
      this.#hooks.log?.(
        `워커가 주지 않았던 값을 화면의 자리채움으로 처음 보냅니다: ${firsts.map(labelOf).join(', ')}`,
      );
    }

    const keys = Object.keys(built.payload);
    if (keys.length === 0) {
      this.#hooks.status?.(
        built.dropped.length > 0
          ? '보낼 값이 없습니다 — 바뀐 것이 전부 엔진 미지원 필드입니다'
          : '보낼 값이 없습니다 — 바뀐 값이 없습니다',
      );
      this.#paintState();
      return;
    }

    this.#busy = true;
    this.#paintState();
    let res: SetParamsResult | null = null;
    try {
      res = await this.#port.setParams(built.payload);
      this.#hooks.log?.(`setParams — 보냄 ${keys.length}건 / 적용 ${res.applied.length}건`);
      if (res.unknown.length > 0) {
        this.#hooks.log?.(`⚠ 워커가 모르는 키: ${res.unknown.join(', ')}`);
      }
    } catch (err: unknown) {
      this.#lastError = toError(err);
      this.#hooks.status?.(`파라미터 적용 실패: ${this.#lastError.message}`, true);
    } finally {
      this.#busy = false;
    }

    // ★ 성공이든 실패든 되읽는다. 실패했을 때가 더 중요하다 — 요청이 워커에
    //   닿기는 했는지 우리는 모른다. 그 모름을 화면에 남기면 다시 ISSUE-009 다.
    await this.refresh();
    if (res === null) return;

    const off = this.#diff(built.payload);
    if (off.length === 0) {
      this.#hooks.status?.(`파라미터 ${res.applied.length}건 적용 — 워커의 값과 일치합니다`);
      return;
    }
    this.#hooks.log?.(`⚠ 워커가 다른 값을 들고 있습니다 — ${off.join(' · ')}`);
    this.#hooks.status?.(
      `적용했지만 워커의 값이 보낸 값과 다릅니다 (${off.length}건) — 화면은 워커의 값을 보여줍니다`,
      true,
    );
  }

  /** 보낸 값 vs 되읽은 값. **화면은 이미 워커 쪽으로 덮인 뒤다** */
  #diff(sent: Readonly<Record<string, number | boolean>>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(sent)) {
      const f = paramField(k);
      if (f === null) continue;
      const now = this.#worker[f.key];
      if (now === undefined || sameValue(f, v, now)) continue;
      out.push(`${f.label}: 보냄 ${String(v)} → 워커 ${String(now)}`);
    }
    return out;
  }

  // ── 그리기 ────────────────────────────────────────────────

  /** 위젯의 값. **`refresh()` 뒤에만 부른다** — 입력 중에 부르면 커서가 튄다 */
  #paintValues(): void {
    for (const [key, row] of this.#rows) {
      const v = this.#pending[key];
      row.set(v ?? row.field.fallback);
      row.fix.hidden = true;
      row.fix.textContent = '';
      const missing = this.#missing.has(key);
      row.src.hidden = !missing;
      row.src.textContent = missing ? t('params.row.missing') : '';
    }
  }

  /**
   * 비활성·버튼·문구. **편집할 때마다 부른다** — `useWind` 를 켜면 그 순간
   * `windMagnitude` 의 비활성이 풀려야 한다.
   */
  #paintState(): void {
    const ready = this.#phase === 'ready';
    const reasons = new Map<ParamKey, ParamDisabled>();
    for (const d of disabledParams({ values: this.#pending, simInitialized: this.#simInitialized })) {
      reasons.set(d.key, d);
    }

    // ⓪ 정적 글자를 지금 언어로 (I-1). 이 함수는 값이 바뀔 때마다 도는데,
    //    언어 전환도 배선이 여기로 흘려 보낸다.
    this.#applyBtn.title = t('btn.apply.title');
    this.#readBtn.textContent = t('params.read');
    this.#readBtn.title = t('params.read.title');
    for (const g of this.#groupHeads) g.el.textContent = PARAM_GROUP_LABELS[g.group];

    for (const [key, row] of this.#rows) {
      row.retext();
      const d = reasons.get(key) ?? null;
      row.setDisabled(d !== null || !ready || this.#busy);
      row.root.classList.toggle('off', d !== null);
      // ★ 규칙 ① — 이유는 **글자로** 남는다. title 은 덤이다.
      row.why.hidden = d === null;
      row.why.textContent = d === null ? '' : `${CAUSE_MARK[d.cause]} ${d.text}`;
      row.root.title = d === null ? row.field.description : d.text;
    }

    const dirty = this.dirty;
    this.#applyBtn.disabled = !ready || this.#busy || this.#blocked !== null || dirty === 0;
    this.#applyBtn.textContent = dirty === 0 ? t('btn.apply') : t('btn.apply.n', { n: dirty });
    this.#readBtn.disabled = this.#busy || !this.#port.connected;

    const banner = this.#bannerText();
    this.#banner.hidden = banner === null;
    this.#banner.textContent = banner ?? '';

    const hint = this.#hintText(ready, dirty);
    this.#hint.hidden = hint === null;
    this.#hint.textContent = hint ?? '';

    if (this.#badge) this.#badge.textContent = this.#badgeText(ready, dirty);
  }

  /** 화면 전체가 지금 믿을 만한가. 믿을 만하면 배너가 없다 */
  #bannerText(): string | null {
    switch (this.#phase) {
      case 'idle':
        return t('params.banner.idle');
      case 'disconnected':
        return t('params.banner.disconnected');
      case 'noScene':
        return t('params.banner.noScene');
      case 'loading':
        return t('params.banner.loading');
      case 'error':
        return t('params.banner.error', { why: this.#lastError?.message ?? t('err.unknownCause') });
      case 'ready':
        if (this.#stale) return t('params.banner.stale');
        if (this.#missing.size > 0) {
          return t('params.banner.missing', { n: this.#missing.size });
        }
        return null;
    }
  }

  /** 적용 버튼 옆 한 줄. **잠겨 있으면 왜 잠겼는지 여기 쓴다** */
  #hintText(ready: boolean, dirty: number): string | null {
    if (this.#blocked !== null) return `🔒 ${this.#blocked}`;
    if (!ready) return null;
    if (dirty === 0) return t('params.hint.clean');
    return t('params.hint.dirty', { n: dirty });
  }

  #badgeText(ready: boolean, dirty: number): string {
    if (this.#phase === 'loading') return t('params.badge.loading');
    if (this.#phase === 'disconnected') return t('params.badge.disconnected');
    if (this.#phase === 'noScene') return t('params.badge.noScene');
    if (this.#phase === 'error') return t('params.badge.error');
    if (this.#phase === 'idle') return t('params.badge.idle');
    if (!ready) return '';
    if (this.#stale) return t('params.badge.stale');
    return dirty === 0 ? t('params.badge.clean') : t('params.badge.dirty', { n: dirty });
  }

  // ── 행 만들기 ─────────────────────────────────────────────

  #buildRow(field: ParamField): Row {
    const root = document.createElement('div');
    root.className = 'prow';
    root.dataset['key'] = field.key;

    // 언어가 바뀔 때 다시 써야 하는 것들을 여기 모은다 (I-1). `#buildControl`
    // 이 자기 몫(`<option>`·aria-label)을 뒤에 덧붙인다.
    const retexts: Array<() => void> = [];

    const head = document.createElement('div');
    head.className = 'phead';
    const label = document.createElement('label');
    label.htmlFor = `p-${field.key}`;
    head.append(label);
    retexts.push(() => {
      label.textContent = field.label;
    });

    const effectBadgeKey = EFFECT_BADGE_KEY[field.effect];
    if (effectBadgeKey !== undefined) {
      const b = document.createElement('span');
      b.className = `pbadge ${field.effect}`;
      head.append(b);
      retexts.push(() => {
        b.textContent = t(effectBadgeKey);
      });
    }
    if (field.source === 'guess') {
      // 최소/최대가 코드 근거 없는 추정이라는 사실을 화면에 남긴다. 슬라이더
      // 끝이 "엔진의 한계" 로 읽히면 그것도 거짓말이다.
      const b = document.createElement('span');
      b.className = 'pbadge guess';
      head.append(b);
      retexts.push(() => {
        b.textContent = t('param.badge.guess');
        b.title = t('param.badge.guess.title');
      });
    }
    root.append(head);

    const box = document.createElement('div');
    box.className = 'pinputs';
    root.append(box);

    const why = line('pwhy');
    const fix = line('pfix');
    const src = line('psrc');

    const help = document.createElement('div');
    help.className = 'phelp';
    root.append(help);
    retexts.push(() => {
      help.textContent = field.description;
    });

    if (field.note !== null) {
      const note = document.createElement('div');
      note.className = 'pnote';
      root.append(note);
      retexts.push(() => {
        note.textContent = `ⓘ ${field.note ?? ''}`;
      });
    }
    root.append(why, fix, src);

    const row = this.#buildControl(field, box, { root, why, fix, src, retexts });
    // 처음 한 번은 여기서 찍는다 — `#paintState()` 가 뒤따라 오지만, 행이
    // 글자 없이 잠깐이라도 서는 것을 막는다.
    row.retext();
    return row;
  }

  #buildControl(
    field: ParamField,
    box: HTMLElement,
    parts: {
      root: HTMLElement;
      why: HTMLElement;
      fix: HTMLElement;
      src: HTMLElement;
      retexts: Array<() => void>;
    },
  ): Row {
    const retext = (): void => {
      for (const f of parts.retexts) f();
    };
    const commit = (row: Row, raw: unknown): void => {
      const c = coerceParamValue(field, raw);
      this.#pending[field.key] = c.value;
      row.set(c.value);
      row.fix.hidden = c.ok;
      row.fix.textContent = c.ok ? '' : `⚠ ${c.reason ?? ''}`;
      if (!c.ok && c.reason !== null) this.#hooks.log?.(`${field.label}: ${c.reason}`);
      this.#paintState();
    };

    if (field.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `p-${field.key}`;
      box.append(input);
      const row: Row = {
        field,
        root: parts.root,
        why: parts.why,
        fix: parts.fix,
        src: parts.src,
        retext,
        read: () => input.checked,
        set: (v) => {
          const on = v === true;
          if (input.checked !== on) input.checked = on;
        },
        setDisabled: (on) => {
          input.disabled = on;
        },
      };
      input.addEventListener('change', () => commit(row, row.read()));
      return row;
    }

    if (field.kind === 'enum') {
      const select = document.createElement('select');
      select.id = `p-${field.key}`;
      const opts: HTMLOptionElement[] = [];
      for (const o of field.options ?? []) {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        select.append(opt);
        opts.push(opt);
      }
      // `<option>` 글자도 화면 글자다 (I-1). 값(`opt.value`)은 엔진 enum 의
      // 숫자라 그대로 두고, 보이는 글자만 다시 쓴다.
      parts.retexts.push(() => {
        const list = field.options ?? [];
        opts.forEach((opt, i) => {
          const o = list[i];
          if (o) opt.textContent = o.label;
        });
      });
      box.append(select);
      const row: Row = {
        field,
        root: parts.root,
        why: parts.why,
        fix: parts.fix,
        src: parts.src,
        retext,
        read: () => Number(select.value),
        set: (v) => {
          const s = String(v);
          if (select.value !== s) select.value = s;
        },
        setDisabled: (on) => {
          select.disabled = on;
        },
      };
      select.addEventListener('change', () => commit(row, row.read()));
      return row;
    }

    // 숫자. **`step` 이 null 이면 슬라이더를 만들지 않는다** — `solverTolerance`
    // 는 1e-10..1 이라 선형 슬라이더로 훑는 것이 무의미하다(params.ts 의 주석).
    const number = document.createElement('input');
    number.type = 'number';
    number.id = `p-${field.key}`;
    number.step = field.step === null ? 'any' : String(field.step);
    if (field.min !== null) number.min = String(field.min);
    if (field.max !== null) number.max = String(field.max);

    const slider =
      field.step !== null && field.min !== null && field.max !== null
        ? document.createElement('input')
        : null;
    if (slider) {
      slider.type = 'range';
      slider.min = String(field.min);
      slider.max = String(field.max);
      slider.step = String(field.step);
      // 슬라이더에는 라벨을 붙이지 않는다 — 같은 값을 가리키는 두 위젯 중
      // 숫자 칸이 정본이고, htmlFor 가 둘이면 클릭 초점이 갈린다.
      // `aria-label` 도 화면 글자와 같이 움직여야 한다 (I-1).
      const s = slider;
      parts.retexts.push(() => s.setAttribute('aria-label', field.label));
      box.append(slider);
    }
    box.append(number);

    const readNumber = (): number => {
      const t = number.value.trim();
      // 빈 칸을 0 으로 읽지 않는다. `coerceParamValue` 가 NaN 을 "숫자가
      // 아닙니다" 로 잡아 이유를 화면에 남긴다.
      return t === '' ? Number.NaN : Number(t);
    };

    const row: Row = {
      field,
      root: parts.root,
      why: parts.why,
      fix: parts.fix,
      src: parts.src,
      retext,
      read: readNumber,
      set: (v) => {
        const s = String(v);
        if (number.value !== s) number.value = s;
        if (slider && slider.value !== s) slider.value = s;
      },
      setDisabled: (on) => {
        number.disabled = on;
        if (slider) slider.disabled = on;
      },
    };

    // 숫자 칸은 `change`(포커스가 떠나거나 Enter) 에서만 확정한다. `input` 마다
    // 클램프하면 "0.0" 을 치는 도중에 값이 잘려 나간다.
    number.addEventListener('change', () => commit(row, readNumber()));
    if (slider) {
      // 슬라이더는 끄는 동안 숫자 칸이 따라와야 한다. 값은 항상 범위 안이라
      // 클램프가 일어나지 않는다.
      slider.addEventListener('input', () => commit(row, Number(slider.value)));
    }
    return row;
  }
}
