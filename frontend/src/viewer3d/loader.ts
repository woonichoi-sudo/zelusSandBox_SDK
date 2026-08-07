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
 */

import { decodePatterns, type GatewayClient } from '../protocol/index.ts';
import type { Viewer3D } from './viewer.ts';

export interface ShownScene {
  scene: string;
  patterns: number;
  vertices: number;
  triangles: number;
  /** 로드부터 화면 반영까지 걸린 시간(ms). 103MB 씬이 ~830ms 였다 */
  elapsedMs: number;
}

/**
 * 씬을 로드하고 정지 드레이프를 화면에 세운다.
 *
 * ⚠️ `sceneId` 는 **경로가 아니라 씬 id** 다 (`POST /api/scenes` 가 돌려준
 *    32자리 hex). 게이트웨이는 클라이언트가 준 경로를 절대 쓰지 않는다.
 */
export async function showScene(
  client: GatewayClient,
  viewer: Viewer3D,
  sceneId: string,
  opts: { frameCamera?: boolean } = {},
): Promise<ShownScene> {
  const t0 = performance.now();

  const loaded = await client.load(sceneId);
  if (!loaded.loaded) throw new Error(`씬을 로드하지 못했습니다 (${sceneId})`);

  // topology:true — 이 한 번이 indices·uvs 를 받는 유일한 기회다.
  const mesh = await client.meshData(true);
  const patterns = decodePatterns(mesh);
  if (patterns.length === 0) {
    throw new Error('씬은 로드됐지만 패턴이 하나도 없습니다');
  }

  viewer.cloth.setTopology(patterns);
  if (opts.frameCamera !== false) viewer.frameCamera();

  return {
    scene: loaded.scene,
    patterns: viewer.cloth.patternCount,
    vertices: viewer.cloth.vertexCount,
    triangles: viewer.cloth.triangleCount,
    elapsedMs: Math.round(performance.now() - t0),
  };
}
