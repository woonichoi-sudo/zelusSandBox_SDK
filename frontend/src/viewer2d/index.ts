/**
 * 2D 펼침 뷰의 공개 표면 (#15-b). **여기만 import 한다** — 다른 층과 같은 규약이다.
 *
 * ── 이 단위는 "세 번째 뷰" 가 아니다 ────────────────────────
 * `Viewer3D` 의 `ViewMode`(실시간 ↔ 스냅샷)에 항목이 늘지 **않았다.** 2D 는
 * 같은 씬·같은 메시의 **다른 자세**라, 켜고 끄는 것이 아니라 `t ∈ [0,1]` 로
 * 이어져 있다. 그래서 배타 규칙(`viewer.setMode`)은 손대지 않았고, UI 하네스
 * §7 이 검사하는 불변식도 그대로다.
 *
 * ── 배선은 네 줄이다 ────────────────────────────────────────
 *
 *   unfold.build(viewer.cloth.patterns);        // 토폴로지가 선 직후 한 번
 *   control.setStats(unfold.stats);
 *
 *   // rAF: 프레임이 붙었으면 원본을 갱신하고, 그 위에 t 를 얹는다
 *   if (out.status === 'applied') unfold.sync(viewer.cloth.patterns);
 *   unfold.apply(viewer.cloth.patterns, control.effectiveT);
 *
 * ⚠️ `sync` 는 **정점 버퍼에 3D 가 들어 있을 때만** 불러야 한다. 순서가
 *    어긋나면 옷이 프레임마다 도면 쪽으로 눌어붙는다 (`unfold.ts` 의 경고).
 */

export {
  UnfoldController,
  type UnfoldView,
} from './control.ts';
export {
  apply2d,
  Unfolder,
  type DraftingBounds,
  type UnfoldStats,
} from './unfold.ts';
