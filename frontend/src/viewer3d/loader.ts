/**
 * 씬 id 하나 → 화면에 뜬 옷. 프로토콜과 렌더러를 잇는 **유일한 지점**이다.
 *
 * 이 함수가 짧아 보이지만 지키는 것이 셋 있고, 셋 다 틀리기 쉽다:
 *
 * ① **`load` 만으로 정지 드레이프가 나온다.** `start` 가 필요 없다. 실측(#7)에서
 *    로드 직후 `meshInfo` 가 정점 3,022 / 삼각형 5,472 를 돌려준다 — `.zls` 에
 *    드레이프된 결과가 들어 있기 때문이다. 시뮬을 돌려야 메시가 나온다고 믿으면
 *    첫 화면을 띄우기 위해 불필요하게 솔버를 돌리게 된다.
 * ② **`topology: true` 는 여기서만.** `indices`·`uvs` 는 프레임 간 고정이라
 *    frame 이벤트에 절대 오지 않는다. 여기서 못 받으면 영영 못 받는다.
 * ③ **재연결하면 새 워커다.** 씬은 로드돼 있지 않다. 그래서 이 함수는 멱등하게
 *    쓸 수 있어야 하고(`setTopology` 가 기존 지오메트리를 해제한다), 호출자는
 *    `open` 이벤트의 `reconnected` 를 보고 그냥 다시 부르면 된다.
 *
 * 그래서 내보내는 것이 셋이고, **왕복과 화면 반영이 갈라져 있다** (L-3d):
 *   - `fetchTopology`   — 왕복만. `meshData(true)` → 디코딩. 화면을 안 만진다.
 *   - `installTopology` — 화면만. 받아 둔 것을 세운다. 왕복이 없어 **동기다**.
 *   - `showScene`       — 씬을 처음 열 때. `load` + 위 둘.
 *
 * ★ **둘로 가른 이유는 그 사이에 검사가 들어가야 하기 때문이다.** 재구성이
 *   겹치면(옷 사이즈를 연속으로 적용, 그 와중에 프레임까지 어긋남) 먼저 시작한
 *   왕복이 나중에 도착할 수 있고, 그러면 **옛 지오메트리가 마지막에 선다.**
 *   호출자가 "내 것이 아직 최신인가" 를 물을 자리가 바로 이 틈이다
 *   (`main.ts` 의 `restageTopology`). 한 함수로 묶어 두면 `setTopology` 가
 *   이미 끝난 뒤에야 물을 수 있어서 늦는다.
 */

import {
  decodeMeshTextures, decodePatterns,
  type DecodedPattern, type GatewayClient, type TextureAsset,
} from '../protocol/index.ts';
import type { ClothObject } from './cloth.ts';
import type { Viewer3D } from './viewer.ts';

/** 토폴로지 한 벌이 화면에 선 결과. `showScene` 은 여기에 씬 정보를 얹는다 */
export interface StagedTopology {
  patterns: number;
  vertices: number;
  triangles: number;
  /**
   * 이 씬의 직물 텍스처 표 (materials-c). 호출자가 통계를 화면에 쓴다.
   *
   * 아바타 것은 여기 없다 — `avatarMesh` 는 별개의 왕복이고 `AvatarViewController`
   * 가 그쪽 표를 들고 온다.
   */
  textures: (TextureAsset | null)[];
}

export interface ShownScene extends StagedTopology {
  scene: string;
  /** 로드부터 화면 반영까지 걸린 시간(ms). 103MB 씬이 ~830ms 였다 */
  elapsedMs: number;
}

export interface StageOptions {
  /**
   * 화각을 옷에 다시 맞출 것인가. **기본은 안 맞춘다.**
   *
   * 이 갈래는 이미 서 있는 씬의 토폴로지만 갈아 끼우는 자리라, 사용자가
   * 조각을 보려고 잡아 둔 시점이 살아 있다. 크기를 한 칸 바꿀 때마다 시점을
   * 빼앗으면 옷을 못 본다. 화각을 새로 잡는 것은 씬을 처음 여는 쪽
   * (`showScene`) 의 판단이고, 그래서 기본값이 반대다.
   */
  frameCamera?: boolean;
  /**
   * 같은 토폴로지를 함께 세울 두 번째 옷 (L-2a — 가운데 칸의 도면).
   *
   * ★ **디코딩 결과를 나눠 쓰는 것이 요점이다.** 가운데 칸이 자기 몫으로
   *   `meshData(true)` 를 한 번 더 부르면 사용자 씬 기준 왕복이 하나 더
   *   늘고(103~138MB 씬), 무엇보다 **두 칸이 서로 다른 순간의 토폴로지를
   *   들 수 있다.** 같은 배열에서 두 벌을 세우면 그 갈라짐이 원리적으로
   *   생기지 않는다.
   *
   * 지오메트리를 공유하지 않고 `setTopology` 를 두 번 부르는 이유는
   * `Unfolder.apply()` 가 정점 버퍼를 덮어쓰기 때문이다 — 왼쪽이 3D 를,
   * 가운데가 도면을 동시에 보여주려면 버퍼가 둘이어야 한다
   * (`viewer2d/viewer2d.ts` 의 `cloth` 주석 참고).
   */
  mirror?: ClothObject;
}

/** 받아서 디코딩만 해 둔 토폴로지. **아직 화면에 없다** */
export interface DecodedTopology {
  patterns: DecodedPattern[];
  textures: (TextureAsset | null)[];
}

/**
 * 토폴로지 한 벌을 받아 디코딩한다. **화면을 만지지 않는다** — 그래서 이
 * 함수가 도는 중에 무엇이 겹쳐도 화면은 안전하다.
 *
 * ★ **씬을 열지 않는다.** 이미 워커에 로드돼 있는 씬을 고쳐 놓고 화면만
 *   맞추려는 자리(옷 사이즈 [적용], 프레임 토폴로지 어긋남)가 이걸 쓴다.
 *   그 자리에서 `showScene` 을 부르면 `load` 가 `.zls` 를 디스크에서 다시
 *   열어 **워커의 편집을 통째로 버린다** — 실측으로 재로드 3.2초 뒤 방금
 *   바꾼 크기가 원래 값으로 돌아왔다(L-3d 의 결함 B).
 */
export async function fetchTopology(client: GatewayClient): Promise<DecodedTopology> {
  // topology:true — 이 한 번이 indices·uvs 를 받는 유일한 기회다.
  const mesh = await client.meshData(true);
  const patterns = decodePatterns(mesh);
  if (patterns.length === 0) {
    throw new Error('씬은 로드됐지만 패턴이 하나도 없습니다');
  }
  // 텍스처 표는 `topology:true` 응답에만 온다 — 재질이 거기에만 실리기 때문이다.
  // 즉 `patterns` 와 정확히 같은 수명이고, 그래서 같은 자리에서 함께 든다.
  return { patterns, textures: decodeMeshTextures(mesh) };
}

/**
 * 받아 둔 토폴로지를 화면에 세운다. **왕복이 없어 동기다** — 이게 요점이다.
 *
 * 호출자가 "내 응답이 아직 최신인가" 를 바로 앞에서 확인하고 부르면, 확인과
 * 반영 사이에 다른 것이 끼어들 틈이 원리적으로 없다.
 */
export function installTopology(
  viewer: Viewer3D,
  decoded: DecodedTopology,
  opts: StageOptions = {},
): StagedTopology {
  viewer.cloth.setTopology(decoded.patterns, decoded.textures);
  // 가운데 칸의 옷. 카메라는 여기서 안 맞춘다 — 도면 범위는 `Unfolder.build()`
  // 가 계산하고, 그건 호출자가 `setTopology` 뒤에 부른다. 순서상 여기서는
  // 아직 범위를 모른다.
  //
  // ★ **표를 넘기지 않는다.** 가운데 칸은 재단 도면이라 로드 직후 `paperize()`
  //   가 면을 흰 종이로 덮는다 — 무늬를 입혔다 곧바로 지우는 셈이고, 그동안
  //   9.5MB 짜리 텍스처가 GPU 에 한 벌 더 올라간다.
  opts.mirror?.setTopology(decoded.patterns);
  if (opts.frameCamera === true) viewer.frameCamera();

  return {
    patterns: viewer.cloth.patternCount,
    vertices: viewer.cloth.vertexCount,
    triangles: viewer.cloth.triangleCount,
    textures: decoded.textures,
  };
}

/**
 * 씬을 로드하고 정지 드레이프를 화면에 세운다.
 *
 * ⚠️ `sceneId` 는 **경로가 아니라 씬 id** 다 (`POST /api/scenes` 가 돌려준
 *    32자리 hex). 게이트웨이는 클라이언트가 준 경로를 절대 쓰지 않는다.
 *
 * ⚠️ **이미 로드된 씬을 고친 뒤 화면만 맞추려는 자리에서 부르지 마라.**
 *    `load` 가 `.zls` 를 디스크에서 다시 열어 워커의 편집을 버린다. 그 자리는
 *    위 `fetchTopology` + `installTopology` 다.
 */
export async function showScene(
  client: GatewayClient,
  viewer: Viewer3D,
  sceneId: string,
  opts: StageOptions = {},
): Promise<ShownScene> {
  const t0 = performance.now();

  const loaded = await client.load(sceneId);
  if (!loaded.loaded) throw new Error(`씬을 로드하지 못했습니다 (${sceneId})`);

  // 씬을 처음 여는 자리라 화각의 기본값이 반대다 — 여기서 뒤집어 넘긴다.
  // 여기에는 순번 검사가 없다. `show()` 가 `busy` 로 자기 자신의 겹침을
  // 막고 있고, 이쪽은 그 하나뿐인 진입점이기 때문이다.
  const staged = installTopology(viewer, await fetchTopology(client), {
    ...opts,
    frameCamera: opts.frameCamera !== false,
  });

  return {
    ...staged,
    scene: loaded.scene,
    elapsedMs: Math.round(performance.now() - t0),
  };
}
