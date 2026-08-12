/**
 * 치수 패널의 **DOM 렌더링** (W-2) — 판단은 한 줄도 없다.
 *
 * `ui/surfacePanel.ts` 와 같은 층위이자 거의 같은 생김새다(숫자 입력 + cm).
 * 무엇을 보낼지 · 몇 초 걸릴지 · 왜 못 누르는지 · 낡았는지는 전부
 * `panels/avatarMeasure.ts` 가 답하고, 여기 있는 것은 그 답을 위젯으로
 * 옮기는 일뿐이다.
 *
 * ── 화면 규칙 ───────────────────────────────────────────────
 *
 * ① **못 쓰는 상태·실패 사유는 화면 글자다.** 툴팁이 아니다 — 마우스를 올려야
 *    보이는 것은 보이는 게 아니다(#16 에서 확립). 특히 `notSupported`
 *    (`sample.zls` 처럼 `ztDesignZeta` 가 아닌 아바타)는 **눌러 봐야 아는
 *    갈래**라, 이 글자가 없으면 "눌렀는데 아무 일도 없다" 가 된다.
 * ② **[적용] 은 행마다가 아니라 하나다.** `surfacePanel` 과 갈리는 지점이고,
 *    이유는 워커 쪽이다 — `setAvatarMeasurements` 는 여러 치수를 **한 번에**
 *    받아 같이 밀고, 나눠 보내면 15초짜리 왕복이 그 수만큼 늘어난다.
 * ③ **왕복이 10초 넘게 걸린다.** 그동안 버튼은 잠기고 글자는 경과/예상 초를
 *    센다. 숫자가 움직이지 않으면 화면이 멈춘 것처럼 보이므로 여기서 1초마다
 *    다시 그린다 — **이 타이머가 이 파일에 있는 유일한 "동작" 이다**(무엇을
 *    말할지는 여전히 `view.text` 가 정한다).
 * ④ **목표와 실제가 다른 것은 오류가 아니다.** 셰이퍼의 근사라(실측 99.3%)
 *    차이는 회색 글자로 덧붙이고 빨갛게 칠하지 않는다.
 */

import { t, type AvatarMeasureController, type AvatarMeasureView } from '../panels/index.ts';

export interface AvatarMeasurePanelOptions {
  /** 행이 그려질 자리 */
  root: HTMLElement;
  /** 상태 모듈. 이 위젯은 값을 **소유하지 않는다** */
  panel: AvatarMeasureController;
  onEdit: (key: string, value: number) => void;
  /** [적용] — 25개가 아니라 **바뀐 것만** 나간다 */
  onApply: () => void;
  onRevert: () => void;
}

/** 왕복 중에 경과 초를 다시 찍는 주기. 1초면 "멈추지 않았다" 가 보인다 */
const TICK_MS = 1_000;

export class AvatarMeasurePanel {
  readonly #root: HTMLElement;
  readonly #panel: AvatarMeasureController;
  readonly #opts: AvatarMeasurePanelOptions;

  readonly #rows = new Map<string, {
    row: HTMLElement;
    input: HTMLInputElement;
    now: HTMLElement;
    why: HTMLElement;
  }>();

  #title: HTMLElement;
  #bar: HTMLElement;
  #apply: HTMLButtonElement;
  #revert: HTMLButtonElement;
  /** 낡음 알림 — 체형 슬라이더를 보낸 뒤에만 뜬다 */
  #stale: HTMLElement;
  /** 사유·진행·결과가 나오는 한 줄 */
  #stat: HTMLElement;
  #body: HTMLElement;
  #builtFor = '';
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AvatarMeasurePanelOptions) {
    this.#root = opts.root;
    this.#panel = opts.panel;
    this.#opts = opts;

    // 글자는 전부 `render()` 가 채운다 (I-1) — 생성자에서 찍으면 언어를
    // 바꿔도 이 상자만 한국어로 남는다.
    this.#title = document.createElement('h4');

    this.#bar = document.createElement('div');
    this.#bar.className = 'pbar';

    this.#apply = document.createElement('button');
    this.#apply.addEventListener('click', () => opts.onApply());

    this.#revert = document.createElement('button');
    this.#revert.addEventListener('click', () => opts.onRevert());

    this.#bar.append(this.#apply, this.#revert);

    this.#stale = document.createElement('div');
    this.#stale.className = 'pbanner';
    this.#stale.hidden = true;

    this.#stat = document.createElement('div');
    this.#stat.className = 'mstat';

    this.#body = document.createElement('div');

    this.#root.append(this.#title, this.#bar, this.#stale, this.#stat, this.#body);
    this.render();
  }

  render(view: AvatarMeasureView = this.#panel.view): void {
    // ⓪ 늘 보이는 글자부터 (I-1)
    this.#title.textContent = t('side.meas.title');
    this.#apply.textContent = t('btn.apply');
    this.#revert.textContent = t('btn.revert');

    // ① 사유든 진행이든 결과든 **한 줄로 화면에 남는다.**
    this.#stat.textContent = view.text;
    this.#stat.classList.toggle('err', view.isError);
    this.#stat.hidden = view.text === '';

    // ③ 왕복 중에만 시계를 돌린다. 안 돌리면 "0초" 에 멎어 화면이 멈춰 보인다.
    this.#tick(view.busy);

    // ② 체형을 보낸 뒤라면 이 숫자들이 낡았다는 사실을 말한다.
    this.#stale.hidden = !view.stale;
    this.#stale.textContent = view.stale ? t('side.meas.stale') : '';

    this.#apply.disabled = !view.canApply;
    this.#revert.disabled = view.dirty === 0 || view.busy;

    // 표를 못 그리는 상태(연결 없음·씬 없음·아바타 없음)면 행을 비운다.
    // 사유는 위 `#stat` 이 이미 말했다.
    if (view.rows.length === 0) {
      this.#builtFor = '';
      this.#rows.clear();
      this.#body.textContent = '';
      return;
    }

    const shape = view.rows.map((r) => r.key).join(',');
    if (shape !== this.#builtFor) {
      this.#build(view);
      this.#builtFor = shape;
    }

    for (const r of view.rows) {
      const w = this.#rows.get(r.key);
      if (!w) continue;
      // 사용자가 타이핑 중인 칸은 덮어쓰지 않는다.
      if (document.activeElement !== w.input) w.input.value = r.value.toFixed(2);
      w.input.disabled = view.busy;
      w.row.classList.toggle('dirty', r.dirty);

      // ④ 지금 몸의 값 + (목표를 걸었다면) 근사 차이. **오류가 아니다.**
      w.now.textContent = t('side.meas.now', { v: r.current.toFixed(2) })
        + (r.offset === undefined || Math.abs(r.offset) < 0.005
          ? ''
          : t('side.meas.target', {
            v: r.target?.toFixed(2) ?? '',
            d: `${r.offset > 0 ? '+' : ''}${r.offset.toFixed(2)}`,
          }))
        + (r.locked ? t('side.meas.locked') : '');

      // 잘못된 값은 회색만 되지 않는다 — 이유가 글자로 남는다.
      w.why.textContent = r.invalid ?? '';
      w.why.hidden = r.invalid === undefined;
    }
  }

  /** 왕복 중에만 1초마다 다시 그린다. 끝나면 반드시 멈춘다 */
  #tick(on: boolean): void {
    if (on && this.#timer === null) {
      this.#timer = setInterval(() => {
        // ⚠️ `render()` 를 통째로 다시 부르면 이 함수가 자기 자신을 다시
        //    부른다(무한이 되지는 않지만 표 전체를 1초마다 훑는다). 왕복
        //    중에 바뀌는 것은 글자 한 줄뿐이라 그것만 갈아 끼운다.
        const v = this.#panel.view;
        this.#stat.textContent = v.text;
        if (!v.busy) this.#tick(false);
      }, TICK_MS);
      return;
    }
    if (!on && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #build(view: AvatarMeasureView): void {
    this.#body.textContent = '';
    this.#rows.clear();

    for (const r of view.rows) {
      const row = document.createElement('div');
      row.className = 'prow mrow';

      const head = document.createElement('div');
      head.className = 'phead';
      const name = document.createElement('label');
      // ⚠️ 엔진 이름 그대로다. cm 단위의 실제 치수라 이름을 우리가 옮기면
      //    사용자가 **잘못된 부위를 잘못된 값으로** 만든다(`panels/` 머리말).
      name.textContent = r.key;
      head.append(name);

      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.min = '0';
      input.addEventListener('input', () => this.#opts.onEdit(r.key, Number(input.value)));
      head.append(input);

      const now = document.createElement('div');
      now.className = 'phelp';

      const why = document.createElement('div');
      why.className = 'pwhy';
      why.hidden = true;

      row.append(head, now, why);
      this.#body.append(row);
      this.#rows.set(r.key, { row, input, now, why });
    }
  }
}
