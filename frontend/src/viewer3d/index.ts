/**
 * 3D 뷰의 공개 표면. **여기만 import 한다** — `protocol/index.ts` 와 같은 규약이다.
 *
 * 프레임 스트리밍(#13)의 배선은 두 줄이다:
 *
 *   client.on('frame', (ev) => stream.push(ev));          // raw 로 칸에 얹기만
 *   viewer.onBeforeRender(() => stream.drain(viewer.cloth)); // rAF 에서 풀기
 *
 * 디코딩은 `drain()` 안에서만 일어난다 — 이벤트 핸들러에서 풀면(40/s × 47.8KB)
 * 어차피 덮어써져 버려질 프레임을 푸느라 이벤트 루프를 태운다. 지오메트리는
 * 다시 만들지 않는다(`setTopology()` 는 로드할 때 한 번뿐).
 *
 * `FrameStream` 과 `ClothObject` 는 DOM·WebGL 을 만지지 않으므로 Node 스모크가
 * 그대로 돌린다. `Viewer3D` 만 브라우저 전용이다.
 */

export { ClothObject, type PatternMesh } from './cloth.ts';
export {
  FrameStream,
  type DrainOutcome,
  type FrameStreamOptions,
  type FrameStreamStats,
  type PositionSink,
  type TopologyMismatch,
} from './frameStream.ts';
export { showScene, type ShownScene } from './loader.ts';
export { Viewer3D, type Viewer3DOptions } from './viewer.ts';
