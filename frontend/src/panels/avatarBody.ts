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
 * ── ⚠️ 치수(`measurements.real`)는 **갱신되지 않는다** ──────
 *
 * **[실측]** 워커가 수정본을 만들 때 그 필드를 복사해 넘기고 엔진이 되써주지
 * 않는다. 즉 체형을 만진 뒤의 치수는 **로드 시점 값**이다. 그래서 이 모듈은
 * 치수를 "지금 몸" 이 아니라 **"로드했을 때의 몸"** 으로 표시하도록
 * `measurementsStale` 을 돌려준다 — 화면이 그 사실을 글자로 말해야 한다.
 * 회색으로만 만들면 #16 이 없애려던 그 거짓말이 된다.
 */

import type { AvatarBodyResult, AvatarMeasurement } from '../protocol/index.ts';

/**
 * 엔진 키 → 한국어 이름. **목록이 아니라 사전이다** (머리말 참고).
 *
 * 순서는 `ztAvatarBodyParam` 을 따르되 화면에서는 아래 `GROUPS` 로 묶는다.
 * 슬라이더 29개를 한 줄로 세워 두면 "키" 를 찾는 데 스크롤을 해야 한다.
 */
const LABELS: Record<string, string> = {
  fatness: '살집',
  height: '키',
  shoulder: '어깨너비',
  shoulder_height: '어깨높이',
  neck: '목둘레',
  mid_neck: '목 중간',
  backneck_height: '뒷목높이',
  head: '머리',
  chest: '가슴우리',
  bust_size: '가슴크기',
  bust_depth: '가슴깊이',
  bust_height: '가슴높이',
  under_bust: '언더버스트',
  bustpoint_to_bustpoint: '유두 간격',
  belly: '배',
  waist_height: '허리높이',
  pelvis: '골반',
  high_hip: '윗엉덩이',
  low_hip: '아랫엉덩이',
  hip_height: '엉덩이높이',
  crotch: '밑위',
  arm_length: '팔길이',
  upper_arm_length: '윗팔길이',
  bicep: '이두',
  wrist: '손목',
  thigh: '허벅지',
  knee_height: '무릎높이',
  calf: '종아리',
  ankle: '발목',
};

/**
 * 화면 묶음. **엔진이 정한 갈래를 하나 빌려 쓴다** —
 * `ztAvatarBodyParamUtils::IsShapeParam` 이 `fatness` 하나만 참이고 나머지가
 * 부위별이다. 그래서 맨 위 묶음이 "전체" 이고 그 아래가 부위다.
 *
 * 여기 없는 키는 사라지지 않고 마지막 "기타" 로 떨어진다(머리말의 같은 이유).
 */
const GROUPS: readonly { key: string; label: string; fields: readonly string[] }[] = [
  { key: 'overall', label: '전체', fields: ['fatness', 'height'] },
  {
    key: 'upper',
    label: '상체',
    fields: ['shoulder', 'shoulder_height', 'neck', 'mid_neck', 'backneck_height', 'head',
             'chest', 'bust_size', 'bust_depth', 'bust_height', 'under_bust',
             'bustpoint_to_bustpoint'],
  },
  {
    key: 'lower',
    label: '하체',
    fields: ['belly', 'waist_height', 'pelvis', 'high_hip', 'low_hip', 'hip_height', 'crotch',
             'thigh', 'knee_height', 'calf', 'ankle'],
  },
  { key: 'arm', label: '팔', fields: ['arm_length', 'upper_arm_length', 'bicep', 'wrist'] },
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

/** 치수 한 줄. **cm 다** */
export interface AvatarMeasureRow {
  key: string;
  /** 엔진 이름 그대로. 여기에는 한국어 사전을 두지 않는다 — 아래 주석 참고 */
  label: string;
  real: number;
  expected?: number;
  locked: boolean;
}

export type AvatarPhase = 'noScene' | 'noAvatar' | 'ready';

export interface AvatarBodyView {
  phase: AvatarPhase;
  /** 왜 못 쓰는지. `phase !== 'ready'` 일 때만 있다. **화면 글자가 된다** */
  reason?: string;
  groups: AvatarGroup[];
  measurements: AvatarMeasureRow[];
  /** 아직 안 보낸 편집 수 */
  dirty: number;
  /**
   * 치수가 낡았는가 — **체형을 한 번이라도 보낸 뒤로 참이다.**
   *
   * 워커가 갱신해 주지 않으므로(머리말) 이 값이 참이면 화면은 치수를
   * "로드 시점 값" 이라고 말해야 한다.
   */
  measurementsStale: boolean;
}

/**
 * 체형 패널의 상태. **DOM 을 모른다.**
 *
 * `ParamsPanel` 과 달리 스키마가 없으므로 이 클래스가 훨씬 얇다 — 하는 일은
 * 셋뿐이다: 워커 값 보관 / 편집 누적 / 보낼 것만 골라내기.
 */
export class AvatarBodyPanel {
  #worker: Record<string, number> = {};
  #measures: Record<string, AvatarMeasurement> = {};
  #pending = new Map<string, number>();
  #phase: AvatarPhase = 'noScene';
  #stale = false;

  /** 워커가 말한 사실로 덮어쓴다. 편집 중이던 값은 **버린다** */
  setFromWorker(res: AvatarBodyResult | null): void {
    this.#pending.clear();
    if (!res) {
      this.#phase = 'noScene';
      this.#worker = {};
      this.#measures = {};
      return;
    }
    if (!res.hasAvatar) {
      this.#phase = 'noAvatar';
      this.#worker = {};
      this.#measures = {};
      return;
    }
    this.#phase = 'ready';
    this.#worker = { ...(res.bodyParams ?? {}) };
    this.#measures = { ...(res.measurements ?? {}) };
  }

  /** 씬을 내렸다 */
  clear(): void {
    this.setFromWorker(null);
    this.#stale = false;
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

  /** 보낸 뒤. 워커가 되읽어 준 값으로 덮는다 */
  applied(res: AvatarBodyResult): void {
    this.setFromWorker(res);
    // 체형이 바뀌었으므로 치수는 이제 낡았다(머리말).
    this.#stale = true;
  }

  get view(): AvatarBodyView {
    const reason
      = this.#phase === 'noScene' ? '씬을 로드하면 아바타 체형을 조절할 수 있습니다'
      : this.#phase === 'noAvatar' ? '이 씬에는 아바타가 없습니다'
      : undefined;

    const seen = new Set<string>();
    const groups: AvatarGroup[] = [];

    for (const g of GROUPS) {
      const fields = g.fields.filter((k) => k in this.#worker).map((k) => {
        seen.add(k);
        return this.#field(k);
      });
      if (fields.length > 0) groups.push({ key: g.key, label: g.label, fields });
    }

    // ★ 표에 없는 키를 버리지 않는다. 엔진이 파라미터를 늘렸을 때 화면에서
    //   조용히 사라지면, 그것이 없는 것인지 우리가 빠뜨린 것인지 알 수 없다.
    const rest = Object.keys(this.#worker).filter((k) => !seen.has(k));
    if (rest.length > 0) {
      groups.push({ key: 'other', label: '기타', fields: rest.map((k) => this.#field(k)) });
    }

    const measurements: AvatarMeasureRow[] = Object.entries(this.#measures).map(([k, m]) => ({
      key: k,
      // ⚠️ 치수에는 한국어 사전을 두지 않는다. 체형과 달리 **cm 단위의 실제
      //    치수**라 이름이 틀리면 사용자가 잘못된 부위를 읽는다 — 엔진 이름을
      //    그대로 두는 편이 안전하고, 필요하면 사전을 나중에 실측과 함께 붙인다.
      label: k,
      real: m.real,
      ...(m.expected === undefined ? {} : { expected: m.expected }),
      locked: m.locked,
    }));

    return {
      phase: this.#phase,
      ...(reason === undefined ? {} : { reason }),
      groups,
      measurements,
      dirty: this.#pending.size,
      measurementsStale: this.#stale,
    };
  }

  #field(key: string): AvatarField {
    const worker = this.#worker[key] ?? 0;
    const pending = this.#pending.get(key);
    return {
      key,
      label: LABELS[key] ?? key,
      worker,
      value: pending ?? worker,
      dirty: pending !== undefined,
    };
  }
}
