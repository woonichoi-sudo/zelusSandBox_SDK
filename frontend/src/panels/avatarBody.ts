/**
 * 아바타 체형 패널의 판단 (L-3a) — **DOM 도 three 도 만지지 않는다.**
 *
 * `params.ts` 와 같은 규약이다. 그리는 것은 `ui/avatarPanel.ts`, 배선은
 * `main.ts` 가 한다. 여기 있는 것은 "무엇을 보여줄지 · 무엇을 보낼지" 뿐이고
 * 그래서 Node 에서 그대로 import 된다.
 *
 * ── ★ 필드 목록의 정본은 **워커다** ─────────────────────────
 *
 * `params.ts` 와 여기가 갈리는 가장 큰 지점이다. 시뮬 파라미터 22개는 우리가
 * 표로 못박았지만, 체형 29개의 이름은 **엔진이 정한다**
 * (`ztAvatarBodyParamUtils::GetParamName`). 그래서 이 모듈은 목록을 갖고 있지
 * 않고 `avatarBody()` 응답이 준 키를 그대로 쓴다.
 *
 * 아래 `LABELS` 는 **목록이 아니라 사전이다.** 엔진 키에 한국어 이름을 붙일
 * 뿐이고, 없는 키가 와도 그 키 문자열이 그대로 화면에 나간다 — 엔진이 파라미터를
 * 하나 늘려도 화면에서 사라지지 않는다. 반대로 우리가 표를 갖고 있었다면 그
 * 파라미터는 **조용히 없는 것이 된다.**
 *
 * ── 값은 정규화 0~1 이다. cm 가 아니다 ─────────────────────
 *
 * **[실측]** 2026-08-11, 사용자 씬(`W_Bra top & Leggings.zls`)의 체형 29개가
 * **전부 0.5** 였다. cm 단위의 몸은 `measurements` 쪽에 따로 온다(키 175.739,
 * 허리 61.647). 둘을 같은 자리에 섞어 보여주면 사용자가 0.5 를 센티미터로 읽는다.
 *
 * ── ⚠️ 치수는 **이 모듈이 더 이상 들고 있지 않다** (W-2) ────
 *
 * L-3a 에서는 치수 25개를 여기서 읽기 전용으로 보여줬고, 체형을 보낸 뒤
 * **갱신할 방법이 없어서** `measurementsStale` 로 "낡았다" 고 말만 했다.
 * W-2 가 `setAvatarMeasurements` 를 열면서 되읽기의 정본(`measured`)이
 * 생겼고, 그 경로는 **왕복이 10초 넘게 걸리는 상태 기계**라 값 그릇인 이
 * 모듈과 성격이 다르다. 그래서 치수는 통째로 `panels/avatarMeasure.ts` 로
 * 옮겼다 — 낡음 플래그도 그쪽이 소유한다(그쪽만이 풀 수 있다).
 *
 * ★ **여기서 남은 책임은 하나다**: 체형을 보낸 쪽이 치수를 낡게 만들었다는
 *   사실을 알리는 것. `applied()` 가 참을 돌려주고, 배선이
 *   `AvatarMeasureController.noteBodyParamsApplied()` 로 넘긴다.
 */

import { t } from './i18n.ts';
import type { AvatarBodyResult } from '../protocol/index.ts';

/**
 * 엔진 키 → **사전 키**. **목록이 아니라 사전이다** (머리말 참고).
 *
 * 순서는 `ztAvatarBodyParam` 을 따르되 화면에서는 아래 `GROUPS` 로 묶는다.
 * 슬라이더 29개를 한 줄로 세워 두면 "키" 를 찾는 데 스크롤을 해야 한다.
 *
 * ★ **여기 오른쪽이 한국어 글자가 아니라 사전 키인 것이 I-1 이다.** 왼쪽
 *   (`fatness`·`shoulder` …)은 **엔진이 준 값**이라 번역 대상이 아니고,
 *   오른쪽은 **우리가 붙인 이름**이라 번역 대상이다. 글자 자체를 여기 두면
 *   모듈이 로드될 때 언어가 굳는다 — 실제 글자는 `#field()` 가 꺼낸다.
 *
 * ⚠️ 표에 없는 엔진 키는 `t(key)` 로 떨어지고, 모르는 키는 키 자체를 돌려주므로
 *    화면에는 엔진 키가 그대로 뜬다. 예전 동작(`LABELS[key] ?? key`)과 같다.
 */
const LABEL_KEYS: Record<string, string> = {
  fatness: 'body.fatness',
  height: 'body.height',
  shoulder: 'body.shoulder',
  shoulder_height: 'body.shoulder_height',
  neck: 'body.neck',
  mid_neck: 'body.mid_neck',
  backneck_height: 'body.backneck_height',
  head: 'body.head',
  chest: 'body.chest',
  bust_size: 'body.bust_size',
  bust_depth: 'body.bust_depth',
  bust_height: 'body.bust_height',
  under_bust: 'body.under_bust',
  bustpoint_to_bustpoint: 'body.bustpoint_to_bustpoint',
  belly: 'body.belly',
  waist_height: 'body.waist_height',
  pelvis: 'body.pelvis',
  high_hip: 'body.high_hip',
  low_hip: 'body.low_hip',
  hip_height: 'body.hip_height',
  crotch: 'body.crotch',
  arm_length: 'body.arm_length',
  upper_arm_length: 'body.upper_arm_length',
  bicep: 'body.bicep',
  wrist: 'body.wrist',
  thigh: 'body.thigh',
  knee_height: 'body.knee_height',
  calf: 'body.calf',
  ankle: 'body.ankle',
};

/**
 * 화면 묶음. **엔진이 정한 갈래를 하나 빌려 쓴다** —
 * `ztAvatarBodyParamUtils::IsShapeParam` 이 `fatness` 하나만 참이고 나머지가
 * 부위별이다. 그래서 맨 위 묶음이 "전체" 이고 그 아래가 부위다.
 *
 * 여기 없는 키는 사라지지 않고 마지막 "기타" 로 떨어진다(머리말의 같은 이유).
 */
/* `label` 은 **사전 키**다 (I-1) — 아래 `get view()` 가 `t()` 로 꺼낸다 */
const GROUPS: readonly { key: string; label: string; fields: readonly string[] }[] = [
  { key: 'overall', label: 'body.group.overall', fields: ['fatness', 'height'] },
  {
    key: 'upper',
    label: 'body.group.upper',
    fields: ['shoulder', 'shoulder_height', 'neck', 'mid_neck', 'backneck_height', 'head',
             'chest', 'bust_size', 'bust_depth', 'bust_height', 'under_bust',
             'bustpoint_to_bustpoint'],
  },
  {
    key: 'lower',
    label: 'body.group.lower',
    fields: ['belly', 'waist_height', 'pelvis', 'high_hip', 'low_hip', 'hip_height', 'crotch',
             'thigh', 'knee_height', 'calf', 'ankle'],
  },
  { key: 'arm', label: 'body.group.arm', fields: ['arm_length', 'upper_arm_length', 'bicep', 'wrist'] },
];

/** 화면에 그릴 슬라이더 한 줄 */
export interface AvatarField {
  key: string;
  label: string;
  /** 워커가 마지막으로 말한 값 */
  worker: number;
  /** 화면이 들고 있는 값. `worker` 와 다르면 아직 안 보낸 편집이다 */
  value: number;
  dirty: boolean;
}

export interface AvatarGroup {
  key: string;
  label: string;
  fields: AvatarField[];
}

export type AvatarPhase = 'noScene' | 'noAvatar' | 'ready';

export interface AvatarBodyView {
  phase: AvatarPhase;
  /** 왜 못 쓰는지. `phase !== 'ready'` 일 때만 있다. **화면 글자가 된다** */
  reason?: string;
  groups: AvatarGroup[];
  /** 아직 안 보낸 편집 수 */
  dirty: number;
}

/**
 * 체형 패널의 상태. **DOM 을 모른다.**
 *
 * `ParamsPanel` 과 달리 스키마가 없으므로 이 클래스가 훨씬 얇다 — 하는 일은
 * 셋뿐이다: 워커 값 보관 / 편집 누적 / 보낼 것만 골라내기.
 */
export class AvatarBodyPanel {
  #worker: Record<string, number> = {};
  #pending = new Map<string, number>();
  #phase: AvatarPhase = 'noScene';

  /** 워커가 말한 사실로 덮어쓴다. 편집 중이던 값은 **버린다** */
  setFromWorker(res: AvatarBodyResult | null): void {
    this.#pending.clear();
    if (!res) {
      this.#phase = 'noScene';
      this.#worker = {};
      return;
    }
    if (!res.hasAvatar) {
      this.#phase = 'noAvatar';
      this.#worker = {};
      return;
    }
    this.#phase = 'ready';
    this.#worker = { ...(res.bodyParams ?? {}) };
  }

  /** 씬을 내렸다 */
  clear(): void {
    this.setFromWorker(null);
  }

  /**
   * 사용자가 슬라이더를 움직였다.
   *
   * 워커 값과 **같아지면 편집을 지운다** — 밀었다가 되돌린 것은 보낼 것이
   * 아니고, 안 지우면 dirty 수가 영영 안 줄어 [적용] 이 켜진 채로 남는다.
   */
  edit(key: string, value: number): void {
    if (!(key in this.#worker)) return;
    if (this.#worker[key] === value) this.#pending.delete(key);
    else this.#pending.set(key, value);
  }

  /** 화면의 편집을 버린다 */
  revert(): void {
    this.#pending.clear();
  }

  /**
   * 보낼 페이로드. **바뀐 것만 담는다.**
   *
   * 전부 보내도 워커는 받지만, 그러면 응답의 `applied` 가 항상 29개라
   * "무엇이 실제로 달라졌나" 를 화면도 로그도 말해 주지 못한다.
   */
  payload(): Record<string, number> {
    return Object.fromEntries(this.#pending);
  }

  /**
   * 보낸 뒤. 워커가 되읽어 준 값으로 덮는다.
   *
   * ★ **치수를 낡게 만든다** (머리말). 이 모듈은 치수를 안 들고 있으므로
   *   그 사실을 배선이 `AvatarMeasureController.noteBodyParamsApplied()` 로
   *   넘겨야 한다 — 여기서 참을 돌려주는 이유가 그것이고, 잊으면 화면이
   *   **바뀐 몸의 옛 치수를 "지금 치수" 로** 말한다.
   */
  applied(res: AvatarBodyResult): void {
    this.setFromWorker(res);
  }

  get view(): AvatarBodyView {
    const reason
      = this.#phase === 'noScene' ? t('body.noScene')
      : this.#phase === 'noAvatar' ? t('avatar.none')
      : undefined;

    const seen = new Set<string>();
    const groups: AvatarGroup[] = [];

    for (const g of GROUPS) {
      const fields = g.fields.filter((k) => k in this.#worker).map((k) => {
        seen.add(k);
        return this.#field(k);
      });
      if (fields.length > 0) groups.push({ key: g.key, label: t(g.label), fields });
    }

    // ★ 표에 없는 키를 버리지 않는다. 엔진이 파라미터를 늘렸을 때 화면에서
    //   조용히 사라지면, 그것이 없는 것인지 우리가 빠뜨린 것인지 알 수 없다.
    const rest = Object.keys(this.#worker).filter((k) => !seen.has(k));
    if (rest.length > 0) {
      groups.push({ key: 'other', label: t('body.group.other'), fields: rest.map((k) => this.#field(k)) });
    }

    return {
      phase: this.#phase,
      ...(reason === undefined ? {} : { reason }),
      groups,
      dirty: this.#pending.size,
    };
  }

  #field(key: string): AvatarField {
    const worker = this.#worker[key] ?? 0;
    const pending = this.#pending.get(key);
    return {
      key,
      label: t(LABEL_KEYS[key] ?? key),
      worker,
      value: pending ?? worker,
      dirty: pending !== undefined,
    };
  }
}
