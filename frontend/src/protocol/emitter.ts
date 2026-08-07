/**
 * 타입 있는 최소 이벤트 에미터.
 *
 * `EventTarget` 을 쓰지 않은 이유 두 가지:
 *   - 페이로드가 `CustomEvent.detail` 안으로 들어가 `any` 로 새어 나온다.
 *     이 계층에서 타입이 약해지면 #12 가 프레임 데이터를 손으로 캐스팅하게 된다.
 *   - `on()` 이 해제 함수를 돌려주는 편이 실수를 덜 만든다. 구독을 못 떼면
 *     재연결마다 리스너가 쌓이고, 그게 프론트에서 가장 흔한 누수다.
 *
 * **리스너의 예외를 삼킨다.** 하나가 던졌다고 나머지 리스너가 실행되지 않으면,
 * 프레임 하나를 잘못 그린 렌더러 때문에 연결 상태 표시가 멈추는 식이 된다.
 * 삼킨 예외는 `onError` 로 흘려보내 조용히 사라지지 않게 한다.
 */

export type Listener<T> = (payload: T) => void;

/** 구독 해제. 두 번 불러도 안전하다 */
export type Unsubscribe = () => void;

export class Emitter<M extends Record<string, unknown>> {
  #listeners = new Map<keyof M, Set<Listener<never>>>();
  #onError: ((err: unknown, type: keyof M) => void) | undefined;

  constructor(onError?: (err: unknown, type: keyof M) => void) {
    this.#onError = onError;
  }

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): Unsubscribe {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.off(type, fn);
    };
  }

  once<K extends keyof M>(type: K, fn: Listener<M[K]>): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof M>(type: K, fn: Listener<M[K]>): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    set.delete(fn as Listener<never>);
    if (set.size === 0) this.#listeners.delete(type);
  }

  /** 리스너 수. 누수를 확인할 때 쓴다 */
  count<K extends keyof M>(type: K): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  removeAll(): void {
    this.#listeners.clear();
  }

  /**
   * 던지지 않는다. 복사본을 돌므로 리스너 안에서 on/off 를 불러도 안전하다.
   */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.#listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<M[K]>)(payload);
      } catch (err: unknown) {
        this.#onError?.(err, type);
      }
    }
  }
}
