/**
 * 프레임 스트리밍의 심장 — **최신-only 큐**. DOM 도 three 도 만지지 않는다 (#13).
 *
 * 이 파일이 따로 있는 이유는 하나다: `viewer.ts` 는 `HTMLCanvasElement` 와
 * `ResizeObserver` 를 잡고 `main.ts` 는 `document` 를 잡아서, 둘 중 어디에 이
 * 로직을 두든 **Node 스모크에서 부를 수 없다.** 여기 두면 `cloth.ts` 처럼
 * 게이트웨이를 실제로 띄운 스모크가 `push()` → `drain()` 을 그대로 돌릴 수 있다.
 * 화면 없이 검증되는 마지막 지점이 여기다.
 *
 * ── 왜 큐가 아니라 칸 하나인가 ──────────────────────────────
 * 구독 중 프레임은 40/s × 47.8KB 로 오고, 한 프레임을 푸는 데 base64 디코딩
 * (약 48KB) + 법선 재계산(정점 3,022)이 든다. 브라우저가 그걸 못 따라가는
 * 순간 큐를 두면 **지연이 무한히 쌓인다** — 화면은 3초 전 옷을 그리면서 메모리는
 * 계속 는다. 옷은 실시간 물리 시뮬레이션이라 3초 전 프레임은 가치가 0 이다.
 * 그래서 보류 칸은 하나이고, 새 프레임이 오면 이전 것을 **버린다.** 늦는 대신
 * 건너뛴다.
 *
 * 게이트웨이(#9)도 같은 판단을 이미 하고 있다 — `sessions.ts` 의 `#emit()` 이
 * `ws.bufferedAmount > 256KiB` 면 보류 칸 하나에 얹는다. 하지만 그 임계값은
 * **소켓 버퍼** 기준이라 "브라우저가 받기는 잘 받는데 푸는 게 느린" 경우는
 * 못 막는다. 서버가 한 겹 걸러 준 뒤에도 프론트 쪽 칸이 여전히 필요한 이유다.
 *
 * ── 왜 `push()` 에서 디코딩하지 않는가 ──────────────────────
 * `push()` 는 WebSocket `message` 핸들러 안에서 돈다. 거기서 `decodePatterns()`
 * 를 부르면 40/s 로 48KB 디코딩 + Float32Array 할당이 이벤트 루프에 얹히고,
 * 그중 대부분은 **다음 rAF 전에 덮어써져 버려질** 프레임이다. 즉 버릴 것을
 * 푸느라 일한다. 그래서 보류 칸에는 **서버가 준 raw(base64 문자열 그대로의
 * `FrameMesh`)** 를 넣고, rAF 가 실제로 쓸 하나만 `drain()` 에서 푼다.
 * 40/s 로 오고 60/s 로 그리면 디코딩 횟수는 최대 40 회지만, 30/s 밖에 못
 * 따라가는 기기에서는 자동으로 30 회로 준다.
 *
 * ── 프레임 번호는 건너뛴다. 역행하지는 않는다 ───────────────
 * 게이트웨이의 보류 칸도 하나라 중간 프레임이 이미 서버에서 버려진다. 번호의
 * 연속성을 가정하면 안 된다(37 다음이 41 일 수 있다). 반대로 칸이 큐가 아니므로
 * **순서가 뒤집히지는 않는다** — 그래서 역행하는 번호는 프로토콜이 깨졌다는
 * 신호이고, 조용히 적용하는 대신 `outOfOrder` 로 세고 버린다.
 */

import { decodePatterns, type DecodedPattern, type FrameMesh } from '../protocol/index.ts';

/**
 * `drain()` 이 위치를 써 넣을 대상. `ClothObject` 가 그대로 만족한다.
 *
 * 구조적 타입으로 받는 이유는 이 모듈이 three 를 import 하지 않기 위해서다 —
 * 테스트가 WebGL 없이 가짜 sink 하나로 흐름 전체를 돌릴 수 있다.
 */
export interface PositionSink {
  /** 토폴로지가 어긋나면 `false`. `ClothObject.updatePositions` 의 계약이다 */
  updatePositions(patterns: readonly DecodedPattern[]): boolean;
  /** 지금 화면에 서 있는 패턴 수. 불일치를 보고할 때 쓴다 */
  readonly patternCount: number;
}

/** 토폴로지가 어긋났을 때 넘기는 정보. 무엇과 무엇이 다른지가 전부다 */
export interface TopologyMismatch {
  /** 어긋난 프레임 번호 */
  frame: number;
  /** 그 프레임이 실어 온 패턴 수 */
  incoming: number;
  /** 화면에 서 있는 패턴 수 */
  current: number;
}

/** `drain()` 한 번의 결과 */
export interface DrainOutcome {
  /**
   * - `idle` 보류 칸이 비었다 (구독 전이거나 시뮬이 멈춰 있다)
   * - `applied` 위치를 덮어썼다
   * - `mismatch` 토폴로지 불일치 → 정지 상태로 들어갔다
   * - `error` 디코딩이 던졌다 (프레임 하나만 버린다)
   * - `stalled` 정지 상태라 보류 프레임을 버렸다
   */
  status: 'idle' | 'applied' | 'mismatch' | 'error' | 'stalled';
  /** 이번에 다룬 프레임 번호. `idle` 이면 null */
  frame: number | null;
  /** `error` 일 때만 */
  error?: Error;
}

export interface FrameStreamStats {
  /** frame 이벤트 총 수. mesh 가 없는 것(비구독)도 센다 */
  received: number;
  /** 그중 mesh 가 실려 온 수 = 실제로 구독이 켜져 있었던 수 */
  withMesh: number;
  /** 보류 칸을 덮어써서 버린 수. **이게 곧 "브라우저가 못 따라간 정도"다** */
  dropped: number;
  /** 번호가 역행해 버린 수. 0 이 아니면 프로토콜을 의심할 것 */
  outOfOrder: number;
  /** 실제로 화면에 반영한 수 */
  applied: number;
  /** 토폴로지 불일치로 버린 수 */
  mismatched: number;
  /** 디코딩이 던져 버린 수 */
  failed: number;
  /** 마지막으로 적용한 프레임 번호 */
  lastApplied: number | null;
  /** 지금 보류 칸에 들어 있는 프레임 번호 */
  pending: number | null;
  /** 토폴로지 불일치로 멈춰 있는가 */
  stalled: boolean;
  /** 적용 기준 fps — **받은 수가 아니라 눈에 보인 수다** */
  fps: number;
}

export interface FrameStreamOptions {
  /**
   * 토폴로지가 어긋났을 때 한 번 부른다. **정지 상태당 한 번뿐이다.**
   *
   * frame 이벤트의 mesh 에는 `indices`·`uvs` 가 없어서(프레임 간 고정이라
   * 서버가 싣지 않는다) 여기서 스스로 복구할 수 없다. 복구는 `meshData(true)`
   * → `setTopology()` 뿐이고 그건 프로토콜을 아는 쪽(`loader.ts` / `main.ts`)의
   * 일이다. 그래서 이 모듈은 "어긋났다" 만 알리고 멈춘다.
   */
  onMismatch?: (info: TopologyMismatch) => void;
  /** fps 계산용 시계. 테스트에서 갈아끼운다 */
  now?: () => number;
  /** fps 를 재는 표본 수. 기본 30 (40/s 기준 약 0.75초 창) */
  fpsWindow?: number;
}

/** fps 를 0 으로 되돌리는 무프레임 시간. 멈췄는데 30fps 로 남아 있으면 안 된다 */
const FPS_IDLE_MS = 1_000;

export class FrameStream {
  readonly #onMismatch: ((info: TopologyMismatch) => void) | null;
  readonly #now: () => number;
  readonly #fpsWindow: number;

  /**
   * 보류 칸. **raw 다** — 디코딩은 `drain()` 에서 한다 (머리말 참고).
   * 칸이 하나이므로 `Array` 도 `Map` 도 아니다. 이 타입이 곧 정책이다.
   */
  #pending: { frame: number; mesh: FrameMesh } | null = null;

  #received = 0;
  #withMesh = 0;
  #dropped = 0;
  #outOfOrder = 0;
  #applied = 0;
  #mismatched = 0;
  #failed = 0;
  #lastApplied: number | null = null;
  #stalled = false;
  #lastError: Error | null = null;

  /** 적용 시각 링. fps 는 여기서만 나온다 */
  #appliedAt: number[] = [];

  constructor(opts: FrameStreamOptions = {}) {
    this.#onMismatch = opts.onMismatch ?? null;
    this.#now = opts.now ?? ((): number => Date.now());
    this.#fpsWindow = Math.max(2, opts.fpsWindow ?? 30);
  }

  /**
   * frame 이벤트를 받는다. **`GatewayClient.on('frame', …)` 에 그대로 꽂는다.**
   *
   * 여기서는 세고 칸에 얹기만 한다 — 디코딩도, three 접근도 없다. 이 함수가
   * 무거워지면 최신-only 큐를 둔 의미가 사라진다.
   *
   * ⚠️ `mesh` 는 구독 중이 아니면 **키 자체가 없다**(null 이 아니다). 그래서
   *    `ev.mesh === null` 이 아니라 존재 여부로 판단한다.
   */
  push(ev: { frame: number; mesh?: FrameMesh }): void {
    this.#received += 1;

    const mesh = ev.mesh;
    // 구독 전/해제 후. 프레임이 진행 중이라는 사실만 알려주는 이벤트다.
    if (mesh === undefined) return;
    this.#withMesh += 1;

    const pending = this.#pending;
    if (pending !== null) {
      // 게이트웨이의 칸도 하나라 순서는 보장된다. 역행하면 프로토콜 문제다.
      if (ev.frame < pending.frame) {
        this.#outOfOrder += 1;
        return;
      }
      // ★ 여기가 최신-only 다. 이전 프레임은 아직 안 그렸어도 버린다.
      this.#dropped += 1;
    }
    this.#pending = { frame: ev.frame, mesh };
  }

  /**
   * 보류 프레임 하나를 풀어 위치에 덮어쓴다. **rAF 에서 부른다.**
   *
   * 절대 던지지 않는다 — rAF 루프 안에서 도는 함수라, 던지면 화면 갱신이
   * 통째로 멈추고 원인은 콘솔 한 줄로만 남는다. 실패는 전부 `status` 로 나온다.
   */
  drain(sink: PositionSink): DrainOutcome {
    const pending = this.#pending;
    // 성공하든 실패하든 칸은 비운다. 남겨 두면 같은 프레임을 다음 rAF 에서
    // 또 풀게 되고, 실패한 프레임이면 그 실패가 영원히 반복된다.
    this.#pending = null;

    if (pending === null) return { status: 'idle', frame: null };
    if (this.#stalled) return { status: 'stalled', frame: pending.frame };

    let patterns: DecodedPattern[];
    try {
      patterns = decodePatterns(pending.mesh);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.#failed += 1;
      this.#lastError = error;
      // 프레임 하나가 깨진 것과 토폴로지가 바뀐 것은 다르다 — 여기서는 멈추지
      // 않는다. 다음 프레임이 멀쩡하면 아무 일도 없었던 것처럼 이어진다.
      return { status: 'error', frame: pending.frame, error };
    }

    if (!sink.updatePositions(patterns)) {
      // ★ `false` 를 삼키지 않는다. 삼키면 화면은 옛 프레임에 얼어붙은 채로
      //   프레임은 계속 흐르고, "시뮬은 도는데 옷이 안 움직인다"가 된다 —
      //   원인이 화면 어디에도 안 남는 최악의 실패다.
      //   여기서 할 수 있는 복구는 없다. frame 이벤트의 mesh 에는 indices·uvs
      //   가 없어서(서버가 싣지 않는다) `setTopology()` 를 만들 수 없기 때문이다.
      //   그래서 멈추고, 위(프로토콜을 아는 쪽)에 한 번 알린다.
      this.#mismatched += 1;
      this.#stalled = true;
      const info: TopologyMismatch = {
        frame: pending.frame,
        incoming: patterns.length,
        current: sink.patternCount,
      };
      try {
        this.#onMismatch?.(info);
      } catch (err: unknown) {
        // 콜백이 던져도 rAF 는 계속 돌아야 한다.
        this.#lastError = err instanceof Error ? err : new Error(String(err));
      }
      return { status: 'mismatch', frame: pending.frame };
    }

    this.#applied += 1;
    this.#lastApplied = pending.frame;
    this.#appliedAt.push(this.#now());
    if (this.#appliedAt.length > this.#fpsWindow) {
      this.#appliedAt.splice(0, this.#appliedAt.length - this.#fpsWindow);
    }
    return { status: 'applied', frame: pending.frame };
  }

  /**
   * 정지 상태를 풀고 보류 프레임을 버린다. **토폴로지를 다시 세운 뒤 부른다.**
   *
   * 보류 프레임을 버리는 것이 핵심이다 — 칸에 남아 있는 것은 옛 토폴로지의
   * 프레임이라 새 지오메트리에 다시 어긋난다. 그러면 복구하자마자 또 멈춘다.
   */
  resume(): void {
    this.#stalled = false;
    this.#pending = null;
    // fps 창도 비운다. 정지 구간을 가로질러 계산하면 말이 안 되는 값이 나온다.
    this.#appliedAt = [];
  }

  /** 누적 카운터까지 0 으로. 세션을 새로 여는 자리에서만 쓴다 */
  reset(): void {
    this.resume();
    this.#received = 0;
    this.#withMesh = 0;
    this.#dropped = 0;
    this.#outOfOrder = 0;
    this.#applied = 0;
    this.#mismatched = 0;
    this.#failed = 0;
    this.#lastApplied = null;
    this.#lastError = null;
  }

  /** 토폴로지 불일치로 멈춰 있는가 */
  get stalled(): boolean {
    return this.#stalled;
  }

  /** 보류 칸에 프레임이 있는가 */
  get hasPending(): boolean {
    return this.#pending !== null;
  }

  /** 마지막 디코딩/콜백 예외. `drain()` 이 던지지 않으므로 여기로만 보인다 */
  get lastError(): Error | null {
    return this.#lastError;
  }

  /**
   * 적용 기준 fps. 받은 프레임 수가 아니라 **화면에 실제로 반영된 수**다.
   *
   * `stats.received` 와 이 값이 크게 벌어지면 브라우저가 못 따라가는 것이고,
   * 그 차이는 `dropped` 에 그대로 쌓인다.
   */
  get fps(): number {
    const t = this.#appliedAt;
    const first = t[0];
    const last = t[t.length - 1];
    if (t.length < 2 || first === undefined || last === undefined) return 0;
    // 마지막 적용이 오래됐으면 멈춘 것이다. 옛 값을 계속 보여주면 안 된다.
    if (this.#now() - last > FPS_IDLE_MS) return 0;
    const span = last - first;
    return span > 0 ? ((t.length - 1) / span) * 1000 : 0;
  }

  get stats(): FrameStreamStats {
    return {
      received: this.#received,
      withMesh: this.#withMesh,
      dropped: this.#dropped,
      outOfOrder: this.#outOfOrder,
      applied: this.#applied,
      mismatched: this.#mismatched,
      failed: this.#failed,
      lastApplied: this.#lastApplied,
      pending: this.#pending?.frame ?? null,
      stalled: this.#stalled,
      fps: this.fps,
    };
  }
}
