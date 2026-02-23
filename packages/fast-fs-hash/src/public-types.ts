/**
 * Public types for fast-fs-hash.
 *
 * @module
 */

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
