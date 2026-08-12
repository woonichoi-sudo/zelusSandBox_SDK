/**
 * 오른쪽 칸 서랍의 **DOM 렌더링** — 판단은 한 줄도 없다.
 *
 * `ui/sideTabs.ts` 와 같은 층위다. 문턱이 얼마인지 · 지금 서랍인지 · 열려
 * 있는지는 전부 `panels/sideDrawer.ts` 가 답하고, 여기 있는 것은 그 답을
 * **`<body>` 의 표식 두 개와 버튼 하나**로 옮기는 일뿐이다.
 *
 * ── ★ 배치를 CSS 에 맡기고 좌표를 계산하지 않는다 ───────────
 *
 * 서랍이 상단 바를 덮지 않아야 하는데, 바 높이는 버튼이 줄바꿈되면 달라진다.
 * `position: fixed; top: <바 높이>` 로 가면 그 높이를 JS 가 재서 CSS 변수로
 * 넘겨야 하고, 바가 두 줄이 되는 순간 어긋난다.
 *
 * 그래서 **칸을 격자 안에 그대로 둔다.** 좁을 때 `grid-column: 1 / -1;
 * grid-row: 2; justify-self: end` 로 두 뷰포트와 **같은 칸을 겹쳐** 쓰고
 * 오른쪽에 붙인다(index.html 의 `body.narrow #sidePanel`). 격자가 이미 바를
 * 뺀 자리를 알고 있으므로 계산할 숫자가 하나도 없다.
 *
 * ── ⚠️ 바깥을 눌러도 안 닫는다 ─────────────────────────────
 *
 * 서랍 UI 의 관례이지만 **여기서는 일부러 뺐다.** 서랍 바깥이 3D·2D
 * 뷰포트이고 거기서 마우스를 누르는 것은 대개 **카메라를 돌리는 드래그**다.
 * 드래그를 시작한 지점으로 서랍을 닫으면 "돌리려다 설정이 사라지는" 화면이
 * 된다. 닫는 길은 버튼과 Escape 둘로 두었다.
 *
 * ── 왜 `hidden` 이 아니라 표식인가 ─────────────────────────
 *
 * 서랍이 닫혀도 칸은 DOM 에 그대로 있어야 한다. `hidden` 으로 지우면
 * 안쪽 패널들이 크기 0 이 되고, 다시 열 때 `sideTabs` 가 기억해 둔 스크롤
 * 위치가 0 으로 잘려 들어간다(`ui/sideTabs.ts` 의 같은 함정). 그래서 화면
 * 밖으로 밀어내기만 한다 — `transform` 은 레이아웃을 안 건드린다.
 */

import { t, type SideDrawerPanel, type SideDrawerView } from '../panels/index.ts';

/** 좁은 창일 때 `<body>` 에 붙는 표식. CSS 가 이것만 본다 */
const CLASS_NARROW = 'narrow';
/** 서랍이 열렸을 때 `<body>` 에 붙는 표식 */
const CLASS_OPEN = 'sideOpen';

export interface SideDrawerOptions {
  /** 표식이 걸릴 곳. 보통 `document.body` */
  body: HTMLElement;
  /** 서랍이 될 칸 (`#sidePanel`). `aria-hidden` 을 걸 대상이다 */
  panel: HTMLElement;
  /** 여닫기 버튼이 들어갈 자리 (상단 바) */
  bar: HTMLElement;
  /** 상태 모듈. 이 위젯은 열림 상태를 **소유하지 않는다** */
  state: SideDrawerPanel;
  /**
   * 서랍이 열리거나 닫힌 뒤. 안 바뀌었으면 부르지 않는다.
   *
   * ⓘ 뷰포트 크기 갱신을 여기에 매달 필요는 **없다** — 두 뷰어가
   *   `ResizeObserver` 로 자기 칸을 보고 있어서 격자가 바뀌면 알아서 따라온다.
   */
  onChange?: (open: boolean) => void;
}

export class SideDrawer {
  readonly #opts: SideDrawerOptions;
  readonly #state: SideDrawerPanel;
  readonly #button: HTMLButtonElement;

  constructor(opts: SideDrawerOptions) {
    this.#opts = opts;
    this.#state = opts.state;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sideToggle';
    btn.setAttribute('aria-controls', opts.panel.id);
    btn.addEventListener('click', () => this.toggle());
    this.#button = btn;
    opts.bar.append(btn);

    // Escape 는 **문서 전체**에서 듣는다. 서랍 안에 포커스가 있을 때만 들으면
    // 열어 놓고 뷰포트를 만진 뒤에는 안 닫혀서, 되는 때와 안 되는 때가 갈린다.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.#state.close()) {
        this.render();
        this.#opts.onChange?.(false);
      }
    });

    this.render();
  }

  /** 창 너비가 바뀌었다. `main.ts` 의 `matchMedia` 가 부른다 */
  setNarrow(narrow: boolean): void {
    if (!this.#state.setNarrow(narrow)) return;
    this.render();
  }

  toggle(): void {
    if (!this.#state.toggle()) return;
    this.render();
    this.#opts.onChange?.(this.#state.overlaying);
  }

  render(view: SideDrawerView = this.#state.view): void {
    const { body, panel } = this.#opts;

    body.classList.toggle(CLASS_NARROW, view.mode === 'drawer');
    body.classList.toggle(CLASS_OPEN, view.expanded);

    this.#button.hidden = !view.toggleVisible;
    this.#button.textContent = view.toggleLabel;
    // 툴팁도 매번 다시 쓴다 — 생성자에서 한 번 찍으면 언어를 바꿔도 안 바뀐다 (I-1)
    this.#button.title = t('side.drawer.title');
    this.#button.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');

    // 화면 밖으로 밀린 칸은 **읽는 기계에도 없어야 한다.** 보이지 않는데
    // 탭 순서에는 남아 있으면 Tab 키가 빈 곳을 훑는다.
    panel.setAttribute('aria-hidden', view.open ? 'false' : 'true');
    // `inert` 를 함께 거는 이유: `aria-hidden` 은 포커스를 막지 못한다.
    // 지원하지 않는 브라우저에서는 아래 CSS 의 `pointer-events: none` 이 남는다.
    panel.toggleAttribute('inert', !view.open);
  }
}
