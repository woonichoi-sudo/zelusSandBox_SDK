/**
 * 실시간 뷰의 **텍스처 표시 스위치**와 한 줄 글자 (materials-c).
 *
 * `ui/avatarViewSwitch.ts`·`ui/design2dOptions.ts` 와 같은 층위이자 같은 모양이다 —
 * **판단이 한 줄도 없다.** 켜졌는지·무엇이 실렸는지는 `panels/textures.ts` 의
 * `TextureOptions` 가 답하고, 여기 있는 것은 그 답을 체크박스와 글자로 옮기는
 * 일뿐이다.
 *
 * ── 왜 이 스위치가 있나 ─────────────────────────────────────
 * 검증 도구다. 스냅샷(`🧍 스냅샷`)이 정답지인데, 무늬가 켜져 있으면 "색이
 * 맞는가"와 "무늬가 맞는가"가 한 화면에서 섞인다. 껐다 켜면 사람이 그 둘을
 * 가를 수 있다. **끄는 데 왕복이 없다** — 이미 받아 둔 것을 화면에서 뗄 뿐이다.
 *
 * ── 왜 글자가 붙어 있나 ─────────────────────────────────────
 * 첫 로드가 **19.7MB** 다. 그동안 아무 말이 없으면 "무늬가 안 나온다"로 읽히고,
 * 그게 정말 실패인지 아직 오는 중인지 구분할 수 없다. 그리고 게이트웨이가
 * 허용 뿌리 밖이라고 거절한 칸이 있으면 **그 사실을 아는 유일한 화면**이 여기다.
 * **툴팁이 아니다** — 마우스를 올려야 보이는 것은 보이는 게 아니다(#16 에서 확립).
 */

import { t, type TextureOptionsState } from '../panels/index.ts';

/** 컨트롤러 쪽. 구조적 타입이라 `TextureOptions` 가 이미 만족한다 */
export interface TextureSwitchPort {
  readonly state: TextureOptionsState;
  setEnabled(on: boolean): void;
}

export interface TextureSwitchOptions {
  /** 체크박스가 그려질 자리 (`#view3dOpts`) */
  root: HTMLElement;
  /** 상태의 정본. 이 위젯은 켜짐/꺼짐을 **소유하지 않는다** */
  port: TextureSwitchPort;
}

export class TextureSwitch {
  readonly #port: TextureSwitchPort;
  readonly #box: HTMLInputElement;
  readonly #stat: HTMLElement;
  /** 체크박스 옆 글자. 참조를 들고 있어야 언어 전환이 여기까지 온다 (I-1) */
  readonly #text: HTMLElement;

  constructor(opts: TextureSwitchOptions) {
    this.#port = opts.port;

    const label = document.createElement('label');
    // 옆의 아바타 스위치와 같은 클래스를 쓴다 — 같은 성격의 물건이 화면에서
    // 다르게 생길 이유가 없다.
    label.className = 'dopt';

    this.#box = document.createElement('input');
    this.#box.type = 'checkbox';
    this.#box.id = 'view3dTextures';
    this.#box.checked = this.#port.state.enabled;
    this.#box.addEventListener('change', () => {
      this.#port.setEnabled(this.#box.checked);
      // 되읽어 맞춘다 — 컨트롤러가 거절했다면 체크박스가 사실과 갈라지지 않는다.
      this.render();
    });

    const text = document.createElement('span');
    // 글자는 `render()` 가 채운다 — 여기서 한 번 찍으면 언어 전환이 안 온다 (I-1)
    this.#text = text;

    label.append(this.#box, text);

    this.#stat = document.createElement('span');
    this.#stat.className = 'dstat';

    opts.root.append(label, this.#stat);
    this.render();
  }

  /** 컨트롤러의 지금 상태를 화면에 옮긴다. **상태를 만들지 않는다** */
  render(state: TextureOptionsState = this.#port.state): void {
    this.#text.textContent = t('cell.texture');
    if (this.#box.checked !== state.enabled) this.#box.checked = state.enabled;
    this.#stat.textContent = state.text;
    this.#stat.classList.toggle('err', state.isError);
  }
}
