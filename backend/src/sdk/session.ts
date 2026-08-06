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
  type SetParamsResult,
  type SimulationParams,
  type StatusResult,
} from './protocol.ts';
import { Worker, type WorkerOptions } from './worker.ts';

export interface SessionOptions extends WorkerOptions {
  /** 씬 로드 전에 Initialize()를 부를지. 끄면 LoadZls가 죽는다 — 기본 true */
  autoInit?: boolean;
}

/** three.js 등에서 바로 쓸 수 있게 푼 지오메트리 */
export interface DecodedPattern {
  uuid: string;
  positions: Float32Array;
  indices?: Int32Array;
  uvs?: Float32Array;
  vertices: number;
  triangles: number;
}

export declare interface Session {
  on(event: 'frame', listener: (frame: number) => void): this;
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
    worker.on('frame', (f) => {
      this.#touch();
      this.emit('frame', f);
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

  status(): Promise<StatusResult> {
    return this.#call('status');
  }

  getParams(): Promise<SimulationParams> {
    return this.#call('getParams');
  }

  setParams(params: Partial<SimulationParams>): Promise<SetParamsResult> {
    return this.#call('setParams', { params });
  }

  meshInfo(): Promise<MeshInfoResult> {
    return this.#call('meshInfo');
  }

  meshData(topology = false): Promise<MeshDataResult> {
    return this.#call('meshData', { topology });
  }

  /** meshData를 받아 base64를 TypedArray로 풀어서 돌려준다. */
  async geometry(topology = false): Promise<DecodedPattern[]> {
    const raw = await this.meshData(topology);
    return raw.patterns.map((p: PatternData): DecodedPattern => {
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
