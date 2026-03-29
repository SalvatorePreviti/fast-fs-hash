/**
 * Cross-process named lock with built-in in-process serialization.
 *
 * Uses OS-level primitives (named mutex on Windows, process-shared
 * pthread_mutex in POSIX shared memory on Linux/macOS/FreeBSD).
 * Crash-safe: stale locks from dead processes are automatically recovered.
 *
 * In-process serialization is built-in via promise chaining — concurrent
 * acquires from the same process are serialized without redundant OS-level
 * lock attempts.
 *
 * @module
 */

import { binding } from "./init-native";
import type { IKeyedLock } from "./public-types";

const { processLockHashName, processLockAsync, processLockRelease, processLockIsLocked } = binding;

/** Options for {@link ProcessLock.acquire}. */
export interface ProcessLockOptions {
  /** Timeout in milliseconds. 0 = try once, -1 = wait forever (default). */
  timeout?: number;
}

const _map = new Map<string, ProcessLock>();

/**
 * Cross-process named lock. Implements `AsyncDisposable` for `await using`.
 * Reusable: call {@link acquire} again after {@link release}.
 *
 * @example
 * ```ts
 * await using lock = await ProcessLock.acquire("my-cache");
 * // ... exclusive cross-process access ...
 * ```
 *
 * @example
 * ```ts
 * const lock = new ProcessLock("my-cache");
 * await lock.acquire();
 * try { ... } finally { lock.release(); }
 * ```
 */
export class ProcessLock implements IKeyedLock<string> {
  #key: string;
  #hash: string | undefined = undefined;
  #handle: object | undefined = undefined;
  #promise: Promise<void> | undefined = undefined;
  #resolve: (() => void) | undefined = undefined;

  /**
   * Create a lock for the given key. Not acquired until {@link acquire} is called.
   * @param key The key to lock on (arbitrary string — hashed to an OS identifier on first use).
   */
  public constructor(key: string) {
    this.#key = key;
  }

  /** The hashed OS-level lock name. Computed once on first use. */
  public get hash(): string {
    return (this.#hash ??= processLockHashName(this.#key));
  }

  /** The key this lock is for. */
  public get key(): string {
    return this.#key;
  }

  /** Whether this instance currently owns the lock. */
  public get ownsLock(): boolean {
    return this.#handle !== undefined;
  }

  /**
   * Whether this key is locked by any instance in this or other processes.
   * Checks in-process map first (fast). Falls back to a non-blocking native
   * trylock + immediate release (~10-20µs) if not held locally.
   */
  public get locked(): boolean {
    return _map.has(this.#key) || processLockIsLocked(this.hash);
  }

  /** Promise that resolves when released. `undefined` if not held. */
  public get promise(): Promise<void> | undefined {
    return this.#promise;
  }

  /**
   * Directory for lock files (FreeBSD, Windows). Set to override the default (os.tmpdir).
   * On Linux/macOS, locks use POSIX shared memory — this property has no effect.
   * Can also be set via the `FAST_FS_HASH_LOCK_DIR` environment variable.
   */
  public static set lockDir(dir: string) {
    process.env.FAST_FS_HASH_LOCK_DIR = dir;
  }

  public static get lockDir(): string {
    return process.env.FAST_FS_HASH_LOCK_DIR ?? require("node:os").tmpdir();
  }

  /** Number of lock keys currently held in this process. */
  public static get count(): number {
    return _map.size;
  }

  /**
   * Whether a key is locked — checks in-process first, then cross-process.
   * The cross-process check is a non-blocking native call (~10-20µs).
   */
  public static isLocked(key: string): boolean {
    return _map.has(key) || processLockIsLocked(processLockHashName(key));
  }

  /**
   * Acquire the lock. Serializes in-process via promise chaining,
   * then acquires the OS-level lock on a dedicated thread.
   * Rejects if already held. Reusable after {@link release}.
   */
  public acquire(options?: ProcessLockOptions): Promise<this> {
    if (this.#handle) {
      return Promise.reject(new Error("ProcessLock: already acquired — release first"));
    }

    const timeout = options?.timeout ?? -1;
    const key = this.#key;
    const prev = _map.get(key);

    this.#promise = new Promise<void>((r) => {
      this.#resolve = r;
    });
    _map.set(key, this);

    const prevPromise = prev ? prev.#promise : undefined;
    if (prevPromise) {
      return prevPromise.then(() => this.#doAcquire(timeout));
    }
    return this.#doAcquire(timeout);
  }

  /**
   * Shorthand: create and acquire a lock in one call.
   * @param key The key to lock on.
   * @param options Timeout options.
   */
  public static acquire(key: string, options?: ProcessLockOptions): Promise<ProcessLock> {
    return new ProcessLock(key).acquire(options);
  }

  /** Release the lock. Returns `true` if held, `false` if already released. */
  public release(): boolean {
    const handle = this.#handle;
    if (!handle) {
      return false;
    }
    this.#handle = undefined;

    processLockRelease(handle);

    const key = this.#key;
    if (_map.get(key) === this) {
      _map.delete(key);
    }

    const resolve = this.#resolve;
    this.#resolve = undefined;
    this.#promise = undefined;
    resolve?.();

    return true;
  }

  /** Implements `AsyncDisposable`. Calls {@link release} and returns the lock's promise. */
  public [Symbol.asyncDispose](): Promise<void> {
    const p = this.#promise;
    this.release();
    return p ?? Promise.resolve();
  }

  async #doAcquire(timeout: number): Promise<this> {
    try {
      this.#handle = await processLockAsync(this.hash, timeout);
    } catch (e) {
      this.#cleanupOnFail();
      throw e;
    }
    return this;
  }

  #cleanupOnFail(): void {
    const key = this.#key;
    if (_map.get(key) === this) {
      _map.delete(key);
    }
    const resolve = this.#resolve;
    this.#resolve = undefined;
    this.#promise = undefined;
    resolve?.();
  }
}
