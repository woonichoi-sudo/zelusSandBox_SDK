/**
 * 패널(화면 조작 계층)의 공개 표면. **여기만 import 한다** —
 * `protocol/index.ts` · `viewer3d/index.ts` 와 같은 규약이다.
 *
 *   import { PlaybackController, shortcutFor } from './panels/index.ts';
 *
 * 이 디렉토리의 규칙은 하나다: **DOM 도 three 도 만지지 않는다.** 재생 상태
 * 기계(#14)가 여기 있는 이유가 그것이다 — `main.ts` 에 두면 Node 스모크가
 * import 조차 못 하고, 그러면 ISSUE-009 같은 상태 어긋남을 사람이 브라우저에서
 * 눈으로 찾는 수밖에 없다. 화면에 닿는 배선(버튼·키 이벤트·글자)만 `main.ts`
 * 에 남긴다.
 *
 * 배선은 세 줄이다:
 *
 *   const playback = new PlaybackController({ port: client, hooks: { … } });
 *   client.on('frame', (ev) => playback.noteFrame(ev.frame));   // 숫자만
 *   ui.play.addEventListener('click', () => void playback.toggle());
 */

export {
  PlaybackController,
  type PlaybackAction,
  type PlaybackHooks,
  type PlaybackOptions,
  type PlaybackPort,
  type PlaybackState,
  type PlaybackStats,
  type PlaybackView,
} from './playback.ts';

export {
  buildSetParamsPayload,
  changedParams,
  coerceParamValue,
  disabledParams,
  fallbackParamValues,
  paramDisabledReason,
  paramField,
  paramGroups,
  PARAM_BY_KEY,
  PARAM_FIELDS,
  PARAM_GROUP_LABELS,
  PARAM_GROUP_ORDER,
  readParamValues,
  type ParamAdjustment,
  type ParamCoercion,
  type ParamContext,
  type ParamDisabled,
  type ParamDisabledCause,
  type ParamEffect,
  type ParamEnumOption,
  type ParamField,
  type ParamGroup,
  type ParamKey,
  type ParamKind,
  type ParamPayload,
  type ParamRangeSource,
  type ParamValue,
  type ParamValues,
} from './params.ts';

export {
  isTypingTarget,
  shortcutFor,
  shortcutHint,
  SHORTCUT_HINT,
  viewHint,
  type KeyLike,
  type ShortcutAction,
  type TargetLike,
} from './shortcuts.ts';

export {
  AvatarBodyPanel,
  type AvatarBodyView,
  type AvatarField,
  type AvatarGroup,
  type AvatarPhase,
} from './avatarBody.ts';

/**
 * 치수(cm)로 몸을 만든다 (W-2). **`avatarBody.ts` 와 짝이되 성격이 다르다** —
 * 이쪽은 왕복이 10초 넘게 걸리는 상태 기계이고, **치수 되읽기의 정본**
 * (`measured`)을 가진 유일한 자리다(원본 머리말의 표 참고).
 */
export {
  AvatarMeasureController,
  estimateSeconds,
  stepsFor,
  validateMeasure,
  DEFAULT_SIM_ITERATIONS,
  DEFAULT_STEP_CM,
  REQUEST_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  type AvatarMeasureHooks,
  type AvatarMeasureOptions,
  type AvatarMeasureOutcome,
  type AvatarMeasurePhase,
  type AvatarMeasurePort,
  type AvatarMeasureRow,
  type AvatarMeasureStats,
  type AvatarMeasureView,
} from './avatarMeasure.ts';

/**
 * 실시간 뷰의 몸을 **언제 다시 받을지** (AM-1). op 하나가 448KB~1.9MB 이고
 * 워커의 시뮬을 24~29ms 멈추므로, 타이밍 자체가 이 모듈의 본체다.
 * 재생 중에는 `POLL_MS` 간격으로 받고 `frameInfo` 가 끝을 알리면 멈춘다.
 */
export {
  AvatarViewController,
  MAX_TOPOLOGY_RETRY,
  POLL_MS,
  type AvatarCause,
  type AvatarRefreshResult,
  type AvatarViewHooks,
  type AvatarViewOptions,
  type AvatarViewPhase,
  type AvatarViewPort,
  type AvatarViewSink,
  type AvatarViewState,
  type AvatarViewStats,
} from './avatarView.ts';

/**
 * 저장된 드레이프 적용 (W-1). **`reset` 과 같은 자리의 op 이다** — 성공하면
 * 워커가 프레임 카운터를 -1 로 되돌린다(원본 머리말 참고).
 */
export {
  DrapingPanel,
  type DrapingHooks,
  type DrapingOptions,
  type DrapingOutcome,
  type DrapingPhase,
  type DrapingPort,
  type DrapingStats,
  type DrapingView,
} from './draping.ts';

/**
 * 실시간 뷰의 텍스처 (materials-c). ★ **옷의 UV 는 cm 라 반복 배수를 물리
 * 크기에서 뽑아야 한다** — 아바타(0~1 UV)와 식이 다르다(원본 머리말).
 */
export {
  addStats,
  EMPTY_TEXTURE_STATS,
  planFor,
  tintColorProfile,
  repeatFor,
  resolveSlots,
  statsOf,
  TextureOptions,
  type TextureOptionsHooks,
  type TextureOptionsState,
  type TexturePlan,
  type TextureSlotUrls,
  type TextureStats,
  type TextureUvKind,
} from './textures.ts';

export {
  SurfaceSizePanel,
  validateSize,
  type SurfacePhase,
  type SurfaceRow,
  type SurfaceSizeView,
} from './surfaceSize.ts';

/**
 * 직물 갈아입히기 (UI #50). 옷 사이즈와 **같은 행 위에 얹힌다** —
 * 조각을 식별할 수 있는 자리가 거기뿐이라 콤보를 그 행에 붙인다.
 */
export {
  FabricsPanel,
  type FabricOption,
  type FabricPhase,
  type FabricRow,
  type FabricsView,
} from './fabrics.ts';

export {
  DEFAULT_SIDE_TAB,
  isSideTabId,
  SIDE_TABS,
  SideTabsPanel,
  type SideTabDef,
  type SideTabId,
  type SideTabItem,
  type SideTabsView,
} from './sideTabs.ts';

export {
  NARROW_MAX_PX,
  narrowQuery,
  SideDrawerPanel,
  type SideDrawerMode,
  type SideDrawerView,
} from './sideDrawer.ts';

/**
 * 화면 글자의 다국어 (I-1). 사전과 언어 결정만 있고 DOM 은 모른다 —
 * **이 단위에서 자동으로 확인할 수 있는 유일한 자리다**(원본 머리말 참고).
 */
export {
  DEFAULT_LANG,
  getLang,
  initLang,
  LANG_LABELS,
  LANG_STORAGE_KEY,
  LANGS,
  MESSAGES,
  normalizeLang,
  onLangChange,
  placeholdersIn,
  readStoredLang,
  setLang,
  storeLang,
  t,
  translate,
  type Dict,
  type Lang,
  type LangStore,
  type MessageVars,
} from './i18n.ts';
