/**
 * 옷 사이즈 패널의 **DOM 렌더링** (L-3b) — 판단은 한 줄도 없다.
 *
 * `ui/avatarPanel.ts` 와 같은 층위이자 같은 규약이다. 화면 규칙도 같다:
 * 못 쓰는 상태와 잘못된 값에는 **이유가 글자로** 남는다(툴팁이 아니다).
 *
 * ── 아바타 패널과 생김새가 다른 이유 ────────────────────────
 *
 * 체형은 슬라이더인데 여기는 숫자 입력이다. 값이 정규화 0~1 이 아니라
 * **실제 cm** 라 슬라이더로 만들면 범위를 우리가 정해야 하고, 그 범위가 곧
 * "이 옷은 이만큼까지만 커진다" 는 거짓 규칙이 된다(`panels/surfaceSize.ts`).
 *
 * ── [적용] 이 행마다 있는 이유 ──────────────────────────────
 *
 * 워커의 `setSurfaceSize` 가 서피스 하나를 받는다. 여러 행을 모아 보내려면
 * 왕복이 N번이고, 중간에 하나가 실패하면 "일부만 적용됨" 이라는 상태를 화면이
 * 표현해야 한다. 행마다 보내면 그 상태가 아예 생기지 않는다.
 */

import type { SurfaceSizePanel, SurfaceSizeView } from '../panels/index.ts';

export interface SurfacePanelOptions {
  root: HTMLElement;
  panel: SurfaceSizePanel;
  onEdit: (uuid: string, axis: 'width' | 'height', value: number) => void;
  /** 행 하나를 워커로 보낸다 */
  onApply: (uuid: string) => void;
  onRevert: (uuid: string) => void;
}

export class SurfacePanel {
  readonly #root: HTMLElement;
  readonly #panel: SurfaceSizePanel;
  readonly #opts: SurfacePanelOptions;

  readonly #rows = new Map<string, {
    row: HTMLElement;
    w: HTMLInputElement;
    h: HTMLInputElement;
    apply: HTMLButtonElement;
    revert: HTMLButtonElement;
    why: HTMLElement;
  }>();

  #head: HTMLElement;
  #banner: HTMLElement;
  #body: HTMLElement;
  #builtFor = '';

  constructor(opts: SurfacePanelOptions) {
    this.#root = opts.root;
    this.#panel = opts.panel;
    this.#opts = opts;

    this.#head = document.createElement('h4');
    this.#head.textContent = '옷 사이즈 (cm)';

    this.#banner = document.createElement('div');
    this.#banner.className = 'pbanner';
    this.#banner.hidden = true;

    this.#body = document.createElement('div');

    this.#root.append(this.#head, this.#banner, this.#body);
    this.render();
  }

  render(view: SurfaceSizeView = this.#panel.view): void {
    if (view.phase !== 'ready') {
      this.#builtFor = '';
      this.#rows.clear();
      this.#body.textContent = '';
      this.#banner.hidden = false;
      this.#banner.textContent = view.reason ?? '';
      return;
    }
    this.#banner.hidden = true;

    const shape = view.rows.map((r) => r.uuid).join(',');
    if (shape !== this.#builtFor) {
      this.#build(view);
      this.#builtFor = shape;
    }

    for (const r of view.rows) {
      const w = this.#rows.get(r.uuid);
      if (!w) continue;
      // 사용자가 타이핑 중인 칸은 덮어쓰지 않는다.
      if (document.activeElement !== w.w) w.w.value = r.editWidth.toFixed(2);
      if (document.activeElement !== w.h) w.h.value = r.editHeight.toFixed(2);
      w.row.classList.toggle('dirty', r.dirty);
      w.apply.disabled = !r.dirty || r.invalid !== undefined;
      w.revert.disabled = !r.dirty;
      // 잘못된 값은 회색만 되지 않는다 — 이유가 글자로 남는다.
      w.why.textContent = r.invalid ?? '';
      w.why.hidden = r.invalid === undefined;
    }
  }

  #build(view: SurfaceSizeView): void {
    this.#body.textContent = '';
    this.#rows.clear();

    for (const r of view.rows) {
      const row = document.createElement('div');
      row.className = 'prow srow';

      const head = document.createElement('div');
      head.className = 'phead';
      const name = document.createElement('label');
      name.textContent = r.name;
      // ⚠️ 이름이 유일하지 않다(실측: `pattern 9` 가 셋). uuid 를 툴팁으로
      //    남겨야 워커 로그와 대조할 수 있다.
      name.title = r.uuid;
      head.append(name);

      const inputs = document.createElement('div');
      inputs.className = 'pinputs';

      const mk = (axis: 'width' | 'height'): HTMLInputElement => {
        const i = document.createElement('input');
        i.type = 'number';
        i.step = '0.1';
        i.min = '0';
        i.addEventListener('input', () => this.#opts.onEdit(r.uuid, axis, Number(i.value)));
        return i;
      };
      const w = mk('width');
      const h = mk('height');
      const x = document.createElement('span');
      x.textContent = '×';
      x.className = 'phelp';
      inputs.append(w, x, h);

      const apply = document.createElement('button');
      apply.textContent = '적용';
      apply.addEventListener('click', () => this.#opts.onApply(r.uuid));

      const revert = document.createElement('button');
      revert.textContent = '↺';
      revert.title = '이 행의 편집을 버립니다';
      revert.addEventListener('click', () => this.#opts.onRevert(r.uuid));

      inputs.append(apply, revert);

      const why = document.createElement('div');
      why.className = 'pwhy';
      why.hidden = true;

      row.append(head, inputs, why);
      this.#body.append(row);
      this.#rows.set(r.uuid, { row, w, h, apply, revert, why });
    }
  }
}
