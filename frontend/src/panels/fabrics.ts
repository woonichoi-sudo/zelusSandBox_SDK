/**
 * 직물 갈아입히기의 판단 (UI #50) — **DOM 도 three 도 만지지 않는다.**
 *
 * `surfaceSize.ts` 와 같은 층위이고, 실제로 **같은 행 위에 얹힌다** — 오른쪽
 * 칸의 "옷 사이즈" 탭에 이미 재단 조각 24개가 이름·크기와 함께 서 있고,
 * 직물 콤보는 그 행에 하나씩 붙는다. 조각을 고르는 UI 를 새로 만들지 않는
 * 이유가 그것이다: 조각을 식별할 수 있는 자리가 이미 거기뿐이다(이름이
 * 유일하지 않아 크기가 구분 수단이다 — `surfaceSize.ts` ③).
 *
 * ── 이 모듈이 아는 것 ───────────────────────────────────────
 *
 *   · 고를 수 있는 직물이 무엇인가          (`setFromWorker`)
 *   · 각 조각이 지금 무엇을 입고 있는가     (`SurfaceInfo.fabricUuid`)
 *   · 그래서 각 행의 콤보가 무엇을 보여야 하는가
 *
 * 무엇을 **입힐지 고르는 것은 상태가 아니다** — 콤보를 바꾸는 순간 바로
 * 보낸다. 그래서 `surfaceSize` 와 달리 "아직 안 보낸 편집"(dirty)이 없다.
 * 크기는 두 축을 맞춰 놓고 한 번에 보내는 것이 자연스럽지만, 직물은 고르는
 * 행위 자체가 곧 결정이라 [적용] 버튼을 하나 더 두면 손만 늘어난다.
 *
 * ── ⚠️ 이 설치본에는 프리셋이 없다 ──────────────────────────
 *
 * **[실측 2026-08-12]** 씬을 열기 전 0개, 연 뒤 **씬 내장 2개뿐**이다.
 * 디스크에도 프리셋 폴더가 없다. 즉 지금 할 수 있는 일은 **그 옷이 이미 쓰는
 * 직물끼리 재배정**이고, "라이브러리에서 새 원단 고르기" 가 아니다.
 *
 * **화면이 이 사실을 글자로 말해야 한다.** 콤보에 두 개만 뜨는 것을 보고
 * 사용자가 "목록이 안 불러와졌나" 로 읽으면 안 된다 — 이 프로젝트의 규칙대로
 * 못 쓰는 이유는 툴팁이 아니라 화면 글자다(#16 에서 확립).
 */

import { t } from './i18n.ts';
import type { FabricInfo, SurfaceInfo } from '../protocol/index.ts';

/** 콤보 한 칸 */
export interface FabricOption {
  id: string;
  /** 화면에 보일 글자. 엔진이 준 이름 그대로다 — **번역하지 않는다** */
  label: string;
  /**
   * 이 직물을 고르면 무늬가 빠지는가. 경로는 있는데 파일이 없는 경우다.
   * ⚠️ 고른 **뒤에** 알면 늦다 — 게이트웨이가 텍스처를 거절해 화면에
   *   `⚠ 거절` 만 뜨고, 그 원인이 직물 선택이라는 것이 어디에도 안 보인다.
   */
  missingTexture: boolean;
}

/** 행 하나가 화면에 보여야 하는 것 */
export interface FabricRow {
  surfaceUuid: string;
  /** 지금 입고 있는 직물의 id. 목록에 없으면(씬이 준 값을 우리가 모를 때) 빈 문자열 */
  current: string;
  /** 이 행이 왕복 중인가. 그동안 콤보를 잠근다 */
  busy: boolean;
}

export type FabricPhase = 'noScene' | 'empty' | 'ready';

export interface FabricsView {
  phase: FabricPhase;
  /** 왜 못 쓰는지. `phase !== 'ready'` 일 때만 있다 */
  reason?: string;
  options: FabricOption[];
  rows: Map<string, FabricRow>;
  /**
   * 목록이 씬 내장뿐이라 선택지가 좁다는 안내. `null` 이면 안 띄운다.
   * **프리셋이 하나라도 있으면 사라진다** — 원단이 깔린 환경에서까지
   * "선택지가 좁다" 고 말하면 그게 거짓말이다.
   */
  notice: string | null;
}

/**
 * 직물 선택의 상태. **왕복은 하지 않는다** — 부르는 쪽(`main.ts`)이 하고
 * 결과를 `applied` / `failed` 로 알려 준다. `surfaceSize` 와 같은 규약이다.
 */
export class FabricsPanel {
  #scene = false;
  #fabrics: FabricInfo[] = [];
  #surfaces: SurfaceInfo[] = [];
  /** 왕복 중인 서피스. 행 단위로 잠근다 */
  readonly #busy = new Set<string>();

  /** 워커에 씬이 있는가 */
  setScene(on: boolean): void {
    this.#scene = on;
    if (!on) {
      this.#fabrics = [];
      this.#surfaces = [];
      this.#busy.clear();
    }
  }

  /**
   * 워커가 준 직물 목록과 서피스 목록.
   *
   * 둘을 한 번에 받는 이유: 행이 무엇을 입고 있는지는 `SurfaceInfo.fabricUuid`
   * 가 답하고, 그 값이 목록의 어느 항목인지는 직물 목록이 답한다. 따로 받으면
   * 한쪽만 새것인 순간이 생기고, 그때 콤보가 **빈 채로** 선다.
   */
  setFromWorker(fabrics: readonly FabricInfo[], surfaces: readonly SurfaceInfo[]): void {
    this.#fabrics = [...fabrics];
    this.#surfaces = [...surfaces];
  }

  /** 한 행의 왕복이 시작됐다 */
  begin(surfaceUuid: string): void {
    this.#busy.add(surfaceUuid);
  }

  /**
   * 왕복이 끝났다. **성패와 무관하게 잠금을 푼다** — 실패했는데 잠긴 채로
   * 남으면 사용자가 다시 시도할 방법이 없다.
   *
   * @param fabricUuid 성공했으면 새 직물 id. 실패면 넘기지 않는다(값을 안 건드린다).
   */
  settle(surfaceUuid: string, fabricUuid?: string): void {
    this.#busy.delete(surfaceUuid);
    if (fabricUuid === undefined) return;
    // 되읽은 값으로 우리 표를 맞춘다. 요청값이 아니라 워커가 답한 값이다.
    this.#surfaces = this.#surfaces.map((s) =>
      (s.uuid === surfaceUuid ? { ...s, fabricUuid } : s));
  }

  get view(): FabricsView {
    const phase: FabricPhase = !this.#scene ? 'noScene'
      : this.#fabrics.length === 0 ? 'empty'
      : 'ready';

    const reason = phase === 'noScene' ? t('fabric.noScene')
      : phase === 'empty' ? t('fabric.empty')
      : undefined;

    const known = new Set(this.#fabrics.map((f) => f.id));
    const rows = new Map<string, FabricRow>();
    for (const s of this.#surfaces) {
      rows.set(s.uuid, {
        surfaceUuid: s.uuid,
        // ⚠️ 목록에 없는 id 는 **빈 문자열로 떨어뜨린다.** 그대로 두면 콤보가
        //    없는 항목을 가리켜 브라우저가 첫 항목을 대신 보여주는데, 그러면
        //    화면이 "이 조각은 A 를 입고 있다" 고 거짓말을 한다.
        current: s.fabricUuid !== undefined && known.has(s.fabricUuid) ? s.fabricUuid : '',
        busy: this.#busy.has(s.uuid),
      });
    }

    const presets = this.#fabrics.filter((f) => f.source === 'preset').length;

    return {
      phase,
      ...(reason === undefined ? {} : { reason }),
      options: this.#fabrics.map((f) => ({
        id: f.id,
        label: f.name,
        missingTexture: f.hasTexture && !f.textureExists,
      })),
      rows,
      // 프리셋이 하나라도 있으면 안내를 걷는다 (머리말 참고).
      notice: phase === 'ready' && presets === 0 ? t('fabric.inFileOnly', { n: this.#fabrics.length }) : null,
    };
  }
}
