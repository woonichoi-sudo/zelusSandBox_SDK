/**
 * 재단 도면의 **표시 스위치** 체크박스 (D2-e).
 *
 * `ui/avatarPanel.ts` · `ui/sideTabs.ts` 와 같은 층위다 — **판단이 한 줄도
 * 없다.** 갈래가 몇 개인지 · 지금 켜졌는지는 전부 `viewer2d/design.ts` 의
 * `Design2DLayer` 가 답하고, 여기 있는 것은 그 답을 체크박스로 옮기는 일뿐이다.
 *
 * ── ★ 상태를 여기가 안 갖는 이유 ────────────────────────────
 *
 * 체크박스의 `checked` 를 정본으로 두면 **씬을 다시 로드할 때 갈라진다** —
 * `Design2DLayer.build()` 가 객체를 새로 만들므로 선은 전부 켜진 채로 서는데
 * 체크박스는 꺼져 있는 그림이 된다. 콘솔에는 아무 이상이 없어 보이고 화면만
 * 거짓말을 한다. 그래서 켜짐/꺼짐은 레이어가 들고, 여기서는 **읽어서 그린다.**
 *
 * ── 왜 데스크톱의 뷰 옵션을 그대로 안 옮겼나 ────────────────
 *
 * `zwViewOptionManager` 에 옵션이 ~130개 있지만 `ReLoad()` 에 호출자가 없어
 * **통째로 동결돼 있다**(PROJECT_ANALYSIS §8). 옮길 동작이 없으므로 우리가
 * 그리는 것만 스위치로 낸다 — 지금은 6개다.
 */

import type { Design2DLayer, DesignLayerKey } from '../viewer2d/index.ts';

export interface Design2DOptionsView {
  key: DesignLayerKey;
  label: string;
  on: boolean;
}

export interface Design2DOptionsOptions {
  /** 체크박스가 그려질 자리 (`#draft2dOpts`) */
  root: HTMLElement;
  /** 상태의 정본. 이 위젯은 켜짐/꺼짐을 **소유하지 않는다** */
  layer: Design2DLayer;
  /** 바뀐 뒤. 로그를 남기고 싶을 때 쓴다 */
  onChange?: (key: DesignLayerKey, on: boolean) => void;
}

export class Design2DOptions {
  readonly #root: HTMLElement;
  readonly #layer: Design2DLayer;
  readonly #opts: Design2DOptionsOptions;
  readonly #boxes = new Map<DesignLayerKey, HTMLInputElement>();

  constructor(opts: Design2DOptionsOptions) {
    this.#root = opts.root;
    this.#layer = opts.layer;
    this.#opts = opts;

    for (const l of this.#layer.layers) {
      const label = document.createElement('label');
      label.className = 'dopt';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = `draft2dOpt-${l.key}`;
      box.checked = l.on;
      box.addEventListener('change', () => {
        this.#layer.setLayerVisible(l.key, box.checked);
        // 되읽어 맞춘다 — 레이어가 거절했다면(앞으로 그럴 수 있다) 체크박스가
        // 사실과 갈라지지 않는다.
        this.render();
        this.#opts.onChange?.(l.key, this.#layer.isLayerVisible(l.key));
      });

      const text = document.createElement('span');
      text.textContent = l.label;

      label.append(box, text);
      this.#boxes.set(l.key, box);
      this.#root.append(label);
    }
  }

  /** 레이어의 지금 상태를 화면에 옮긴다 */
  render(): void {
    for (const l of this.#layer.layers) {
      const box = this.#boxes.get(l.key);
      if (box) box.checked = l.on;
    }
  }

  /** 지금 화면이 말하고 있는 것. 진단용이다 */
  get view(): Design2DOptionsView[] {
    return this.#layer.layers;
  }
}
