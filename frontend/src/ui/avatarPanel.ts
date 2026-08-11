/**
 * 아바타 체형 패널의 **DOM 렌더링** (L-3a) — 판단은 한 줄도 없다.
 *
 * `ui/paramsPanel.ts` 와 같은 층위이자 같은 규약이다. 무엇을 보여줄지 ·
 * 무엇을 보낼지 · 치수가 낡았는지는 전부 `panels/avatarBody.ts` 가 답하고,
 * 여기 있는 것은 **그 답을 위젯으로 옮기는 일**뿐이다.
 *
 * ── ★ 화면 규칙 (paramsPanel 과 같다) ───────────────────────
 *
 * ① **못 쓰는 상태에는 이유가 글자로 남는다.** 툴팁이 아니라 화면 글자다 —
 *    마우스를 올려야 보이는 것은 보이는 게 아니다.
 * ② **치수가 낡았으면 그 사실을 말한다.** 체형을 보낸 뒤의 `real` 은 로드 시점
 *    값이다(워커가 갱신해 주지 않는다). 숫자만 그대로 두면 화면이 거짓말을
 *    한다 — 이 패널에서 가장 조용히 틀릴 수 있는 자리다.
 * ③ **슬라이더와 숫자를 같이 둔다.** 0~1 정규화라 슬라이더만으로는 지금 값이
 *    얼마인지 못 읽고, 숫자만으로는 범위 감각이 없다.
 */

import type { AvatarBodyPanel, AvatarBodyView } from '../panels/index.ts';

export interface AvatarPanelOptions {
  /** 행이 그려질 자리 */
  root: HTMLElement;
  /** 상태 모듈. 이 패널은 값을 **소유하지 않는다** */
  panel: AvatarBodyPanel;
  /** 사용자가 슬라이더를 움직였다. 다시 그리는 것은 부르는 쪽이 정한다 */
  onEdit: (key: string, value: number) => void;
  /** [적용] */
  onApply: () => void;
  /** [되돌리기] */
  onRevert: () => void;
}

/** 0~1 을 소수 셋째 자리까지. 엔진이 float32 라 그 아래는 의미가 없다 */
function fmt(v: number): string {
  return v.toFixed(3);
}

export class AvatarPanel {
  readonly #root: HTMLElement;
  readonly #panel: AvatarBodyPanel;
  readonly #opts: AvatarPanelOptions;

  /** 매번 다시 만들지 않고 값만 갈아 끼우려고 잡아 둔다 */
  readonly #inputs = new Map<string, { range: HTMLInputElement; num: HTMLElement; row: HTMLElement }>();

  #bar: HTMLElement;
  #apply: HTMLButtonElement;
  #revert: HTMLButtonElement;
  #banner: HTMLElement;
  #body: HTMLElement;
  /** 마지막으로 행을 만든 필드 구성. 달라졌을 때만 다시 만든다 */
  #builtFor = '';

  constructor(opts: AvatarPanelOptions) {
    this.#root = opts.root;
    this.#panel = opts.panel;
    this.#opts = opts;

    this.#bar = document.createElement('div');
    this.#bar.className = 'pbar';

    this.#apply = document.createElement('button');
    this.#apply.textContent = '적용';
    this.#apply.title = '바뀐 값만 워커로 보냅니다';
    this.#apply.addEventListener('click', () => opts.onApply());

    this.#revert = document.createElement('button');
    this.#revert.textContent = '되돌리기';
    this.#revert.title = '화면의 편집을 버리고 워커의 실제 값으로 다시 채웁니다';
    this.#revert.addEventListener('click', () => opts.onRevert());

    this.#bar.append(this.#apply, this.#revert);

    this.#banner = document.createElement('div');
    this.#banner.className = 'pbanner';
    this.#banner.hidden = true;

    this.#body = document.createElement('div');

    this.#root.append(this.#bar, this.#banner, this.#body);
    this.render();
  }

  render(view: AvatarBodyView = this.#panel.view): void {
    // ① 못 쓰는 상태 — 이유를 글자로.
    if (view.phase !== 'ready') {
      this.#builtFor = '';
      this.#inputs.clear();
      this.#body.textContent = '';
      this.#banner.hidden = false;
      this.#banner.textContent = view.reason ?? '';
      this.#apply.disabled = true;
      this.#revert.disabled = true;
      return;
    }

    // 구성이 그대로면 행을 다시 만들지 않는다. 슬라이더를 미는 동안 DOM 이
    // 통째로 갈리면 포커스와 드래그가 끊긴다.
    const shape = view.groups.map((g) => `${g.key}:${g.fields.map((f) => f.key).join(',')}`).join('|');
    if (shape !== this.#builtFor) {
      this.#build(view);
      this.#builtFor = shape;
    }

    for (const g of view.groups) {
      for (const f of g.fields) {
        const w = this.#inputs.get(f.key);
        if (!w) continue;
        // 사용자가 잡고 있는 슬라이더의 값을 덮어쓰지 않는다.
        const want = String(Math.round(f.value * 1000));
        if (w.range.value !== want && document.activeElement !== w.range) w.range.value = want;
        w.num.textContent = fmt(f.value);
        w.row.classList.toggle('dirty', f.dirty);
      }
    }

    this.#apply.disabled = view.dirty === 0;
    this.#revert.disabled = view.dirty === 0;

    // ② 치수가 낡았으면 그 사실을 말한다.
    this.#banner.hidden = !view.measurementsStale;
    this.#banner.textContent = view.measurementsStale
      ? '아래 치수는 로드했을 때의 값입니다 — 체형을 바꿔도 갱신되지 않습니다. 정확한 치수를 보려면 씬을 다시 로드하세요.'
      : '';
  }

  #build(view: AvatarBodyView): void {
    this.#body.textContent = '';
    this.#inputs.clear();

    for (const g of view.groups) {
      const group = document.createElement('div');
      group.className = 'pgroup';

      const h = document.createElement('h4');
      h.textContent = g.label;
      group.append(h);

      for (const f of g.fields) {
        const row = document.createElement('div');
        row.className = 'prow arow';

        const head = document.createElement('div');
        head.className = 'phead';
        const label = document.createElement('label');
        label.textContent = f.label;
        // 엔진 키를 툴팁으로 남긴다 — 워커 로그나 프로토콜과 대조할 때 쓴다.
        label.title = f.key;
        const num = document.createElement('span');
        num.className = 'anum';
        head.append(label, num);

        const range = document.createElement('input');
        range.type = 'range';
        // 0~1 을 1/1000 눈금으로. 엔진이 float32 라 그 아래는 의미가 없다.
        range.min = '0';
        range.max = '1000';
        range.step = '1';
        range.addEventListener('input', () => {
          this.#opts.onEdit(f.key, Number(range.value) / 1000);
        });

        row.append(head, range);
        group.append(row);
        this.#inputs.set(f.key, { range, num, row });
      }

      this.#body.append(group);
    }

    // 치수 — 읽기 전용이다. 쓰기는 `SetMeasurementParam` 경로이고 우리 op 에
    // 아직 없다(체형 쪽만 열었다).
    if (view.measurements.length > 0) {
      const group = document.createElement('div');
      group.className = 'pgroup';
      const h = document.createElement('h4');
      h.textContent = `치수 (cm) — 읽기 전용 ${view.measurements.length}개`;
      group.append(h);

      for (const m of view.measurements) {
        const row = document.createElement('div');
        row.className = 'prow amrow';
        const k = document.createElement('span');
        k.textContent = m.label;
        const v = document.createElement('b');
        v.textContent = m.real.toFixed(1);
        row.append(k, v);
        group.append(row);
      }
      this.#body.append(group);
    }
  }
}
