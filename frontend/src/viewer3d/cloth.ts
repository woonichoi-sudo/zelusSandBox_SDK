/**
 * 패턴 메시 관리 — **토폴로지는 한 번, 위치는 매 프레임.**
 *
 * 이 파일의 존재 이유는 그 분리 하나다. `.zls` 한 벌은 패턴 5개(= 메시 5개)로
 * 오고, 프레임마다 바뀌는 것은 `positions` 뿐이다. `indices`·`uvs` 는 프레임 간
 * 고정이라 frame 이벤트에 **아예 실려 오지 않는다** — `meshData(true)` 로 한 번
 * 받는 것이 유일한 경로다.
 *
 * ── 왜 패턴을 합치지 않고 메시 5개로 두는가 ──────────────────
 * 워커는 패턴별 배열을 준다. 합쳐서 하나의 지오메트리로 만들면 (a) 최초 1회
 * 인덱스에 정점 오프셋을 더해야 하고 (b) **매 프레임** 5개 배열을 하나로
 * 이어붙이는 복사가 생긴다. 나눠 두면 프레임 갱신이
 * `positionAttr.array.set(p.positions)` 한 줄로 끝난다 — 오프셋 계산도, 중간
 * 버퍼도 없다. 드로우콜 5개는 이 규모(정점 3,022)에서 아무 의미가 없다.
 * (#13 이 얹는 자리가 정확히 `updatePositions()` 다.)
 *
 * ── 세 가지 함정 ────────────────────────────────────────────
 * ① **인덱스는 Int32Array 로 온다.** WebGL 의 `drawElements` 는 INT 를 받지
 *    않는다(UNSIGNED_BYTE/SHORT/INT 뿐). three 는 배열 타입을 보고 GL 타입을
 *    정하므로 Int32Array 를 그대로 넘기면 GL 오류가 나거나 아무것도 안 그려진다.
 *    값이 전부 음이 아니므로 **비트 패턴은 같다** — 재해석해서 복사한다.
 * ② **법선이 프로토콜에 없다.** `positions`·`indices`·`uvs` 뿐이다. 법선 없이
 *    조명을 켜면 새까맣게 나오므로 `computeVertexNormals()` 로 만든다.
 *    정점 3,022 / 삼각형 5,472 규모라 40/s 로 다시 계산해도 부담이 없다.
 * ③ **경계구를 다시 계산해야 한다.** 프러스텀 컬링이 boundingSphere 를 쓰는데,
 *    위치만 바꾸고 두면 옷이 화면 밖으로 나갔다고 판단해 **통째로 사라진다.**
 *
 * ⚠️ `uvs` 는 텍스처 좌표가 아니라 **cm 단위 2D 패턴 좌표**다(앞판 20.5 × 96.4).
 *    0~1 로 정규화돼 있지 않다. #15 의 2D 펼침 뷰가 이 값을 위치로 쓴다.
 */

import * as THREE from 'three';

import type { DecodedPattern } from '../protocol/index.ts';

/** 패턴 하나에 대응하는 three 객체 묶음 */
export interface PatternMesh {
  readonly uuid: string;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** 매 프레임 덮어쓰는 대상 (#13) */
  readonly position: THREE.BufferAttribute;
  readonly vertices: number;
  readonly triangles: number;
  /** cm 단위 2D 패턴 좌표. #15 가 쓴다. 없으면 null */
  readonly uvs: Float32Array | null;
}

/**
 * 패턴 5개를 구분되게 칠한다.
 *
 * 단색으로 두면 패턴 경계가 안 보여서, 화면만 보고는 "제대로 그려진 것"과
 * "패턴 하나가 통째로 뒤집힌 것"을 구분할 수 없다. 사람이 눈으로 판정하는
 * 단위(#12 는 `verify: manual`)라 색이 곧 검증 도구다.
 */
const PALETTE = [0x7ea8d8, 0xd8a87e, 0x8fc9a0, 0xc98f9e, 0xb0a8d8] as const;

function colorFor(index: number): number {
  return PALETTE[index % PALETTE.length] ?? 0xcccccc;
}

/**
 * Int32Array 인덱스 → three 가 받아 주는 Uint32Array.
 *
 * 같은 바이트를 다른 타입으로 **재해석**한 뒤 복사한다. 재해석만 하고 넘기면
 * 디코더가 준 버퍼를 우리가 계속 붙잡게 되는데, 그 버퍼는 프레임마다 새로
 * 만들어지는 것과 같은 출처라 수명을 섞지 않는 편이 낫다.
 */
function toIndexArray(indices: Int32Array): Uint32Array {
  return new Uint32Array(
    new Uint32Array(indices.buffer, indices.byteOffset, indices.length),
  );
}

/** 옷 한 벌. `group` 을 씬에 붙이면 된다 */
export class ClothObject {
  readonly group = new THREE.Group();

  /** 삽입 순서를 유지한다 — 색 배정이 로드할 때마다 달라지면 안 된다 */
  readonly #byUuid = new Map<string, PatternMesh>();

  #vertices = 0;
  #triangles = 0;

  constructor() {
    this.group.name = 'cloth';
  }

  get patternCount(): number {
    return this.#byUuid.size;
  }

  get vertexCount(): number {
    return this.#vertices;
  }

  get triangleCount(): number {
    return this.#triangles;
  }

  get patterns(): readonly PatternMesh[] {
    return [...this.#byUuid.values()];
  }

  /**
   * 토폴로지를 세운다 — **로드 직후 한 번.**
   *
   * 기존 지오메트리를 전부 버리고 새로 만든다. 프레임 갱신에 이 함수를 쓰면
   * 매 프레임 GPU 버퍼를 새로 할당하게 된다. 그 경로는 `updatePositions()` 다.
   */
  setTopology(patterns: readonly DecodedPattern[]): void {
    this.clear();

    patterns.forEach((p, i) => {
      const geometry = new THREE.BufferGeometry();

      // 복사해서 우리가 소유한다. 디코더가 준 배열은 호출자가 언제 버릴지 모른다.
      const position = new THREE.BufferAttribute(new Float32Array(p.positions), 3);
      // 매 프레임 갱신될 것이라고 드라이버에 알린다 (#13).
      position.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', position);

      if (p.uvs) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.uvs), 2));
      }
      if (p.indices) {
        geometry.setIndex(new THREE.BufferAttribute(toIndexArray(p.indices), 1));
      }

      // 법선은 프로토콜에 없다 — 여기서 만든다.
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();

      const material = new THREE.MeshStandardMaterial({
        color: colorFor(i),
        // 옷은 두께 없는 껍질이다. 단면으로 두면 안쪽을 볼 때 통째로 사라진다.
        side: THREE.DoubleSide,
        roughness: 0.78,
        metalness: 0.0,
        flatShading: false,
        // ★ Z-파이팅 방지. 패턴들은 봉제선과 겹침 구간에서 **실제로 같은 자리에
        //   있다** — 두께가 0인 껍질 여러 장이 맞닿아 있으니 깊이값이 같고,
        //   그러면 화면에 얼룩덜룩한 반점이 생겨 형체가 깨진 것처럼 보인다.
        //   패턴마다 다른 오프셋을 주면 "누가 위인가" 가 결정적으로 정해진다.
        //   기하를 바꾸는 게 아니라 깊이 비교만 어긋내는 것이라 공짜다.
        polygonOffset: true,
        polygonOffsetFactor: -1 - i,
        polygonOffsetUnits: -1 - i,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `pattern:${p.uuid}`;
      // 패턴 하나가 프러스텀에서 잘려 나가는 사고를 막는다. 5개짜리 씬에서
      // 컬링으로 얻을 것이 없다.
      mesh.frustumCulled = false;
      this.group.add(mesh);

      this.#byUuid.set(p.uuid, {
        uuid: p.uuid,
        mesh,
        geometry,
        position,
        vertices: p.vertices,
        triangles: p.triangles,
        uvs: p.uvs ? new Float32Array(p.uvs) : null,
      });

      this.#vertices += p.vertices;
      this.#triangles += p.triangles;
    });
  }

  /**
   * 위치만 덮어쓴다 — **프레임 갱신 경로 (#13).**
   *
   * 지오메트리를 새로 만들지 않는다. 토폴로지가 달라졌으면(패턴 수·정점 수)
   * 조용히 어긋난 메시를 그리는 대신 `false` 를 돌려준다. 부르는 쪽은 그때
   * `setTopology()` 를 다시 해야 한다 — 재연결로 워커가 바뀌었거나 다른 씬을
   * 연 경우다.
   */
  updatePositions(patterns: readonly DecodedPattern[]): boolean {
    if (patterns.length !== this.#byUuid.size) return false;

    // 먼저 전부 확인하고 나서 쓴다. 절반만 갱신된 옷은 눈으로 원인을 못 찾는다.
    const targets: { target: PatternMesh; src: Float32Array }[] = [];
    for (const p of patterns) {
      const target = this.#byUuid.get(p.uuid);
      if (!target) return false;
      if (p.positions.length !== target.position.array.length) return false;
      targets.push({ target, src: p.positions });
    }

    for (const { target, src } of targets) {
      (target.position.array as Float32Array).set(src);
      target.position.needsUpdate = true;
      // 법선이 없으면 음영이 지난 프레임에 고정된다 — 움직이는데 빛이 안 따라간다.
      target.geometry.computeVertexNormals();
      // ★ 이걸 빼면 옷이 움직이다가 화면에서 사라진다 (프러스텀 컬링).
      //   지금은 frustumCulled=false 라 당장은 안 보이지만, 레이캐스팅(#16 의
      //   그래빙)이 같은 값을 쓴다.
      target.geometry.computeBoundingSphere();
    }
    return true;
  }

  /** 씬 경계. 카메라를 맞출 때 쓴다 */
  boundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const p of this.#byUuid.values()) {
      p.geometry.computeBoundingBox();
      if (p.geometry.boundingBox) box.union(p.geometry.boundingBox);
    }
    return box;
  }

  /** GPU 자원까지 해제한다. 씬을 갈아 끼울 때 반드시 부른다 */
  clear(): void {
    for (const p of this.#byUuid.values()) {
      this.group.remove(p.mesh);
      p.geometry.dispose();
      const mat = p.mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    this.#byUuid.clear();
    this.#vertices = 0;
    this.#triangles = 0;
  }
}
