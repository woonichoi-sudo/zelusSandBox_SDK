/**
 * 실시간 3D 뷰의 **텍스처 판단** (materials-c) — DOM 도 three 도 만지지 않는다.
 *
 * 그리는 것은 `viewer3d/textures.ts`, 스위치는 `ui/textureSwitch.ts`, 배선은
 * `main.ts` 다. 여기 있는 것은 세 가지 판단뿐이고, 셋 다 **틀리면 화면에서
 * 원인을 못 읽는** 종류다:
 *
 *   ① 어느 파일이 어느 슬롯인가   — 표 색인 → URL
 *   ② 무늬를 몇 번 반복하는가     — 물리 크기 → `texture.repeat`
 *   ③ 켜져 있는가                 — 사용자 스위치
 *
 * ── ★ ② 가 이 파일의 존재 이유다 ────────────────────────────
 *
 * 옷의 `uvs` 는 **0~1 이 아니라 cm 단위 패턴 좌표**다(`cloth.ts` 머리말: 앞판이
 * 20.5 × 96.4). 텍스처를 그대로 입히면 UV 가 20.5 까지 가므로 무늬가 20번
 * 반복되고, 그건 직물의 실제 무늬 크기와 아무 관계가 없다.
 *
 * 직물 한 장이 덮는 실제 크기가 `physicalSizeCm` 이다. UV 가 cm 이므로
 * **반복 배수 = 1 / 크기** 가 그대로 성립한다:
 *
 *   노랑 `CS-00120`  2.114 × 2.115cm → repeat 0.473 × 0.473
 *   민트 `TOP_Mesh`  29.997 × 29.997cm → repeat 0.0333 × 0.0333
 *
 * 두 직물의 무늬 스케일이 **14배** 차이 난다. 한쪽 값으로 통일하거나 repeat 를
 * 1 로 두면 한 벌 안에서 한쪽 옷의 무늬만 통째로 틀린 크기가 되는데, 화면에서는
 * "천이 좀 이상하다"로만 보여서 원인을 지목할 수 없다.
 *
 * ── ⚠️ 아바타는 정반대다 ────────────────────────────────────
 * 아바타의 `uvs` 는 **이미 0~1 정규화된 텍스처 좌표**다. 그래서 반복은 언제나
 * 1 이어야 한다.
 *
 * 실측상 아바타 재질의 `physicalSizeCm` 은 `[1, 1]` 이라 위 식(1/1 = 1)에
 * 넣어도 우연히 맞는다. **그 우연에 기대지 않는다** — 언젠가 엔진이 아바타
 * 재질에 진짜 물리 크기를 채우는 날, 몸에 피부 텍스처가 수십 번 반복되고
 * 그 원인이 이 파일에 없는 것처럼 보이게 된다. UV 의 성격이 다르면 식도
 * 달라야 한다.
 */

import type { MaterialTextures, TextureAsset } from '../protocol/index.ts';

/** UV 좌표계의 성격. ②의 식을 가르는 유일한 축이다 */
export type TextureUvKind =
  /** UV 가 cm 단위 패턴 좌표 — 반복 = 1 / 물리 크기 */
  | 'cloth'
  /** UV 가 0~1 정규화 텍스처 좌표 — 반복은 언제나 1 */
  | 'avatar';

/** 슬롯 → 다운로드 URL. 없는 슬롯은 키가 없다 */
export interface TextureSlotUrls {
  basecolor?: string;
  normal?: string;
  alpha?: string;
}

/** 메시 하나에 걸 텍스처 한 벌 */
export interface TexturePlan {
  slots: TextureSlotUrls;
  /** `[u, v]` 반복 배수 */
  repeat: [number, number];
  /**
   * `texture.flipY` 에 그대로 넣을 값.
   *
   * 엔진의 `flipTextures` 를 따른다. 실측상 두 씬 모두 `false` 이고, 그것이
   * glTF 규약(three 의 `GLTFLoader` 도 `flipY = false` 를 쓴다)과 같은 쪽이다 —
   * 스냅샷 뷰와 실시간 뷰가 같은 그림이 되려면 여기가 같아야 한다.
   */
  flipY: boolean;
}

/** 무엇이 실렸는지. 화면 글자와 로그가 이 값을 쓴다 */
export interface TextureStats {
  /** 표에 실린 칸 수 (거절된 `null` 포함) */
  entries: number;
  /** 실제로 받을 수 있는 파일 수 */
  files: number;
  /** 게이트웨이가 거절한 칸 수. **0 이 정상이다** */
  rejected: number;
  bytes: number;
}

/** 빈 통계. "아직 안 왔다"와 "0개가 왔다"를 같은 값으로 두지 않으려면 null 을 쓸 것 */
export const EMPTY_TEXTURE_STATS: TextureStats = {
  entries: 0, files: 0, rejected: 0, bytes: 0,
};

/** 표 하나를 요약한다. 아바타·옷 것을 더해서 화면에 한 줄로 쓴다 */
export function statsOf(table: readonly (TextureAsset | null)[]): TextureStats {
  let files = 0;
  let bytes = 0;
  for (const e of table) {
    if (!e) continue;
    files += 1;
    bytes += e.bytes;
  }
  return { entries: table.length, files, rejected: table.length - files, bytes };
}

export function addStats(a: TextureStats, b: TextureStats): TextureStats {
  return {
    entries: a.entries + b.entries,
    files: a.files + b.files,
    rejected: a.rejected + b.rejected,
    bytes: a.bytes + b.bytes,
  };
}

/**
 * 머티리얼의 색인 → URL.
 *
 * 표 밖을 가리키거나 거절된 칸은 **조용히 건너뛴다** — 디코더가 이미 같은
 * 정리를 했으므로 여기 오는 것은 정상이지만, 두 곳이 갈라져도 화면이 안 깨지게
 * 한 겹 더 둔다(엉뚱한 이미지를 입히는 것보다 없는 편이 낫다).
 */
export function resolveSlots(
  textures: MaterialTextures | undefined,
  table: readonly (TextureAsset | null)[],
): TextureSlotUrls {
  const out: TextureSlotUrls = {};
  if (!textures) return out;
  for (const slot of ['basecolor', 'normal', 'alpha'] as const) {
    const idx = textures[slot];
    if (idx === undefined) continue;
    const entry = table[idx];
    if (!entry) continue;
    out[slot] = entry.url;
  }
  return out;
}

/**
 * 반복 배수. **머리말 ②가 이 함수 하나다.**
 *
 * 크기를 모르면(0 이하라 디코더가 지웠거나 구버전 워커) `[1, 1]` 로 떨어진다.
 * 옷에서 그 값은 거의 확실히 틀리지만, 유일하게 안전한 기본값이기도 하다 —
 * 0 으로 나눠 `Infinity` 가 되면 텍스처가 한 점으로 뭉개져서 화면이 통째로
 * 이상해진다.
 */
export function repeatFor(
  physicalSizeCm: readonly [number, number] | undefined,
  kind: TextureUvKind,
): [number, number] {
  // 아바타의 UV 는 이미 0~1 이다. 물리 크기를 쓰면 안 된다 (머리말 참고).
  if (kind === 'avatar') return [1, 1];
  if (!physicalSizeCm) return [1, 1];
  const [w, h] = physicalSizeCm;
  if (!(w > 0) || !(h > 0)) return [1, 1];
  return [1 / w, 1 / h];
}

/**
 * 무늬와 **곱해질 때** 색을 어느 공간으로 읽을 것인가.
 *
 * ── ★ 실측으로 갈린 문제다. 두 값이 2.5배 어긋났다 ──────────
 *
 * 워커는 `colorProfile: 'srgb'` 를 실어 준다. 그 근거는 확실하다 — 실측한 노랑
 * `[0.9254902, 0.8117647, 0.4705882]` 은 정확히 236/255, 207/255, 120/255 라
 * 8비트 색선택기에서 나온 값이다.
 *
 * **그런데 스냅샷(glTF)은 그 값을 선형으로 쓴다.** 익스포터가
 * `baseColorFactor = basecolor.xyz` 를 그대로 쓰는데(zwGltfExporterImpl.cpp:1282),
 * glTF 규약에서 그 칸은 **선형**이고 three 의 `GLTFLoader` 도 그렇게 읽는다.
 * 브라우저에서 두 뷰의 factor 를 나란히 꺼내 확인했다:
 *
 *   스냅샷 (선형) 노랑 [0.9255, 0.8118, 0.4706]   민트 [0.7333, 0.8863, 0.8157]
 *   sRGB 로 읽으면 노랑 [0.8388, 0.6240, 0.1878]   민트 [0.4969, 0.7605, 0.6308]
 *                                        ↑ 파랑이 2.5배 어긋난다
 *
 * 화면에서도 그대로 보였다 — sRGB 로 읽으면 실시간 옷이 스냅샷보다 눈에 띄게
 * 진하고 어둡다(민트가 흰빛 대신 초록으로 뜬다).
 *
 * ⇒ **무늬가 있을 때는 선형으로 읽는다.** 스냅샷이 정답지이고, 그 값이
 *   "익스포터가 실제로 하는 일"에서 나온 것이지 우리가 고른 것이 아니다.
 *   무늬가 없을 때는 워커가 말한 `colorProfile` 을 그대로 따른다 — 그 경로에는
 *   대조할 스냅샷이 없고, 8비트 색선택기 논거가 그대로 살아 있다.
 *
 * ⚠️ **남은 미지수**: 데스크톱 앱의 3D 뷰가 어느 쪽인지는 못 봤다. 익스포터와
 *    앱 렌더러가 서로 다를 수 있고, 그렇다면 데스크톱과 glTF 가 원래 색이
 *    다르다는 뜻이 된다. 그건 이 코드가 아니라 엔진 쪽 질문이다.
 */
export function tintColorProfile(
  plan: TexturePlan | null,
  declared: 'srgb' | 'linear',
): 'srgb' | 'linear' {
  return plan?.slots.basecolor !== undefined ? 'linear' : declared;
}

/** 재질 하나에 걸 계획. 슬롯이 하나도 없으면 null (= 텍스처 없이 색만) */
export function planFor(
  material: {
    textures?: MaterialTextures;
    physicalSizeCm?: [number, number];
    flipTextures?: boolean;
  } | null | undefined,
  table: readonly (TextureAsset | null)[],
  kind: TextureUvKind,
): TexturePlan | null {
  if (!material) return null;
  const slots = resolveSlots(material.textures, table);
  if (Object.keys(slots).length === 0) return null;
  return {
    slots,
    repeat: repeatFor(material.physicalSizeCm, kind),
    // 없으면 false — 엔진 실측값이자 glTF 규약이다(TexturePlan.flipY 주석).
    flipY: material.flipTextures === true,
  };
}

// ── 스위치 ──────────────────────────────────────────────────

/** 화면에 그대로 찍을 수 있는 한 벌 */
export interface TextureOptionsState {
  enabled: boolean;
  /** 표가 한 번이라도 왔는가. 안 왔으면 스위치를 만져도 바뀔 것이 없다 */
  hasTextures: boolean;
  /** 한 줄 글자. **툴팁이 아니라 화면 글자다** */
  text: string;
  isError: boolean;
  stats: TextureStats;
}

export interface TextureOptionsHooks {
  onChange?: (state: TextureOptionsState) => void;
  log?: (line: string) => void;
}

/**
 * 텍스처를 켜고 끄는 상태의 **정본**.
 *
 * ── 왜 끄는 스위치가 필요한가 ───────────────────────────────
 * 스냅샷(익스포트한 glTF)과 나란히 놓고 대조하는 것이 이 기능의 검증 방법인데,
 * 텍스처가 켜져 있으면 "색이 맞는가"와 "무늬가 맞는가"가 한 화면에서 섞인다.
 * 껐다 켜면 그 둘을 사람이 가를 수 있다.
 *
 * ── 끄는 것이 **다시 받는 것이 아니다** ─────────────────────
 * 스위치는 이미 받아 둔 표를 화면에 걸었다 뗐다 할 뿐이고 왕복이 없다. 그래서
 * 요청은 언제나 `textures:true` 로 나간다 — 끈 상태에서 켜는 데 19.7MB 를 다시
 * 무는 것이 이 단위가 없애려던 바로 그 비용이다.
 */
export class TextureOptions {
  readonly #hooks: TextureOptionsHooks;

  #enabled = true;
  #stats: TextureStats | null = null;
  #error: string | null = null;

  constructor(hooks: TextureOptionsHooks = {}) {
    this.#hooks = hooks;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get state(): TextureOptionsState {
    const stats = this.#stats ?? EMPTY_TEXTURE_STATS;
    return {
      enabled: this.#enabled,
      hasTextures: stats.files > 0,
      text: this.#text(stats),
      isError: this.#error !== null,
      stats,
    };
  }

  #text(stats: TextureStats): string {
    if (this.#error) return this.#error;
    if (this.#stats === null) return '씬을 로드하면 무늬가 입혀집니다';
    if (stats.files === 0) return '이 씬에는 텍스처가 없습니다';
    const mb = (stats.bytes / 1048576).toFixed(1);
    const head = this.#enabled ? `무늬 ${stats.files}장` : `무늬 ${stats.files}장 (꺼짐)`;
    // 거절은 조용히 넘어가면 안 된다 — 허용 뿌리 설정이 틀렸을 때 유일한 신호다.
    const bad = stats.rejected > 0 ? ` · ⚠ 거절 ${stats.rejected}칸` : '';
    return `${head} · ${mb}MB${bad}`;
  }

  setEnabled(on: boolean): void {
    if (this.#enabled === on) return;
    this.#enabled = on;
    this.#hooks.log?.(`텍스처 ${on ? '켬' : '끔'}`);
    this.#emit();
  }

  /** 새 표가 왔다. 아바타·옷 것을 **합쳐서** 넘길 것 */
  setStats(stats: TextureStats): void {
    this.#stats = stats;
    this.#error = null;
    this.#emit();
  }

  /** 이미지를 못 받았다. 표는 왔는데 HTTP 가 실패한 경우다 */
  setError(message: string): void {
    this.#error = message;
    this.#emit();
  }

  /** 씬을 내렸다. "아직 안 왔다"로 되돌린다 — 0개가 왔다와 구분해야 한다 */
  clear(): void {
    this.#stats = null;
    this.#error = null;
    this.#emit();
  }

  #emit(): void {
    this.#hooks.onChange?.(this.state);
  }
}
