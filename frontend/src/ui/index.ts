/**
 * DOM 위젯 계층의 공개 표면. **여기만 import 한다** —
 * `protocol/index.ts` · `panels/index.ts` · `viewer3d/index.ts` 와 같은 규약이다.
 *
 *   import { ParamsPanel } from './ui/index.ts';
 *
 * 이 디렉토리의 규칙은 `panels/` 의 정확한 반대다: **DOM 만 만진다.** 판단은
 * 한 줄도 두지 않는다 — 어느 필드가 비활성인지, 값이 유효한지, 무엇을 보낼지는
 * 전부 `panels/` 가 이미 답하고 여기서는 그 답을 그리기만 한다. 그래서 이
 * 디렉토리에는 Node 테스트가 붙지 않고, 붙을 필요도 없다(판단이 없으므로
 * 검증할 규칙이 없다). 반대로 여기에 판단이 새면 그만큼 자동 테스트가 사라진다.
 */

export {
  ParamsPanel,
  type ParamsPanelHooks,
  type ParamsPanelOptions,
  type ParamsPhase,
  type ParamsPort,
} from './paramsPanel.ts';

export {
  AvatarPanel,
  type AvatarPanelOptions,
} from './avatarPanel.ts';

/**
 * 실시간 3D 뷰의 아바타 표시 스위치 (AM-1). 켜짐/꺼짐의 정본은 `AvatarObject`
 * 이고 이 위젯은 `AvatarViewController` 를 통해 읽어서 그리기만 한다 —
 * `Design2DOptions` 와 같은 규약이다.
 */
export {
  AvatarViewSwitch,
  type AvatarViewSwitchOptions,
  type AvatarViewSwitchPort,
} from './avatarViewSwitch.ts';

/**
 * 실시간 3D 뷰의 텍스처 표시 스위치 (materials-c). 아바타 스위치 바로 옆이고,
 * 켜짐/꺼짐의 정본은 `panels/textures.ts` 의 `TextureOptions` 다.
 */
export {
  TextureSwitch,
  type TextureSwitchOptions,
  type TextureSwitchPort,
} from './textureSwitch.ts';

/** 치수 25개를 cm 로 편집한다 (W-2). 같은 탭의 아래 칸이다 */
export {
  AvatarMeasurePanel,
  type AvatarMeasurePanelOptions,
} from './avatarMeasurePanel.ts';

export {
  SurfacePanel,
  type SurfacePanelOptions,
} from './surfacePanel.ts';

export {
  SideTabs,
  type SideTabsOptions,
} from './sideTabs.ts';

export {
  SideDrawer,
  type SideDrawerOptions,
} from './sideDrawer.ts';

/**
 * 재단 도면의 표시 스위치 (D2-e). 켜짐/꺼짐의 정본은 `Design2DLayer` 이고
 * 이 위젯은 읽어서 그리기만 한다 — 씬을 다시 로드해도 안 갈라지는 이유다.
 */
export {
  Design2DOptions,
  type Design2DOptionsOptions,
  type Design2DOptionsView,
} from './design2dOptions.ts';
