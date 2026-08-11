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
 * `FrameStream` · `ClothObject` · `SnapshotLoader` 는 DOM 을 만지지 않으므로
 * Node 스모크가 그대로 돌린다. 브라우저 전용은 `Viewer3D` 와, glTF 파싱이
 * `ImageLoader` 를 타는 `SnapshotObject`/`parseSnapshot` 뿐이다.
 *
 * ── 스냅샷(#: 아바타 + 진짜 색)의 배선도 세 줄이다 ──────────
 *
 *   const snap = new SnapshotLoader({
 *     source: { requestExport: (f) => client.exportScene(f), download: downloadExport },
 *     target: viewer.snapshot,             // SnapshotTarget 을 이미 구현하고 있다
 *   });
 *   await snap.load();                     // export → GET → parse → install
 *   viewer.setMode('snapshot');            // 실시간 옷과 **동시에 보이지 않는다**
 */

/**
 * 실시간 뷰의 몸 (AM-1). ★ 정점이 **월드 cm** 다 — `cloth.ts` 와 정반대로
 * 변환을 걸지 않는다. 원본 머리말 참고.
 */
export { AvatarObject, type AvatarPartMesh } from './avatar.ts';
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
/**
 * 텍스처를 받아 재질에 거는 자리 (materials-c). 판단은 `panels/textures.ts` 가
 * 하고 여기는 three 고유의 것(캐시·색공간·늦게 오는 로드)만 다룬다.
 */
export { applyPlan, TextureCache } from './textures.ts';
export {
  SnapshotLoader,
  SnapshotStaleError,
  type SnapshotLoaderOptions,
  type SnapshotLoaderStats,
  type SnapshotPhase,
  type SnapshotProgress,
  type SnapshotResult,
  type SnapshotSource,
  type SnapshotStats,
  type SnapshotTarget,
} from './snapshot.ts';
export {
  parseSnapshot,
  SnapshotObject,
  SNAPSHOT_SCALE,
  type ParsedSnapshot,
} from './snapshotView.ts';
export { Viewer3D, type ViewMode, type Viewer3DOptions } from './viewer.ts';
