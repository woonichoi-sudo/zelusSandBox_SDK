/**
 * 오른쪽 칸을 좁은 창에서 서랍으로 바꾸는 판단 — **DOM 도 three 도 만지지 않는다.**
 *
 * `sideTabs.ts` 와 같은 층위다. 그리는 것은 `ui/sideDrawer.ts`, 배선은
 * `main.ts` 다. 이 모듈이 아는 것은 두 가지 사실뿐이다: **지금 좁은가**,
 * **서랍이 열려 있는가.**
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────
 *
 * 3분할의 세 번째 칸이 `minmax(0, 24rem)` 이었다. 최소가 **0** 이라 창을
 * 좁히면 칸이 끝없이 찌그러진다 — 슬라이더 29개와 치수 25개가 들어 있는
 * 칸이라 250px 아래로 가면 이름과 숫자가 겹쳐 읽을 수 없고, 그렇다고 최소를
 * 박아 두면 반대로 **좁은 창에서 뷰포트 둘이 0 이 된다.** 원래 주석(index.html
 * ④)이 최소를 0 으로 둔 이유가 정확히 그것이었다.
 *
 * 둘 다 피하는 길은 **좁아지면 칸을 격자에서 빼는 것**이다. 칸이 없어지면
 * 뷰포트가 자리를 다 쓰고, 필요할 때만 서랍으로 덮는다.
 *
 * ── ★ 문턱이 여기 한 곳에만 있다 ────────────────────────────
 *
 * `NARROW_MAX_PX` 가 정본이고 CSS 에는 미디어 쿼리를 **두지 않았다.**
 * 같은 숫자를 CSS 와 TS 양쪽에 적으면 한쪽만 고치는 날이 오고, 그때
 * "버튼은 있는데 칸이 그대로" 같은 어긋난 화면이 된다. 대신 `main.ts` 가
 * `matchMedia(narrowQuery())` 를 듣고 `<body>` 에 표식을 걸며, CSS 는
 * 그 표식에만 반응한다. **숫자의 주인은 이 파일이다.**
 *
 * 문턱 값의 근거: 서랍이 아닌 상태에서 칸이 최소 20rem(320px)이고 뷰포트
 * 둘에 각 280px 는 남아야 3분할이 성립한다 — 320 + 560 = 880. 여유를 조금
 * 두어 900 으로 잡았다.
 */

/** 3분할이 성립하는 하한. 이 값 **이하**면 서랍이 된다 (머리말 참고) */
export const NARROW_MAX_PX = 899;

/** `matchMedia` 에 넘길 질의. 문턱을 문자열로 만드는 유일한 자리다 */
export function narrowQuery(): string {
  return `(max-width: ${NARROW_MAX_PX}px)`;
}

/**
 * 칸이 지금 무엇으로 서 있는가.
 *
 * `docked` = 격자의 세 번째 칸. `drawer` = 뷰포트 위로 밀려나오는 서랍.
 */
export type SideDrawerMode = 'docked' | 'drawer';

export interface SideDrawerView {
  mode: SideDrawerMode;
  /**
   * 칸의 내용이 지금 보이는가.
   *
   * ★ `docked` 에서는 **항상 참이다.** 넓은 창에서는 접는 개념이 없다 —
   *   여닫기는 서랍일 때만 뜻이 있고, 그 사실을 이 필드가 흡수해 주므로
   *   그리는 쪽이 `mode` 로 갈래를 안 나눠도 된다.
   */
  open: boolean;
  /** 여닫기 버튼을 화면에 두는가. 서랍일 때만 참이다 */
  toggleVisible: boolean;
  /** 버튼 글자. 여는 동작인지 닫는 동작인지를 글자가 말한다 */
  toggleLabel: string;
  /** 버튼의 `aria-expanded` 에 그대로 넣을 값 */
  expanded: boolean;
}

/** 닫힌 서랍을 여는 버튼 / 열린 서랍을 닫는 버튼 */
const LABEL_OPEN = '☰ 설정';
const LABEL_CLOSE = '✕ 설정';

/**
 * 오른쪽 칸의 서랍 상태. **DOM 을 모른다.**
 *
 * 칸 **안의** 것(탭·슬라이더·치수)은 전혀 건드리지 않는다 — `sideTabs.ts`
 * 와 마찬가지로 "무엇이 보이는가" 만 정한다. 그래서 서랍이 닫혀 있는 동안에도
 * 패널들은 계속 갱신되고, 여는 순간 이미 최신이다.
 */
export class SideDrawerPanel {
  #mode: SideDrawerMode = 'docked';
  /** **서랍일 때만** 뜻이 있는 값. `docked` 에서는 읽지 않는다 */
  #open = false;

  get mode(): SideDrawerMode {
    return this.#mode;
  }

  /** 서랍이 실제로 화면을 덮고 있는가. `docked` 면 거짓이다 */
  get overlaying(): boolean {
    return this.#mode === 'drawer' && this.#open;
  }

  /**
   * 창 너비가 문턱을 넘나들 때 부른다.
   *
   * ★ **모드가 바뀌면 서랍을 닫는다.** 두 방향 모두 필요하다:
   *
   *   - 서랍 → 고정: 열어 둔 채 창을 넓히면 칸이 제자리로 돌아오는데
   *     `#open` 이 참으로 남는다. 다음에 창을 다시 좁히는 순간 **아무도
   *     누르지 않은 서랍이 열린 채로** 나타난다.
   *   - 고정 → 서랍: 닫힌 채로 시작한다. 창을 좁혔더니 설정 칸이 뷰포트를
   *     덮고 있는 것은 사용자가 시킨 적 없는 일이다.
   *
   * @returns 모드가 실제로 바뀌었으면 참. 부르는 쪽이 다시 그릴지 정한다
   */
  setNarrow(narrow: boolean): boolean {
    const next: SideDrawerMode = narrow ? 'drawer' : 'docked';
    if (next === this.#mode) return false;
    this.#mode = next;
    this.#open = false;
    return true;
  }

  /**
   * 서랍을 여닫는다.
   *
   * **고정 모드에서는 아무 일도 하지 않는다.** 던지지 않는 이유는
   * `sideTabs.select` 와 같다 — 버튼이 안 보이는 상태에서 단축키가 들어오는
   * 경로가 있고, 그때 배선이 죽는 것보다 무시하는 편이 낫다.
   *
   * @returns 실제로 바뀌었으면 참
   */
  toggle(): boolean {
    if (this.#mode !== 'drawer') return false;
    this.#open = !this.#open;
    return true;
  }

  /** @returns 실제로 바뀌었으면 참 */
  close(): boolean {
    if (this.#mode !== 'drawer' || !this.#open) return false;
    this.#open = false;
    return true;
  }

  /** @returns 실제로 바뀌었으면 참 */
  open(): boolean {
    if (this.#mode !== 'drawer' || this.#open) return false;
    this.#open = true;
    return true;
  }

  get view(): SideDrawerView {
    const drawer = this.#mode === 'drawer';
    // 고정 모드의 `open: true` 는 머리말 참고 — 넓은 창에는 접는 개념이 없다.
    const open = drawer ? this.#open : true;
    return {
      mode: this.#mode,
      open,
      toggleVisible: drawer,
      toggleLabel: this.#open ? LABEL_CLOSE : LABEL_OPEN,
      expanded: drawer && this.#open,
    };
  }
}
