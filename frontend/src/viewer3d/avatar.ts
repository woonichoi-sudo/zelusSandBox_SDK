/**
 * 실시간 뷰의 **몸** (AM-1). `cloth.ts` 와 같은 자리의 물건이되, 규약이 하나
 * 정반대다.
 *
 * ── ★ 정점은 월드 cm 다. 변환을 곱하지 마라 ─────────────────
 * 옷은 패턴 로컬 좌표라 `transform`(TRS)을 `Mesh` 에 걸어야 제자리에 선다
 * (ISSUE-011). 아바타는 **엔진이 `localTransform` 을 정점에 이미 구워서** 주고,
 * glTF 익스포터도 아바타 노드에 항등변환을 준다 — 그래서 응답에 `transform`
 * 키가 **일부러 없다**(glTF 와 정점 단위 오차 0.00cm 로 확인됐다).
 *
 * `cloth.ts` 를 복사해 오면 이 함정에 정확히 빠진다. 거기엔
 * `mesh.position.fromArray(p.transform.translation)` 이 들어 있고, 아바타에
 * 그걸 걸면 **몸이 옷에서 떨어져 선다** — ISSUE-011 의 증상 그대로인데 원인은
 * 정반대(변환을 안 걸어서가 아니라 걸어서)라 진단이 뒤집힌다. 그래서 이
 * 파일에는 `position`/`quaternion`/`scale` 을 만지는 줄이 **한 줄도 없다.**
 *
 * ── 파트 12개를 합치지 않는다 ───────────────────────────────
 * 제타는 Face / Body / Legs / Arms + 좌우 Eye / Lashe / Pupil / Cornea 로 온다.
 * **재질이 다르다** — 속눈썹·각막은 `opacity` 0.5 라 반투명이고 동공은 검정이다.
 * 합치면 눈이 뭉개진다. 드로우콜 12개는 이 규모(정점 28,564)에서 아무 의미가 없다.
 *
 * ── 법선은 positions 와 한 몸이다 ───────────────────────────
 * 워커가 `normals` 를 위치와 같이 준다(기본 `normals:true`). 몸이 휘면 법선도
 * 바뀌므로 위치를 갈아 끼울 때 법선도 같이 간다. 안 오면
 * `computeVertexNormals()` 로 만든다 — **몸 색이 전부 흰색이라 형태를 드러내는
 * 것이 조명과 음영뿐**이고, 법선이 틀리면 흰 덩어리가 된다.
 *
 * ── 색은 흰색이 정상이다 ────────────────────────────────────
 * 제타의 파트 재질은 전부 `[1,1,1] srgb` 다. 진짜 피부색은 텍스처이고 이
 * 프로토콜에 이미지를 실을 통로가 아직 없다 — "색이 안 왔다" 가 아니다.
 * 머리카락(액세서리)도 같은 이유로 안 실린다. 대머리가 정상이다.
 *
 * ── 경계 상자는 응답의 것을 쓴다 ────────────────────────────
 * `positions` 전체로 다시 재면 안 된다. 아바타 정점 버퍼에는 **어떤 삼각형도
 * 참조하지 않는 쓰레기 정점**이 섞여 있어서 상자가 커지고, 카메라를 그 상자에
 * 맞추면 몸이 화면 구석에 박힌다(익스포터도 같은 이유로 인덱스 참조분만 센다).
 */

import * as THREE from 'three';

import type { AvatarPartMaterial, DecodedAvatar, DecodedAvatarPart } from '../protocol/index.ts';

/** 파트 하나에 대응하는 three 객체 묶음 */
export interface AvatarPartMesh {
  /** `${아바타 uuid}#${파트 index}`. 이름은 중복될 수 있어 짝의 정본이 못 된다 */
  readonly key: string;
  readonly avatarUuid: string;
  readonly index: number;
  readonly name: string;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** 체형·포즈가 바뀔 때 덮어쓰는 대상 */
  readonly position: THREE.BufferAttribute;
  /** 없으면 `computeVertexNormals()` 로 만든 것이다 */
  readonly normal: THREE.BufferAttribute | null;
  readonly vertices: number;
  readonly triangles: number;
  /** 씬이 정한 재질. `topology:false` 로만 받았으면 null */
  readonly material: AvatarPartMaterial | null;
}

/**
 * 재질이 없을 때의 폴백.
 *
 * 흰색으로 메우지 않는다 — 진짜 흰 몸(제타가 그렇다)과 구분할 수 없어진다.
 * 살짝 도는 회색이라 "재질을 못 받았다" 가 화면에서 읽힌다.
 */
const FALLBACK_COLOR = 0xb9bec8;

/**
 * Int32Array 인덱스 → three 가 받아 주는 Uint32Array.
 *
 * ⚠️ **이 처리를 빼면 아무것도 안 그려진다.** WebGL 의 `drawElements` 는 INT 를
 *    받지 않고(UNSIGNED_BYTE/SHORT/INT 뿐), three 는 배열 타입을 보고 GL 타입을
 *    정한다. 값이 전부 음이 아니므로 **비트 패턴은 같다** — 재해석해서 복사한다.
 *    (`cloth.ts` 의 `toIndexArray` 와 같은 이유·같은 코드다. 두 벌인 이유는
 *     한쪽이 사라져도 다른 쪽이 안 깨지게 하려는 것이 아니라, 이 파일이
 *     `cloth.ts` 를 import 하면 "옷을 베껴 오지 말 것" 이라는 이 파일의
 *     머리말과 정면으로 어긋나서다.)
 */
function toIndexArray(indices: Int32Array): Uint32Array {
  return new Uint32Array(new Uint32Array(indices.buffer, indices.byteOffset, indices.length));
}

/** 워커의 색 → three 의 색. `colorProfile` 없이 해석하면 안 된다 */
function colorOf(m: AvatarPartMaterial): THREE.Color {
  const [r, g, b] = m.color;
  return new THREE.Color().setRGB(
    r,
    g,
    b,
    m.colorProfile === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace,
  );
}

/**
 * 아바타 전체. `group` 을 씬에 붙이면 된다.
 *
 * ── 보이는가 = 두 불리언의 곱이다 ───────────────────────────
 * ① 사용자가 켰는가(`setVisible`) ② 지금 실시간 뷰인가(`setModeLive`).
 * 스냅샷(익스포트한 glTF)에는 **이미 아바타가 들어 있어서**, 스냅샷을 보는
 * 동안 이쪽도 켜 두면 같은 몸이 두 벌 겹쳐 서고 z-파이팅으로 얼룩진다.
 * 두 값을 각각 `group.visible` 에 쓰면 나중에 반드시 갈라지므로, 여기서
 * **하나의 파생값**으로 묶는다 (`Viewer3D.setMode` 와 같은 판단이다).
 */
export class AvatarObject {
  readonly group = new THREE.Group();

  readonly #byKey = new Map<string, AvatarPartMesh>();

  #vertices = 0;
  #triangles = 0;
  /** 응답이 준 월드 AABB. 다시 재지 않는다 (머리말 참고) */
  #bounds: THREE.Box3 | null = null;

  /** 사용자가 켰는가 */
  #wanted = true;
  /** 지금 실시간 뷰인가 */
  #live = true;

  constructor() {
    this.group.name = 'avatar';
    this.#apply();
  }

  get partCount(): number {
    return this.#byKey.size;
  }

  get vertexCount(): number {
    return this.#vertices;
  }

  get triangleCount(): number {
    return this.#triangles;
  }

  get parts(): readonly AvatarPartMesh[] {
    return [...this.#byKey.values()];
  }

  /** 사용자가 켜 둔 상태. **화면에 실제로 보이는지와 다르다**(모드가 곱해진다) */
  get visible(): boolean {
    return this.#wanted;
  }

  /** 지금 실제로 그려지고 있는가 */
  get shown(): boolean {
    return this.group.visible;
  }

  setVisible(on: boolean): void {
    this.#wanted = on;
    this.#apply();
  }

  /** `Viewer3D.setMode` 가 부른다. 스냅샷 모드에서는 몸을 내린다 */
  setModeLive(live: boolean): void {
    this.#live = live;
    this.#apply();
  }

  #apply(): void {
    this.group.visible = this.#wanted && this.#live;
  }

  /**
   * 토폴로지를 세운다 — **`topology:true` 로 받았을 때 한 번.**
   *
   * 기존 지오메트리를 전부 버리고 새로 만든다. 체형이 바뀔 때마다 이걸 부르면
   * 매번 GPU 버퍼를 새로 할당하게 된다. 그 경로는 `updatePositions()` 다.
   */
  setTopology(avatars: readonly DecodedAvatar[]): void {
    this.clear();

    for (const a of avatars) {
      for (const p of a.parts) {
        const built = this.#build(a, p);
        this.group.add(built.mesh);
        this.#byKey.set(built.key, built);
        this.#vertices += p.vertices;
        this.#triangles += p.triangles;
      }
      this.#unionBounds(a);
    }
  }

  #build(a: DecodedAvatar, p: DecodedAvatarPart): AvatarPartMesh {
    const geometry = new THREE.BufferGeometry();

    // 복사해서 우리가 소유한다. 디코더가 준 배열은 호출자가 언제 버릴지 모른다.
    const position = new THREE.BufferAttribute(new Float32Array(p.positions), 3);
    // 체형·포즈로 갱신될 것이라고 드라이버에 알린다.
    position.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);

    let normal: THREE.BufferAttribute | null = null;
    if (p.normals) {
      normal = new THREE.BufferAttribute(new Float32Array(p.normals), 3);
      normal.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('normal', normal);
    }

    if (p.uvs) {
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.uvs), 2));
    }
    if (p.indices) {
      geometry.setIndex(new THREE.BufferAttribute(toIndexArray(p.indices), 1));
    }

    // 법선이 안 왔을 때만 만든다. 왔으면 엔진 것이 정본이다 — 우리가 다시
    // 계산하면 파트 경계(눈꺼풀·목)에서 각이 서서 이음매가 드러난다.
    if (!normal) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.#materialFor(p));
    mesh.name = `avatar:${a.uuid}#${p.index}:${p.name}`;
    // 파트 12개짜리 씬에서 컬링으로 얻을 것이 없다. 반대로 경계구 갱신을
    // 한 번 빠뜨리면 몸의 일부가 통째로 사라진다.
    mesh.frustumCulled = false;

    return {
      key: `${a.uuid}#${p.index}`,
      avatarUuid: a.uuid,
      index: p.index,
      name: p.name,
      mesh,
      geometry,
      position,
      normal,
      vertices: p.vertices,
      triangles: p.triangles,
      material: p.material
        ? { ...p.material, color: [...p.material.color] as [number, number, number] }
        : null,
    };
  }

  /**
   * 파트의 재질.
   *
   * ★ **반투명을 살리는 것이 요점이다.** 속눈썹·각막이 `opacity` 0.5 로 오는데
   *   `transparent` 를 안 켜면 three 가 알파를 통째로 무시해서 눈이 판때기가
   *   된다. 대신 켜면 정렬 문제가 따라오므로 `depthWrite` 를 끈다 — 반투명
   *   껍질이 뒤의 눈알을 깊이 버퍼로 가리는 것을 막는다.
   *
   * `side` 는 양면이다. 몸은 닫힌 메시라 앞면만으로 충분해 보이지만, 감기
   * 방향이 한 파트라도 뒤집혀 있으면 **그 파트가 통째로 사라진다** — 화면에서
   * 원인을 읽을 수 없는 실패라 값싼 보험을 든다.
   */
  #materialFor(p: DecodedAvatarPart): THREE.MeshStandardMaterial {
    const m = p.material;
    if (!m) {
      return new THREE.MeshStandardMaterial({
        color: FALLBACK_COLOR,
        side: THREE.DoubleSide,
        roughness: 0.72,
        metalness: 0.0,
      });
    }

    const transparent = m.opacity < 1;
    return new THREE.MeshStandardMaterial({
      color: colorOf(m),
      side: THREE.DoubleSide,
      roughness: m.roughness,
      metalness: m.metalness,
      opacity: m.opacity,
      transparent,
      depthWrite: !transparent,
    });
  }

  /**
   * 위치(와 법선)만 덮어쓴다 — **체형 변경·드레이프·애니메이션 경로.**
   *
   * 토폴로지가 달라졌으면(파트 짝이 안 맞거나 정점 수가 다르면) 조용히 어긋난
   * 몸을 그리는 대신 `false` 를 돌려준다. 부르는 쪽은 그때 `topology:true` 로
   * 다시 받아 `setTopology()` 를 해야 한다.
   *
   * ⚠️ 여기서 **변환을 걸지 않는다.** 걸 것이 애초에 없다(머리말 참고).
   */
  updatePositions(avatars: readonly DecodedAvatar[]): boolean {
    // 먼저 전부 확인하고 나서 쓴다. 절반만 갱신된 몸은 눈으로 원인을 못 찾는다.
    const targets: { target: AvatarPartMesh; src: DecodedAvatarPart }[] = [];
    let seen = 0;
    for (const a of avatars) {
      for (const p of a.parts) {
        const target = this.#byKey.get(`${a.uuid}#${p.index}`);
        if (!target) return false;
        if (p.positions.length !== target.position.array.length) return false;
        if (p.normals && target.normal && p.normals.length !== target.normal.array.length) {
          return false;
        }
        targets.push({ target, src: p });
        seen += 1;
      }
    }
    if (seen !== this.#byKey.size) return false;

    for (const { target, src } of targets) {
      (target.position.array as Float32Array).set(src.positions);
      target.position.needsUpdate = true;

      if (src.normals && target.normal) {
        (target.normal.array as Float32Array).set(src.normals);
        target.normal.needsUpdate = true;
      } else {
        // 법선이 없으면 음영이 옛 자세에 굳는다 — 몸은 휘는데 빛이 안 따라간다.
        target.geometry.computeVertexNormals();
      }

      // 레이캐스팅(그래빙)이 같은 값을 쓴다. 프러스텀은 꺼 뒀지만 이건 남긴다.
      target.geometry.computeBoundingSphere();
    }

    // 상자도 같이 간다 — 체형을 바꾸면 키가 달라지고, 낡은 상자에 카메라를
    // 맞추면 머리가 잘린다.
    this.#bounds = null;
    for (const a of avatars) this.#unionBounds(a);
    return true;
  }

  #unionBounds(a: DecodedAvatar): void {
    if (!a.bounds) return;
    const box = new THREE.Box3(
      new THREE.Vector3().fromArray(a.bounds.min),
      new THREE.Vector3().fromArray(a.bounds.max),
    );
    if (this.#bounds) this.#bounds.union(box);
    else this.#bounds = box;
  }

  /**
   * 씬 경계 — **월드 cm.** 카메라를 맞출 때 쓴다.
   *
   * ★ **응답이 준 값이다. 정점에서 다시 재지 않는다**(머리말 참고). 그래서
   *   `cloth.boundingBox()` 와 달리 `computeBoundingBox()` 를 부르는 줄이 없다.
   *   응답에 `bounds` 가 없었으면 빈 상자다 — 0 짜리 상자로 메우지 않는다.
   */
  boundingBox(): THREE.Box3 {
    return this.#bounds ? this.#bounds.clone() : new THREE.Box3();
  }

  /** GPU 자원까지 해제한다. 씬을 갈아 끼울 때 반드시 부른다 */
  clear(): void {
    for (const p of this.#byKey.values()) {
      this.group.remove(p.mesh);
      p.geometry.dispose();
      const mat = p.mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    this.#byKey.clear();
    this.#vertices = 0;
    this.#triangles = 0;
    this.#bounds = null;
  }
}
