/**
 * 세션 수명 정책.
 *
 * 프로세스를 요청마다 띄웠다 죽일지, 계속 켜둘지는 환경마다 답이 다르다.
 * SDK가 정책을 강제하지 않고 하나의 축(idleTimeout)으로 표현한다:
 *
 *   idleTimeout: 0         세션이 끝나면 즉시 종료
 *   idleTimeout: 300_000   5분 놀면 종료
 *   idleTimeout: Infinity  계속 켜둠
 *
 * 판단 근거가 된 실측 (Release, sample.zls 103MB):
 *   프로세스 기동 + DLL 48개  ~110 ms
 *   씬 로드                   ~830 ms
 *   세션당 메모리(시뮬 중)     ~360 MB
 *   clear 후 메모리            ~24 MB
 *
 * 즉 프로세스를 살려서 아끼는 건 기동 110ms뿐이다. 씬 로드는 어느 쪽이든
 * 다시 내야 한다. 반면 유휴 프로세스는 라이선스 인스턴스를 계속 점유하며,
 * 이건 clear로도 풀리지 않는다 — maxLifetime이 필요한 이유다.
 */

import { Session, type SessionOptions } from './session.ts';

export interface PoolOptions extends SessionOptions {
  /**
   * 세션을 놓아준 뒤 이만큼 놀면 프로세스를 종료한다.
   * 0이면 즉시 종료, Infinity면 계속 유지. 기본 0.
   */
  idleTimeout?: number;
  /** 유휴 상태로 유지할 프로세스 상한. 기본 4 */
  maxIdle?: number;
  /** 동시에 살아 있을 수 있는 프로세스 상한. 라이선스 인스턴스 수와 직결된다 */
  maxTotal?: number;
  /**
   * 사용 중이더라도 이 시간을 넘기면 회수한다.
   * 브라우저 탭을 켜둔 채 방치하는 경우가 반드시 생긴다. 기본 무제한.
   */
  maxLifetime?: number;
}

interface IdleEntry {
  session: Session;
  timer: NodeJS.Timeout | null;
}

export class PoolExhaustedError extends Error {}

export class SessionPool {
  #opts: PoolOptions;
  #idle: IdleEntry[] = [];
  #busy = new Set<Session>();
  #closed = false;

  constructor(opts: PoolOptions) {
    this.#opts = opts;
  }

  get stats() {
    return {
      idle: this.#idle.length,
      busy: this.#busy.size,
      total: this.#idle.length + this.#busy.size,
    };
  }

  #idleTimeout(): number {
    return this.#opts.idleTimeout ?? 0;
  }

  /**
   * 쓸 세션을 얻는다. 유휴 프로세스가 있으면 재사용하고, 없으면 새로 띄운다.
   * 재사용된 세션은 씬이 내려간 상태다 (release에서 clear 했으므로).
   */
  async acquire(): Promise<Session> {
    if (this.#closed) throw new Error('풀이 이미 닫혔습니다');

    while (this.#idle.length > 0) {
      const entry = this.#idle.pop()!;
      if (entry.timer) clearTimeout(entry.timer);

      // 유휴 중에 죽었을 수 있다
      if (!entry.session.alive) continue;

      this.#busy.add(entry.session);
      return entry.session;
    }

    const max = this.#opts.maxTotal;
    if (max !== undefined && this.stats.total >= max) {
      throw new PoolExhaustedError(
        `세션 상한 도달 (${max}). 동시 인스턴스 수는 라이선스와 직결됩니다.`,
      );
    }

    const session = await Session.create(this.#opts);
    this.#busy.add(session);
    return session;
  }

  /**
   * 세션을 놓아준다. idleTimeout 정책에 따라 종료하거나 유휴로 돌린다.
   * 유휴로 돌릴 때는 씬을 내려 메모리를 반납한다.
   */
  async release(session: Session): Promise<void> {
    this.#busy.delete(session);

    if (!session.alive || this.#closed) {
      await session.dispose().catch(() => {});
      return;
    }

    const idleTimeout = this.#idleTimeout();
    const maxIdle = this.#opts.maxIdle ?? 4;
    const maxLifetime = this.#opts.maxLifetime;

    const tooOld = maxLifetime !== undefined && session.ageMs >= maxLifetime;

    if (idleTimeout <= 0 || tooOld || this.#idle.length >= maxIdle) {
      await session.dispose().catch(() => {});
      return;
    }

    // 씬을 내려 메모리를 반납한다. 시뮬 중이면 먼저 멈춘다.
    try {
      await session.pause().catch(() => {});
      await session.clear();
    } catch {
      await session.dispose().catch(() => {});
      return;
    }

    const entry: IdleEntry = { session, timer: null };

    if (Number.isFinite(idleTimeout)) {
      entry.timer = setTimeout(() => {
        const i = this.#idle.indexOf(entry);
        if (i >= 0) this.#idle.splice(i, 1);
        void session.dispose().catch(() => {});
      }, idleTimeout);
      entry.timer.unref?.();
    }

    this.#idle.push(entry);
  }

  /** acquire → 작업 → release 를 한 번에. 예외가 나도 반드시 반납한다. */
  async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.acquire();
    try {
      return await fn(session);
    } finally {
      await this.release(session);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;

    const all = [
      ...this.#idle.map((e) => {
        if (e.timer) clearTimeout(e.timer);
        return e.session;
      }),
      ...this.#busy,
    ];

    this.#idle = [];
    this.#busy.clear();

    await Promise.all(all.map((s) => s.dispose().catch(() => {})));
  }
}
