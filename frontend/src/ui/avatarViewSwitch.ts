/**
 * 실시간 뷰의 **아바타 표시 스위치**와 한 줄 글자 (AM-1).
 *
 * `ui/design2dOptions.ts`(재단 도면의 표시 스위치)와 같은 층위이자 같은 모양이다 —
 * **판단이 한 줄도 없다.** 켜졌는지·지금 무슨 상태인지는 전부
 * `panels/avatarView.ts` 가 답하고, 여기 있는 것은 그 답을 체크박스와 글자로
 * 옮기는 일뿐이다.
 *
 * ── ★ 상태를 여기가 안 갖는 이유 ────────────────────────────
 * 체크박스의 `checked` 를 정본으로 두면 **씬을 다시 로드할 때 갈라진다** —
 * `Design2DOptions` 의 머리말과 같은 이야기이고, 여기서는 한 겹 더 있다:
 * 표시 여부의 정본은 `AvatarObject`(그리는 쪽)이고 컨트롤러도 사본을 두지
 * 않는다. 세 곳이 같은 불리언을 갖는 대신 **한 곳이 갖고 둘이 읽는다.**
 *
 * ── 왜 글자가 붙어 있나 ─────────────────────────────────────
 * 첫 요청이 **1.9MB** 라 눈에 띄게 걸린다. 그동안 아무 말이 없으면 "고장났다"
 * 로 읽힌다. 그리고 몸이 안 보이는 이유가 셋(끔 / 씬 없음 / 아바타 없는 씬)인데
 * 셋 다 화면상 똑같이 "몸이 없다" 라, 어느 쪽인지 글자가 말해야 한다.
 * **툴팁이 아니다** — 마우스를 올려야 보이는 것은 보이는 게 아니다(#16 에서 확립).
 */

import type { AvatarViewState } from '../panels/index.ts';

/** 컨트롤러 쪽. 구조적 타입이라 `AvatarViewController` 가 이미 만족한다 */
export interface AvatarViewSwitchPort {
  readonly view: AvatarViewState;
  setVisible(on: boolean): void;
}

export interface AvatarViewSwitchOptions {
  /** 체크박스가 그려질 자리 (`#view3dOpts`) */
  root: HTMLElement;
  /** 상태의 정본. 이 위젯은 켜짐/꺼짐을 **소유하지 않는다** */
  port: AvatarViewSwitchPort;
}

export class AvatarViewSwitch {
  readonly #port: AvatarViewSwitchPort;
  readonly #box: HTMLInputElement;
  readonly #stat: HTMLElement;

  constructor(opts: AvatarViewSwitchOptions) {
    this.#port = opts.port;

    const label = document.createElement('label');
    // 재단 도면의 스위치와 같은 클래스를 쓴다 — 같은 성격의 물건이 화면에서
    // 다르게 생길 이유가 없다.
    label.className = 'dopt';

    this.#box = document.createElement('input');
    this.#box.type = 'checkbox';
    this.#box.id = 'view3dAvatar';
    this.#box.checked = this.#port.view.visible;
    this.#box.addEventListener('change', () => {
      this.#port.setVisible(this.#box.checked);
      // 되읽어 맞춘다 — 컨트롤러가 거절했다면 체크박스가 사실과 갈라지지 않는다.
      this.render();
    });

    const text = document.createElement('span');
    text.textContent = '🧍 아바타';

    label.append(this.#box, text);

    this.#stat = document.createElement('span');
    this.#stat.className = 'dstat';

    opts.root.append(label, this.#stat);
    this.render();
  }

  /** 컨트롤러의 지금 상태를 화면에 옮긴다. **상태를 만들지 않는다** */
  render(view: AvatarViewState = this.#port.view): void {
    if (this.#box.checked !== view.visible) this.#box.checked = view.visible;
    this.#box.disabled = !view.canToggle;
    this.#stat.textContent = view.text;
    this.#stat.classList.toggle('err', view.isError);
  }
}
