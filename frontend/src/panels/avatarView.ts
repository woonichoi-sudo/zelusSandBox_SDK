/**
 * 실시간 뷰의 몸을 **언제 다시 받을지** 정한다 (AM-1) — DOM 도 three 도 만지지
 * 않는다.
 *
 * `draping.ts`·`avatarMeasure.ts` 와 같은 계열이다: 왕복을 스스로 하고, 그
 * 결과에 따라 화면이 무엇을 말해야 하는지까지 정한다. 그리는 것은
 * `ui/avatarViewSwitch.ts`, 배선은 `main.ts` 다.
 *
 * ── 이 모듈이 존재하는 이유 = 타이밍이 전부라서다 ───────────
 *
 * 아바타 한 벌은 최소본 **448KB**(topology+normals 는 1,947KB)이고, 이 op 은
 * 워커의 시뮬 스레드를 `ztGlobalMutex` 로 **24~29ms 멈춘다.** 즉 "필요할 때만
 * 받는다" 가 기능의 절반이고, 그 판단이 `main.ts` 의 불리언으로 흩어지면
 * 자동 테스트가 원리적으로 못 붙는다(ISSUE-009 가 정확히 그 반대편에서 났다).
 *
 * ── 언제 받는가 ─────────────────────────────────────────────
 *
 * | 계기            | 무엇이 바뀌나                        | topology |
 * |-----------------|--------------------------------------|----------|
 * | 씬 로드         | 전부                                 | **true** |
 * | 체형/치수 변경  | 정점·법선 (실측: 28,564개 100% 이동) | false    |
 * | 드레이프        | 포즈 (실측: 팔이 내려와 x ±61.3→±29.9)| false   |
 * | 리셋            | 애니메이션이 처음으로 되돌아간다     | false    |
 * | 애니메이션 중   | 포즈가 계속 움직인다                 | false    |
 * | 씬 내림         | 치운다                               | —        |
 *
 * ★ **`topology:false` 로 받았는데 모양이 달라졌으면 자동으로 다시 받는다.**
 *   AM-1 의 실측("uuid·파트·정점 수는 그대로였다")은 씬 하나의 관측이라
 *   불변식이 아니다. 서명이 어긋난 채로 `updatePositions` 를 밀어 넣으면
 *   몸이 조용히 뒤틀리므로, 어긋남을 발견하면 그 자리에서 `topology:true` 로
 *   한 번 더 받는다. 무한 왕복을 막는 상한이 `MAX_TOPOLOGY_RETRY` 다
 *   (`main.ts` 의 `MAX_TOPOLOGY_RECOVERIES` 와 같은 계열의 장치다).
 *
 * ── ★ 애니메이션 중 갱신 — 여기가 이 모듈의 유일한 재량이다 ─
 *
 * 시뮬을 재생하면 아바타가 **움직이다가 끝나면 정지한다.** 매 프레임 받는 것은
 * 불가능하다(448KB × 40/s + 시뮬 스톨). 안 받으면 옷은 새 포즈인데 몸은 첫
 * 포즈에 굳어서, **옷이 몸을 뚫고 지나가는 것처럼** 보인다 — 좌표계가 틀렸을
 * 때와 화면상 구분이 안 되는 실패다(이 단위가 없애려던 바로 그것).
 *
 * 그래서 **낮은 빈도로 받되, 끝나면 멈춘다**:
 *   ① 재생 중일 때만, `POLL_MS` 간격으로 (2/s → 시뮬 스톨 약 5%)
 *   ② `frameInfo` 로 `cur + 1 >= total` 이면 **더 안 받는다.** 애니메이션이
 *      끝난 뒤로는 몸이 안 움직이므로 계속 받는 것은 순수한 낭비다.
 *      ⚠️ 엔진의 `IsAnimationFinished()` 를 워커가 못 부른다(읽는 순간 시뮬
 *         플래그를 지운다). 그래서 판정이 여기 있다.
 *   ③ `animation:false` 인 아바타(마네킹)는 처음부터 안 받는다
 *   ④ 재생이 **멈추는 순간 한 번** 더 받는다. 마지막 포즈를 폴링 간격 안에서
 *      놓칠 수 있고, 정지 화면이 어긋나 있으면 그게 사용자가 오래 보는 그림이다
 *   ⑤ 사용자가 몸을 꺼 두면 한 번도 안 받는다
 */

import { t } from './i18n.ts';
import {
  decodeAvatars,
  decodeAvatarTextures,
  isAnimationFinished,
  type AvatarMeshResult,
  type DecodedAvatar,
  type TextureAsset,
} from '../protocol/index.ts';

/**
 * 재생 중 갱신 간격(ms).
 *
 * 2/s 다. 근거: 응답 448KB / 왕복 24~29ms 이므로 시뮬 스톨이 약 5%, 대역폭이
 * 약 0.9MB/s 다(구독 중 옷이 이미 1.9MB/s 를 쓴다). 1/s 로 낮추면 40fps 시뮬
 * 에서 몸이 40프레임씩 건너뛰어 눈에 띄게 끊기고, 4/s 로 올리면 스톨이 10% 를
 * 넘는다. **애니메이션이 끝나면 멈추므로 상시 비용이 아니다.**
 */
export const POLL_MS = 500;

/** 서명이 어긋났을 때 `topology:true` 로 다시 받는 횟수 상한 */
export const MAX_TOPOLOGY_RETRY = 3;

/** 무엇 때문에 다시 받는가. 로그에 그대로 나간다 */
export type AvatarCause =
  | '로드'
  | '체형'
  | '치수'
  | '드레이프'
  | '리셋'
  | '애니메이션'
  | '정지'
  | '표시';

/** 씬 로드는 무조건 토폴로지부터 받는다 — 인덱스·UV·재질이 여기서만 온다 */
const TOPOLOGY_CAUSES: ReadonlySet<AvatarCause> = new Set<AvatarCause>(['로드']);

/**
 * 워커에 op 을 보내는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * `PlaybackPort`·`DrapingPort` 와 같은 판단이라 어댑터가 필요 없다.
 */
export interface AvatarViewPort {
  readonly connected: boolean;
  avatarMesh(topology?: boolean, normals?: boolean): Promise<AvatarMeshResult>;
}

/**
 * 몸을 세우는 쪽. **`viewer3d/avatar.ts` 의 `AvatarObject` 가 이미 만족한다.**
 *
 * 구조적 타입으로 두는 이유는 이 파일이 three 를 import 하지 않기 위해서다 —
 * import 하는 순간 Node 테스트가 이 모듈을 못 연다.
 */
export interface AvatarViewSink {
  /** 사용자가 켜 둔 상태의 **정본**. 이 컨트롤러는 사본을 두지 않는다 */
  readonly visible: boolean;
  setVisible(on: boolean): void;
  /**
   * `textures` 는 **선택 인자다** (materials-c). 표를 받은 구현은 그걸 걸고,
   * 안 받는 구현(옛 가짜)은 그냥 무시한다 — 인자를 필수로 만들면 이 인터페이스를
   * 만족하던 테스트용 가짜가 전부 깨진다.
   */
  setTopology(
    avatars: readonly DecodedAvatar[],
    textures?: readonly (TextureAsset | null)[],
  ): void;
  /** 짝이나 정점 수가 어긋나면 `false`. 그때 토폴로지를 다시 받는다 */
  updatePositions(avatars: readonly DecodedAvatar[]): boolean;
  clear(): void;
}

export type AvatarViewPhase =
  /** 소켓이 없거나 워커에 씬이 없다 */
  | 'noScene'
  /** 왕복 중 */
  | 'loading'
  /** 몸이 서 있다 */
  | 'ready'
  /** 씬에 (시뮬에 참여하는) 아바타가 없다. **오류가 아니다** */
  | 'noAvatar'
  /** 마지막 왕복이 실패했다 */
  | 'error';

/** 화면에 그대로 찍을 수 있는 한 벌 */
export interface AvatarViewState {
  phase: AvatarViewPhase;
  /** 사용자가 켜 뒀는가 (정본은 sink) */
  visible: boolean;
  /** 체크박스를 만질 수 있는가 */
  canToggle: boolean;
  /** 한 줄 글자. **툴팁이 아니라 화면 글자다** */
  text: string;
  isError: boolean;
  avatars: number;
  vertices: number;
  triangles: number;
  /** 마지막으로 실린 `[현재, 전체]` 프레임. 모르면 null */
  frameInfo: [number, number] | null;
  /** 애니메이션이 끝났는가. 끝났으면 재생 중에도 더 안 받는다 */
  animationDone: boolean;
}

export interface AvatarViewStats {
  /** 왕복 횟수 */
  requests: number;
  /** `topology:true` 로 받은 횟수. 로드당 1 이 정상이다 */
  topologyRequests: number;
  /** 서명이 어긋나 토폴로지를 다시 받은 횟수. **0 이 정상이다** */
  resyncs: number;
  /** 재생 중 폴링으로 받은 횟수 */
  polls: number;
  /** 실패 횟수 */
  failures: number;
  /** 마지막 왕복에 걸린 ms */
  lastMs: number;
  /** 마지막 실패 */
  lastError: Error | null;
}

/** `refresh()` 의 결과. 배선이 카메라를 다시 맞출지 정할 때 쓴다 */
export interface AvatarRefreshResult {
  ok: boolean;
  /** 이번에 토폴로지를 새로 세웠는가 */
  installedTopology: boolean;
  avatars: number;
  vertices: number;
  elapsedMs: number;
}

export interface AvatarViewHooks {
  onChange?: (state: AvatarViewState) => void;
  log?: (line: string) => void;
  /** 현재 시각(ms). 테스트가 시계를 밀어 넣는 자리다 */
  now?: () => number;
}

export interface AvatarViewOptions {
  port: AvatarViewPort;
  sink: AvatarViewSink;
  hooks?: AvatarViewHooks;
}

/** 파트 짝과 정점 수의 서명. 이게 그대로면 `updatePositions` 로 충분하다 */
function signatureOf(avatars: readonly DecodedAvatar[]): string {
  return avatars
    .map((a) => `${a.uuid}[${a.parts.map((p) => `${p.index}:${p.vertices}`).join(',')}]`)
    .join('|');
}

export class AvatarViewController {
  readonly #port: AvatarViewPort;
  readonly #sink: AvatarViewSink;
  readonly #hooks: AvatarViewHooks;
  readonly #now: () => number;

  #phase: AvatarViewPhase = 'noScene';
  #scene = false;
  /** 왕복이 겹치지 않게 한다. 워커는 stdin 을 순차 처리한다 */
  #inFlight = false;
  /** 세워 둔 토폴로지의 서명. null 이면 아직 몸이 없다 */
  #signature: string | null = null;
  /** 마지막 토폴로지와 함께 온 텍스처 표 (materials-c). 배선이 통계를 읽어 간다 */
  #textures: readonly (TextureAsset | null)[] = [];
  #resyncBudget = MAX_TOPOLOGY_RETRY;

  #avatars = 0;
  #vertices = 0;
  #triangles = 0;
  #frameInfo: [number, number] | null = null;
  #animationDone = false;
  /** 애니메이션을 가진 아바타가 하나라도 있는가 */
  #animated = false;

  #lastPollAt = 0;
  /** 지난 tick 의 재생 상태. 멈추는 순간을 잡는다 */
  #wasPlaying = false;

  #stats: AvatarViewStats = {
    requests: 0,
    topologyRequests: 0,
    resyncs: 0,
    polls: 0,
    failures: 0,
    lastMs: 0,
    lastError: null,
  };

  constructor(opts: AvatarViewOptions) {
    this.#port = opts.port;
    this.#sink = opts.sink;
    this.#hooks = opts.hooks ?? {};
    this.#now = this.#hooks.now ?? ((): number => Date.now());
  }

  get stats(): AvatarViewStats {
    return { ...this.#stats };
  }

  /**
   * 마지막 토폴로지와 함께 온 텍스처 표 (materials-c).
   *
   * ⚠️ 이 컨트롤러는 표를 **해석하지 않는다** — 사본을 sink 에 넘기고, 배선이
   *    통계를 화면에 쓰라고 여기로 읽어 갈 뿐이다. 무늬를 켜고 끄는 판단은
   *    `panels/textures.ts` 에 있다.
   */
  get textures(): readonly (TextureAsset | null)[] {
    return this.#textures;
  }

  get view(): AvatarViewState {
    return {
      phase: this.#phase,
      visible: this.#sink.visible,
      // 씬이 없어도 스위치는 만질 수 있다 — 끄고 로드하면 왕복이 아예 안 나간다.
      canToggle: true,
      text: this.#text(),
      isError: this.#phase === 'error',
      avatars: this.#avatars,
      vertices: this.#vertices,
      triangles: this.#triangles,
      frameInfo: this.#frameInfo ? [this.#frameInfo[0], this.#frameInfo[1]] : null,
      animationDone: this.#animationDone,
    };
  }

  #text(): string {
    if (!this.#sink.visible) return t('av.hidden');
    switch (this.#phase) {
      case 'noScene':
        return this.#port.connected ? t('av.noScene') : t('err.notConnected');
      case 'loading':
        // 첫 요청은 1.9MB 다. 말해 두지 않으면 "멈췄다" 로 읽힌다.
        return this.#signature === null ? t('av.loading.first') : t('av.loading');
      case 'noAvatar':
        return t('av.none');
      case 'error':
        return t('av.failed', { why: this.#stats.lastError?.message ?? t('err.unknownCause') });
      case 'ready':
        return (
          t('av.ready', {
            avatars: this.#avatars,
            vertices: this.#vertices.toLocaleString('ko-KR'),
          })
          + (this.#animated && !this.#animationDone && this.#frameInfo
            ? t('av.anim', { at: this.#frameInfo[0] + 1, total: this.#frameInfo[1] })
            : '')
        );
    }
  }

  #emit(): void {
    this.#hooks.onChange?.(this.view);
  }

  /**
   * 워커에 씬이 로드돼 있는가. **`playback.view.scene` 을 그대로 넣는다** —
   * `currentScene`(우리가 보고 싶은 것)이 아니라 워커의 사실이라야 한다
   * (재연결 직후처럼 둘이 갈라지면 왕복이 "씬이 없다" 로 실패한다).
   */
  setScene(on: boolean): void {
    if (this.#scene === on) return;
    this.#scene = on;
    if (!on) this.#phase = 'noScene';
    this.#emit();
  }

  /**
   * 몸을 껐다 켠다.
   *
   * 켜는 순간 아직 몸이 없으면 그 자리에서 받아 온다 — 안 그러면 체크박스를
   * 켰는데 아무 일도 안 일어난다(로드 때 꺼져 있었으면 왕복이 없었다).
   */
  setVisible(on: boolean): void {
    if (this.#sink.visible === on) return;
    this.#sink.setVisible(on);
    this.#hooks.log?.(`아바타 — ${on ? '표시' : '숨김'}`);
    this.#emit();
    if (on && this.#signature === null && this.#scene) void this.refresh('표시');
  }

  /** 씬이 내려갔다. 화면에 남은 몸은 이미 아무것도 가리키지 않는다 */
  clear(): void {
    this.#sink.clear();
    this.#signature = null;
    this.#resyncBudget = MAX_TOPOLOGY_RETRY;
    this.#avatars = 0;
    this.#vertices = 0;
    this.#triangles = 0;
    this.#frameInfo = null;
    this.#animationDone = false;
    this.#animated = false;
    this.#scene = false;
    this.#phase = 'noScene';
    this.#emit();
  }

  /**
   * rAF 박자에서 부른다 — **재생 중 갱신의 유일한 진입점.**
   *
   * 상태를 만들지 않고 조건만 본다. 여기서 왕복을 내보내는 경우는 둘뿐이다:
   * 폴링 간격이 찼거나(재생 중 · 애니메이션 안 끝남), 방금 재생이 멈췄거나.
   */
  tick(playing: boolean): void {
    const stopped = this.#wasPlaying && !playing;
    this.#wasPlaying = playing;

    if (!this.#scene || !this.#sink.visible || this.#signature === null) return;
    if (this.#inFlight) return;

    if (stopped) {
      // 마지막 포즈. 폴링 간격 안에서 놓칠 수 있고, 정지 화면이 어긋나 있으면
      // 그게 사용자가 오래 보는 그림이다.
      void this.refresh('정지');
      return;
    }

    if (!playing) return;
    // 애니메이션이 없거나 이미 끝났으면 몸은 더 안 움직인다.
    if (!this.#animated || this.#animationDone) return;

    const now = this.#now();
    if (now - this.#lastPollAt < POLL_MS) return;
    this.#stats.polls += 1;
    void this.refresh('애니메이션');
  }

  /**
   * 몸을 다시 받는다.
   *
   * `topology` 는 **여기서 정한다** — 부르는 쪽이 매번 판단하게 두면 그 판단이
   * 배선마다 조금씩 달라지고, 한 곳이 `true` 를 빠뜨리면 1.9MB 를 아끼는 대신
   * 재질 없는 회색 몸이 선다.
   */
  async refresh(cause: AvatarCause): Promise<AvatarRefreshResult> {
    const empty: AvatarRefreshResult = {
      ok: false,
      installedTopology: false,
      avatars: 0,
      vertices: 0,
      elapsedMs: 0,
    };

    if (!this.#sink.visible) return empty;
    if (!this.#port.connected || !this.#scene) {
      this.#phase = 'noScene';
      this.#emit();
      return empty;
    }
    // 워커는 stdin 을 순차 처리한다. 겹쳐 보내면 뒤엣것이 앞엣것을 기다리며
    // 시뮬 스톨만 두 배가 된다.
    if (this.#inFlight) return empty;

    // ⚠️ 서명이 없으면(= 몸이 아직 없으면) 계기가 무엇이든 토폴로지부터다.
    //    인덱스·UV·재질은 `topology:true` 응답에만 실린다.
    const wantTopology = this.#signature === null || TOPOLOGY_CAUSES.has(cause);

    this.#inFlight = true;
    this.#phase = 'loading';
    this.#lastPollAt = this.#now();
    this.#emit();

    const t0 = this.#now();
    try {
      let res = await this.#fetch(wantTopology);
      let decoded = decodeAvatars(res);
      let installedTopology = wantTopology;

      if (decoded.length > 0 && !wantTopology) {
        // ★ 서명이 그대로여야 정점만 갈아 끼울 수 있다. 어긋난 채 밀어 넣으면
        //   몸이 조용히 뒤틀리므로, **그 자리에서** 토폴로지를 다시 받는다.
        //   다음 계기로 미루지 않는 이유는 그 사이의 화면이 이미 틀렸어서다.
        const sig = signatureOf(decoded);
        const fits = sig === this.#signature && this.#sink.updatePositions(decoded);
        if (!fits) {
          if (this.#resyncBudget <= 0) {
            this.#hooks.log?.(
              '아바타 — 토폴로지를 다시 세워도 계속 어긋납니다. 재요청을 중단합니다',
            );
          } else {
            this.#resyncBudget -= 1;
            this.#stats.resyncs += 1;
            this.#hooks.log?.(
              `아바타 — ${cause} 뒤 모양이 달라졌습니다. 토폴로지를 다시 받습니다`
              + ` (${MAX_TOPOLOGY_RETRY - this.#resyncBudget}/${MAX_TOPOLOGY_RETRY})`,
            );
            res = await this.#fetch(true);
            decoded = decodeAvatars(res);
            installedTopology = true;
          }
        }
      }

      if (installedTopology && decoded.length > 0) {
        // ★ 텍스처 표를 **같이** 넘긴다 (materials-c). `setTopology` 가 재질을
        //   새로 만들므로, 안 넘기면 체형을 바꿔 토폴로지를 다시 세운 순간
        //   몸이 흰색으로 돌아간다 — 크래시가 없어 원인을 못 찾는 종류다.
        //   (표는 `topology:true` 응답에만 실린다. 그래서 여기가 유일한 자리다.)
        this.#textures = decodeAvatarTextures(res);
        this.#sink.setTopology(decoded, this.#textures);
        this.#signature = signatureOf(decoded);
        this.#resyncBudget = MAX_TOPOLOGY_RETRY;
      }

      if (decoded.length === 0) {
        // 아바타가 없는 씬이다. **오류가 아니다** — 화면에 글자로만 남긴다.
        this.#sink.clear();
        this.#signature = null;
        this.#avatars = 0;
        this.#vertices = 0;
        this.#triangles = 0;
        this.#frameInfo = null;
        this.#animated = false;
        this.#animationDone = true;
        this.#phase = 'noAvatar';
        return { ...empty, ok: true, elapsedMs: Math.round(this.#now() - t0) };
      }

      this.#note(decoded, res);
      this.#phase = 'ready';

      const elapsedMs = Math.round(this.#now() - t0);
      this.#stats.lastMs = elapsedMs;
      this.#hooks.log?.(
        `아바타 — ${cause}: ${installedTopology ? '토폴로지' : '정점'}`
        + ` ${this.#vertices.toLocaleString('ko-KR')}개 · ${elapsedMs}ms`,
      );
      return {
        ok: true,
        installedTopology,
        avatars: this.#avatars,
        vertices: this.#vertices,
        elapsedMs,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.#stats.failures += 1;
      this.#stats.lastError = error;
      this.#phase = 'error';
      // ★ 몸을 **치우지 않는다.** 못 받은 것이 화면에 서 있는 몸을 거짓으로
      //   만들지는 않는다 — 마지막으로 받은 포즈는 여전히 그 씬의 몸이다.
      //   글자로만 말한다(옷의 프레임 실패와 같은 판단이다).
      this.#hooks.log?.(`아바타 — ${cause} 실패: ${error.message}`);
      return empty;
    } finally {
      this.#inFlight = false;
      this.#emit();
    }
  }

  /**
   * 왕복 하나. **`normals` 는 항상 켠다.**
   *
   * 법선은 topology 가 아니라 positions 와 한 몸이다 — 몸이 휘면 법선도 바뀐다.
   * 끄면 대역폭이 3분의 1 줄지만 우리가 `computeVertexNormals()` 로 다시
   * 만들어야 하고, 그러면 파트 경계(눈꺼풀·목)에서 각이 서서 이음매가 드러난다.
   * 몸 색이 전부 흰색이라 **형태를 드러내는 것이 음영뿐**이므로 여기서 아끼지
   * 않는다.
   */
  async #fetch(topology: boolean): Promise<AvatarMeshResult> {
    const res = await this.#port.avatarMesh(topology, true);
    this.#stats.requests += 1;
    if (topology) this.#stats.topologyRequests += 1;
    return res;
  }

  /** 응답의 사실을 화면용 숫자로 옮긴다. **요청값의 메아리가 아니다** */
  #note(decoded: DecodedAvatar[], res: AvatarMeshResult): void {
    this.#avatars = decoded.length;
    this.#vertices = res.totalVertices;
    this.#triangles = res.totalTriangles;

    // 애니메이션 판정은 **현재 아바타**를 기준으로 한다. 여럿이면 하나라도
    // 안 끝났을 때 계속 받는다 — 덜 받아서 몸이 굳는 쪽이 더 나쁘다.
    const animated = decoded.filter((a) => a.animation);
    this.#animated = animated.length > 0;
    const first = animated[0] ?? decoded[0];
    this.#frameInfo = first ? [first.frameInfo[0], first.frameInfo[1]] : null;
    this.#animationDone = this.#animated
      ? animated.every((a) => isAnimationFinished(a))
      : true;
  }
}
