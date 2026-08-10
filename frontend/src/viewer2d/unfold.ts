/**
 * 2D 펼침 — **3D 드레이프 ↔ 평면 재단 도면을 잇는 좌표 변환과 보간.**
 *
 * 이 파일은 DOM 을 만지지 않는다. `document`·`window`·`WebGLRenderer` 가 한 번도
 * 나오지 않으므로 Node 에서 그대로 import 되고, 그래서 **자동 테스트가 붙는
 * 유일한 자리**다. 그리는 일은 `viewer3d/viewer.ts` 가, 배선은 `main.ts` 가 한다.
 * (three 의 자료구조는 쓴다 — `Matrix4` 나 `BufferAttribute` 는 GL 컨텍스트가
 *  없어도 돌아간다. `cloth.ts` 가 이미 같은 전제 위에 서 있다.)
 *
 * ── 왜 `uvs` 만으로는 안 되는가 (ISSUE-018) ──────────────────
 * `uvs` 는 cm 단위 2D 패턴 좌표지만 **서피스 로컬**이라 패턴마다 자기 원점
 * 근처에서 시작한다. 그대로 그리면 24개가 겹쳐 한 덩어리가 된다(실측: AABB 쌍
 * 276개 중 227개 = 82.2%). 도면 위의 자리는 `transform2d` 를 곱해야 나온다
 * (적용 후 2.5%). 그래서 이 모듈은 **둘을 항상 짝으로** 다룬다.
 *
 * ── 2D 평면을 어느 축에 놓았는가: 월드 **XY 평면(z = 0)** ────
 * 도면의 (x, y) 를 3D 월드의 (x, y) 에 그대로 놓고 z 를 0 으로 둔다. 3D 가
 * Y-up 이므로(`gravityY` = -980) 도면의 세로 161cm 가 화면 세로가 된다.
 *
 * ★ **y 가 뒤집히지 않는다는 것을 실측으로 확인했다.** 상하 반전은 실루엣이
 *   대칭이라 화면으로 못 잡는 종류의 실패라 숫자로 갈랐다: 엔진의
 *   `GenerateUVs` 가 `CopyPositionToUV`(uv.x = p.x, uv.y = p.y)라서 로드 직후
 *   uv 와 로컬 정점이 같아야 하는데, `W_Bra top & Leggings.zls` 24개 패턴에서
 *   `max|uv.y − pos.y| = 0.0000`(비트 단위 일치)이고 `max|uv.y + pos.y|` 는
 *   최대 98.8cm 였다. 24/24 전부 같은 방향이다.
 *
 * ── 왜 정점을 **메시 로컬**로 되돌려 넣는가 ──────────────────
 * `cloth.ts` 는 패턴 로컬 → 3D 월드 변환을 `Mesh` 에 걸어 둔다(ISSUE-011).
 * 정점 버퍼에 도면 좌표를 그대로 쓰면 GPU 가 거기에 3D 변환을 **또** 곱해서,
 * 도면이 옷이 서 있던 자리만큼 통째로 밀리고 회전한다. 그래서 목표 정점을
 * `M3d⁻¹ · (도면 좌표)` 로 만들어 둔다 — 그러면 `Mesh` 의 변환은 손대지 않은
 * 채로 화면에 도면이 제자리에 선다.
 *
 * **왜 반대로(메시 변환을 항등으로 보간) 하지 않는가**: 그러면 "메시 변환은
 * 패턴 로컬 → 3D 월드다" 라는 불변식이 시간에 따라 변하는 값이 된다. 그
 * 불변식이 흔들리면 `boundingBox()`·레이캐스팅·스냅샷 대조가 전부 "지금 t 가
 * 얼마냐" 에 의존하게 된다. 정점만 움직이는 편이 건드리는 것이 적다.
 */

import * as THREE from 'three';

import type { PatternTransform2D } from '../protocol/types.ts';
import type { PatternMesh } from '../viewer3d/cloth.ts';

/**
 * 행 우선 3×3 · **열벡터** 규약: `world = M · [x, y, 1]ᵀ`.
 *
 * ⚠️ 전치해 읽어도 패턴은 그럴듯하게 흩어진다 — 규약을 눈으로 검증할 수 없다.
 *    그래서 `protocol/smoke.ts` §8-12 ⑤ 가 회전이 있는 행렬로 이 식을 못박아
 *    두었다(90° 회전에서 로컬 (3,0) → 도면 (100, 203)). **여기 식은 그 절과
 *    같은 식이어야 한다.** 고칠 일이 생기면 그쪽을 먼저 볼 것.
 *
 * 마지막 행은 항상 `[0,0,1]` 이라 계산에 쓰지 않는다.
 */
export function apply2d(
  m: PatternTransform2D | readonly number[],
  x: number,
  y: number,
): [number, number] {
  return [
    (m[0] ?? 1) * x + (m[1] ?? 0) * y + (m[2] ?? 0),
    (m[3] ?? 0) * x + (m[4] ?? 1) * y + (m[5] ?? 0),
  ];
}

/** 도면 전체가 차지하는 범위. cm. 카메라를 맞출 때 쓴다 */
export interface DraftingBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * 펼침이 무엇을 할 수 있는 상태인가. **화면에 글자로 나가는 값이다.**
 *
 * `unplaced` 가 0 이 아니면 화면이 그 사실을 말해야 한다 — 아래
 * `Unfolder` 머리말의 "배치를 모르는 패턴" 항목 참고.
 */
export interface UnfoldStats {
  /** 대상 패턴 수 */
  patterns: number;
  /** `uvs` 와 `transform2d` 가 모두 있어 도면에 놓인 패턴 수 */
  placed: number;
  /** 배치를 모르는 패턴 수 (`transform2d` 가 null 이거나 `uvs` 가 없다) */
  unplaced: number;
  /** 놓인 패턴들의 정점 합 */
  vertices: number;
  /** 놓인 것이 하나도 없으면 null */
  bounds: DraftingBounds | null;
}

const EMPTY_STATS: UnfoldStats = {
  patterns: 0,
  placed: 0,
  unplaced: 0,
  vertices: 0,
  bounds: null,
};

/** 패턴 하나에 대해 미리 계산해 둔 것 */
interface Target {
  /** 메시 로컬 좌표계의 목표 정점. 정점당 3개 (z 는 평면이라 상수는 아니다) */
  readonly local: Float32Array;
  /** 3D 원본. 프레임이 올 때마다 갱신된다 */
  base: Float32Array;
}

/**
 * 3D ↔ 2D 모핑을 계산하고 정점 버퍼에 써 넣는다.
 *
 * ── 세 단계로 나뉜다 ────────────────────────────────────────
 *   `build(patterns)`  토폴로지가 섰을 때 **한 번**. 도면 좌표를 계산하고
 *                      메시 로컬로 되돌려 둔다. 비싼 일은 전부 여기 있다.
 *   `sync(patterns)`   3D 정점이 새로 쓰였을 때. 원본을 복사해 둔다.
 *   `apply(patterns,t)` 매 프레임. 두 값을 섞어 버퍼에 쓴다.
 *
 * `build` 와 `sync` 를 가른 이유는 **프레임마다 바뀌는 것이 `positions` 뿐**
 * 이기 때문이다(`uvs`·`transform2d` 는 topology 와 함께 한 번만 온다). 도면
 * 좌표를 매 프레임 다시 만들면 정점 3,022~13,398개에 행렬 곱이 붙는다.
 *
 * ── 재생 중에 모핑하면 무엇이 보이는가 ──────────────────────
 * **3D 쪽은 계속 살아 있다.** `sync` 가 프레임마다 원본을 갱신하므로 t=0.5 에서
 * 화면은 "움직이는 3D 와 정지한 도면의 중간" 이고, t 가 1 로 갈수록 움직임의
 * 진폭이 자연스럽게 0 으로 줄어든다.
 *
 * **왜 t>0 에서 3D 를 얼리지 않는가** — 얼리면 눈에 안 보이는 문턱(t가 0을
 * 벗어나는 순간)에서 옷이 갑자기 멈춘다. 사용자가 한 것은 슬라이더를 조금
 * 민 것뿐인데 재생이 멈춘 것처럼 보이고, 그 인과가 화면 어디에도 안 남는다.
 * 진폭이 t 에 따라 연속적으로 줄어드는 편이 **보이는 것과 일어나는 일이
 * 일치한다.**
 *
 * ── 배치를 모르는 패턴은 모핑에서 **빼 둔다** ────────────────
 * `transform2d` 가 null 이면(서피스가 없는 패턴 / 구버전 워커) 그 패턴은
 * 목표가 없다. 항등행렬로 메우면 도면 원점에 놓이는데, 그러면 **"원점에 배치된
 * 패턴" 과 구분되지 않는다** — 다른 패턴과 겹쳐도 사용자는 이유를 알 수 없다.
 * 숨기는 것도 답이 아니다(패턴이 존재한다는 사실까지 지운다). 그래서 **3D
 * 자리에 그대로 둔다**: t=1 에서 평평한 도면 옆에 그 패턴만 3D 로 떠 있어
 * 눈에 띄고, 몇 개인지는 `stats.unplaced` 가 화면에 글자로 남긴다.
 */
export class Unfolder {
  readonly #targets = new Map<string, Target>();
  #stats: UnfoldStats = EMPTY_STATS;
  /** 마지막으로 버퍼에 쓴 t. 같은 값을 다시 쓰지 않으려고 기억한다 */
  #written: number | null = null;

  get stats(): UnfoldStats {
    return this.#stats;
  }

  /** 도면에 놓인 패턴이 하나라도 있는가. 없으면 모핑은 아무 일도 못 한다 */
  get ready(): boolean {
    return this.#stats.placed > 0;
  }

  /**
   * 도면 좌표를 계산한다 — **토폴로지가 섰을 때 한 번.**
   *
   * `uvs` 나 `transform2d` 가 없는 패턴은 조용히 건너뛴다(오류가 아니다).
   * 몇 개가 그랬는지는 `stats.unplaced` 에 남는다.
   */
  build(patterns: readonly PatternMesh[]): void {
    this.#targets.clear();
    this.#written = null;

    let placed = 0;
    let vertices = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // 재사용한다 — 패턴마다 새로 만들면 24개짜리 씬에서 의미 없는 할당이 는다.
    const inverse = new THREE.Matrix4();
    const point = new THREE.Vector3();

    for (const p of patterns) {
      if (!p.uvs || !p.transform2d) continue;
      // 길이가 어긋나면 그리지 않는다. 조용히 잘라 쓰면 정점 몇 개가 원점에
      // 붙은 도면이 나오는데, 화면만 봐서는 배치 문제인지 디코딩 문제인지
      // 구분할 수 없다.
      if (p.uvs.length !== p.vertices * 2) continue;
      if (p.position.count !== p.vertices) continue;

      // ★ 메시에 걸린 3D 변환을 되돌린다 (머리말 참고). 렌더 루프가 아직 안
      //   돌았을 수도 있으므로 행렬을 직접 갱신하고 나서 뒤집는다.
      p.mesh.updateMatrix();
      // 특이행렬이면 three 가 경고와 함께 항등을 돌려준다. 그때는 3D 변환이
      // 없는 것과 같게 동작하는데, scale 이 0 인 패턴은 애초에 화면에 없다.
      inverse.copy(p.mesh.matrix).invert();

      const local = new Float32Array(p.vertices * 3);
      for (let i = 0; i < p.vertices; i++) {
        const [wx, wy] = apply2d(p.transform2d, p.uvs[i * 2] ?? 0, p.uvs[i * 2 + 1] ?? 0);
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;

        // 도면은 월드 XY 평면 위에 있다 — z = 0.
        point.set(wx, wy, 0).applyMatrix4(inverse);
        local[i * 3] = point.x;
        local[i * 3 + 1] = point.y;
        local[i * 3 + 2] = point.z;
      }

      this.#targets.set(p.uuid, {
        local,
        base: new Float32Array(p.position.array as Float32Array),
      });
      placed += 1;
      vertices += p.vertices;
    }

    this.#stats = {
      patterns: patterns.length,
      placed,
      unplaced: patterns.length - placed,
      vertices,
      bounds: placed > 0
        ? {
            minX, minY, maxX, maxY,
            width: maxX - minX,
            height: maxY - minY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2,
          }
        : null,
    };
  }

  /**
   * 3D 원본을 다시 읽어 둔다 — **정점 버퍼에 3D 가 들어 있을 때만 부를 것.**
   *
   * ⚠️ `apply(t>0)` 이 쓴 뒤에 이걸 부르면 **섞인 값을 원본으로 착각한다.**
   *    그 다음 `apply` 가 그 위에 또 섞으므로 옷이 프레임마다 도면 쪽으로
   *    조금씩 끌려가다 완전히 눌어붙는다 — 화면에서는 "재생하면 옷이 서서히
   *    납작해진다" 로 보이고 원인이 어디에도 안 남는다. 부르는 쪽(`main.ts`)이
   *    프레임이 실제로 붙은 직후에만 부르는 이유가 이것이다.
   */
  sync(patterns: readonly PatternMesh[]): void {
    for (const p of patterns) {
      const t = this.#targets.get(p.uuid);
      if (!t) continue;
      const src = p.position.array as Float32Array;
      if (src.length !== t.base.length) continue;
      t.base.set(src);
    }
    // 원본이 바뀌었으니 같은 t 라도 다시 써야 한다.
    this.#written = null;
  }

  /**
   * 두 값을 섞어 정점 버퍼에 쓴다. `t=0` 이 3D, `t=1` 이 도면.
   *
   * `t === 0` 이면 **아무것도 하지 않는다.** 버퍼에는 이미 3D 가 들어 있고,
   * 되돌려 쓰면 프레임마다 법선과 경계구를 헛계산하게 된다. 이 조기 반환이
   * "2D 를 안 쓰는 동안에는 이 단위가 존재하지 않는 것과 같다" 를 보장한다 —
   * 기존 화면·기존 단언이 흔들릴 여지를 여기서 없앤다.
   *
   * @returns 실제로 버퍼를 건드렸으면 true
   */
  apply(patterns: readonly PatternMesh[], t: number): boolean {
    const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (clamped === 0 && this.#written === null) return false;
    if (clamped === this.#written) return false;

    let touched = false;
    for (const p of patterns) {
      const target = this.#targets.get(p.uuid);
      if (!target) continue;

      const dst = p.position.array as Float32Array;
      const { base, local } = target;
      if (dst.length !== base.length || dst.length !== local.length) continue;

      if (clamped === 0) {
        dst.set(base);
      } else if (clamped === 1) {
        dst.set(local);
      } else {
        const u = 1 - clamped;
        for (let i = 0; i < dst.length; i++) {
          dst[i] = (base[i] ?? 0) * u + (local[i] ?? 0) * clamped;
        }
      }

      p.position.needsUpdate = true;
      // 법선을 다시 만들지 않으면 음영이 3D 자세에 멎어 있다 — 평평해졌는데
      // 빛은 여전히 주름을 그린다. `cloth.updatePositions()` 와 같은 이유다.
      p.geometry.computeVertexNormals();
      // 프러스텀 컬링과 (나중의) 레이캐스팅이 경계구를 쓴다.
      p.geometry.computeBoundingSphere();
      touched = true;
    }

    // 0 으로 완전히 되돌아왔으면 "쓴 적 없음" 으로 되돌린다. 다음 `apply(0)`
    // 이 헛일을 하지 않는다.
    this.#written = clamped === 0 ? null : clamped;
    return touched;
  }

  /** 씬을 갈아 끼울 때. 남겨 두면 옛 씬의 도면 좌표가 새 씬에 섞인다 */
  clear(): void {
    this.#targets.clear();
    this.#stats = EMPTY_STATS;
    this.#written = null;
  }
}
