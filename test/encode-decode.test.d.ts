/**
 * Tests for encodeFilePaths / decodeFilePaths — the null-separated
 * path encoding used to pass file lists to the C++ engine.
 *
 * Encoding rules:
 *   - Paths are UTF-8 encoded, separated by \0 bytes.
 *   - Paths containing \0 are replaced with empty strings (just a \0 separator),
 *     since null bytes are illegal in file paths on all platforms.
 *   - Empty segments are preserved and map to zero-hash entries.
 *   - A trailing \0 is always present; decoding strips it.
 */
export {};
