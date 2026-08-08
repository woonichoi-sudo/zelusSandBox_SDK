/**
 * 스냅샷의 브라우저 쪽 — **glTF 바이트를 씬 그래프로.** three 와 GLTFLoader 를
 * 쓰는 유일한 스냅샷 파일이다 (상태 기계는 `snapshot.ts`, DOM-free).
 *
 * ── 스케일: 왜 100 을 곱하는가 ──────────────────────────────
 * 익스포터가 루트 노드에 `scale = [0.01, 0.01, 0.01]` 을 건다(ISSUE-011,
 * `zwGltfExporterImpl.cpp:212`). 엔진 단위가 **cm** 인데 glTF 규약이 **m** 이기
 * 때문이다. 그런데 우리 3D 뷰는 `cloth.ts` 가 워커의 원시 정점(cm)을 그대로
 * 쓰고 `viewer.ts` 의 격자가 "한 칸 10cm" 로 서 있다 — 즉 **씬 전체가 cm 규약**
 * 이다. GLB 를 그대로 넣으면 100배 작게(옷 한 벌이 격자 한 칸 안에) 나온다.
 *
 * 고르는 방법이 둘 있었다:
 *   (a) 씬 전체를 m 로 바꾼다 — 격자·카메라·`cloth.ts` 를 전부 고쳐야 하고,
 *       그러면 이번 단위의 실패 원인이 "아바타가 안 나온다"인지 "단위 변경이
 *       뭔가 깨뜨렸다"인지 구분되지 않는다.
 *   (b) 스냅샷만 100배로 되돌린다 — 100 × 0.01 = 1 이므로 **엔진 좌표(cm)로
 *       정확히 복원된다.** 반올림도 근사도 없다.
 * (b) 를 택했다. 게다가 이 100 은 임의의 보정값이 아니라 **익스포터가 건 0.01
 * 의 역수**라, 익스포터가 그 값을 바꾸면 여기도 바꿔야 한다는 관계가 분명하다.
 *
 * ⚠️ 곱하는 자리가 중요하다. `gltf.scene` 자체의 스케일을 건드리지 않고
 *    **감싸는 그룹**에 건다. 그래야 임포트한 노드 계층이 파일 그대로 남아,
 *    화면이 이상할 때 "우리가 만졌나"를 의심하지 않아도 된다.
 *
 * ── 노드 변환은 손대지 않는다 ───────────────────────────────
 * 옷 패턴 노드에는 translation(y 54.7~56.7cm)이 걸려 있고 아바타 노드는
 * `[0,0,0]` 이다(ISSUE-011). `GLTFLoader` 가 그 계층을 그대로 만들어 주므로
 * **아바타와 옷의 상대 위치는 자동으로 맞는다.** 실시간 경로(`cloth.ts`)도 이제
 * 같은 변환을 `Mesh` 에 걸므로(ISSUE-011) 두 뷰의 옷은 같은 자리에 선다 —
 * 실측 대조에서 경계 상자가 0.03cm 안에서 일치했다. 그래도 겹쳐 놓지 않는
 * 이유는 `viewer.ts` 의 `ViewMode` 주석에 있다.
 *
 * ── 해제 ────────────────────────────────────────────────────
 * 36.5MB glTF 하나에 지오메트리 수십 개와 **임베드 텍스처 13장**이 딸려 온다.
 * 이걸 안 놓으면 스냅샷을 다시 찍을 때마다 GPU 메모리가 는다. `cloth.ts` 의
 * `clear()` 와 같은 규약이되, 텍스처가 머티리얼 **여러 개에 공유**되므로 Set 으로
 * 모아서 한 번씩만 dispose 한다.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { SnapshotStats, SnapshotTarget } from './snapshot.ts';

/** 익스포터가 루트에 거는 스케일의 역수. 100 × 0.01 = 1 → 엔진 cm 좌표 */
export const SNAPSHOT_SCALE = 100;

/** `GLTFLoader.parseAsync` 가 돌려주는 것 중 우리가 쓰는 부분만 */
export interface ParsedSnapshot {
  scene: THREE.Object3D;
}

/**
 * glTF/GLB 바이트를 파싱한다. **브라우저에서만 돈다.**
 *
 * ⚠️ Node 에서 부르면 텍스처 로딩에서 죽는다 — 임베드된 base64 이미지를
 *    `ImageBitmapLoader`/`ImageLoader` 로 여는데 둘 다 DOM 이 필요하다. 그래서
 *    이 함수가 `snapshot.ts` 가 아니라 여기 있고, 상태 기계는 이걸 **주입받는다.**
 *
 * ⚠️ 두 번째 인자(resourcePath)가 `''` 인 것이 맞다. #10 의 산출물은 `.bin`
 *    사이드카가 없고 텍스처가 전부 data URI 라 **로더가 추가 요청을 하지 않는다.**
 *    즉 상대경로 해석이 일어날 자리가 없다.
 */
export async function parseSnapshot(bytes: ArrayBuffer): Promise<ParsedSnapshot> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(bytes, '');
  return { scene: gltf.scene };
}

/**
 * 화면에 선 스냅샷 하나. `group` 을 씬에 붙이면 된다.
 *
 * `SnapshotTarget` 을 구현하므로 `SnapshotLoader` 에 그대로 넘길 수 있다.
 */
export class SnapshotObject implements SnapshotTarget<ParsedSnapshot> {
  readonly group = new THREE.Group();

  #root: THREE.Object3D | null = null;
  #stats: SnapshotStats = { meshes: 0, vertices: 0, materials: 0, textures: 0 };

  constructor() {
    this.group.name = 'snapshot';
    // ★ 여기 한 줄이 좌표계 결정의 전부다. 머리말 참고.
    this.group.scale.setScalar(SNAPSHOT_SCALE);
    // 기본은 안 보이는 상태다 — 화면에 무엇을 세울지는 `Viewer3D.setMode` 가
    // 단 한 곳에서 정한다. 여기서 true 로 두면 스냅샷이 붙는 순간 실시간 옷과
    // 겹쳐 보이는 창이 한 프레임이라도 생긴다.
    this.group.visible = false;
  }

  parse(bytes: ArrayBuffer): Promise<ParsedSnapshot> {
    return parseSnapshot(bytes);
  }

  get present(): boolean {
    return this.#root !== null;
  }

  get stats(): SnapshotStats {
    return this.#stats;
  }

  /** 세운다. **이전 것은 여기서 해제된다** — 호출자가 챙길 것이 없다 */
  install(content: ParsedSnapshot): SnapshotStats {
    this.clear();

    const root = content.scene;
    this.group.add(root);
    this.#root = root;

    let meshes = 0;
    let vertices = 0;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes += 1;
      const pos = mesh.geometry.getAttribute('position');
      if (pos) vertices += pos.count;
      for (const mat of materialsOf(mesh)) {
        materials.add(mat);
        for (const tex of texturesOf(mat)) textures.add(tex);
      }
    });

    this.#stats = { meshes, vertices, materials: materials.size, textures: textures.size };
    return this.#stats;
  }

  /** 붙이지 못한 파싱 결과를 버린다 (세대가 바뀐 경우) */
  dispose(content: ParsedSnapshot): void {
    disposeTree(content.scene);
  }

  /** 화면에서 내리고 GPU 자원까지 해제한다 */
  clear(): void {
    const root = this.#root;
    if (!root) return;
    this.group.remove(root);
    disposeTree(root);
    this.#root = null;
    this.#stats = { meshes: 0, vertices: 0, materials: 0, textures: 0 };
  }

  /**
   * 씬 경계 — **월드 좌표(= cm)** 다. 카메라를 맞출 때 쓴다.
   *
   * `updateMatrixWorld` 를 먼저 부르는 이유: `Box3.setFromObject` 는 각 노드의
   * 행렬을 부모 기준으로만 갱신하므로, 그룹 자신의 `matrixWorld` 가 낡아 있으면
   * (아직 렌더를 한 번도 안 돌았을 때) 스케일 100 이 빠진 상자가 나온다.
   */
  boundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (!this.#root) return box;
    this.group.updateMatrixWorld(true);
    return box.setFromObject(this.group);
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  const mat = mesh.material;
  return Array.isArray(mat) ? mat : [mat];
}

/**
 * 머티리얼이 들고 있는 텍스처 전부.
 *
 * 이름을 나열하지 않고 값을 훑는 이유는 glTF 확장 때문이다 — `map`·`normalMap`
 * 말고도 KHR 확장이 붙는 슬롯(`clearcoatMap`, `sheenColorMap`, `iridescenceMap`
 * …)이 계속 늘어난다. 목록으로 두면 새 확장이 낀 파일에서 조용히 새어 나간다.
 */
function texturesOf(mat: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
    const tex = value as THREE.Texture | null;
    if (tex && (tex as { isTexture?: boolean }).isTexture === true) out.push(tex);
  }
  return out;
}

/** 지오메트리 · 머티리얼 · 텍스처를 한 번씩만 해제한다 */
function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    for (const mat of materialsOf(mesh)) {
      materials.add(mat);
      for (const tex of texturesOf(mat)) textures.add(tex);
    }
  });

  for (const t of textures) t.dispose();
  for (const m of materials) m.dispose();
  for (const g of geometries) g.dispose();
  root.clear();
}
