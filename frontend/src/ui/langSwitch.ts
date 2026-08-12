/**
 * 언어 전환 위젯과 **정적 글자 채우기** (I-1).
 *
 * 이 디렉토리의 규칙대로 판단이 한 줄도 없다 — 어떤 언어가 있는지, 무엇이
 * 기본인지, 어디에 저장하는지는 전부 `panels/i18n.ts` 가 답하고 여기서는
 * 그 답을 `<select>` 와 `textContent` 로 옮기기만 한다.
 *
 * ── 왜 상단 바인가 ──────────────────────────────────────────
 *
 * 오른쪽 칸은 좁은 창에서 서랍으로 접힌다(`ui/sideDrawer.ts`). 언어를 못
 * 읽어서 언어를 바꾸려는 사람이 먼저 서랍 여는 법을 알아내야 한다면 순서가
 * 거꾸로다. 상단 바는 어느 폭에서도 항상 보인다.
 *
 * ── 왜 `data-i18n` 인가 ─────────────────────────────────────
 *
 * `index.html` 에는 우리가 마크업에 직접 박은 글자가 열댓 개 있다(씬 라벨,
 * 버튼 다섯, 빈 자리 표시, 툴팁 넷…). 이것들을 `main.ts` 에서 `el(...)` 로
 * 하나씩 잡아 채우면 배선이 그만큼 길어지고, `index.html` 에 글자를 하나 더
 * 넣는 날 **거기만 한국어로 남는다**(그 실패가 이 단위에서 가장 흔하다).
 * 마크업 옆에 키를 적어 두면 글자와 키가 한 자리에 있어 갈라지지 않는다.
 *
 *   <button id="load" data-i18n="bar.load">로드</button>
 *   <button id="reset" data-i18n-title="bar.reset.title">…</button>
 *
 * ⚠️ `data-i18n` 이 붙은 요소의 **자식은 지워진다**(`textContent` 대입).
 *    안에 다른 요소가 있는 자리에는 붙이지 말 것 — `<summary>` 처럼 배지
 *    `<span>` 을 품은 자리는 그 안쪽에 따로 붙인다.
 */

import { getLang, LANG_LABELS, LANGS, setLang, t, type Lang } from '../panels/index.ts';

/**
 * `data-i18n` · `data-i18n-title` · `data-i18n-aria` 가 붙은 요소를 지금
 * 언어로 채운다. 언어가 바뀔 때마다 다시 부르면 된다 — 새로고침이 필요 없는
 * 이유가 이것이다(씬 로드가 2~3초라 새로고침을 요구하면 언어를 바꿀 때마다
 * 씬을 다시 연다).
 */
export function applyStaticText(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n'];
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = node.dataset['i18nTitle'];
    if (key) node.title = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    const key = node.dataset['i18nAria'];
    if (key) node.setAttribute('aria-label', t(key));
  }
  // 문서 제목도 화면 글자다 — 탭에 보인다.
  const title = document.querySelector('title');
  if (title) title.textContent = t('app.title');
  // 스크린 리더와 브라우저의 번역 제안이 보는 값. 화면 글자와 갈라지면 안 된다.
  document.documentElement.lang = getLang();
}

export interface LangSwitchOptions {
  /** 상자가 들어갈 자리 (상단 바) */
  root: HTMLElement;
  /**
   * 언어가 바뀐 **뒤에** 부른다. 화면을 다시 그리는 것은 배선의 일이다 —
   * 이 위젯은 무엇을 다시 그려야 하는지 모른다.
   */
  onChange?: (lang: Lang) => void;
}

export class LangSwitch {
  readonly #select: HTMLSelectElement;
  readonly #label: HTMLLabelElement;

  constructor(opts: LangSwitchOptions) {
    this.#label = document.createElement('label');
    this.#label.htmlFor = 'lang';

    this.#select = document.createElement('select');
    this.#select.id = 'lang';
    for (const lang of LANGS) {
      const o = document.createElement('option');
      o.value = lang;
      // ⚠️ 언어 이름은 번역하지 않는다 — 자기 언어로 적혀 있어야 읽는다.
      o.textContent = LANG_LABELS[lang];
      this.#select.append(o);
    }
    this.#select.value = getLang();
    this.#select.addEventListener('change', () => {
      const next = setLang(this.#select.value);
      // 되읽어 맞춘다 — 모르는 값이 들어오면 한국어로 떨어지는데, 그때
      // 상자만 다른 것을 가리키고 있으면 화면이 거짓말을 한다.
      this.#select.value = next;
      opts.onChange?.(next);
    });

    // **맨 앞이다.** 언어는 화면 전체에 걸리는 조작이라 씬·재생보다 앞에 둔다 —
    // 그리고 오른쪽 끝은 상태 글자들이 길이를 오가며 쓰는 자리다.
    opts.root.prepend(this.#label, this.#select);
    this.render();
  }

  /** 지금 언어를 화면에 옮긴다. **상태를 만들지 않는다** */
  render(): void {
    this.#label.textContent = t('bar.lang');
    const now = getLang();
    if (this.#select.value !== now) this.#select.value = now;
  }
}
