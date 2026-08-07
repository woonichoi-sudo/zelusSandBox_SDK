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

import type { FrameMesh, PatternData } from './types.ts';

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
  vertices: number;
  triangles: number;
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

  return out;
}

/**
 * `meshData` 응답과 구독 중 `frame` 이벤트의 mesh 는 **모양이 같다.** 그래서
 * 디코더도 하나다 — 두 경로가 갈라지면 한쪽만 조용히 깨진다 (SDK 와 같은 판단).
 */
export function decodePatterns(mesh: FrameMesh): DecodedPattern[] {
  return mesh.patterns.map(decodePattern);
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
