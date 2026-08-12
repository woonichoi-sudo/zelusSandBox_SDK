/**
 * 옷 사이즈 패널의 판단 (L-3b) — **DOM 도 three 도 만지지 않는다.**
 *
 * `avatarBody.ts` 와 같은 규약이자 거의 같은 모양이다. 다른 점 셋만 적는다.
 *
 * ── ① 값이 cm 다. 정규화가 아니다 ───────────────────────────
 *
 * 체형은 0~1 이라 슬라이더가 자연스럽지만, 여기는 **실제 치수**다
 * (실측: `pattern 2` 가 23.673 × 9.739cm). 슬라이더로 만들면 범위를 우리가
 * 정해야 하는데, 그 범위가 곧 "이 옷은 이만큼까지만 커진다" 는 거짓 규칙이
 * 된다. 그래서 숫자 입력이다.
 *
 * ── ② 한 번에 하나만 보낸다 ─────────────────────────────────
 *
 * 워커의 `setSurfaceSize` 가 서피스 하나를 받는다. 체형처럼 여러 개를 모아
 * 보낼 수 없으므로 **[적용] 버튼도 행마다**다. 여러 행을 모아 보내려면
 * 게이트웨이가 왕복을 N번 하게 되는데, 중간에 하나가 실패하면 화면이
 * "일부만 적용됨" 이라는 상태를 표현해야 한다 — 그 상태를 만들지 않는 편이 낫다.
 *
 * ── ③ 이름이 유일하지 않다 ──────────────────────────────────
 *
 * **[실측]** 사용자 씬의 서피스 24개 중 `pattern 9` 가 셋, `pattern 3` 이 넷,
 * `pattern 8` 이 둘이다. 그래서 **이름으로 행을 찾으면 안 되고**, 화면도
 * 이름만으로는 어느 것인지 알려주지 못한다 — 크기를 함께 보여주는 것이
 * 구분 수단이다.
 */

import { t } from './i18n.ts';
import type { SurfaceInfo } from '../protocol/index.ts';

/** 화면에 그릴 행 하나 */
export interface SurfaceRow {
  uuid: string;
  name: string;
  /** 워커가 마지막으로 말한 크기. cm */
  width: number;
  height: number;
  /** 화면이 들고 있는 값. 워커 값과 다르면 아직 안 보낸 편집이다 */
  editWidth: number;
  editHeight: number;
  dirty: boolean;
  /** 값이 유효하지 않으면 이유. **화면 글자가 된다** */
  invalid?: string;
}

export type SurfacePhase = 'noScene' | 'empty' | 'ready';

export interface SurfaceSizeView {
  phase: SurfacePhase;
  /** 왜 못 쓰는지. `phase !== 'ready'` 일 때만 있다 */
  reason?: string;
  rows: SurfaceRow[];
  dirty: number;
}

/** 0 이하와 비수를 막는다. 상한은 두지 않는다 — 아래 주석 참고 */
export function validateSize(v: number): string | undefined {
  if (!Number.isFinite(v)) return t('valid.notNumber');
  if (v <= 0) return t('valid.notPositive');
  // ⚠️ 상한을 두지 않는다. "옷이 이만큼까지만 커진다" 는 우리가 아는 사실이
  //    아니고, 막아 두면 엔진이 실제로 어떻게 다루는지가 우리 코드에 가려진다.
  //    게이트웨이·워커도 같은 판단이다.
  return undefined;
}

export class SurfaceSizePanel {
  #worker: SurfaceInfo[] = [];
  #edits = new Map<string, { width?: number; height?: number }>();
  #phase: SurfacePhase = 'noScene';

  /** 워커가 말한 사실로 덮어쓴다. 편집 중이던 값은 **버린다** */
  setFromWorker(list: SurfaceInfo[] | null): void {
    this.#edits.clear();
    if (!list) {
      this.#phase = 'noScene';
      this.#worker = [];
      return;
    }
    this.#worker = [...list];
    this.#phase = list.length === 0 ? 'empty' : 'ready';
  }

  clear(): void {
    this.setFromWorker(null);
  }

  /**
   * 한 축을 편집한다.
   *
   * 워커 값과 같아지면 그 축의 편집을 지우고, 두 축이 다 지워지면 행 전체를
   * 지운다 — 안 지우면 dirty 수가 안 줄어 [적용] 이 켜진 채로 남는다.
   */
  edit(uuid: string, axis: 'width' | 'height', value: number): void {
    const base = this.#worker.find((s) => s.uuid === uuid);
    if (!base) return;

    const cur = this.#edits.get(uuid) ?? {};
    if (base[axis] === value) delete cur[axis];
    else cur[axis] = value;

    if (cur.width === undefined && cur.height === undefined) this.#edits.delete(uuid);
    else this.#edits.set(uuid, cur);
  }

  /** 행 하나의 편집을 버린다 */
  revert(uuid: string): void {
    this.#edits.delete(uuid);
  }

  /**
   * 행 하나가 보낼 것. 바꾼 축만 담는다.
   *
   * 안 바꾼 축을 함께 보내면, 그 사이 엔진이 값을 조정했을 때(실측: 폭을
   * 바꾸면 높이가 0.03% 흔들린다) **낡은 값으로 되돌려 쓰게 된다.**
   */
  payload(uuid: string): { width?: number; height?: number } | null {
    const e = this.#edits.get(uuid);
    if (!e) return null;
    const out: { width?: number; height?: number } = {};
    if (e.width !== undefined && validateSize(e.width) === undefined) out.width = e.width;
    if (e.height !== undefined && validateSize(e.height) === undefined) out.height = e.height;
    return out.width === undefined && out.height === undefined ? null : out;
  }

  get view(): SurfaceSizeView {
    const reason
      = this.#phase === 'noScene' ? t('surface.noScene')
      : this.#phase === 'empty' ? t('surface.empty')
      : undefined;

    const rows: SurfaceRow[] = this.#worker.map((s) => {
      const e = this.#edits.get(s.uuid);
      const editWidth = e?.width ?? s.width;
      const editHeight = e?.height ?? s.height;
      const invalid = validateSize(editWidth) ?? validateSize(editHeight);
      return {
        uuid: s.uuid,
        name: s.name,
        width: s.width,
        height: s.height,
        editWidth,
        editHeight,
        dirty: e !== undefined,
        ...(invalid === undefined ? {} : { invalid }),
      };
    });

    return {
      phase: this.#phase,
      ...(reason === undefined ? {} : { reason }),
      rows,
      dirty: this.#edits.size,
    };
  }
}
