/**
 * 3D 뷰의 공개 표면. **여기만 import 한다** — `protocol/index.ts` 와 같은 규약이다.
 *
 * #13(프레임 스트리밍)이 얹힐 자리는 `Viewer3D.cloth.updatePositions()` 하나다.
 * frame 이벤트의 mesh 를 `decodePatterns()` 로 푼 뒤 그대로 넘기면 된다 —
 * 지오메트리는 다시 만들지 않는다. 디코딩을 이벤트 핸들러에서 하면 안 되고
 * (40/s × 47.8KB) 마지막 프레임만 들고 있다가 rAF 에서 푸는 것이 옳다.
 */

export { ClothObject, type PatternMesh } from './cloth.ts';
export { showScene, type ShownScene } from './loader.ts';
export { Viewer3D, type Viewer3DOptions } from './viewer.ts';
