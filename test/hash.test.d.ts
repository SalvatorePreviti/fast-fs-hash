/**
 * Tests for hashFiles with persistent fixtures (test/fixtures/hash-fixture/).
 * These fixtures are checked into git and never change, so we can hard-code
 * the expected hash values.
 *
 * Fixture layout:
 *   a.txt         "hello world\n"
 *   b.txt         "goodbye world\n"
 *   subdir/c.txt  "nested file\n"
 *   empty.txt     ""
 *   binary.bin    16 bytes  [0x00–0x0f]
 *   data-4k.bin   4096 bytes [0x00..0xff × 16]
 *   unicode.txt   "日本語テスト 🚀 émojis\n"
 */
export {};
