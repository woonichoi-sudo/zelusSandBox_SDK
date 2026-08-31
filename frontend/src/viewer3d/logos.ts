/**
 * 옷 위의 그래픽 — 로고 (LG-1).
 *
 * 프린트·자수처럼 **원단 텍스처와 다른 계층**의 그림이다. 직물을 아무리 잘
 * 입혀도 이것을 따로 그리지 않으면 화면에 안 나온다(실제로 그 상태였다).
 *
 * ── ★ 좌표가 아니라 무게중심을 받는다 ──────────────────────
 *
 * 워커가 주는 한 점은 `{ tri: [a,b,c], ratio: [x,y] }` 이고, 이는 **패턴 메시의
 * 삼각형 하나와 그 안의 비율**이다. 그래서
 *
 *     p = v0 + (v1 - v0)·x + (v2 - v0)·y
 *
 * 로 풀면 그 프레임의 로고 좌표가 나온다. 옷이 매 프레임 움직여도 **다시 받을
 * 필요가 없다** — 이 식을 다시 돌리면 로고가 따라 움직인다.
 *
 * ⓘ 이 식은 추측이 아니다. 워커가 같은 응답에 그 순간의 정답 좌표(`positions`)를
 *   같이 싣고, SDK 탐침으로 대조해 **최대 오차 0.000006cm** 를 확인했다
 *   (`W_Track Pants.zls`, 점 41개). 규약을 잘못 읽으면 로고가 엉뚱한 자리에
 *   뜨는데, 그건 화면만 보고는 원인을 못 읽으므로 숫자로 못을 박았다.
 *
 * ── 왜 패턴 메시의 자식으로 붙이는가 ────────────────────────
 *
 * 패턴 좌표는 **패턴 로컬**이고, 월드로 가는 변환은 `ClothObject` 가 각 패턴
 * `Mesh` 에 걸어 두었다(ISSUE-011). 로고를 그 메시의 **자식**으로 붙이면 같은
 * 변환을 공짜로 물려받는다 — 여기서 변환을 다시 계산하면 두 벌이 되고, 한쪽만
 * 고쳐지는 날 로고만 엉뚱한 데 뜬다.
 */

import * as THREE from 'three';

import { decodeFloat32, decodeInt32 } from '../protocol/index.ts';

/** 워커의 `logos` 응답에서 로고 하나 */
export interface LogoData {
  readonly uuid: string;
  readonly patternUuid: string;
  readonly assetName: string;
  /** 꺼져 있으면 3D 에 그리지 않는다 — 데스크톱과 같은 동작이다 */
  readonly showIn3DView: boolean;
  /** 메시에서 띄우는 거리(cm). 안 띄우면 옷과 같은 면이라 z-파이팅이 난다 */
  readonly offsetFromMesh: number;
  /** 그림. 없으면 그리지 않는다 (색만 있는 로고는 아직 안 다룬다) */
  readonly textureIndex?: number;
  /** base64 — int32 3개씩 (삼각형의 정점 색인) */
  readonly tri?: string;
  /** base64 — float 2개씩 (삼각형 안의 비율) */
  readonly ratio?: string;
  /** base64 — int32 (삼각형 목록) */
  readonly indices?: string;
  /** base64 — float 2개씩 (UV) */
  readonly uv?: string;
}

/** 화면에 선 로고 하나. `update()` 가 매 프레임 만지는 것이 `position` 이다 */
interface LogoMesh {
  readonly patternUuid: string;
  readonly mesh: THREE.Mesh;
  readonly position: THREE.BufferAttribute;
  /** 점 하나당 3개 (삼각형의 정점 색인) */
  readonly tri: Int32Array;
  /** 점 하나당 2개 (비율) */
  readonly ratio: Float32Array;
  readonly offset: number;
}

export class LogoLayer {
  readonly #meshes: LogoMesh[] = [];

  get count(): number {
    return this.#meshes.length;
  }

  /**
   * 로고를 세운다. **패턴 메시가 이미 서 있어야 한다** — 그 자식으로 붙는다.
   *
   * `parentOf` 가 null 을 주면(짝이 맞는 패턴이 없으면) 그 로고는 건너뛴다.
   * 지어내서 그리면 옷과 무관한 자리에 그림이 떠 있게 된다.
   *
   * @returns 실제로 세운 개수와, 건너뛴 사유
   */
  set(
    logos: readonly LogoData[],
    textureOf: (index: number) => THREE.Texture | null,
    parentOf: (patternUuid: string) => THREE.Mesh | null,
  ): { placed: number; skipped: { uuid: string; why: string }[] } {
    this.clear();
    const skipped: { uuid: string; why: string }[] = [];

    for (const logo of logos) {
      // 꺼진 로고는 데스크톱에서도 3D 에 안 나온다. 사유를 남겨 두면 화면이
      // "없는 것" 과 "꺼 둔 것" 을 다르게 말할 수 있다.
      if (!logo.showIn3DView) {
        skipped.push({ uuid: logo.uuid, why: '3D 표시 꺼짐' });
        continue;
      }
      if (!logo.tri || !logo.ratio || !logo.indices || !logo.uv) {
        skipped.push({ uuid: logo.uuid, why: '메시 없음' });
        continue;
      }
      const parent = parentOf(logo.patternUuid);
      if (!parent) {
        skipped.push({ uuid: logo.uuid, why: '짝이 되는 패턴이 화면에 없음' });
        continue;
      }
      const texture = logo.textureIndex === undefined ? null : textureOf(logo.textureIndex);
      if (!texture) {
        skipped.push({ uuid: logo.uuid, why: '그림 없음' });
        continue;
      }

      const tri = decodeInt32(logo.tri, `로고 ${logo.uuid} 의 tri`);
      const ratio = decodeFloat32(logo.ratio, `로고 ${logo.uuid} 의 ratio`);
      const uv = decodeFloat32(logo.uv, `로고 ${logo.uuid} 의 uv`);
      const indices = decodeInt32(logo.indices, `로고 ${logo.uuid} 의 indices`);

      const points = ratio.length / 2;
      if (tri.length !== points * 3 || uv.length !== points * 2) {
        skipped.push({ uuid: logo.uuid, why: '메시 배열의 길이가 안 맞음' });
        continue;
      }

      const geometry = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(new Float32Array(points * 3), 3);
      // 옷과 같은 이유로 매 프레임 갱신된다고 드라이버에 알린다
      position.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', position);
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

      const material = new THREE.MeshStandardMaterial({
        map: texture,
        // 로고 그림은 대개 알파가 있는 PNG 다. 끄면 배경 사각형이 같이 보인다
        transparent: true,
        // ⚠️ 알파가 0 인 픽셀까지 깊이를 쓰면 **뒤쪽 로고가 지워진다.**
        //    반투명 정렬 사고를 여기서 미리 막는다.
        depthWrite: false,
        // 옷과 같은 면에 서지 않도록 아래에서 법선 방향으로 띄우지만, 그것만으로
        // 부족한 각도가 있다. 깊이 편향을 같이 준다
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `logo:${logo.uuid}`;
      // 옷과 같은 이유 — 패턴 하나가 프러스텀에서 잘려 나가는 사고를 막는다
      mesh.frustumCulled = false;
      // ★ 자식으로 붙인다 (머리말). 변환을 여기서 다시 계산하지 않는다
      parent.add(mesh);

      this.#meshes.push({
        patternUuid: logo.patternUuid,
        mesh,
        position,
        tri: new Int32Array(tri),
        ratio: new Float32Array(ratio),
        offset: logo.offsetFromMesh,
      });
    }

    return { placed: this.#meshes.length, skipped };
  }

  /**
   * 옷이 움직였다. 로고 좌표를 다시 푼다 (머리말의 식).
   *
   * ⚠️ **옷의 좌표를 쓴 뒤에 불러야 한다.** 먼저 부르면 로고가 한 프레임 뒤처져,
   *    빠르게 움직일 때 옷 밖으로 삐져나온다.
   *
   * @param positionsOf 패턴 uuid → 그 패턴의 현재 정점 배열 (없으면 null)
   */
  update(positionsOf: (patternUuid: string) => Float32Array | null): void {
    for (const item of this.#meshes) {
      const src = positionsOf(item.patternUuid);
      if (!src) continue;

      const dst = item.position.array as Float32Array;
      const n = item.ratio.length / 2;

      for (let i = 0; i < n; i++) {
        const a = item.tri[i * 3] ?? 0;
        const b = item.tri[i * 3 + 1] ?? 0;
        const c = item.tri[i * 3 + 2] ?? 0;
        const rx = item.ratio[i * 2] ?? 0;
        const ry = item.ratio[i * 2 + 1] ?? 0;

        const a3 = a * 3, b3 = b * 3, c3 = c * 3;
        // 배열 밖을 가리키면 그 점은 건드리지 않는다. 워커가 이미 걸러 내지만,
        // 옷과 로고가 서로 다른 순간의 것일 수 있는 경로(토폴로지 교체 직후)가
        // 남아 있어 여기서도 막는다 — 넘치면 조용히 NaN 이 되어 메시가 사라진다
        if (c3 + 2 >= src.length) continue;

        const x0 = src[a3] ?? 0, y0 = src[a3 + 1] ?? 0, z0 = src[a3 + 2] ?? 0;
        const x1 = src[b3] ?? 0, y1 = src[b3 + 1] ?? 0, z1 = src[b3 + 2] ?? 0;
        const x2 = src[c3] ?? 0, y2 = src[c3 + 1] ?? 0, z2 = src[c3 + 2] ?? 0;

        const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;

        // 삼각형의 법선 방향으로 띄운다 — 안 띄우면 옷과 같은 면이라 얼룩진다
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }

        dst[i * 3]     = x0 + e1x * rx + e2x * ry + nx * item.offset;
        dst[i * 3 + 1] = y0 + e1y * rx + e2y * ry + ny * item.offset;
        dst[i * 3 + 2] = z0 + e1z * rx + e2z * ry + nz * item.offset;
      }

      item.position.needsUpdate = true;
      // 옷과 같은 이유 — 법선이 없으면 음영이 지난 프레임에 고정된다
      item.mesh.geometry.computeVertexNormals();
      item.mesh.geometry.computeBoundingSphere();
    }
  }

  /** 화면에서 내린다. 씬을 갈아 끼울 때 반드시 부를 것 */
  clear(): void {
    for (const item of this.#meshes) {
      item.mesh.removeFromParent();
      item.mesh.geometry.dispose();
      const m = item.mesh.material;
      // 텍스처는 캐시가 소유한다 — 여기서 dispose 하면 같은 그림을 쓰는 다른
      // 자리가 같이 죽는다
      if (Array.isArray(m)) m.forEach((x) => { x.dispose(); });
      else m.dispose();
    }
    this.#meshes.length = 0;
  }
}
