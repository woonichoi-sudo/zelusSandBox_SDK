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
  SHORTCUT_HINT,
  type KeyLike,
  type ShortcutAction,
  type TargetLike,
} from './shortcuts.ts';

export {
  AvatarBodyPanel,
  type AvatarBodyView,
  type AvatarField,
  type AvatarGroup,
  type AvatarMeasureRow,
  type AvatarPhase,
} from './avatarBody.ts';

export {
  SurfaceSizePanel,
  validateSize,
  type SurfacePhase,
  type SurfaceRow,
  type SurfaceSizeView,
} from './surfaceSize.ts';
