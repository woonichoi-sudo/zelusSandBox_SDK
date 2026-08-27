/**
 * 드레이핑 보드의 **DOM 렌더링** (DB-1) — 판단은 한 줄도 없다.
 *
 * `ui/surfacePanel.ts` 와 같은 층위이자 같은 규약이다. 화면 규칙도 같다:
 * 못 쓰는 상태와 빈 목록에는 **이유가 글자로** 남는다(툴팁이 아니다).
 *
 * ── 왜 표가 아니라 카드 격자인가 ────────────────────────────
 *
 * 옷 사이즈는 숫자를 고치는 표라 행이 맞다. 여기서 사용자가 하는 일은
 * **고르는 것**이고, 고르는 근거는 이름이 아니라 **그림**이다 — "advance" 와
 * "legacy" 라는 이름만 보고 어느 쪽이 원하는 포즈인지 알 수 없다. 실측
 * 썸네일이 512×512 정사각이라 격자에 그대로 얹힌다.
 *
 * ── ★ "고른 것" 과 "적용된 것" 은 다른 표시다 ───────────────
 *
 * 테두리(`.sel`)는 **사용자가 고른 것**이고, `적용됨` 배지는 **엔진이 지금 서
 * 있는 자리**(`activeUuid`)다. 둘을 하나로 합치면 "골랐는데 아직 적용 안 한
 * 상태" 가 화면에서 사라진다 — 그 상태가 이 패널의 존재 이유다(데스크톱 앱도
 * 목록에서 고르고 Apply 를 따로 누른다).
 *
 * 그리고 둘은 실제로 어긋날 수 있다: 적용이 `loadFailed` 로 끝나면 고른 것은
 * 그대로인데 엔진은 옛 자리에 남는다. 표시가 하나뿐이면 그 사실이 안 보인다.
 *
 * ── 썸네일을 언제 받는가 ────────────────────────────────────
 *
 * 카드를 **만들 때** 한 번 요청한다(`onNeedThumb`). 판단 쪽이 캐시를 들고
 * 있어서 두 번 부르면 두 번째는 왕복 없이 끝난다 — 그래서 여기서 "이미
 * 받았나" 를 따로 기억하지 않는다. 그 기억이 두 군데 있으면 갈라진다.
 */

import { t, type DrapingPanel, type DrapingView } from '../panels/index.ts';
// 아이템 타입은 **프로토콜의 것**이다 — `panels/` 를 지나오지 않는다.
// 워커가 말한 모양 그대로라, 중간에 다시 정의하면 두 벌이 갈라진다.
import type { DrapingItem } from '../protocol/index.ts';

export interface DrapingBoardPanelOptions {
  root: HTMLElement;
  panel: DrapingPanel;
  /** 카드를 눌렀다. **고르기만 한다** — 적용은 아래 버튼이다 */
  onSelect: (uuid: string | null) => void;
  /** [적용]. 인자가 없으면 판단 쪽이 고른 것(없으면 자동)을 쓴다 */
  onApply: () => void;
  /** [목록 새로고침] */
  onRefresh: () => void;
  /**
   * 이 아이템의 미리보기가 화면에 필요하다. **던지지 않는 함수여야 한다** —
   * 그리는 도중에 부르는 것이라 예외가 렌더링을 끊는다.
   */
  onNeedThumb: (uuid: string) => void;
}

export class DrapingBoardPanel {
  readonly #root: HTMLElement;
  readonly #panel: DrapingPanel;
  readonly #opts: DrapingBoardPanelOptions;

  readonly #head: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #refresh: HTMLButtonElement;
  readonly #apply: HTMLButtonElement;
  readonly #hint: HTMLElement;
  readonly #grid: HTMLElement;
  readonly #stat: HTMLElement;

  readonly #cards = new Map<string, {
    card: HTMLButtonElement;
    thumb: HTMLElement;
    name: HTMLElement;
    meta: HTMLElement;
    tags: HTMLElement;
  }>();

  /** 지금 격자가 **무엇으로** 서 있는가. 바뀔 때만 다시 만든다 */
  #builtFor = '';

  constructor(opts: DrapingBoardPanelOptions) {
    this.#root = opts.root;
    this.#panel = opts.panel;
    this.#opts = opts;

    // 글자는 `render()` 가 채운다 — 여기서 한 번 찍으면 언어 전환이 안 온다 (I-1)
    this.#head = document.createElement('h4');

    this.#refresh = document.createElement('button');
    this.#refresh.addEventListener('click', () => this.#opts.onRefresh());

    this.#apply = document.createElement('button');
    this.#apply.addEventListener('click', () => this.#opts.onApply());

    this.#bar = document.createElement('div');
    this.#bar.className = 'dbar';
    this.#bar.append(this.#refresh, this.#apply);

    // 아무것도 안 골랐을 때 [적용] 이 무엇을 하는지. 안 쓰면 빈 선택이
    // "아무 일도 안 일어난다" 로 읽히는데 실제로는 자동이 적용된다.
    this.#hint = document.createElement('div');
    this.#hint.className = 'phint';

    this.#grid = document.createElement('div');
    this.#grid.className = 'dgrid';

    this.#stat = document.createElement('div');
    this.#stat.className = 'dstat';

    this.#root.append(this.#head, this.#bar, this.#hint, this.#grid, this.#stat);
    this.render();
  }

  render(view: DrapingView = this.#panel.view): void {
    this.#head.textContent = t('drape.board.title');
    this.#refresh.textContent = t('drape.board.refresh');
    this.#apply.textContent = t('drape.board.apply');
    this.#refresh.disabled = !view.canRefresh;
    this.#apply.disabled = !view.canApply;

    // 고른 것이 없을 때만 말한다. 골랐으면 [적용] 이 무엇을 할지가 자명하다.
    this.#hint.textContent = view.selectedUuid === null ? t('drape.board.autoHint') : '';
    this.#hint.hidden = view.selectedUuid !== null;

    this.#renderGrid(view);

    // ★ 목록 사정(`listText`)이 적용 결과(`text`)보다 **먼저다.** 목록을 못
    //   읽은 화면에 "드레이프 적용됨" 만 남으면, 그 글자가 지금 보이지도 않는
    //   아이템을 가리키는 것처럼 읽힌다.
    const listText = view.listText;
    this.#stat.textContent = listText !== '' ? listText : view.text;
    this.#stat.classList.toggle(
      'err',
      listText !== '' ? view.list === 'error' : view.isError,
    );
  }

  #renderGrid(view: DrapingView): void {
    // 격자의 정체성 = 어떤 아이템이 어떤 순서로. **썸네일은 여기 안 넣는다** —
    // 그림이 도착할 때마다 카드를 다시 만들면 클릭 대상이 바뀐다.
    const shape = view.items.map((it) => it.uuid).join(',');
    if (shape !== this.#builtFor) {
      this.#build(view.items);
      this.#builtFor = shape;
    }

    for (const it of view.items) {
      const w = this.#cards.get(it.uuid);
      if (!w) continue;

      w.name.textContent = it.name;
      // ⛔ 이름은 씬 파일의 문자열이라 번역하지 않는다. **title 은 단다** —
      //    카드가 좁아 이름이 잘리므로, 잘린 전체를 볼 길이 있어야 한다.
      w.card.title = it.name;

      w.card.classList.toggle('sel', view.selectedUuid === it.uuid);

      // 배지: `자동`(파일이 정한 성격)과 `적용됨`(엔진이 지금 선 자리).
      // 위 머리말 참고 — 선택 테두리와 **겹치지 않는 별개의 사실**이다.
      w.tags.textContent = '';
      if (it.isAuto) w.tags.append(badge(t('drape.board.auto')));
      if (view.activeUuid !== null && view.activeUuid === it.uuid) {
        w.tags.append(badge(t('drape.board.active')));
      }

      const meta: string[] = [];
      if (it.frameNo !== undefined) meta.push(t('drape.board.frame', { frame: String(it.frameNo) }));
      if (it.savedAt !== undefined) {
        meta.push(t('drape.board.savedAt', { when: formatSavedAt(it.savedAt) }));
      }
      w.meta.textContent = meta.join(' · ');

      this.#renderThumb(w.thumb, it.uuid);
    }
  }

  /** 그림 한 칸. 없으면 **왜 없는지**를 그 자리에 글자로 쓴다 */
  #renderThumb(box: HTMLElement, uuid: string): void {
    const st = this.#panel.thumbnail(uuid);

    if (st.url !== null) {
      // 같은 url 이면 손대지 않는다 — `src` 를 다시 쓰면 브라우저가 그림을
      // 다시 디코딩하고, 그동안 칸이 한 프레임 빈다(깜빡인다).
      const img = box.firstElementChild;
      if (img instanceof HTMLImageElement) {
        if (img.src !== st.url) img.src = st.url;
        return;
      }
      const fresh = document.createElement('img');
      fresh.src = st.url;
      fresh.alt = '';           // 이름이 바로 아래 있다. 읽어 주면 두 번이다
      fresh.decoding = 'async';
      box.textContent = '';
      box.append(fresh);
      return;
    }

    const why = st.loading
      ? t('drape.board.thumbLoading')
      : st.reason === null
        ? t('drape.board.thumbLoading')   // 곧 요청이 나간다 (아래)
        : st.reason === 'noImage'
          ? t('drape.board.noThumb')
          : t('drape.board.thumbFailed');

    const cur = box.firstElementChild;
    if (cur instanceof HTMLElement && cur.classList.contains('dnone')) {
      cur.textContent = why;
    } else {
      const span = document.createElement('span');
      span.className = 'dnone';
      span.textContent = why;
      box.textContent = '';
      box.append(span);
    }

    // 아직 아무 일도 없었으면 지금 요청한다. 판단 쪽이 캐시와 "받는 중" 을
    // 들고 있으므로 여러 번 불려도 왕복은 아이템당 한 번이다.
    if (!st.loading && st.reason === null) this.#opts.onNeedThumb(uuid);
  }

  #build(items: readonly DrapingItem[]): void {
    this.#cards.clear();
    this.#grid.textContent = '';

    for (const it of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'dcard';

      const thumb = document.createElement('div');
      thumb.className = 'dthumb';

      const name = document.createElement('div');
      name.className = 'dname';

      const tags = document.createElement('div');
      tags.className = 'dtags';

      const meta = document.createElement('div');
      meta.className = 'dmeta';

      card.append(thumb, name, tags, meta);

      // 이미 고른 것을 다시 누르면 **선택이 풀린다** = 자동으로 돌아간다.
      // 선택을 지우는 다른 길이 없으면, 한 번 고른 사용자가 자동을 다시
      // 쓰려면 페이지를 새로 열어야 한다.
      card.addEventListener('click', () => {
        const sel = this.#panel.view.selectedUuid;
        this.#opts.onSelect(sel === it.uuid ? null : it.uuid);
      });

      this.#grid.append(card);
      this.#cards.set(it.uuid, { card, thumb, name, meta, tags });
    }
  }
}

function badge(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'pbadge';
  el.textContent = text;
  return el;
}

/**
 * unix 초 → 사람이 읽는 시각.
 *
 * ⚠️ **시간대를 약속하지 않는다.** `ztDateTime` 은 시간대를 안 들고 다니고
 *    (`Zest/common/ztDateTime.h`), 저장한 쪽이 UTC 였는지 로컬이었는지 기록이
 *    없다. 그래서 `toLocaleString` 으로 브라우저 시간대에 맞춰 찍되 **분까지만**
 *    보인다 — 초까지 쓰면 없는 정확도를 약속하는 것이 된다.
 */
function formatSavedAt(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
