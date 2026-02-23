import type { IKeyedLock } from "./public-types";

let _defaultMap: Map<unknown, KeyedLock> | undefined;

/**
 * Async lock keyed by any value. Concurrent acquires on the same key are serialized.
 * In-process only — does not prevent other processes or worker threads from acquiring the same key.
 * Implements `AsyncDisposable` for `await using`. Reusable after {@link release}.
 *
 * @example
 * ```ts
 * await using lock = await KeyedLock.acquire("myfile.txt");
 * // ... exclusive access ...
 * ```
 *
 * @example
 * ```ts
 * const lock = new KeyedLock("myfile.txt");
 * await lock.acquire();
 * try { ... } finally { lock.release(); }
 * ```
 */
export class KeyedLock<K = unknown> implements IKeyedLock<K> {
  #key: K;
  #map: Map<K, KeyedLock>;
  #promise: Promise<void> | undefined = undefined;
  #resolve: (() => void) | undefined = undefined;

  /**
   * Create a lock for the given key. Not acquired until {@link acquire} is called.
   * @param key The key to lock on.
   * @param map Optional custom map for namespace isolation. Defaults to a shared global map.
   */
  public constructor(key: K, map?: Map<K, KeyedLock> | null | undefined) {
    this.#key = key;
    this.#map = map ?? (_defaultMap ??= new Map());
  }

  /** The key this lock is for. */
  public get key(): K {
    return this.#key;
  }

  /** Whether this instance currently owns the lock. */
  public get ownsLock(): boolean {
    return this.#resolve !== undefined;
  }

  /** Whether any lock instance currently holds this key in this lock's map. */
  public get locked(): boolean {
    return this.#map.has(this.#key);
  }

  /** Promise that resolves when released. `undefined` if not held. */
  public get promise(): Promise<void> | undefined {
    return this.#promise;
  }

  /** Number of keys currently held in the default lock map. */
  public static get count(): number {
    return _defaultMap?.size ?? 0;
  }

  /** Whether a lock is currently held for the given key in the default map. */
  public static isLocked(key: unknown): boolean {
    return _defaultMap?.has(key) ?? false;
  }

  /**
   * Acquire the lock. Waits for any previous holder of the same key.
   * Rejects if already held. Reusable after {@link release}.
   */
  public acquire(): Promise<this> {
    if (this.#resolve) {
      return Promise.reject(new Error("KeyedLock: already acquired — release first"));
    }

    const map = this.#map;
    const key = this.#key;
    const prev = map.get(key);

    this.#promise = new Promise<void>((r) => {
      this.#resolve = r;
    });
    map.set(key, this as KeyedLock);

    const w = prev ? prev.#promise : undefined;
    return w ? w.then(() => this) : Promise.resolve(this);
  }

  /**
   * Shorthand: create and acquire a lock in one call.
   * @param key The key to lock on.
   * @param map Optional custom map for namespace isolation.
   */
  public static acquire<K = unknown>(key: K, map?: Map<K, KeyedLock> | null | undefined): Promise<KeyedLock<K>> {
    return new KeyedLock<K>(key, map).acquire();
  }

  /** Release the lock. Returns `true` if it was held, `false` if already released. */
  public release(): boolean {
    const resolve = this.#resolve;
    if (!resolve) {
      return false;
    }
    this.#resolve = undefined;
    this.#promise = undefined;

    const map = this.#map;
    const key = this.#key;
    if (map.get(key) === (this as KeyedLock)) {
      map.delete(key);
    }

    resolve();
    return true;
  }

  /** Implements `AsyncDisposable`. Calls {@link release} and returns the lock's promise. */
  public [Symbol.asyncDispose](): Promise<void> {
    const p = this.#promise;
    this.release();
    return p ?? Promise.resolve();
  }
}
