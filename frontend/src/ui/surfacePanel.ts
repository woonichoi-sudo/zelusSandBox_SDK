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

import {
  t,
  type FabricsPanel, type FabricsView,
  type SurfaceSizePanel, type SurfaceSizeView,
} from '../panels/index.ts';

export interface SurfacePanelOptions {
  root: HTMLElement;
  panel: SurfaceSizePanel;
  onEdit: (uuid: string, axis: 'width' | 'height', value: number) => void;
  /** 행 하나를 워커로 보낸다 */
  onApply: (uuid: string) => void;
  onRevert: (uuid: string) => void;
  /**
   * 직물 (UI #50). **행마다 콤보 하나**다 — 조각을 식별할 수 있는 자리가
   * 여기뿐이라 크기와 같은 행에 붙인다(`panels/fabrics.ts` 머리말).
   */
  fabrics: FabricsPanel;
  /** 콤보를 바꾸는 순간 바로 보낸다 — [적용] 버튼을 따로 두지 않는다 */
  onFabric: (surfaceUuid: string, fabricId: string) => void;
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
    fabric: HTMLSelectElement;
    fabricLabel: HTMLElement;
  }>();

  #head: HTMLElement;
  #banner: HTMLElement;
  #body: HTMLElement;
  #builtFor = '';
  /** 직물 콤보의 항목이 무엇으로 서 있는가. 바뀔 때만 다시 만든다 */
  #fabricOptionsFor = '';
  /** 프리셋이 없다는 안내 (`panels/fabrics.ts` 의 `notice`) */
  #notice: HTMLElement;

  constructor(opts: SurfacePanelOptions) {
    this.#root = opts.root;
    this.#panel = opts.panel;
    this.#opts = opts;

    // 글자는 `render()` 가 채운다 — 여기서 한 번 찍으면 언어 전환이 안 온다 (I-1)
    this.#head = document.createElement('h4');

    this.#banner = document.createElement('div');
    this.#banner.className = 'pbanner';
    this.#banner.hidden = true;

    this.#body = document.createElement('div');

    // 프리셋이 없다는 안내. 배너와 달리 **`ready` 일 때도 뜬다** — 기능은
    // 멀쩡한데 선택지가 좁다는 사실이라, 못 쓰는 이유가 아니라 조건이다.
    this.#notice = document.createElement('div');
    this.#notice.className = 'pbanner';
    this.#notice.hidden = true;

    this.#root.append(this.#head, this.#banner, this.#notice, this.#body);
    this.render();
  }

  render(view: SurfaceSizeView = this.#panel.view, fabrics: FabricsView = this.#opts.fabrics.view): void {
    this.#head.textContent = t('side.surface.title');
    if (view.phase !== 'ready') {
      this.#notice.hidden = true;
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
      // ⚠️ 버튼 글자를 **여기서** 다시 쓴다 (I-1). `#build()` 는 행 목록이
      //    바뀔 때만 도는데 언어 전환은 목록을 안 바꾼다 — 거기 두면 [적용]
      //    스물넷이 한국어로 남는다.
      w.apply.textContent = t('btn.apply');
      w.revert.title = t('side.surface.revert.title');
      w.apply.disabled = !r.dirty || r.invalid !== undefined;
      w.revert.disabled = !r.dirty;
      // 잘못된 값은 회색만 되지 않는다 — 이유가 글자로 남는다.
      w.why.textContent = r.invalid ?? '';
      w.why.hidden = r.invalid === undefined;
    }

    this.#renderFabrics(fabrics);
  }

  /**
   * 직물 콤보 (UI #50). **항목은 목록이 바뀔 때만 다시 만든다** — 매번 새로
   * 만들면 사용자가 콤보를 연 채로 갱신이 돌 때 목록이 닫힌다.
   */
  #renderFabrics(view: FabricsView): void {
    this.#notice.textContent = view.notice ?? '';
    this.#notice.hidden = view.notice === null;

    // 항목의 정체성 = id + 글자. 글자가 바뀌는 경우는 언어 전환뿐이다.
    const shape = view.options.map((o) => `${o.id}:${o.label}:${String(o.missingTexture)}`).join('|')
      + `|${t('fabric.missingTexture')}`;
    const rebuild = shape !== this.#fabricOptionsFor;
    if (rebuild) this.#fabricOptionsFor = shape;

    for (const [uuid, w] of this.#rows) {
      const row = view.rows.get(uuid);
      w.fabricLabel.textContent = t('fabric.label');

      // 직물을 못 쓰는 상태면 콤보를 감춘다. 회색으로 두면 "왜 안 되는지" 를
      // 행마다 스물넷 번 말해야 하는데, 이유는 패널 위 배너가 한 번 말한다.
      const usable = view.phase === 'ready' && row !== undefined;
      w.fabric.hidden = !usable;
      w.fabricLabel.hidden = !usable;
      if (!usable) continue;

      if (rebuild) {
        w.fabric.textContent = '';
        for (const o of view.options) {
          const opt = document.createElement('option');
          opt.value = o.id;
          // ⚠️ 이름은 엔진이 준 값이라 **번역하지 않는다.** 뒤에 붙는 경고만
          //    사전을 탄다 — 고르기 전에 알아야 하는 사실이다.
          opt.textContent = o.label + (o.missingTexture ? t('fabric.missingTexture') : '');
          w.fabric.append(opt);
        }
      }

      // 왕복 중에는 잠근다. 연타하면 워커가 같은 서피스를 두 번 고쳐 쓴다.
      w.fabric.disabled = row.busy;
      // ⚠️ 사용자가 콤보를 **연 채로** 있으면 덮지 않는다 — 브라우저가 열린
      //    목록을 닫아 버려서, 고르는 도중에 선택이 튄다.
      if (document.activeElement !== w.fabric) w.fabric.value = row.current;
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

      // 글자·툴팁은 `render()` 가 채운다 (I-1) — `↺` 는 기호라 그대로다
      const apply = document.createElement('button');
      apply.addEventListener('click', () => this.#opts.onApply(r.uuid));

      const revert = document.createElement('button');
      revert.textContent = '↺';
      revert.addEventListener('click', () => this.#opts.onRevert(r.uuid));

      inputs.append(apply, revert);

      const why = document.createElement('div');
      why.className = 'pwhy';
      why.hidden = true;

      // ── 직물 콤보 (UI #50) ─────────────────────────────────
      //
      // ★ **바꾸는 순간 보낸다.** [적용] 버튼을 따로 두지 않는 이유는
      //   `panels/fabrics.ts` 머리말에 있다 — 고르는 행위 자체가 결정이다.
      const fabricWrap = document.createElement('div');
      fabricWrap.className = 'pinputs';
      const fabricLabel = document.createElement('span');
      fabricLabel.className = 'phelp';
      const fabric = document.createElement('select');
      fabric.addEventListener('change', () => {
        this.#opts.onFabric(r.uuid, fabric.value);
      });
      fabricWrap.append(fabricLabel, fabric);

      row.append(head, inputs, fabricWrap, why);
      this.#body.append(row);
      this.#rows.set(r.uuid, { row, w, h, apply, revert, why, fabric, fabricLabel });
    }
  }
}
