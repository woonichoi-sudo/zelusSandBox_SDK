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
 * ② **슬라이더와 숫자를 같이 둔다.** 0~1 정규화라 슬라이더만으로는 지금 값이
 *    얼마인지 못 읽고, 숫자만으로는 범위 감각이 없다.
 *
 * ── 치수 25개는 **여기 없다** (W-2) ─────────────────────────
 *
 * L-3a 에서는 이 패널이 치수도 읽기 전용으로 그렸다. W-2 가 그것을 편집
 * 가능하게 만들면서 `ui/avatarMeasurePanel.ts` 로 옮겼다 — 같은 탭의 바로
 * 아래 칸이라 사용자가 보는 자리는 그대로다. 갈라 놓은 이유는 **왕복 시간**
 * 이다: 치수 쪽은 [적용] 한 번이 10초 넘게 걸려서 그동안 자기 상자만 다시
 * 그려야 하는데, 한 위젯이면 슬라이더 29개까지 같이 흔들린다.
 */

import { t, type AvatarBodyPanel, type AvatarBodyView } from '../panels/index.ts';

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

  /**
   * 매번 다시 만들지 않고 값만 갈아 끼우려고 잡아 둔다.
   *
   * ★ `label` 도 여기 있다 (I-1). `#build()` 는 **필드 구성이 바뀔 때만** 도는데
   *   언어 전환은 구성을 안 바꾼다 — 참조가 없으면 슬라이더 29개의 이름이
   *   한국어로 남는다.
   */
  readonly #inputs = new Map<string, {
    range: HTMLInputElement;
    num: HTMLElement;
    row: HTMLElement;
    label: HTMLElement;
  }>();

  /** 그룹 제목(`전체`·`상체` …). `#inputs` 와 같은 이유로 잡아 둔다 (I-1) */
  readonly #groupHeads = new Map<string, HTMLElement>();

  #title: HTMLElement;
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

    // 같은 탭에 [적용] 버튼이 둘(체형·치수)이 됐다. 어느 것이 무엇을 보내는지
    // 제목이 없으면 알 수 없다 — 하나는 정규화 0~1, 하나는 cm 다.
    // 글자·툴팁은 전부 `render()` 가 채운다 (I-1) — 생성자에서 찍으면
    // 언어를 바꿔도 이 상자만 한국어로 남는다.
    this.#title = document.createElement('h4');

    this.#bar = document.createElement('div');
    this.#bar.className = 'pbar';

    this.#apply = document.createElement('button');
    this.#apply.addEventListener('click', () => opts.onApply());

    this.#revert = document.createElement('button');
    this.#revert.addEventListener('click', () => opts.onRevert());

    this.#bar.append(this.#apply, this.#revert);

    this.#banner = document.createElement('div');
    this.#banner.className = 'pbanner';
    this.#banner.hidden = true;

    this.#body = document.createElement('div');

    this.#root.append(this.#title, this.#bar, this.#banner, this.#body);
    this.render();
  }

  render(view: AvatarBodyView = this.#panel.view): void {
    // 언어와 무관하게 늘 보이는 글자부터. **상태보다 먼저** — 아래 갈래 어느
    // 쪽으로 빠져도 제목과 버튼은 지금 언어여야 한다 (I-1).
    this.#title.textContent = t('side.body.title');
    this.#apply.textContent = t('btn.apply');
    this.#apply.title = t('btn.apply.title');
    this.#revert.textContent = t('btn.revert');
    this.#revert.title = t('side.body.revert.title');

    // ① 못 쓰는 상태 — 이유를 글자로.
    if (view.phase !== 'ready') {
      this.#builtFor = '';
      this.#inputs.clear();
      this.#groupHeads.clear();
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
      // 그룹 제목도 매번 다시 쓴다 — `g.label` 은 이미 번역된 글자다 (I-1)
      const head = this.#groupHeads.get(g.key);
      if (head) head.textContent = g.label;
      for (const f of g.fields) {
        const w = this.#inputs.get(f.key);
        if (!w) continue;
        // 이름도 매번 다시 쓴다 — 같은 이유다 (I-1)
        w.label.textContent = f.label;
        // 사용자가 잡고 있는 슬라이더의 값을 덮어쓰지 않는다.
        const want = String(Math.round(f.value * 1000));
        if (w.range.value !== want && document.activeElement !== w.range) w.range.value = want;
        w.num.textContent = fmt(f.value);
        w.row.classList.toggle('dirty', f.dirty);
      }
    }

    this.#apply.disabled = view.dirty === 0;
    this.#revert.disabled = view.dirty === 0;

    // 낡음 알림은 **치수 패널이 낸다** (W-2). 낡는 것도 풀리는 것도 그쪽
    // 숫자이고, 두 상자가 같은 말을 하면 어느 것이 정본인지 흐려진다.
    this.#banner.hidden = true;
    this.#banner.textContent = '';
  }

  #build(view: AvatarBodyView): void {
    this.#body.textContent = '';
    this.#inputs.clear();
    this.#groupHeads.clear();

    for (const g of view.groups) {
      const group = document.createElement('div');
      group.className = 'pgroup';

      const h = document.createElement('h4');
      h.textContent = g.label;
      this.#groupHeads.set(g.key, h);
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
        this.#inputs.set(f.key, { range, num, row, label });
      }

      this.#body.append(group);
    }
  }
}
