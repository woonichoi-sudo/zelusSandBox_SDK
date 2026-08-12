/**
 * 키보드 단축키 (#14 / 데스크톱 기능 #60~#63) — **DOM 을 만지지 않는다.**
 *
 * 이벤트를 듣는 것(`addEventListener`)은 `main.ts` 의 일이고, **어떤 키가 어떤
 * 조작인가** 만 여기서 정한다. 순수 함수 하나라 Node 에서 표 전체를 돌릴 수 있다.
 *
 * ── 데스크톱과 같은 배치를 쓴다 ─────────────────────────────
 * `PROJECT_ANALYSIS.md` §4 의 기능 60~63 이 그대로다:
 *
 *   S      PLAY ↔ PAUSE 토글      (#60, MainGUI.cpp:766-775)
 *   R      SetAnimationMode(RESET) (#61, :763)
 *   C      Clear()                 (#62, :776)
 *   SPACE  SetAnimationMode(STEP)  (#63, :779)  ← ⛔ 지금은 꺼 두었다
 *
 * 새 배치를 발명하지 않은 이유는 **이 앱을 쓸 사람이 데스크톱을 쓰던 사람**
 * 이어서다. 손이 기억하는 것과 다르면 단축키가 있는 편이 더 나쁘다.
 *
 * ── ⛔ SPACE(#63)를 표에서 뺀 이유 ──────────────────────────
 * **[실측]** 워커의 `step` op 이 아무 일도 하지 않는다. 응답은 `{mode:"step"}`
 * 인데 곧바로 `status` 를 물으면 `mode:"pause"` 이고, `maxFrame` 은 5초가
 * 지나도 그대로다(정지 상태에서 3회 연속 시도, 프레임 14 → 14 → 14 → 14).
 * 즉 지금 SPACE 를 살려 두면 **키를 눌러도 아무 일이 없는데 브라우저의 기본
 * 동작(스크롤·포커스된 버튼 재클릭)만 빼앗는다** — 이 단위가 없애려던 바로 그
 * "화면이 거짓말한다" 다. 아래 `TABLE` 의 한 줄을 되살리는 것이 전부이므로,
 * 워커가 고쳐지면 그때 켠다. `PlaybackController.step()` 은 그대로 있다.
 *
 * ── 가로채면 안 되는 순간이 두 가지 있다 ────────────────────
 * ① **수식키가 눌려 있으면 손대지 않는다.** `Ctrl+R` 은 새로고침, `Ctrl+C` 는
 *    복사, `Cmd+R`·`Alt+…` 도 브라우저/OS 의 것이다. 여기서 `preventDefault()`
 *    를 걸면 사용자가 "브라우저가 고장났다" 고 느낀다. `Shift` 도 뺀다 — 대문자
 *    입력을 조작으로 읽을 이유가 없다.
 * ② **글자를 넣거나 버튼에 포커스가 있으면 손대지 않는다.** 화면에 `<select>`
 *    와 `<input type=file>` 이 있고, 무엇보다 **SPACE 는 포커스된 버튼을 다시
 *    누른다.** 재생 버튼을 누른 직후 스페이스를 치면 "step + play 토글" 이
 *    한꺼번에 일어난다 — 어느 쪽이 반응한 것인지 화면만 봐서는 알 수 없다.
 *    그래서 상호작용 요소가 대상이면 그쪽에 양보한다.
 *
 * ── 왜 `clear` 까지 단축키를 주는가 ─────────────────────────
 * `C` 는 씬을 내린다. 실수로 누르면 옷이 사라진다. 그래도 넣는 이유는 (a)
 * 데스크톱이 그렇고 (b) `.zls` 는 게이트웨이에 남아 있어 [로드] 한 번이면
 * 되돌아오기 때문이다. 잃는 것은 시뮬 진행뿐이다 (`playback.ts` 머리말).
 */

import { t } from './i18n.ts';

/** 단축키가 만들어 내는 조작. `PlaybackController` 의 메서드 이름과 맞춘다 */
export type ShortcutAction = 'toggle' | 'reset' | 'clear' | 'step';

/**
 * `KeyboardEvent` 에서 우리가 보는 것 전부. 이 모양이면 되므로 Node 테스트는
 * 객체 리터럴 하나로 표를 돌릴 수 있다 — `KeyboardEvent` 를 만들 필요가 없다.
 */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** IME 조합 중. 한글 입력 중의 `ㄴ` 을 조작으로 읽으면 안 된다 */
  isComposing?: boolean;
  /** 반복 입력(누르고 있는 중). 시뮬 op 을 초당 수십 번 보내지 않는다 */
  repeat?: boolean;
}

/** 대상 요소가 "키를 먼저 가져야 하는" 것인가. `main.ts` 가 태그 이름을 준다 */
export interface TargetLike {
  /** 대문자 태그 이름 (`INPUT`, `SELECT`, `BUTTON`, …) */
  tagName?: string;
  isContentEditable?: boolean;
}

/** 키 하나에 해당하는 조작. 없으면 null */
const TABLE: Record<string, ShortcutAction> = {
  s: 'toggle',
  r: 'reset',
  c: 'clear',
  // ⛔ 워커의 step 이 no-op 인 동안 꺼 둔다 (머리말 참고). 되살릴 때는 이 두 줄:
  //   ' ': 'step',
  //   spacebar: 'step',   // 옛 브라우저/일부 IME 가 스페이스를 이 이름으로 준다
};

/** 키를 양보해야 하는 요소들. SPACE 가 버튼을 다시 누르는 문제가 여기 걸린다 */
const INTERACTIVE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTION', 'A']);

export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return INTERACTIVE.has((target.tagName ?? '').toUpperCase());
}

/**
 * 이 키 입력이 무슨 조작인가. **아무것도 아니면 null** — 호출자는 그때
 * `preventDefault()` 를 걸지 않는다.
 */
export function shortcutFor(
  ev: KeyLike,
  target?: TargetLike | null,
): ShortcutAction | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
  if (ev.isComposing || ev.repeat) return null;
  if (isTypingTarget(target)) return null;
  return TABLE[ev.key.toLowerCase()] ?? null;
}

/**
 * 화면 아래 힌트에 쓸 한 줄. 표와 한 곳에서 나오게 둔다.
 *
 * ⚠️ **상수는 한국어로 굳는다** (I-1). 모듈이 로드되는 순간의 언어로 한 번
 *    계산되므로, 화면에는 이것 말고 아래 `shortcutHint()` 를 쓸 것. 상수를
 *    남겨 두는 이유는 스모크가 "SPACE 가 안내에 없다"·"S/R/C 가 있다" 를 이
 *    이름으로 보기 때문이다 — 검사의 대상은 **표에서 나온다는 사실**이지
 *    언어가 아니다.
 */
export const SHORTCUT_HINT = 'S 재생/정지 · R 리셋 · C 씬 내림';

/** 지금 언어로 된 단축키 한 줄 (I-1). 화면은 이것을 쓴다 */
export function shortcutHint(): string {
  return t('hint.shortcuts');
}

/**
 * 3D 칸의 조작 설명 (I-1). 예전에는 `index.html` 에 박혀 있었는데, 그러면
 * 언어를 바꿀 때 한 줄 안에서 앞 절반만 한국어로 남는다.
 */
export function viewHint(): string {
  return t('hint.view');
}
