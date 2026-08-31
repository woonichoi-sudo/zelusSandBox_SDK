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
 *
 *    ★ **그런데 `uvs` 만으로는 2D 뷰가 안 나온다** (ISSUE-018). 이 좌표는
 *      **서피스 로컬**이라 패턴마다 자기 원점 근처에서 시작한다 — 그대로
 *      그리면 24개가 겹쳐 한 덩어리가 된다(실측: AABB 쌍 276개 중 227개
 *      = 82.2% 가 겹쳤고, 98cm 짜리 레깅스 판 두 장이 소수점 둘째 자리까지
 *      같은 자리였다). 도면 위의 자리는 아래 `transform2d` 를 곱해야 정해진다
 *      (적용 후 겹침 2.5%). 그래서 이 클래스가 둘을 **함께** 들고 있는다.
 *
 * ── 정점은 로컬 좌표다 (ISSUE-011) ──────────────────────────
 * `positions` 는 **패턴 로컬 좌표**이고, 월드 위치는 패턴마다 딸려 오는
 * `transform`(TRS)을 곱해야 정해진다. 그래서 여기서 그것을 `Mesh` 에 건다.
 *
 * **왜 정점에 미리 곱하지 않는가** — 두 가지다.
 *   ① #15 의 2D 펼침 뷰가 로컬 좌표를 원한다. 정점에 곱해 버리면 되돌릴
 *      방법이 없다(변환을 따로 보관해도 부동소수 왕복이 남는다).
 *   ② 매 프레임 정점 3,022~13,398개에 행렬 곱이 붙는다. `Mesh` 에 걸면
 *      GPU 가 모델 행렬로 공짜로 처리한다 — 프레임 갱신 경로가 그대로 남는다.
 *
 * **왜 한 번만 받는가** — 워커가 `topology:true` 응답에만 싣기 때문이다.
 * 실측상 프레임마다 바뀌지 않아서다(sample.zls 249프레임, 비트 단위 동일).
 * 따라서 `updatePositions()` 는 변환을 다시 걸 필요가 없다 — `Mesh` 의
 * position/quaternion/scale 은 우리가 건드리지 않는 한 그대로 남는다.
 * 나중에 라이브 에디팅으로 이 가정이 깨지면 **정점은 흔들리는데 옷 전체가
 * 엉뚱한 자리에 고정**되는 모습으로 드러난다.
 */

import * as THREE from 'three';

import { planFor, tintColorProfile } from '../panels/index.ts';
import type {
  DecodedPattern, PatternMaterial, PatternTransform2D, TextureAsset,
} from '../protocol/index.ts';
import { LogoLayer } from './logos.ts';   // 옷 위의 그래픽 (LG-1)
import { applyPlan, TextureCache } from './textures.ts';

/** 패턴 하나에 대응하는 three 객체 묶음 */
export interface PatternMesh {
  readonly uuid: string;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** 매 프레임 덮어쓰는 대상 (#13) */
  readonly position: THREE.BufferAttribute;
  readonly vertices: number;
  readonly triangles: number;
  /**
   * cm 단위 2D 패턴 좌표. #15 가 쓴다. 없으면 null.
   *
   * **서피스 로컬**이다 — 도면 위의 자리는 `transform2d` 를 곱해야 나온다.
   */
  readonly uvs: Float32Array | null;
  /**
   * 서피스 로컬 → 2D 도면 배치. 행 우선 3×3, 열벡터 규약 (ISSUE-018).
   *
   *   wx = m[0]*x + m[1]*y + m[2]
   *   wy = m[3]*x + m[4]*y + m[5]
   *
   * ⚠️ `mesh` 에 걸어 둔 3D 변환(`p.transform`)과 **다른 것이다.** 2D 펼침은
   *    그것을 쓰지 않는 것이 요점이다.
   *
   * 없으면 null — 서피스가 없는 패턴이거나 구버전 워커다. 항등행렬로 메우지
   * 않는다(원점에 배치된 것과 구분할 수 있어야 한다).
   */
  readonly transform2d: PatternTransform2D | null;
  /**
   * 씬이 정한 **진짜** 재질. 없으면 null.
   *
   * ★ materials-c 부터 화면에 반영된다 — 다만 **무늬가 있을 때만**이다.
   *   텍스처가 붙은 패턴은 이 색이 `mesh.material.color` 가 되고(glTF 의
   *   `baseColorFactor` 와 같은 자리라 스냅샷과 곱셈 규칙이 맞는다), 무늬가
   *   없으면 아래 `PALETTE` 의 임의 색으로 남는다.
   *
   * null 인 경우(재질 없는 패턴, 구버전 워커)에 흰색으로 메우지 않는다 —
   * 진짜 흰 옷과 구분할 수 없게 된다. 그때 쓸 것이 `PALETTE` 폴백이다.
   */
  readonly material: PatternMaterial | null;
}

/**
 * 패턴 5개를 구분되게 칠한다.
 *
 * 단색으로 두면 패턴 경계가 안 보여서, 화면만 보고는 "제대로 그려진 것"과
 * "패턴 하나가 통째로 뒤집힌 것"을 구분할 수 없다. 사람이 눈으로 판정하는
 * 단위(#12 는 `verify: manual`)라 색이 곧 검증 도구다.
 *
 * ★ materials-c 부터 이것은 **폴백이다.** 무늬(텍스처)가 붙은 패턴은 씬의 진짜
 *   색을 쓰고, 무늬가 없는 패턴만 여기로 온다. `sample.zls` 는 5개 패턴이
 *   **전부 흰색**이라 진짜 색만 쓰면 옷이 흰 덩어리 하나로 보인다 — 그 씬에서는
 *   폴백이 오히려 정답이다. 지우지 말 것.
 *
 * ⚠️ **`verify/ui.ts` 의 `LIVE_PALETTE_BUCKETS` 논증이 여기서 깨진다.** 그쪽은
 *    이 다섯 색의 색상 칸을 베껴 두고 "이 칸에 없는 민트/노랑이면 스냅샷(진짜
 *    텍스처)에서 온 것"이라는 배제 논증을 쓴다. 이제 실시간 옷도 민트·노랑을
 *    낼 수 있으므로 그 논증은 성립하지 않는다 — 두 뷰를 색으로 가르려면 다른
 *    기준이 필요하다(예: 무늬의 유무, 또는 텍스처 스위치를 끄고 비교).
 */
const PALETTE = [0x7ea8d8, 0xd8a87e, 0x8fc9a0, 0xc98f9e, 0xb0a8d8] as const;

function colorFor(index: number): number {
  return PALETTE[index % PALETTE.length] ?? 0xcccccc;
}

/**
 * 씬의 진짜 색 → three 의 색. **색공간을 넘겨짚으면 안 된다.**
 *
 * ⚠️ 어느 공간으로 읽을지는 여기서 정하지 않는다 — `panels/textures.ts` 의
 *    `tintColorProfile` 이 정한다. 무늬와 곱해지는 경우와 그렇지 않은 경우의
 *    답이 다르고(실측으로 파랑이 2.5배 갈렸다), 그 판단은 DOM·three 없이
 *    테스트되는 자리에 있어야 한다.
 *
 * (`avatar.ts` 의 같은 이름 함수와 같은 일이다. 두 벌인 이유도 거기와 같다 —
 *  두 파일이 서로를 import 하지 않는 것이 규약이다.)
 */
function colorOf(m: PatternMaterial, profile: 'srgb' | 'linear'): THREE.Color {
  const [r, g, b] = m.color;
  return new THREE.Color().setRGB(
    r, g, b,
    profile === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace,
  );
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

  /**
   * 옷 위의 그래픽 (LG-1). **옷이 소유한다.**
   *
   * 배선을 밖에 두면 `updatePositions()` 를 부르는 자리마다(프레임 스트림 ·
   * 리셋 · 드레이프 · 치수) 로고 갱신을 따로 이어 붙여야 하고, 한 곳을
   * 빠뜨리는 날 **옷만 움직이고 로고는 옛 자리에 남는다.** 여기 두면
   * 통로가 하나다.
   */
  readonly logos = new LogoLayer();

  /** 삽입 순서를 유지한다 — 색 배정이 로드할 때마다 달라지면 안 된다 */
  readonly #byUuid = new Map<string, PatternMesh>();

  #vertices = 0;
  #triangles = 0;

  /**
   * 마지막으로 받은 텍스처 표. 스위치를 껐다 켜는 데 왕복이 없어야 한다.
   *
   * ⚠️ `clear()` 에서 비우지 않는다 — `setTopology` 가 맨 앞에서 clear() 를
   *    부르므로, 비우면 인자 없이 부르는 경로가 무늬를 잃는다.
   */
  #textures: readonly (TextureAsset | null)[] = [];
  #texturesOn = true;
  /** 아바타와 나눠 갖지 않는다 — `avatar.ts` 의 `#cache` 주석과 같은 이유다 */
  readonly #cache = new TextureCache();

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
  setTopology(patterns: readonly DecodedPattern[], textures?: readonly (TextureAsset | null)[]): void {
    this.clear();

    // 재질을 만들기 전에 갈아 끼운다 (`avatar.ts` 의 같은 자리 주석 참고).
    if (textures) this.#textures = textures;

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

      // ★ 무늬가 있으면 **씬의 진짜 색**을, 없으면 임의 팔레트를 쓴다.
      //
      //   임의 색 위에 텍스처를 곱하면 무늬가 통째로 물든다(민트 직물 × 파란
      //   팔레트). 그렇다고 흰색으로 못 박아도 안 된다 — 스냅샷(glTF)이 정답지인데
      //   익스포터가 쓰는 `baseColorFactor` 는 basecolor.xyz 이고, glTF 규약에서
      //   baseColor = factor × 텍스처 다(protocol.cpp 의 "익스포터와 같은 네 가지"
      //   주석). 즉 **스냅샷은 곱한다.** 실시간이 같은 그림이 되려면 여기도 곱해야 한다.
      //   ⓘ 브라우저에서 두 뷰의 factor 를 꺼내 확인했다 — 스냅샷도 흰색이 아닌
      //     색과 텍스처를 함께 갖고 있었다. 곱셈이 맞다.
      //
      //   ★ 그 factor 를 **어느 색공간으로 읽는가**는 또 다른 문제이고, 실측에서
      //     2.5배 갈렸다 — `tintColorProfile` 주석에 숫자가 있다.
      //
      //   무늬가 없을 때 팔레트로 남는 이유는 원래대로다 — `sample.zls` 는 패턴이
      //   전부 흰색이라 진짜 색만 쓰면 옷이 흰 덩어리 하나가 된다.
      const plan = this.#texturesOn ? planFor(p.material, this.#textures, 'cloth') : null;
      const material = new THREE.MeshStandardMaterial({
        color: plan && p.material
          ? colorOf(p.material, tintColorProfile(plan, p.material.colorProfile))
          : colorFor(i),
        // 옷은 두께 없는 껍질이다. 단면으로 두면 안쪽을 볼 때 통째로 사라진다.
        side: THREE.DoubleSide,
        // ★ **씬의 값을 쓴다 (2026-08-24).** 예전에는 `0.78 / 0.0` 하드코딩이었다.
        //   워커는 이 둘을 이미 싣고(`protocol.cpp` 의 재질 5값) 디코더도 받아
        //   두는데(`decode.ts:429-431`) 옷만 버리고 있었다 — 아바타는 처음부터
        //   씬 값을 쓴다(`avatar.ts:305-306`). 데스크톱도 데이터 값을 쓴다
        //   (`Renderer3D.cpp:340-345`). 무늬가 없는 씬(`sample.zls`)에서는
        //   `p.material` 이 없을 수 있어 그때만 옛 상수로 떨어진다.
        roughness: p.material?.roughness ?? 0.78,
        metalness: p.material?.metalness ?? 0.0,
        flatShading: false,
        // ⛔ **Z-파이팅 오프셋을 걷어냈다 (2026-08-24).** 예전에는 여기에
        //    `polygonOffset: true, polygonOffsetFactor: -1 - i, polygonOffsetUnits: -1 - i`
        //    가 있었다. 의도는 "두께 0 껍질이 봉제선에서 겹쳐 깊이값이 같아지는
        //    것"을 막는 것이었는데, 두 가지가 틀렸다:
        //
        //    ① **엔진이 이미 같은 일을 한다.** `ztSimulationDataModel.cpp:2069-2076`
        //       이 완전 봉제된 비경계 에지마다 `sewing.BiasedOffset(mesh, I, 0.01)`
        //       을 로컬로 회전해 양 끝점에 누적 가산한다 — 즉 **정점 좌표에 바이어스가
        //       이미 구워져 온다.** 데스크톱(`Renderer3D.cpp`)에는 폴리곤 오프셋이
        //       없는 이유가 이것이다. 우리 것은 그 위에 얹힌 중복이었다.
        //
        //    ② **값이 패턴 색인에 비례했다.** `factor` 는 깊이 기울기에 곱해지므로,
        //       밑단처럼 표면이 시선과 거의 평행해지는 자리에서 -27(패턴 26개)
        //       만큼 앞으로 끌려 나온다. 그 결과 색인이 큰 조각이 앞 패널을 **뚫고**
        //       나왔다. 무늬를 끄고 보면 그 자리에 다른 패턴의 팔레트 색이 그대로
        //       드러난다(실측). 무늬가 켜져 있을 때는 그 조각이 검은 원단이어서
        //       "밑단에 붓자국 같은 검은 얼룩"으로 보였다.
        //
        //    ⚠️ 만약 이것을 뺀 뒤 봉제선에 **얼룩덜룩한 반점**(색이 픽셀 단위로
        //       번갈아 나오는 진짜 z-파이팅)이 돌아오면, 색인 비례가 아니라
        //       **모든 패턴에 같은 작은 상수**(예: factor/units = -1)를 주는 것이
        //       맞다. 색인에 비례시키면 안 된다.
      });

      if (plan) applyPlan(material, plan, this.#cache);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `pattern:${p.uuid}`;

      // ★ 패턴 로컬 → 월드 (ISSUE-011). 지오메트리가 아니라 **여기**에 건다.
      //   없으면(구버전 워커 / 프레임 이벤트에서 만든 패턴) identity 로 둔다 —
      //   지금까지의 화면이 정확히 그 상태였고, 옷만 그리면 어긋날 상대가
      //   없어서 드러나지 않았다.
      if (p.transform) {
        mesh.position.fromArray(p.transform.translation);
        mesh.quaternion.fromArray(p.transform.rotation); // [x, y, z, w]
        mesh.scale.fromArray(p.transform.scale);
        // 렌더 루프가 돌기 전에도 월드 행렬이 맞아야 한다 — boundingBox() 와
        // 레이캐스팅(#16)이 렌더보다 먼저 불릴 수 있다.
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
      }

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
        // 복사해서 우리가 소유한다 — `uvs`·`positions` 와 같은 이유다.
        transform2d: p.transform2d ? ([...p.transform2d] as PatternTransform2D) : null,
        // 같은 이유로 복사한다. color 배열까지 새로 만들어야 디코더가 준
        // 객체를 나중에 누가 건드려도 여기가 안 흔들린다.
        material: p.material
          ? { ...p.material, color: [...p.material.color] as [number, number, number] }
          : null,
      });

      this.#vertices += p.vertices;
      this.#triangles += p.triangles;
    });
  }

  /**
   * 텍스처 표를 갈아 끼우거나 껐다 켠다. **왕복이 없다.**
   *
   * ★ 색도 같이 간다. 무늬가 붙으면 씬의 진짜 색으로, 떼면 임의 팔레트로
   *   되돌린다 — `setTopology` 의 같은 판단을 여기서도 해야 한다. 색을 그대로
   *   두면 텍스처를 껐을 때 옷 24장이 **직물별로 두 색**만 남아서 패턴 경계가
   *   안 보인다(팔레트가 있는 이유가 정확히 그것이다).
   */
  applyTextures(on: boolean, textures?: readonly (TextureAsset | null)[]): void {
    this.#texturesOn = on;
    if (textures) this.#textures = textures;

    let i = 0;
    for (const p of this.#byUuid.values()) {
      const index = i;
      i += 1;
      const mat = p.mesh.material;
      if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) continue;

      const plan = on ? planFor(p.material, this.#textures, 'cloth') : null;
      applyPlan(mat, plan, this.#cache);
      if (plan && p.material) {
        mat.color.copy(colorOf(p.material, tintColorProfile(plan, p.material.colorProfile)));
      } else {
        mat.color.setHex(colorFor(index));
      }
    }
  }

  /**
   * 위치만 덮어쓴다 — **프레임 갱신 경로 (#13).**
   *
   * 지오메트리를 새로 만들지 않는다. 토폴로지가 달라졌으면(패턴 수·정점 수)
   * 조용히 어긋난 메시를 그리는 대신 `false` 를 돌려준다. 부르는 쪽은 그때
   * `setTopology()` 를 다시 해야 한다 — 재연결로 워커가 바뀌었거나 다른 씬을
   * 연 경우다.
   *
   * ⚠️ 여기서 패턴 변환을 다시 걸지 않는다(ISSUE-011). 프레임 이벤트의 mesh 에는
   *    `transform` 이 애초에 오지 않고, `Mesh` 에 걸어 둔 값은 우리가 건드리지
   *    않는 한 그대로 살아 있다. 정점만 갈아 끼우는 것이 맞다.
   */
  /**
   * 패턴 uuid → 지금 화면에 선 그 패턴의 정점 배열. 로고가 자기 좌표를 풀 때
   * 쓴다 (LG-1). 없으면 null — 지어내지 않는다.
   */
  /** 패턴 uuid → 화면의 그 메시. 로고가 자식으로 붙을 부모다 (LG-1) */
  meshOf(patternUuid: string): THREE.Mesh | null {
    return this.#byUuid.get(patternUuid)?.mesh ?? null;
  }

  /**
   * 로고 그림 하나 (LG-1). **옷의 캐시를 그대로 쓴다** — 로고가 자기 캐시를
   * 따로 가지면 씬을 갈아 끼울 때 지우는 자리가 두 곳이 되고, 한쪽만 지우는
   * 날 옛 씬의 그림이 새 옷에 남는다.
   */
  logoTexture(asset: TextureAsset): THREE.Texture {
    // basecolor 로 읽는다 — sRGB 이고, 옷 무늬와 같은 규약이다
    return this.#cache.get(asset.url, 'basecolor', false);
  }

  positionsOf(patternUuid: string): Float32Array | null {
    const target = this.#byUuid.get(patternUuid);
    return target ? (target.position.array as Float32Array) : null;
  }

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
    // ★ **옷을 쓴 뒤에 부른다** (LG-1). 먼저 부르면 로고가 한 프레임 뒤처져
    //   빠르게 움직일 때 옷 밖으로 삐져나온다.
    this.logos.update((uuid) => this.positionsOf(uuid));
    return true;
  }

  /**
   * 씬 경계 — **월드 좌표(= cm)** 다. 카메라를 맞출 때 쓴다.
   *
   * ★ 지오메트리의 경계 상자는 **로컬 좌표**라 그대로 합치면 안 된다
   *   (ISSUE-011). 변환을 `Mesh` 에 걸어 놨으므로 각 상자에 그 메시의
   *   `matrixWorld` 를 곱해야 카메라가 옷이 실제로 있는 자리를 본다. 이걸
   *   빼면 옷은 y=55~113 에 서 있는데 카메라는 원점 근처를 겨눠서, 화면에
   *   옷이 반쯤 걸리거나 통째로 벗어난다. `snapshotView.boundingBox()` 가
   *   `setFromObject` 로 같은 일을 한다 — 두 뷰의 경계가 같은 공간에 있어야
   *   서로 대조가 된다.
   *
   * `computeBoundingBox()` 를 매번 다시 부르는 이유: `updatePositions()` 는
   * 경계 **구**만 갱신하므로(프러스텀 컬링이 그것을 쓴다) 상자는 로드 직후
   * 값에 멎어 있다.
   */
  boundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    const local = new THREE.Box3();
    // 렌더를 한 번도 안 돌렸을 때(로드 직후의 frameCamera) 자식 행렬이 낡아
    // 있다. 그룹에서 한 번에 내려 갱신한다 — snapshotView 와 같은 이유다.
    this.group.updateMatrixWorld(true);
    for (const p of this.#byUuid.values()) {
      p.geometry.computeBoundingBox();
      if (!p.geometry.boundingBox) continue;
      // 빈 상자(정점 0개)에 applyMatrix4 를 걸어도 three 가 그대로 돌려준다.
      box.union(local.copy(p.geometry.boundingBox).applyMatrix4(p.mesh.matrixWorld));
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
    // 로고는 패턴 메시의 **자식**이라 위에서 부모를 지우면 화면에서는 같이
    // 사라지지만, 지오메트리·머티리얼은 남는다. 명시적으로 내린다
    this.logos.clear();
    this.#byUuid.clear();
    this.#vertices = 0;
    this.#triangles = 0;
    // 표는 남긴다(`#textures` 주석). GPU 텍스처만 버린다 — 세대도 같이 올라가서
    // 늦게 도착하는 로드가 새 씬에 무늬를 입히지 못한다.
    this.#cache.clear();
  }
}
