/**
 * 스냅샷 상태 기계 — **익스포트 요청 → url → 받기 → 씬에 붙이기.**
 * DOM 도 three 도 만지지 않는다 (`frameStream.ts` 와 같은 규약).
 *
 * ── 왜 스냅샷이라는 것이 필요한가 ───────────────────────────
 * 실시간 경로(`cloth.ts`)가 화면에 세우는 것은 **옷뿐**이다. `meshData` 에는
 * 아바타도, 머티리얼도, 텍스처도 없다 — 패턴별 `positions`/`indices`/`uvs` 가
 * 전부다. 그런데 워커의 `export` 가 뽑는 glTF 에는 그 셋이 **이미 다 들어 있다**
 * (#10 실측: 아바타 `zeta_body0..11` 25,357정점, 머티리얼 14개, 임베드 이미지
 * 8장). 즉 "아바타와 진짜 옷 색"은 새로 만들 것이 아니라 **받아 오면 되는 것**
 * 이고, 이 파일이 그 받아오기의 순서와 실패를 관리한다.
 *
 * ── 왜 파싱이 여기 없는가 (경계의 이유) ─────────────────────
 * `GLTFLoader.parse()` 는 임베드된 base64 이미지를 **텍스처로 만들면서** 끝난다.
 * 그 과정이 `ImageBitmapLoader`/`ImageLoader` 를 거치므로 브라우저 API 없이는
 * 돌지 않는다. 그래서 파싱과 씬 부착은 `parse`/`install` 로 **주입받고**, 이
 * 파일에는 순서·중복 방지·세대 관리·계측만 남긴다. Node 스모크는 가짜
 * `SnapshotTarget` 하나로 흐름 전체(성공/실패/취소/중복 호출)를 돌릴 수 있다.
 *
 * ── 한 번에 하나 ────────────────────────────────────────────
 * 익스포트는 사용자 씬 기준 **36.5MB / 4.3초**다. 버튼을 두 번 누르면 워커가
 * 36MB 를 두 번 쓰고 세션당 상한(#10)이 자기 것을 밀어낸다. 그래서 진행 중에
 * 다시 부르면 **새로 시작하지 않고 진행 중인 약속을 그대로 돌려준다** —
 * `GatewayClient.connect()` 와 같은 판단이다.
 *
 * ── 세대(generation) ────────────────────────────────────────
 * 4.3초 사이에 사용자가 다른 씬을 로드하거나 `clear()` 를 부를 수 있다. 그때
 * 뒤늦게 도착한 파싱 결과를 씬에 붙이면 **다른 씬의 아바타가 서 있게 된다.**
 * `#gen` 이 바뀌었으면 붙이지 않고 `dispose` 로 버린다 — GPU 자원이 딸린
 * 결과물이라 그냥 참조를 놓는 것으로는 안 된다.
 */

import type { ExportFormat, ExportResult } from '../protocol/index.ts';

/**
 * - `idle`        아무것도 안 하는 중 (스냅샷이 있을 수도, 없을 수도 있다)
 * - `exporting`   워커가 파일을 쓰는 중. **가장 긴 구간이다** (1.5~4.3초)
 * - `downloading` HTTP 로 바이트를 받는 중
 * - `parsing`     glTF → 씬 그래프
 * - `ready`       화면에 서 있다
 * - `error`       실패했다. `lastError` 에 이유가 있다
 */
export type SnapshotPhase = 'idle' | 'exporting' | 'downloading' | 'parsing' | 'ready' | 'error';

/** 진행 보고 한 건. **화면에 그대로 찍을 수 있게** 필요한 것이 다 들어 있다 */
export interface SnapshotProgress {
  phase: SnapshotPhase;
  /** `downloading` 에서 받은 바이트. 그 외에는 0 */
  loaded: number;
  /** 전체 바이트. `export` 응답 전이면 0 */
  total: number;
  /** 이번 시도가 시작된 뒤 흐른 ms */
  elapsedMs: number;
  /** `error` 일 때만 */
  error?: Error;
}

/** `install()` 이 돌려주는 것 — **무엇이 실제로 화면에 섰는지** */
export interface SnapshotStats {
  meshes: number;
  vertices: number;
  materials: number;
  textures: number;
}

/** 한 번의 성공 결과 */
export interface SnapshotResult {
  info: ExportResult;
  stats: SnapshotStats;
  /** 익스포트 요청부터 씬 부착까지 (ms) */
  elapsedMs: number;
  /** 구간별 소요. 어디가 느린지가 곧 다음에 고칠 곳이다 */
  timings: { exportMs: number; downloadMs: number; parseMs: number; installMs: number };
}

/**
 * 바이트를 화면으로 바꾸는 쪽. **브라우저 전용 구현이 들어온다**
 * (`snapshotView.ts` 의 `SnapshotObject`).
 *
 * `T` 를 열어 둔 이유는 이 파일이 three 를 import 하지 않기 위해서다 — 파싱
 * 결과가 무엇이든 여기서는 `parse` → `install` 로 흘려보내기만 한다.
 */
export interface SnapshotTarget<T = unknown> {
  /** 바이트 → 씬 그래프. glTF 파싱은 브라우저 API 를 쓴다 */
  parse(bytes: ArrayBuffer): Promise<T>;
  /** 화면에 세운다. **이전 것을 해제하는 책임도 여기 있다** */
  install(content: T): SnapshotStats;
  /** 화면에서 내리고 GPU 자원을 해제한다 */
  clear(): void;
  /**
   * 붙이지 못한 파싱 결과를 버린다 (세대가 바뀐 경우).
   * 없으면 그냥 참조를 놓는다 — 그러면 텍스처가 GPU 에 남을 수 있다.
   */
  dispose?(content: T): void;
}

/** 게이트웨이 쪽. 스모크는 두 함수를 가짜로 바꿔 흐름만 돌린다 */
export interface SnapshotSource {
  /** `export` op. `path` 를 넣지 않는다 — 게이트웨이가 거부한다 */
  requestExport(format: ExportFormat): Promise<ExportResult>;
  /** `GET /api/exports/:id` */
  download(
    url: string,
    onProgress: (loaded: number, total: number) => void,
    expectedBytes: number,
  ): Promise<ArrayBuffer>;
}

export interface SnapshotLoaderOptions<T = unknown> {
  source: SnapshotSource;
  target: SnapshotTarget<T>;
  /** 기본 `gltf` */
  format?: ExportFormat;
  /** 단계가 바뀔 때마다 부른다. 던져도 흐름을 깨지 않는다 */
  onProgress?: (p: SnapshotProgress) => void;
  /** 테스트에서 갈아끼운다. 기본 `Date.now` */
  now?: () => number;
}

export interface SnapshotLoaderStats {
  phase: SnapshotPhase;
  /** `load()` 호출 중 실제로 익스포트를 시작한 수 */
  attempts: number;
  /** 진행 중이라 새로 시작하지 않고 합쳐진 수 */
  coalesced: number;
  succeeded: number;
  failed: number;
  /** 세대가 바뀌어 버린 결과 수. 0 이 아니면 사용자가 기다리다 다른 걸 했다는 뜻 */
  discarded: number;
  /** 지금 화면에 스냅샷이 서 있는가 */
  present: boolean;
  lastResult: SnapshotResult | null;
  lastError: Error | null;
}

export class SnapshotLoader<T = unknown> {
  readonly #source: SnapshotSource;
  readonly #target: SnapshotTarget<T>;
  readonly #format: ExportFormat;
  readonly #onProgress: ((p: SnapshotProgress) => void) | null;
  readonly #now: () => number;

  #phase: SnapshotPhase = 'idle';
  /** 진행 중인 시도. 두 번째 호출은 이걸 그대로 받는다 */
  #inFlight: Promise<SnapshotResult> | null = null;
  /** `clear()` 나 새 `load()` 마다 오른다. 늦게 온 결과를 버리는 기준 */
  #gen = 0;
  #present = false;
  #startedAt = 0;

  #attempts = 0;
  #coalesced = 0;
  #succeeded = 0;
  #failed = 0;
  #discarded = 0;
  #lastResult: SnapshotResult | null = null;
  #lastError: Error | null = null;

  constructor(opts: SnapshotLoaderOptions<T>) {
    this.#source = opts.source;
    this.#target = opts.target;
    this.#format = opts.format ?? 'gltf';
    this.#onProgress = opts.onProgress ?? null;
    this.#now = opts.now ?? ((): number => Date.now());
  }

  get phase(): SnapshotPhase {
    return this.#phase;
  }

  /** 지금 화면에 스냅샷이 서 있는가. 모드 전환 버튼의 활성 조건이다 */
  get present(): boolean {
    return this.#present;
  }

  get busy(): boolean {
    return this.#inFlight !== null;
  }

  get lastResult(): SnapshotResult | null {
    return this.#lastResult;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  get stats(): SnapshotLoaderStats {
    return {
      phase: this.#phase,
      attempts: this.#attempts,
      coalesced: this.#coalesced,
      succeeded: this.#succeeded,
      failed: this.#failed,
      discarded: this.#discarded,
      present: this.#present,
      lastResult: this.#lastResult,
      lastError: this.#lastError,
    };
  }

  /**
   * 스냅샷을 하나 만들어 화면에 세운다.
   *
   * 진행 중이면 **새로 시작하지 않고** 그 약속을 돌려준다 (머리말 참고).
   * 실패하면 던진다 — 부르는 쪽이 화면에 이유를 적어야 하기 때문이다. 다만
   * 던지기 전에 `phase` 와 `lastError` 를 남기므로, 삼켜도 상태로는 보인다.
   */
  load(): Promise<SnapshotResult> {
    const running = this.#inFlight;
    if (running) {
      this.#coalesced += 1;
      return running;
    }
    this.#attempts += 1;
    const promise = this.#run();
    this.#inFlight = promise;
    // 성공이든 실패든 자물쇠는 반드시 푼다. finally 를 promise 에 직접 걸면
    // 호출자가 catch 하지 않았을 때 unhandled rejection 이 하나 더 생기므로,
    // 붙잡을 값이 없는 쪽(void)에만 건다.
    void promise.catch(() => {}).finally(() => {
      if (this.#inFlight === promise) this.#inFlight = null;
    });
    return promise;
  }

  /**
   * 화면에서 내린다. **진행 중인 시도의 결과도 버린다** (세대를 올린다).
   *
   * 씬을 갈아 끼우는 자리에서 반드시 부른다 — 안 부르면 이전 씬의 아바타가
   * 새 씬 위에 서 있게 되고, 그건 화면만 봐서는 절대 못 알아챈다.
   */
  clear(): void {
    this.#gen += 1;
    this.#target.clear();
    this.#present = false;
    this.#setPhase('idle', 0, 0);
  }

  async #run(): Promise<SnapshotResult> {
    const gen = ++this.#gen;
    const t0 = this.#now();
    this.#startedAt = t0;
    this.#lastError = null;

    try {
      this.#setPhase('exporting', 0, 0);
      const info = await this.#source.requestExport(this.#format);
      const t1 = this.#now();
      this.#assertCurrent(gen);

      this.#setPhase('downloading', 0, info.bytes);
      const bytes = await this.#source.download(
        info.url,
        (loaded, total) => this.#setPhase('downloading', loaded, total),
        info.bytes,
      );
      const t2 = this.#now();
      this.#assertCurrent(gen);

      this.#setPhase('parsing', info.bytes, info.bytes);
      const content = await this.#target.parse(bytes);
      const t3 = this.#now();

      // ★ 여기서만은 던지기 전에 버려야 한다. 파싱된 결과에는 GPU 텍스처가
      //   딸려 있어서, 참조를 놓는 것만으로는 회수되지 않는다.
      if (gen !== this.#gen) {
        this.#discarded += 1;
        this.#target.dispose?.(content);
        throw new SnapshotStaleError();
      }

      const stats = this.#target.install(content);
      const t4 = this.#now();
      this.#present = true;

      const result: SnapshotResult = {
        info,
        stats,
        elapsedMs: Math.round(t4 - t0),
        timings: {
          exportMs: Math.round(t1 - t0),
          downloadMs: Math.round(t2 - t1),
          parseMs: Math.round(t3 - t2),
          installMs: Math.round(t4 - t3),
        },
      };
      this.#lastResult = result;
      this.#succeeded += 1;
      this.#setPhase('ready', info.bytes, info.bytes);
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.#lastError = error;
      if (error instanceof SnapshotStaleError) {
        // 취소는 실패가 아니다. 세대를 올린 쪽(clear/새 load)이 이미 phase 를
        // 자기 것으로 정했으므로 여기서 error 로 덮으면 그 상태를 지운다.
        throw error;
      }
      this.#failed += 1;
      this.#setPhase('error', 0, 0, error);
      throw error;
    }
  }

  /** 세대가 바뀌었으면 더 진행하지 않는다 */
  #assertCurrent(gen: number): void {
    if (gen !== this.#gen) {
      this.#discarded += 1;
      throw new SnapshotStaleError();
    }
  }

  #setPhase(phase: SnapshotPhase, loaded: number, total: number, error?: Error): void {
    this.#phase = phase;
    if (!this.#onProgress) return;
    const p: SnapshotProgress = {
      phase,
      loaded,
      total,
      elapsedMs: Math.round(this.#now() - this.#startedAt),
      ...(error ? { error } : {}),
    };
    try {
      this.#onProgress(p);
    } catch {
      // 진행 보고가 던졌다고 익스포트를 실패시키지 않는다. 화면에 숫자를 찍는
      // 코드가 36MB 짜리 작업을 죽이면 원인을 찾을 길이 없다.
    }
  }
}

/**
 * 진행 중에 세대가 바뀌어 결과를 버렸다. **실패가 아니라 취소다.**
 *
 * 따로 둔 이유는 화면 때문이다 — 사용자가 다른 씬을 눌러서 취소된 것을
 * "익스포트 실패" 로 빨갛게 찍으면 있지도 않은 문제를 보고하게 된다.
 */
export class SnapshotStaleError extends Error {
  constructor() {
    super('스냅샷이 만들어지는 사이에 대상이 바뀌어 결과를 버렸습니다');
    this.name = 'SnapshotStaleError';
  }
}
