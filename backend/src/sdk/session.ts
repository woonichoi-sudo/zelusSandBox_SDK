/**
 * 워커 위에 얹은 고수준 API.
 *
 * 프로토콜의 op를 타입 있는 메서드로 감싸고, 세션 상태(마지막 활동 시각 등)를
 * 들고 있다. 풀이 유휴 판단에 이걸 쓴다.
 */

import { EventEmitter } from 'node:events';

import {
  decodeFloat32,
  decodeInt32,
  type MeshDataResult,
  type MeshInfoResult,
  type PatternData,
  type AvatarBodyResult,
  type AvatarMeshResult,
  type AvatarMeasurementTargets,
  type DrapingItemsResult,
  type DrapingThumbnailResult,
  type LoadDrapingResult,
  type SetAvatarBodyResult,
  type SetAvatarMeasurementsResult,
  type FabricsResult,
  type SetFabricResult,
  type SurfacesResult,
  type Design2DResult,
  type SetParamsResult,
  type SimulationParams,
  type StatusResult,
  type SubscribeResult,
  type VersionResult,
} from './protocol.ts';
import { Worker, type WorkerOptions } from './worker.ts';

export interface SessionOptions extends WorkerOptions {
  /** 씬 로드 전에 Initialize()를 부를지. 끄면 LoadZls가 죽는다 — 기본 true */
  autoInit?: boolean;
}

/**
 * three.js 등에서 바로 쓸 수 있게 푼 지오메트리 — **base64 배열만 푼다.**
 *
 * ⚠️ 변환 두 개(`transform` 3D / `transform2d` 2D)는 **여기 없다.** 둘 다
 *    base64 가 아니라 평문 숫자라 풀 것이 없고, 이 SDK 를 쓰는 쪽(도구·게이트
 *    웨이)은 원본 `MeshDataResult` 를 그대로 들고 있기 때문이다 — 필요하면
 *    `mesh.patterns[i].transform` / `.transform2d` 를 직접 읽는다
 *    (`tools/ground-probe.ts` 가 그렇게 한다). 하나만 여기 올리면 "2D 배치는
 *    풀어 주는데 3D 는 안 풀어 주나" 라는 어긋남이 생기므로 둘 다 두지 않는다.
 *    **프론트의 `DecodedPattern`(frontend/src/protocol/decode.ts)은 다르다** —
 *    그쪽은 three 에 바로 꽂아야 해서 둘 다 싣는다.
 */
export interface DecodedPattern {
  uuid: string;
  positions: Float32Array;
  indices?: Int32Array;
  /** cm 단위 2D 패턴 좌표. **서피스 로컬**이다 (`transform2d` 를 곱해야 도면) */
  uvs?: Float32Array;
  vertices: number;
  triangles: number;
}

/**
 * meshData 응답과 구독 중 frame 이벤트의 mesh는 모양이 같다. 그래서
 * 디코더도 하나다 — 두 경로가 갈라지면 한쪽만 조용히 깨진다.
 */
export function decodePatterns(mesh: MeshDataResult): DecodedPattern[] {
  return mesh.patterns.map((p: PatternData): DecodedPattern => {
    const out: DecodedPattern = {
      uuid: p.uuid,
      vertices: p.vertices,
      triangles: p.triangles,
      positions: p.positions ? decodeFloat32(p.positions) : new Float32Array(0),
    };
    if (p.indices) out.indices = decodeInt32(p.indices);
    if (p.uvs) out.uvs = decodeFloat32(p.uvs);
    return out;
  });
}

export declare interface Session {
  /** mesh는 subscribe() 중일 때만 온다. 기존 `(frame) => ...` 리스너는 그대로다. */
  on(event: 'frame', listener: (frame: number, mesh?: MeshDataResult) => void): this;
  on(event: 'engineMessage', listener: (message: string) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
}

export class Session extends EventEmitter {
  readonly worker: Worker;

  #lastActivity = Date.now();
  readonly createdAt = Date.now();
  #loadedPath: string | null = null;

  private constructor(worker: Worker) {
    super();
    this.worker = worker;
    worker.on('frame', (f, mesh) => {
      this.#touch();
      this.emit('frame', f, mesh);
    });
    worker.on('engineMessage', (m) => this.emit('engineMessage', m));
    worker.on('exit', (c) => this.emit('exit', c));
  }

  /** 프로세스를 띄우고 ready를 기다린다. autoInit이면 Initialize()까지. */
  static async create(opts: SessionOptions): Promise<Session> {
    const worker = Worker.spawn(opts);
    const session = new Session(worker);

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        worker.off('exit', onExit);
        resolve();
      };
      const onExit = (code: number | null) => {
        worker.off('ready', onReady);
        reject(new Error(`워커가 시작 중 종료됨 (code=${code})`));
      };
      worker.once('ready', onReady);
      worker.once('exit', onExit);
    });

    if (opts.autoInit !== false) {
      await session.init();
    }

    return session;
  }

  #touch(): void {
    this.#lastActivity = Date.now();
  }

  get idleMs(): number {
    return Date.now() - this.#lastActivity;
  }

  get ageMs(): number {
    return Date.now() - this.createdAt;
  }

  get loadedPath(): string | null {
    return this.#loadedPath;
  }

  get alive(): boolean {
    return !this.worker.closed;
  }

  async #call<T>(op: Parameters<Worker['request']>[0], payload?: Record<string, unknown>): Promise<T> {
    this.#touch();
    const r = await this.worker.request<T>(op, payload);
    this.#touch();
    return r;
  }

  // ── 명령 ──────────────────────────────────────────────────

  ping(): Promise<{ pong: boolean }> {
    return this.#call('ping');
  }

  /** 링크된 엔진(Zelus/Lumia)의 버전 문자열. init/load 없이도 된다. */
  version(): Promise<VersionResult> {
    return this.#call('version');
  }

  init(): Promise<{ initialized: boolean }> {
    return this.#call('init');
  }

  async load(path: string): Promise<void> {
    await this.#call('load', { path });
    this.#loadedPath = path;
  }

  /**
   * 씬을 내린다. 메모리 대부분이 반납된다 (측정: 364MB → 24MB).
   * 프로세스는 살아 있으므로 다음 로드에서 기동 비용(~110ms)을 아낀다.
   */
  async clear(): Promise<void> {
    await this.#call('clear');
    this.#loadedPath = null;
  }

  start(): Promise<{ mode: string }> {
    return this.#call('start');
  }

  pause(): Promise<{ mode: string }> {
    return this.#call('pause');
  }

  reset(): Promise<{ mode: string }> {
    return this.#call('reset');
  }

  step(): Promise<{ mode: string }> {
    return this.#call('step');
  }

  /**
   * frame 이벤트에 메시(positions)를 실어 보내라고 켠다. 프레임마다
   * meshData를 되묻는 왕복이 사라진다.
   *
   * 토폴로지는 안 온다 — 프레임 간 고정이라 `geometry(true)`로 한 번만
   * 받아 두고, 이후엔 frame 이벤트의 positions만 갈아끼우면 된다.
   */
  subscribe(): Promise<SubscribeResult> {
    return this.#call('subscribe');
  }

  unsubscribe(): Promise<SubscribeResult> {
    return this.#call('unsubscribe');
  }

  status(): Promise<StatusResult> {
    return this.#call('status');
  }

  getParams(): Promise<SimulationParams> {
    return this.#call('getParams');
  }

  setParams(params: Partial<SimulationParams>): Promise<SetParamsResult> {
    return this.#call('setParams', { params });
  }

  /**
   * 아바타 체형과 치수를 읽는다 (L-3a).
   *
   * ⚠️ 돌아오는 `measurements[].real` 은 **로드 시점 값이고 체형을 바꿔도
   *    갱신되지 않는다** (`AvatarBodyResult` 주석 참고).
   */
  avatarBody(): Promise<AvatarBodyResult> {
    return this.#call('avatarBody');
  }

  /**
   * 체형을 쓴다. 키는 `avatarBody()` 가 준 `bodyParams` 의 이름이고 값은 0~1 이다.
   *
   * 돌려주는 `avatar` 는 **쓰고 나서 다시 읽은 값**이다 — 요청값의 메아리가
   * 아니므로, 반영 여부를 이 응답만으로 판정할 수 있다.
   */
  setAvatarBody(bodyParams: Record<string, number>): Promise<SetAvatarBodyResult> {
    return this.#call('setAvatarBody', { bodyParams });
  }

  /**
   * 치수(cm)로 몸을 만든다 (W-1). 키는 `avatarBody()` 의 `measurements` 이름이고
   * **`null` 은 "지정 안 함"** 이다 — 안 바꿀 치수를 지우지 않고 그대로 실어도 된다.
   *
   * ⚠️ **오래 걸리고, 그동안 이 세션은 다른 op 에 응답하지 못한다.** 실측
   *    Release Δ15cm = 15.4초(Step 96번). 기본값(`6`, `1.0`)은 엔진팀 문서 값이며
   *    회사 struct 의 초기값(`1`, `100`)과 다르다 — 그쪽을 쓰면 단계가 통째로
   *    사라져 옷이 몸을 뚫는다(`protocol.cpp` 주석 참고).
   *
   * ★ 되읽기의 정본은 `measured` 다. `avatar.measurements[*].real` 은 이 op 으로
   *   움직이지 않는다.
   */
  setAvatarMeasurements(
    measurements: AvatarMeasurementTargets,
    opts: { simulationIterations?: number; bodyDimensionStepCm?: number } = {},
  ): Promise<SetAvatarMeasurementsResult> {
    return this.#call('setAvatarMeasurements', {
      measurements,
      ...(opts.simulationIterations === undefined
        ? {} : { simulationIterations: opts.simulationIterations }),
      ...(opts.bodyDimensionStepCm === undefined
        ? {} : { bodyDimensionStepCm: opts.bodyDimensionStepCm }),
    });
  }

  /**
   * 씬에 저장된 드레이핑 아이템 목록 (DB-1). **씬을 안 바꾼다.**
   *
   * `loadDraping()` 도 목록을 같이 돌려주지만, 이쪽은 **적용하지 않고** 읽기만
   * 한다 — 화면이 보드를 그리려면 아무것도 씌우기 전에 목록이 있어야 한다.
   *
   * ⚠️ 이름이 빈 아이템은 **목록에 안 나온다**(엔진의 필터다, 데스크톱 앱과
   *    같다). 즉 `count` 는 "고를 수 있는 것" 의 수이지 파일 안의 총수가 아니다.
   */
  drapingItems(): Promise<DrapingItemsResult> {
    return this.#call('drapingItems');
  }

  /**
   * `.zls` 에 저장된 드레이프를 적용한다 (W-1 / DB-1). 펼쳐진 옷이 입혀진다.
   *
   * `uuid` 를 주면 그 아이템을, **없으면 자동 아이템**을 적용한다.
   *
   * ⚠️ **`applied:false` 는 실패가 아니다** — 자동 드레이프가 없거나
   *   (`noAutoItem`) 준 uuid 가 목록에 없다(`notFound`).
   * ★ **`applied:true` 면 프레임 카운터가 -1 로 되돌아간다** (엔진이 안에서
   *   `Reset()` 한다). 부르는 쪽은 `reset()` 과 같은 뒤처리를 해야 한다.
   */
  loadDraping(uuid?: string): Promise<LoadDrapingResult> {
    // 인자가 없으면 **필드 자체를 안 보낸다.** `uuid: undefined` 를 실으면
    // JSON 직렬화에서 사라지긴 하지만, 빈 문자열이 섞여 들어올 여지를 남긴다 —
    // 워커는 빈 문자열을 "자동" 으로 읽으므로 조용히 다른 것이 적용된다.
    return uuid === undefined
      ? this.#call('loadDraping')
      : this.#call('loadDraping', { uuid });
  }

  /**
   * 아이템 하나의 미리보기 이미지 (DB-1). **base64 로 온다** — 60~75KB 짜리
   * PNG 가 약 4/3 배로 부풀어 ~100KB 다.
   *
   * ★ **목록에는 바이트가 안 실린다.** 화면이 필요한 것만 하나씩 받고, 받은
   *   것은 부르는 쪽이 캐시한다(같은 씬에서 안 변한다).
   *
   * ⚠️ **`hasImage:false` 는 실패가 아니다** — 없는 uuid, 미리보기 없이 저장된
   *   아이템, 모르는 형식이 전부 여기로 온다. `reason` 이 셋을 가른다.
   */
  drapingThumbnail(uuid: string): Promise<DrapingThumbnailResult> {
    return this.#call('drapingThumbnail', { uuid });
  }

  /** 서피스(패턴) 목록과 크기를 읽는다. **cm 다** (L-3b) */
  surfaces(): Promise<SurfacesResult> {
    return this.#call('surfaces');
  }

  /**
   * 서피스 하나의 크기를 바꾼다. **폭·높이 중 하나만 줘도 된다** — 안 준 쪽은
   * 지금 값을 그대로 쓴다.
   *
   * 돌려주는 것은 **바꾼 뒤의 전체 목록**이다. 엔진이 크기를 조정했으면 그
   * 사실이 응답에 그대로 드러난다(실측: 폭을 +30% 하면 높이가 0.03% 흔들린다).
   */
  setSurfaceSize(uuid: string, size: { width?: number; height?: number }): Promise<SurfacesResult> {
    return this.#call('setSurfaceSize', { uuid, ...size });
  }

  /**
   * 고를 수 있는 직물 목록 (UI #50).
   *
   * ⚠️ **씬을 열기 전에는 비어 있다** — 씬 내장 직물이 그때 채워진다.
   *    그리고 이 설치본에는 프리셋이 없어 **씬 내장뿐**이다(`FabricsResult` 주석).
   */
  fabrics(): Promise<FabricsResult> {
    return this.#call('fabrics');
  }

  /**
   * 서피스(재단 조각) 하나에 직물을 입힌다. **한 번에 하나다** —
   * `setSurfaceSize` 와 같은 판단이다(부분 적용 상태를 안 만든다).
   *
   * ⚠️ **화면은 이 응답만으로 새 색을 그리지 못한다.** 옷 색은 `meshData` 의
   *    `topology` 페이로드 안에 있고 클라이언트는 그것을 최초 1회만 받는다.
   *    적용 뒤 **토폴로지를 다시 받아야** 한다(프론트의 `restageTopology`).
   *    안 하면 증상이 "적용 버튼이 안 먹는다" 로 보인다.
   */
  setFabric(surface: string, fabricId: string): Promise<SetFabricResult> {
    return this.#call('setFabric', { surface, fabricId });
  }

  /**
   * 재단 도면의 **디자인 정보**를 읽는다 — 커브·봉제선·스티치 (D2-a).
   *
   * ★ 좌표가 **월드 2D 다.** 워커가 `atWorld` 로 배치까지 끝낸 값을 주므로
   *   화면이 `transform2d` 를 곱하면 안 된다 — 두 번 적용된다.
   *
   * 로드당 한 번이면 된다. 커브·봉제선은 드레이프와 무관하게 고정이라
   * 프레임 경로에 없다(L-2a 가 재단 도면에 대해 확인한 성질과 같다).
   */
  design2d(): Promise<Design2DResult> {
    return this.#call('design2d');
  }

  meshInfo(): Promise<MeshInfoResult> {
    return this.#call('meshInfo');
  }

  meshData(topology = false): Promise<MeshDataResult> {
    return this.#call('meshData', { topology });
  }

  /**
   * 아바타(사람 몸) 메시를 읽는다 (AM-1).
   *
   * ⚠️ **프레임마다 부르지 마라.** 이것은 스트리밍이 아니라 요청-응답이고,
   *    한 번이 옷 한 프레임의 몇 배다. 부를 시점은 정해져 있다 — 씬 로드 /
   *    체형 변경(`setAvatarMeasurements`·`setAvatarBody`) / `loadDraping`
   *    (포즈가 크게 바뀐다) / 애니메이션 중. 자세한 것은
   *    `AvatarMeshResult` 주석.
   *
   * ★ 정점은 **월드 좌표**다. 옷과 달리 변환을 곱하면 안 된다.
   *
   * @param topology indices/uvs/material 을 포함할지. 몸의 형태만 갱신할
   *                 때는 false 로 두어 절반 이하로 줄인다.
   * @param normals  엔진 법선을 포함할지(기본 true). 끄면 절반이 줄지만
   *                 클라이언트가 직접 계산해야 하고 UV 이음매가 각져 보인다.
   */
  avatarMesh(topology = false, normals = true): Promise<AvatarMeshResult> {
    return this.#call('avatarMesh', { topology, normals });
  }

  /** meshData를 받아 base64를 TypedArray로 풀어서 돌려준다. */
  async geometry(topology = false): Promise<DecodedPattern[]> {
    return decodePatterns(await this.meshData(topology));
  }

  export(path: string, format: 'gltf' | 'zbin' = 'gltf'): Promise<{ path: string }> {
    return this.#call('export', { path, format });
  }

  /**
   * 목표 프레임에 도달할 때까지 기다린다.
   * 프레임 이벤트가 끊기면 timeout으로 실패한다.
   */
  waitForFrame(target: number, timeoutMs = 300_000): Promise<number> {
    if (this.worker.lastFrame >= target) {
      return Promise.resolve(this.worker.lastFrame);
    }

    return new Promise<number>((resolve, reject) => {
      const cleanup = () => {
        this.worker.off('frame', onFrame);
        this.worker.off('exit', onExit);
        clearTimeout(timer);
      };
      const onFrame = (f: number) => {
        if (f >= target) {
          cleanup();
          resolve(f);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error('프레임 대기 중 워커가 종료됨'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`프레임 ${target} 도달 실패 (${timeoutMs}ms). 현재 ${this.worker.lastFrame}`));
      }, timeoutMs);

      this.worker.on('frame', onFrame);
      this.worker.once('exit', onExit);
    });
  }

  dispose(): Promise<void> {
    return this.worker.dispose();
  }
}
