/**
 * 오른쪽 칸 탭 바의 **DOM 렌더링** (L-3c) — 판단은 한 줄도 없다.
 *
 * `ui/avatarPanel.ts` · `ui/surfacePanel.ts` 와 같은 층위다. 탭이 몇 개인지 ·
 * 어느 상자와 짝인지 · 지금 어느 것이 켜졌는지는 전부
 * `panels/sideTabs.ts` 가 답하고, 여기 있는 것은 그 답을 버튼과 가시성으로
 * 옮기는 일뿐이다.
 *
 * ── ★ 두 패널의 내용에는 손대지 않는다 ──────────────────────
 *
 * 이 모듈이 만지는 것은 `#avatarPanel` · `#surfacePanel` 상자의 **가시성뿐**
 * 이고, 그 안을 그리는 것은 여전히 `AvatarPanel` · `SurfacePanel` 이다. 숨은
 * 탭도 `main.ts` 가 씬마다 계속 그리므로 탭을 켜는 순간 이미 최신이다 —
 * 탭 전환에 갱신을 매달면 "탭을 한 번 눌러야 값이 맞는" 화면이 된다.
 *
 * ── ⚠️ `hidden` 만 믿지 않는다 ──────────────────────────────
 *
 * 브라우저 기본 스타일의 `[hidden] { display: none }` 은 작성자 규칙에 진다.
 * L-2a 에서 `.todo { display: flex }` 가 그것을 이겨, 코드는 "숨겼다" 는데
 * 화면에는 글자가 그대로 뜬 적이 있다 — 속성과 화면이 갈라지면 콘솔로는
 * 아무 이상이 없어 보이므로 원인을 렌더링 쪽에서 찾게 된다. 그래서 여기서는
 * 속성과 별개로 `index.html` 의 `#sideScroll > .sidepane[hidden]` 규칙이
 * `display: none` 을 못박고, 이 모듈은 둘 다 건다.
 *
 * ── 스크롤 위치는 **탭마다 기억한다** ───────────────────────
 *
 * 아바타 탭은 슬라이더 29 + 치수 25 로 길다. 옷 사이즈를 확인하고 돌아왔을 때
 * 맨 위로 튀면 만지던 자리를 다시 찾아 내려가야 하고, 이 칸이 존재하는 이유인
 * "몸을 키웠더니 옷이 안 맞는다" 를 오가며 보는 흐름이 그때마다 끊긴다.
 * 기억은 이 모듈이 한다 — 스크롤 위치는 화면 상태이지 판단이 아니다.
 */

import { type SideTabId, type SideTabsPanel, type SideTabsView } from '../panels/index.ts';

export interface SideTabsOptions {
  /** 탭 버튼이 그려질 자리 (`#sideTabs`). **스크롤 상자 바깥이어야 한다** */
  root: HTMLElement;
  /** 내용이 담긴 스크롤 상자 (`#sideScroll`). 위치를 기억·복원할 대상이다 */
  scroll: HTMLElement;
  /** 상태 모듈. 이 위젯은 활성 탭을 **소유하지 않는다** */
  panel: SideTabsPanel;
  /** 탭이 실제로 바뀐 뒤. 안 바뀌었으면 부르지 않는다 */
  onChange?: (id: SideTabId) => void;
}

export class SideTabs {
  readonly #root: HTMLElement;
  readonly #scroll: HTMLElement;
  readonly #panel: SideTabsPanel;
  readonly #opts: SideTabsOptions;

  readonly #buttons = new Map<SideTabId, HTMLButtonElement>();
  readonly #panes = new Map<SideTabId, HTMLElement>();
  /** 탭 → 마지막으로 보던 스크롤 위치 (머리말 참고) */
  readonly #scrollTop = new Map<SideTabId, number>();

  constructor(opts: SideTabsOptions) {
    this.#root = opts.root;
    this.#scroll = opts.scroll;
    this.#panel = opts.panel;
    this.#opts = opts;

    this.#root.setAttribute('role', 'tablist');

    for (const t of this.#panel.view.tabs) {
      const pane = document.getElementById(t.paneId);
      // 상자가 없으면 **조용히 넘어가지 않는다.** 탭만 남고 내용이 없는 칸은
      // "빈 패널" 로 보여서, 마크업이 어긋났다는 사실이 화면에 안 남는다.
      if (!pane) throw new Error(`#${t.paneId} 가 없습니다 (${t.id} 탭)`);
      // 아래 CSS 규칙(`#sideScroll > .sidepane[hidden]`)이 걸릴 표식.
      pane.classList.add('sidepane');
      this.#panes.set(t.id, pane);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stab';
      btn.textContent = t.label;
      btn.setAttribute('role', 'tab');
      btn.id = `sideTab-${t.id}`;
      btn.setAttribute('aria-controls', t.paneId);
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', btn.id);
      btn.addEventListener('click', () => this.select(t.id));

      this.#buttons.set(t.id, btn);
      this.#root.append(btn);
    }

    this.render();
  }

  /**
   * 탭을 켠다. 클릭 핸들러와 바깥(단축키 등)이 같은 문을 쓴다.
   *
   * 스크롤 저장·복원이 **바뀔 때만** 일어나는 것이 핵심이다. 같은 탭을 다시
   * 누를 때도 돌리면 지금 보고 있던 자리가 저장값으로 튄다.
   */
  select(id: SideTabId): void {
    const prev = this.#panel.active;
    // 안 바뀌었으면 **아무것도 하지 않는다.** 여기서 저장값을 되돌리면 같은 탭을
    // 다시 누른 순간 보고 있던 자리가 옛 위치로 튄다 (머리말 참고).
    if (!this.#panel.select(id)) return;
    this.#scrollTop.set(prev, this.#scroll.scrollTop);
    this.render();
    // ★ 복원은 `render()` **뒤**여야 한다. 숨어 있는 동안에는 상자가 짧아
    //   `scrollTop` 이 그 높이로 잘려 들어간다.
    this.#scroll.scrollTop = this.#scrollTop.get(this.#panel.active) ?? 0;
    this.#opts.onChange?.(this.#panel.active);
  }

  render(view: SideTabsView = this.#panel.view): void {
    for (const t of view.tabs) {
      const btn = this.#buttons.get(t.id);
      if (btn) {
        // 글자도 매번 다시 쓴다 — 언어가 바뀌면 `t.label` 이 달라진다 (I-1).
        btn.textContent = t.label;
        btn.classList.toggle('on', t.active);
        btn.setAttribute('aria-selected', t.active ? 'true' : 'false');
        // 켜진 탭은 눌러도 할 일이 없다. 비활성으로 만들면 포커스가 빠져
        // 키보드로 탭을 오갈 수 없으므로 **글자만** 진하게 둔다.
        btn.tabIndex = t.active ? 0 : -1;
      }
      const pane = this.#panes.get(t.id);
      if (pane) pane.hidden = !t.active;
    }
  }
}
