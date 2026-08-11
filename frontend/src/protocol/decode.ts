/**
 * base64 지오메트리 → TypedArray. **브라우저 전용 구현이다.**
 *
 * SDK(`backend/src/sdk/protocol.ts`)에 같은 이름의 함수가 있지만 `Buffer` 를
 * 쓴다 — 브라우저에는 없다. SDK 는 수정 금지 대상이므로 여기에 브라우저 API
 * (`atob` / `Uint8Array.fromBase64`) 로 다시 쓴다. 두 구현이 같은 바이트를
 * 내놓는지는 스모크가 확인한다.
 *
 * ── 정렬 함정 ────────────────────────────────────────────────
 * `new Float32Array(bytes.buffer)` 는 **바이트 오프셋이 4의 배수가 아니면
 * 던진다.** Node 의 `Buffer` 는 풀링된 ArrayBuffer 의 임의 위치를 가리키므로
 * 실제로 걸리고, 그래서 SDK 도 복사해서 정렬을 맞춘다. 브라우저의 `atob` 경로는
 * 우리가 `new Uint8Array(n)` 으로 직접 잡으니 오프셋이 항상 0 이지만,
 * `Uint8Array.fromBase64` 나 남이 준 뷰가 섞이면 다시 문제가 된다.
 * 그래서 **오프셋을 확인하고, 어긋나면 복사한다** — 조건을 없애는 대신 확인한다.
 *
 * ── 성능 ─────────────────────────────────────────────────────
 * 구독 중 실측이 프레임당 47.8KB × 40/s ≈ 1.9MB/s 다. `atob` + 문자 루프로도
 * 여유가 있지만, 있으면 `Uint8Array.fromBase64`(ES2025, Node 22+/Chrome 133+)를
 * 쓴다 — 네이티브라 3~5배 빠르다. 없으면 조용히 폴백한다.
 */

import type {
  AvatarMesh,
  AvatarMeshResult,
  AvatarPart,
  AvatarPartMaterial,
  FrameMesh,
  PatternData,
  PatternMaterial,
  PatternTransform,
  PatternTransform2D,
} from './types.ts';

/** ES2025 `Uint8Array.fromBase64`. 아직 lib 에 없어서 직접 좁힌다 */
type FromBase64 = (base64: string) => Uint8Array;

const nativeFromBase64: FromBase64 | null = (() => {
  const fn = (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
  return typeof fn === 'function' ? (fn as FromBase64).bind(Uint8Array) : null;
})();

/**
 * base64 → 바이트. 결과는 **오프셋 0 의 전용 ArrayBuffer**를 갖는다.
 *
 * 그 보장이 있어야 아래 뷰 생성이 복사 없이 끝난다. 예외를 우리 문구로 감싸는
 * 이유는, `atob` 의 `InvalidCharacterError` 만 보고는 어느 패턴의 어느 필드가
 * 깨졌는지 알 수 없기 때문이다.
 */
export function base64ToBytes(base64: string): Uint8Array {
  if (nativeFromBase64) {
    try {
      return nativeFromBase64(base64);
    } catch (err: unknown) {
      throw new Error(`base64 디코딩 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch (err: unknown) {
    throw new Error(`base64 디코딩 실패: ${err instanceof Error ? err.message : String(err)}`);
  }

  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 정렬을 보장한 뷰를 만든다. 이미 맞으면 복사하지 않는다.
 *
 * `bytesPerElement` 로 나눠떨어지지 않는 길이는 **던진다.** 조용히 잘라내면
 * 정점 하나가 사라진 메시가 화면에 그려지고, 원인은 영영 안 보인다.
 */
function viewOf<T>(
  bytes: Uint8Array,
  label: string,
  bytesPerElement: number,
  make: (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
): T {
  if (bytes.byteLength % bytesPerElement !== 0) {
    throw new Error(
      `${label} 길이가 ${bytesPerElement}의 배수가 아닙니다 (${bytes.byteLength}바이트)`,
    );
  }

  // ★ 정렬 확인. 어긋나면 복사한다 (새 Uint8Array 는 오프셋 0 이다).
  const aligned = bytes.byteOffset % bytesPerElement === 0
    ? bytes
    : new Uint8Array(bytes); // 복사

  return make(aligned.buffer, aligned.byteOffset, aligned.byteLength / bytesPerElement);
}

/** base64 → Float32Array. 정점 좌표(x,y,z)와 UV 가 이걸 쓴다 */
export function decodeFloat32(base64: string, label = 'float32 배열'): Float32Array {
  return viewOf(base64ToBytes(base64), label, 4, (b, o, n) => new Float32Array(b, o, n));
}

/** base64 → Int32Array. 삼각형 인덱스가 이걸 쓴다 */
export function decodeInt32(base64: string, label = 'int32 배열'): Int32Array {
  return viewOf(base64ToBytes(base64), label, 4, (b, o, n) => new Int32Array(b, o, n));
}

/** three.js 가 그대로 받을 수 있는 형태 (#12). SDK 의 DecodedPattern 과 같은 모양이다 */
export interface DecodedPattern {
  uuid: string;
  /** 정점당 3 개. 길이 === vertices * 3 (아래에서 검증한다) */
  positions: Float32Array;
  /** topology:true 로 받았을 때만. 삼각형당 3 개 */
  indices?: Int32Array;
  /** topology:true 로 받았을 때만. 정점당 2 개 */
  uvs?: Float32Array;
  /**
   * 패턴 로컬 → 월드 변환 (ISSUE-011). **topology:true 로 받았을 때만.**
   *
   * `positions` 는 이 변환이 곱해지지 **않은** 로컬 좌표다. 그리는 쪽이
   * `Mesh` 에 걸어야 옷이 제자리에 선다 (`cloth.ts` 의 `setTopology`).
   * 프레임 이벤트에는 오지 않으므로 여기서 받은 것을 계속 쓴다.
   */
  transform?: PatternTransform;
  /**
   * 서피스 로컬 → **2D 재단 도면** 배치 (ISSUE-018). **topology:true 일 때만.**
   *
   * ⚠️ 위의 `transform`(3D)과 **다른 것이다.** 저쪽은 옷이 몸에 둘러지는 자리,
   *    이쪽은 도면 위의 자리다. 2D 펼침 뷰(#15-b)는 3D 변환을 **쓰지 않는다.**
   *
   * `uvs` 와 짝으로 쓴다 — `uvs` 만으로 그리면 패턴 24개가 겹쳐 한 덩어리가
   * 된다(실측: 겹치는 AABB 쌍 82.2% → 이 행렬 적용 후 2.5%).
   *
   * 행 우선 3×3, 열벡터 규약: `wx = m[0]*x + m[1]*y + m[2]`,
   * `wy = m[3]*x + m[4]*y + m[5]`. 단위 cm.
   */
  transform2d?: PatternTransform2D;
  /**
   * 패턴의 **진짜** 재질. **topology:true 로 받았을 때만.**
   *
   * 실시간 3D 뷰는 여태 패턴 구분용 임의 팔레트로 칠했고, 진짜 색은
   * 스냅샷(glTF)에만 나왔다 — 사용자가 움직이는 옷을 보면서 색을 믿을 수
   * 없는 상태였다. 이 필드가 그 출처다.
   *
   * ⚠️ **없을 수 있고, 그건 오류가 아니다.** 재질이 없는 패턴이 그렇다.
   *    그때 흰색으로 대신하면 안 된다 — 그리는 쪽은 임의 팔레트로 폴백해
   *    패턴 경계를 보이게 유지해야 한다(`cloth.ts` 의 `PALETTE`).
   */
  material?: PatternMaterial;
  vertices: number;
  triangles: number;
}

/**
 * `transform` 검증 — **길이와 유한성만 본다.**
 *
 * 값의 옳고 그름은 여기서 판정할 수 없지만(그건 씬이 정한다) 모양이 틀린 것은
 * 확실히 안다. 모양이 틀린 채 통과시키면 `fromArray` 가 `undefined` 를 읽어
 * 좌표가 `NaN` 이 되고, three 는 조용히 **아무것도 그리지 않는다** — 화면이
 * 비었는데 정점 수는 정상으로 찍히므로 원인을 화면에서 읽을 방법이 없다.
 *
 * ⚠️ 없는 것(`undefined`)은 오류가 아니다. 프레임 이벤트의 mesh 와 이 필드를
 *    싣기 전 워커가 그렇다 — 그 경우 변환 없이(= identity) 그린다.
 */
function decodeTransform(uuid: string, raw: unknown): PatternTransform | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== 'object') {
    throw new Error(`패턴 ${uuid}: transform 이 객체가 아닙니다 (${typeof raw})`);
  }

  const src = raw as Record<string, unknown>;
  const take = (key: string, len: number): number[] => {
    const arr = src[key];
    if (!Array.isArray(arr) || arr.length !== len) {
      throw new Error(
        `패턴 ${uuid}: transform.${key} 는 길이 ${len} 의 배열이어야 합니다`,
      );
    }
    for (const v of arr) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`패턴 ${uuid}: transform.${key} 에 숫자가 아닌 값이 있습니다`);
      }
    }
    return arr as number[];
  };

  const [tx, ty, tz] = take('translation', 3) as [number, number, number];
  const [rx, ry, rz, rw] = take('rotation', 4) as [number, number, number, number];
  const [sx, sy, sz] = take('scale', 3) as [number, number, number];

  return {
    translation: [tx, ty, tz],
    rotation: [rx, ry, rz, rw],
    scale: [sx, sy, sz],
  };
}

/**
 * `transform2d` 검증 — `decodeTransform` 과 **같은 이유로 같은 일**을 한다.
 *
 * 길이 9 와 유한성만 본다. 모양이 틀린 채 통과시키면 2D 위치가 `NaN` 이 되고,
 * three 는 조용히 아무것도 그리지 않는다 — 패턴 하나가 통째로 사라지는데
 * 정점 수는 정상으로 찍히므로 화면에서 원인을 읽을 방법이 없다.
 *
 * ⚠️ 없는 것(`undefined`)은 오류가 아니다. `topology:false` 로 받은 프레임
 *    이벤트의 mesh 와, 서피스가 없는 패턴이 그렇다. 그 경우 2D 배치를
 *    **모르는 것**이고, 항등행렬로 대신하지 않는다 — 원점에 배치된 패턴과
 *    구분할 수 없게 된다.
 */
function decodeTransform2D(uuid: string, raw: unknown): PatternTransform2D | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (!Array.isArray(raw) || raw.length !== 9) {
    throw new Error(
      `패턴 ${uuid}: transform2d 는 길이 9 의 배열이어야 합니다 `
      + `(${Array.isArray(raw) ? `길이 ${raw.length}` : typeof raw})`,
    );
  }

  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`패턴 ${uuid}: transform2d 에 숫자가 아닌 값이 있습니다`);
    }
  }

  return [...(raw as number[])] as unknown as PatternTransform2D;
}

/**
 * `material` 검증 — 위 두 변환과 **같은 이유로 같은 일**을 한다.
 *
 * 다만 실패 양상이 다르다. 변환이 `NaN` 이면 패턴이 통째로 사라져서 최소한
 * 눈에는 띈다. 색은 그렇지 않다 — `NaN` 이나 문자열이 섞인 색을 three 에
 * 넘기면 그 패턴만 **검게** 그려지고, 그건 "어두운 천"과 구분되지 않는다.
 * 화면만 보고는 재질 문제인지 조명 문제인지 알 수 없으므로 여기서 끊는다.
 *
 * 0~1 범위는 **검사하지 않는다.** 범위를 벗어난 값은 씬이 그렇게 정한 것일
 * 수 있고(HDR 색), 그 판정은 디코더의 권한이 아니다. 유한성만 본다 —
 * 그건 확실히 틀린 것이다.
 *
 * ⚠️ 없는 것(`undefined`)은 오류가 아니다. `topology:false` 로 받은 프레임
 *    이벤트의 mesh 와, 재질이 없는 패턴이 그렇다. 그 경우 색을 **모르는
 *    것**이고, 흰색으로 대신하지 않는다 — 진짜 흰 옷과 구분할 수 없게 된다.
 */
function decodeMaterial(uuid: string, raw: unknown): PatternMaterial | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== 'object') {
    throw new Error(`패턴 ${uuid}: material 이 객체가 아닙니다 (${typeof raw})`);
  }

  const src = raw as Record<string, unknown>;

  const color = src['color'];
  if (!Array.isArray(color) || color.length !== 3) {
    throw new Error(
      `패턴 ${uuid}: material.color 는 길이 3 의 배열이어야 합니다 `
      + `(${Array.isArray(color) ? `길이 ${color.length}` : typeof color})`,
    );
  }
  for (const v of color) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`패턴 ${uuid}: material.color 에 숫자가 아닌 값이 있습니다`);
    }
  }

  const profile = src['colorProfile'];
  if (profile !== 'srgb' && profile !== 'linear') {
    // 여기서 sRGB 로 넘겨짚지 않는다. 틀린 쪽으로 짚으면 색이 눈에 띄게
    // 어긋나는데 아무도 예외를 못 본다 — 화면이 "좀 칙칙하다"로만 보인다.
    throw new Error(
      `패턴 ${uuid}: material.colorProfile 은 'srgb' | 'linear' 여야 합니다 `
      + `(${JSON.stringify(profile)})`,
    );
  }

  const scalar = (key: 'opacity' | 'roughness' | 'metalness'): number => {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`패턴 ${uuid}: material.${key} 가 유한한 숫자가 아닙니다`);
    }
    return v;
  };

  const fabricUuid = src['fabricUuid'];
  if (typeof fabricUuid !== 'string') {
    throw new Error(`패턴 ${uuid}: material.fabricUuid 가 문자열이 아닙니다`);
  }

  const [r, g, b] = color as [number, number, number];

  return {
    fabricUuid,
    color: [r, g, b],
    colorProfile: profile,
    opacity: scalar('opacity'),
    roughness: scalar('roughness'),
    metalness: scalar('metalness'),
  };
}

/**
 * 패턴 하나를 푼다.
 *
 * **길이를 검증하는 것이 이 함수의 본체다.** 디코딩 자체는 세 줄이고, 값진 것은
 * `positions.length === vertices * 3` 이 실제로 성립하는지 확인하는 쪽이다.
 * 어긋난 채로 three.js 에 넘기면 지오메트리가 조용히 뒤틀리거나, 마지막 몇
 * 정점이 원점에 붙는다 — 렌더 결과만 보고는 디코딩 문제인지 시뮬 문제인지
 * 구분할 수 없다. 여기서 끊으면 원인이 한 곳을 가리킨다.
 *
 * `positionStride` 는 검증에 쓰지 않는다. 서버가 12(= float32 × 3)를 실어
 * 보내지만, 그건 "촘촘히 포장했다"는 사실의 재확인일 뿐이고 정본은 vertices 다.
 */
export function decodePattern(p: PatternData): DecodedPattern {
  const positions = p.positions
    ? decodeFloat32(p.positions, `패턴 ${p.uuid} positions`)
    : new Float32Array(0);

  if (p.positions && positions.length !== p.vertices * 3) {
    throw new Error(
      `패턴 ${p.uuid}: positions 길이가 맞지 않습니다 `
      + `(${positions.length} !== vertices ${p.vertices} × 3)`,
    );
  }

  const out: DecodedPattern = {
    uuid: p.uuid,
    vertices: p.vertices,
    triangles: p.triangles,
    positions,
  };

  if (p.indices) {
    const indices = decodeInt32(p.indices, `패턴 ${p.uuid} indices`);
    if (indices.length !== p.triangles * 3) {
      throw new Error(
        `패턴 ${p.uuid}: indices 길이가 맞지 않습니다 `
        + `(${indices.length} !== triangles ${p.triangles} × 3)`,
      );
    }
    out.indices = indices;
  }

  if (p.uvs) {
    const uvs = decodeFloat32(p.uvs, `패턴 ${p.uuid} uvs`);
    if (uvs.length !== p.vertices * 2) {
      throw new Error(
        `패턴 ${p.uuid}: uvs 길이가 맞지 않습니다 (${uvs.length} !== vertices ${p.vertices} × 2)`,
      );
    }
    out.uvs = uvs;
  }

  // base64 가 아니라 평문 숫자다 — 패턴당 10개뿐이라 압축 이득이 없고,
  // 사람이 읽을 수 있어야 익스포트 산출물의 노드 변환과 대조할 수 있다.
  const transform = decodeTransform(p.uuid, p.transform);
  if (transform) out.transform = transform;

  // 2D 도면 배치 (ISSUE-018). 같은 이유로 평문 숫자다 — 패턴당 9개뿐이고,
  // 사람이 읽을 수 있어야 씬 파일의 translateX/translateY 와 대조할 수 있다
  // (실측 대조: 패턴 12 의 m02=64.9047 / m12=102.6260 이 .zls 의
  //  translateX=64.9046783 / translateY=102.6260376 과 일치했다).
  const transform2d = decodeTransform2D(p.uuid, p.transform2d);
  if (transform2d) out.transform2d = transform2d;

  // 재질도 평문이다 — 패턴당 숫자 5개와 문자열 2개뿐이라 압축 이득이 없고,
  // 사람이 읽을 수 있어야 씬 파일의 basecolor 와 대조할 수 있다
  // (실측 대조: `W_Bra top & Leggings.zls` 의 노랑
  //  [0.9254902, 0.8117647, 0.4705882] ×16, 민트
  //  [0.7333333, 0.8862745, 0.8156863] ×8 이 워커 출력과 자릿수까지 일치했다).
  const material = decodeMaterial(p.uuid, p.material);
  if (material) out.material = material;

  return out;
}

/**
 * `meshData` 응답과 구독 중 `frame` 이벤트의 mesh 는 **모양이 같다.** 그래서
 * 디코더도 하나다 — 두 경로가 갈라지면 한쪽만 조용히 깨진다 (SDK 와 같은 판단).
 */
export function decodePatterns(mesh: FrameMesh): DecodedPattern[] {
  return mesh.patterns.map(decodePattern);
}

// ── 아바타 (AM-1) ───────────────────────────────────────────
//
// **옷과 정반대의 규약이 하나 있다.** 패턴의 `positions` 는 패턴 로컬이라
// `transform` 을 곱해야 월드가 되지만(ISSUE-011), 아바타의 `positions` 는
// **이미 월드 cm** 다 — 엔진이 `localTransform` 을 정점에 구워서 준다. 그래서
// 아래 타입에는 `transform` 이 아예 없다. 옷의 디코더를 베껴 오면 여기에
// 없는 필드를 찾다가, 없으니 identity 로 메우고 지나가게 된다(그건 우연히
// 맞는다). 진짜 사고는 **그리는 쪽이 `cloth.ts` 를 베껴 변환을 거는 것**이고
// 그러면 몸이 옷에서 떨어져 선다.
//
// 나머지는 패턴과 같은 규약이다: `topology:true` 로 받았을 때만 `indices`·
// `uvs`·`material` 이 실리고, 없는 것은 오류가 아니다.

/** 아바타 파트 하나. three.js 가 그대로 받을 수 있는 형태 */
export interface DecodedAvatarPart {
  /** 엔진의 파트 순서. `name` 은 중복될 수 있으므로 짝의 정본은 이쪽이다 */
  index: number;
  name: string;
  vertices: number;
  triangles: number;
  /** ★ **월드 cm.** 어떤 변환도 곱하지 마라 */
  positions: Float32Array;
  /**
   * `normals:false` 로 요청했을 때만 없다.
   *
   * ⚠️ **topology 가 아니라 positions 와 한 몸이다.** 몸이 휘면 법선도 바뀐다 —
   *    최초 1회만 받아 두면 몸은 움직이는데 음영만 옛 자세로 굳는다.
   */
  normals?: Float32Array;
  /** topology:true 일 때만 */
  indices?: Int32Array;
  /** topology:true 일 때만. 옷의 `uvs` 와 달리 **텍스처 좌표**다(cm 가 아니다) */
  uvs?: Float32Array;
  /** topology:true 일 때만. 없는 것은 오류가 아니다 — 흰색으로 메우지 않는다 */
  material?: AvatarPartMaterial;
}

/** 아바타 한 구 */
export interface DecodedAvatar {
  uuid: string;
  subType: 'zeta' | 'mannequin';
  /** `avatarBody`/`setAvatarMeasurements` 가 대상으로 삼는 아바타인가 */
  current: boolean;
  parts: DecodedAvatarPart[];
  vertices: number;
  triangles: number;
  animation: boolean;
  animationTime: number;
  /** `[현재, 전체]`. 끝났는지는 `isAnimationFinished()` 가 판정한다 */
  frameInfo: [number, number];
  /**
   * 워커가 **인덱스가 가리키는 정점만으로** 다시 잰 월드 AABB (cm).
   *
   * ⚠️ **화면이 `positions` 전체로 다시 재면 안 된다.** 아바타 정점 버퍼에는
   *    어떤 삼각형도 참조하지 않는 쓰레기 정점이 섞여 있어서, 다시 재면 상자가
   *    커지고 카메라를 거기 맞추면 몸이 구석에 박힌다.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * 애니메이션이 끝났는가 — **`cur + 1 >= total`.**
 *
 * ★ 이 판정이 클라이언트에 있는 이유는 워커가 못 하기 때문이다. 엔진의
 *   `IsAnimationFinished()` 는 `const` 인데 내부에서 mutable 플래그를 지우고,
 *   시뮬 실행기가 바로 그 플래그로 아바타 갱신 여부를 정한다 — 워커가 읽으면
 *   시뮬 동작 자체가 바뀐다. 그래서 워커는 `frameInfo` 를 실어 주고 판정은
 *   여기서 한다.
 *
 * `total <= 0`(애니메이션이 없다)이면 **끝난 것으로 본다** — 갱신을 계속
 * 요청할 이유가 없다.
 */
export function isAnimationFinished(a: { frameInfo: readonly [number, number] }): boolean {
  const [cur, total] = a.frameInfo;
  if (total <= 0) return true;
  return cur + 1 >= total;
}

/** 길이 3 의 유한한 숫자 배열. bounds 가 이걸 쓴다 */
function triple(label: string, raw: unknown): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(
      `${label} 은 길이 3 의 배열이어야 합니다 `
      + `(${Array.isArray(raw) ? `길이 ${raw.length}` : typeof raw})`,
    );
  }
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label} 에 유한하지 않은 값이 있습니다`);
    }
  }
  const [x, y, z] = raw as [number, number, number];
  return [x, y, z];
}

/**
 * 아바타 파트의 재질 — `decodeMaterial`(옷)과 **같은 이유로 같은 일**을 한다.
 *
 * 다른 것은 uuid 필드 이름(`assetUuid`)뿐이다. 두 함수를 합치지 않는 이유는
 * 그 이름이 프로토콜에 그렇게 박혀 있어서고, 합치면 한쪽이 바뀔 때 다른 쪽이
 * 조용히 따라 바뀐다.
 *
 * ⚠️ 없는 것(`undefined`)은 오류가 아니다 — `topology:false` 로 받았을 때가
 *    그렇다. 흰색으로 메우면 **진짜 흰 몸**과 구분할 수 없어진다(제타의 몸은
 *    실제로 전부 흰색이다).
 */
function decodeAvatarMaterial(label: string, raw: unknown): AvatarPartMaterial | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== 'object') {
    throw new Error(`${label}: material 이 객체가 아닙니다 (${typeof raw})`);
  }

  const src = raw as Record<string, unknown>;

  const assetUuid = src['assetUuid'];
  if (typeof assetUuid !== 'string') {
    throw new Error(`${label}: material.assetUuid 가 문자열이 아닙니다`);
  }

  const color = triple(`${label}: material.color`, src['color']);

  const profile = src['colorProfile'];
  if (profile !== 'srgb' && profile !== 'linear') {
    // 넘겨짚지 않는다. 틀린 쪽으로 짚으면 색이 어긋나는데 아무도 예외를 못 본다.
    throw new Error(
      `${label}: material.colorProfile 은 'srgb' | 'linear' 여야 합니다 `
      + `(${JSON.stringify(profile)})`,
    );
  }

  const scalar = (key: 'opacity' | 'roughness' | 'metalness'): number => {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label}: material.${key} 가 유한한 숫자가 아닙니다`);
    }
    return v;
  };

  return {
    assetUuid,
    color,
    colorProfile: profile,
    opacity: scalar('opacity'),
    roughness: scalar('roughness'),
    metalness: scalar('metalness'),
  };
}

/**
 * 파트 하나를 푼다. **길이를 검증하는 것이 본체다** (`decodePattern` 과 같다).
 *
 * 어긋난 채 three 로 넘기면 지오메트리가 조용히 뒤틀리거나 마지막 몇 정점이
 * 원점에 붙는다 — 화면만 보고는 디코딩 문제인지 엔진 문제인지 알 수 없다.
 */
export function decodeAvatarPart(avatarUuid: string, p: AvatarPart): DecodedAvatarPart {
  const label = `아바타 ${avatarUuid} 파트 ${p.index}(${p.name})`;

  const positions = p.positions
    ? decodeFloat32(p.positions, `${label} positions`)
    : new Float32Array(0);
  if (p.positions && positions.length !== p.vertices * 3) {
    throw new Error(
      `${label}: positions 길이가 맞지 않습니다 `
      + `(${positions.length} !== vertices ${p.vertices} × 3)`,
    );
  }

  const out: DecodedAvatarPart = {
    index: p.index,
    name: p.name,
    vertices: p.vertices,
    triangles: p.triangles,
    positions,
  };

  if (p.normals) {
    const normals = decodeFloat32(p.normals, `${label} normals`);
    if (normals.length !== p.vertices * 3) {
      throw new Error(
        `${label}: normals 길이가 맞지 않습니다 `
        + `(${normals.length} !== vertices ${p.vertices} × 3)`,
      );
    }
    out.normals = normals;
  }

  if (p.indices) {
    const indices = decodeInt32(p.indices, `${label} indices`);
    if (indices.length !== p.triangles * 3) {
      throw new Error(
        `${label}: indices 길이가 맞지 않습니다 `
        + `(${indices.length} !== triangles ${p.triangles} × 3)`,
      );
    }
    out.indices = indices;
  }

  if (p.uvs) {
    const uvs = decodeFloat32(p.uvs, `${label} uvs`);
    if (uvs.length !== p.vertices * 2) {
      throw new Error(
        `${label}: uvs 길이가 맞지 않습니다 (${uvs.length} !== vertices ${p.vertices} × 2)`,
      );
    }
    out.uvs = uvs;
  }

  const material = decodeAvatarMaterial(label, p.material);
  if (material) out.material = material;

  return out;
}

/** 아바타 하나를 푼다 */
export function decodeAvatar(a: AvatarMesh): DecodedAvatar {
  const parts = a.parts.map((p) => decodeAvatarPart(a.uuid, p));

  const info = a.frameInfo;
  if (!Array.isArray(info) || info.length !== 2
    || typeof info[0] !== 'number' || typeof info[1] !== 'number') {
    throw new Error(`아바타 ${a.uuid}: frameInfo 는 숫자 두 개여야 합니다`);
  }

  const out: DecodedAvatar = {
    uuid: a.uuid,
    subType: a.subType,
    current: a.current,
    parts,
    vertices: a.vertices,
    triangles: a.triangles,
    animation: a.animation,
    animationTime: a.animationTime,
    frameInfo: [info[0], info[1]],
  };

  // 없을 수 있다 — 정점이 하나도 없는 아바타가 그렇다. 0 으로 메우지 않는다
  // (원점 크기 0 인 상자에 카메라를 맞추면 화면이 통째로 이상해진다).
  if (a.bounds) {
    out.bounds = {
      min: triple(`아바타 ${a.uuid}: bounds.min`, a.bounds.min),
      max: triple(`아바타 ${a.uuid}: bounds.max`, a.bounds.max),
    };
  }

  return out;
}

/**
 * `avatarMesh` 응답을 통째로 푼다.
 *
 * `joinInSimulation` 이 꺼진 아바타는 애초에 오지 않고, **액세서리(머리카락)도
 * 안 온다** — 알파 컷아웃 텍스처를 실을 통로가 아직 없어서다. 대머리로 보이는
 * 것이 정상이다.
 */
export function decodeAvatars(res: AvatarMeshResult): DecodedAvatar[] {
  return res.avatars.map(decodeAvatar);
}

/** 진단용 합계. 프레임당 대역폭을 눈으로 확인할 때 쓴다 */
export function meshStats(mesh: FrameMesh): {
  patterns: number;
  vertices: number;
  triangles: number;
  base64Bytes: number;
} {
  let vertices = 0;
  let triangles = 0;
  let base64Bytes = 0;
  for (const p of mesh.patterns) {
    vertices += p.vertices;
    triangles += p.triangles;
    base64Bytes += (p.positions?.length ?? 0) + (p.indices?.length ?? 0) + (p.uvs?.length ?? 0);
  }
  return { patterns: mesh.patterns.length, vertices, triangles, base64Bytes };
}
