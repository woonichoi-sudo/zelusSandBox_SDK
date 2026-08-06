/**
 * zelusSandBoxd 프로세스 하나를 감싼다.
 *
 * 세션 = 프로세스 1개다. ZestManager의 콜백이 전부 static이라 한 프로세스에
 * 두 세션을 담을 수 없다 (PROJECT_ANALYSIS.md §9 구조적 관찰). 따라서
 * 이 클래스의 수명이 곧 세션의 수명이다.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';

import {
  isEvent,
  type Event,
  type Incoming,
  type MeshDataResult,
  type Op,
  type Response,
} from './protocol.ts';

export interface WorkerOptions {
  /** zelusSandBoxd(-demo).exe 경로 */
  exePath: string;
  /** 라이선스 필요한 빌드일 때. SDK 엔진을 쓰면 반드시 지정해야 한다 */
  licenseFile?: string;
  /** 요청 하나의 상한. 씬 로드가 1초 안팎이므로 넉넉히 잡는다 */
  requestTimeoutMs?: number;
  /** 엔진이 stderr로 뱉는 로그를 받아볼 훅 */
  onLog?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  op: Op;
  timer: NodeJS.Timeout;
}

export class WorkerError extends Error {}

export declare interface Worker {
  /**
   * mesh는 구독 중일 때만 온다. 인자를 늘리는 쪽을 택했으므로 기존
   * `(frame) => ...` 리스너는 그대로 동작한다 (waitForFrame 포함).
   */
  on(event: 'frame', listener: (frame: number, mesh?: MeshDataResult) => void): this;
  on(event: 'engineMessage', listener: (message: string) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
}

export class Worker extends EventEmitter {
  #child: ChildProcessWithoutNullStreams;
  #stdout: Interface;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #timeoutMs: number;

  /** 마지막으로 관찰한 프레임. 세션 상태 판단에 쓴다 */
  lastFrame = -1;

  private constructor(child: ChildProcessWithoutNullStreams, opts: WorkerOptions) {
    super();
    this.#child = child;
    this.#timeoutMs = opts.requestTimeoutMs ?? 120_000;

    this.#stdout = createInterface({ input: child.stdout });
    this.#stdout.on('line', (line) => this.#onLine(line));

    // stderr는 사람이 읽는 로그다. 파싱하지 않는다.
    createInterface({ input: child.stderr }).on('line', (line) => {
      opts.onLog?.(line);
    });

    // spawn 자체가 실패하면(exe 경로가 틀림, 권한 없음, fd 고갈) 프로세스는
    // 시작조차 못 하므로 **'exit'이 오지 않는다.** 그리고 child_process의
    // 'error'는 리스너가 없으면 EventEmitter가 unhandled로 승격시켜
    // **게이트웨이 프로세스 전체를 죽인다** (ISSUE-006). 여기서 받아
    // "세션 하나의 실패"로 국한한다 — 게이트웨이는 이걸 502로 돌려준다.
    //
    // 에러는 nextTick으로 오므로(ChildProcess.spawn이 그렇게 예약한다)
    // Session.create()가 'ready'/'exit' 리스너를 다는 동기 구간보다 늦다.
    // 따라서 아래 emit('exit')은 반드시 그 대기를 깨운다.
    child.on('error', (err: Error) => {
      // err.message에 이미 exe 경로가 들어 있지만(`spawn <path> ENOENT`),
      // 다른 실패 모드에서도 원인을 알 수 있게 경로를 명시한다.
      const message = `워커를 시작하지 못했습니다: ${err.message} (exe=${opts.exePath})`;
      // 이미 죽은 뒤 도착한 에러(kill EPERM 등)라도 로그는 남긴다.
      opts.onLog?.(message);
      this.#end(null, () => new WorkerError(message));
    });

    child.on('exit', (code) => {
      this.#end(code, () => new WorkerError(`워커가 종료됨 (code=${code})`));
    });
  }

  /**
   * 프로세스가 끝났다 — 정상 종료든 기동 실패든.
   *
   * 'error'와 'exit'은 **둘 다 올 수도, 한쪽만 올 수도** 있다(ENOENT는 'error'만).
   * 그래서 여기가 유일한 종료 처리 지점이고, 먼저 온 쪽만 통과시킨다.
   * 두 번 통과하면 'exit'이 두 번 나가 세션이 이미 끝난 뒤에도 다시 정리된다.
   */
  #end(code: number | null, reason: () => WorkerError): void {
    if (this.#closed) return;
    this.#closed = true;

    // 프로세스가 죽으면 대기 중인 요청은 전부 실패다. 조용히 매달려 있게
    // 두면 게이트웨이가 영원히 응답을 기다린다.
    if (this.#pending.size > 0) {
      const err = reason();
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.#pending.clear();
    }

    this.emit('exit', code);
  }

  static spawn(opts: WorkerOptions): Worker {
    const env = { ...process.env };
    if (opts.licenseFile) {
      env['ZELUS_SDK_LICENSE_FILE'] = opts.licenseFile;
    }

    const child = spawn(opts.exePath, ['--serve'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    return new Worker(child, opts);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  #onLine(line: string): void {
    if (!line) return;

    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      // 프로토콜 스트림에 JSON이 아닌 게 섞였다는 뜻이다. C++ 쪽에서
      // stdout으로 뭔가를 찍고 있을 수 있다 (cout은 stderr로 돌려뒀지만
      // 새 코드가 직접 printf를 쓰면 뚫린다).
      this.emit('engineMessage', `[비 JSON 출력] ${line}`);
      return;
    }

    if (isEvent(msg)) {
      this.#onEvent(msg);
      return;
    }

    if (msg.id === undefined) {
      // id 없는 응답 = 파싱 실패 같은 프로토콜 수준 오류
      this.emit('engineMessage', line);
      return;
    }

    const pending = this.#pending.get(msg.id);
    if (!pending) return;

    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new WorkerError(`${pending.op}: ${msg.error}`));
  }

  #onEvent(ev: Event): void {
    switch (ev.event) {
      case 'ready':
        this.emit('ready');
        break;
      case 'frame':
        this.lastFrame = ev.frame;
        // ev.mesh는 구독 중일 때만 있다. undefined면 인자 하나짜리 emit과
        // 구분되지 않으므로 비구독 경로의 동작은 이전과 같다.
        this.emit('frame', ev.frame, ev.mesh);
        break;
      case 'engineMessage':
        if (ev.message) this.emit('engineMessage', ev.message);
        break;
    }
  }

  /** 요청 하나를 보내고 응답을 기다린다. */
  request<T = unknown>(op: Op, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new WorkerError(`워커가 이미 종료됨 (op=${op})`));
    }

    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WorkerError(`${op} 응답 없음 (${this.#timeoutMs}ms 초과)`));
      }, this.#timeoutMs);

      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        op,
        timer,
      });

      this.#child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });
  }

  /** quit을 보내고, 응하지 않으면 강제 종료한다. */
  async dispose(graceMs = 3000): Promise<void> {
    if (this.#closed) return;

    const exited = new Promise<void>((resolve) => {
      this.#child.once('exit', () => resolve());
    });

    try {
      await this.request('quit');
    } catch {
      // 이미 죽었거나 응답 못 함. 아래에서 강제 종료한다.
    }

    const timer = setTimeout(() => {
      if (!this.#closed) this.#child.kill();
    }, graceMs);

    await exited;
    clearTimeout(timer);
    this.#stdout.close();
  }

  /** 응답을 기다리지 않고 즉시 죽인다. */
  kill(): void {
    if (!this.#closed) this.#child.kill();
  }
}
