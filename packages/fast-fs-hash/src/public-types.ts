/**
 * Public types for fast-fs-hash.
 *
 * @module
 */

/**
 * Result of {@link findProjectRoot} / {@link findProjectRootSync}.
 *
 * Every field is independently populated as the walker climbs the parent
 * chain from the start path. A field is `null` when its marker was not
 * found before the walk hit a stop boundary (filesystem root, user home,
 * enclosing `.git`, or the depth cap of 128).
 */
export interface ProjectRoot {
  /** Innermost directory containing a `.git` (directory OR file). Matches `git rev-parse --show-toplevel`. */
  gitRoot: string | null;
  /** Outermost directory containing a `.git` *directory*. `null` when not inside a submodule/worktree. */
  gitSuperRoot: string | null;
  /** First `package.json` encountered walking up from the start path. */
  nearestPackageJson: string | null;
  /** Last `package.json` walking up, bounded by `gitRoot` (does not cross into a superproject). */
  rootPackageJson: string | null;
  /** First `tsconfig.json` encountered walking up from the start path. */
  nearestTsconfigJson: string | null;
  /** Last `tsconfig.json` walking up, bounded by `gitRoot`. */
  rootTsconfigJson: string | null;
  /** First `node_modules/` directory encountered walking up. */
  nearestNodeModules: string | null;
  /** Last `node_modules/` walking up, bounded by `gitRoot`. */
  rootNodeModules: string | null;
}

/**
 * Stateless xxHash128 digest functions — available as static methods on XxHash128Stream.
 */
export interface IXxHash128Functions {
  digestBuffer(input: Uint8Array): Buffer;
  digestBufferRange(input: Uint8Array, offset: number, length?: number): Buffer;
  digestBufferTo<TOut extends Uint8Array = Buffer>(input: Uint8Array, out: TOut, outOffset?: number): TOut;
  digestBufferRangeTo<TOut extends Uint8Array = Buffer>(
    input: Uint8Array,
    offset: number,
    length: number,
    out: TOut,
    outOffset?: number
  ): TOut;
  digestString(input: string): Buffer;
  digestStringTo<TOut extends Uint8Array = Buffer>(input: string, out: TOut, outOffset?: number): TOut;
  digestFile(path: string, throwOnError?: boolean): Promise<Buffer>;
  digestFileTo<TOut extends Uint8Array = Buffer>(
    path: string,
    out: TOut,
    outOffset?: number,
    throwOnError?: boolean
  ): Promise<TOut>;
  digestFilesSequential(paths: readonly string[], throwOnError?: boolean): Promise<Buffer>;
  digestFilesSequentialTo<TOut extends Uint8Array>(
    paths: readonly string[],
    out: TOut,
    outOffset?: number,
    throwOnError?: boolean
  ): Promise<TOut>;
  digestFilesParallel(paths: readonly string[], concurrency?: number, throwOnError?: boolean): Promise<Buffer>;
  digestFilesParallelTo<TOut extends Uint8Array>(
    paths: readonly string[],
    out: TOut,
    outOffset?: number,
    concurrency?: number,
    throwOnError?: boolean
  ): Promise<TOut>;
}
