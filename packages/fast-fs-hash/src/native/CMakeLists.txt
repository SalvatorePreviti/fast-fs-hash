# fast-fs-hash — Native addon build configuration
#
# Uses cmake-js for Node.js addon compilation and CMake FetchContent
# to pull in xxHash. No vendored third-party source code.
#
# Build:
#   npx cmake-js compile -d src/native
#   npx cmake-js compile -d src/native --release

cmake_minimum_required(VERSION 3.15)
project(fast_fs_hash LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ── xxHash via FetchContent ───────────────────────────────────────────────

include(FetchContent)
FetchContent_Declare(
    xxHash
    URL        https://github.com/Cyan4973/xxHash/archive/refs/tags/v0.8.3.tar.gz
    URL_HASH   SHA256=aae608dfe8213dfd05d909a57718ef82f30722c392344583d3f39050c7f29a80
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    EXCLUDE_FROM_ALL
)
# We only need the xxhash.h header, not xxHash's own build targets.
FetchContent_MakeAvailable(xxHash)

# ── Node.js / N-API headers ──────────────────────────────────────────────

# cmake-js sets these variables automatically:
#   CMAKE_JS_INC  — Node.js + N-API + node-addon-api include dirs
#   CMAKE_JS_LIB  — Link libraries (Windows only)
#   CMAKE_JS_SRC  — Source files to compile (Windows delay-load hook)

include_directories(${CMAKE_JS_INC})

# node-addon-api: resolve from the project root's node_modules.
# cmake-js already adds this but we make it explicit for clarity.
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/../..
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# xxHash header directory
include_directories(${xxhash_SOURCE_DIR})

# ── Compile the addon ────────────────────────────────────────────────────

add_library(${PROJECT_NAME} SHARED
    binding.cpp
    ${CMAKE_JS_SRC}
)

# N-API: don't throw C++ exceptions, use Napi::Error instead.
# XXH_FORCE_MEMORY_ACCESS=2: use unaligned reads — faster on modern CPUs.
target_compile_definitions(${PROJECT_NAME} PRIVATE
    NAPI_DISABLE_CPP_EXCEPTIONS
    XXH_FORCE_MEMORY_ACCESS=2
)

# Output as .node
set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
)

# Link cmake-js libraries (needed on Windows)
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# ── High-performance build configuration ─────────────────────────────────
#
# We build with maximum optimizations since this is a compute-heavy
# native addon: LTO, no-exceptions, no-RTTI, loop unrolling, and
# architecture-specific SIMD flags.

include(CheckCXXCompilerFlag)

if(MSVC)
    # MSVC: maximum speed, whole-program optimization, no buffer checks,
    # no exceptions, no RTTI, favor speed over size, omit frame pointers.
    target_compile_options(${PROJECT_NAME} PRIVATE
        /O2 /Oi /Ot /Oy /GL /GS- /DNDEBUG
        /EHs-c-  # disable C++ exceptions
        /GR-     # disable RTTI
        /Gy      # function-level linking (enable COMDAT folding)
        /Gw      # optimize global data (allow linker to discard unused globals)
    )
    # LTCG + aggressive linker optimizations: eliminate dead code, fold identical COMDATs,
    # strip debug info from release builds.
    set_target_properties(${PROJECT_NAME} PROPERTIES
        LINK_FLAGS "/LTCG /OPT:REF /OPT:ICF=2 /DEBUG:NONE"
    )
else()
    # GCC / Clang: aggressive optimizations for throughput-critical code.
    target_compile_options(${PROJECT_NAME} PRIVATE
        -O3
        -DNDEBUG
        -g0                           # no debug info
        -fno-exceptions
        -fno-rtti
        -fomit-frame-pointer
        -funroll-loops
        -fmerge-all-constants
        -fvisibility=hidden           # hide all symbols by default — biggest size win
        -fvisibility-inlines-hidden   # hide inline function symbols
        -ffunction-sections           # each function in its own section (enables dead stripping)
        -fdata-sections               # each data object in its own section
        -fno-unwind-tables            # remove .eh_frame unwind tables
        -fno-asynchronous-unwind-tables  # remove async unwind tables
        -fno-stack-protector          # no stack canaries (no exception unwinding anyway)
        -fno-math-errno               # don't set errno on math ops
        -fstrict-aliasing             # strict aliasing for better optimization
    )

    # Thin LTO — faster than full LTO, comparable code quality
    check_cxx_compiler_flag("-flto=thin" HAS_THIN_LTO)
    if(HAS_THIN_LTO)
        target_compile_options(${PROJECT_NAME} PRIVATE -flto=thin)
        target_link_options(${PROJECT_NAME} PRIVATE -flto=thin)
    else()
        check_cxx_compiler_flag("-flto" HAS_LTO)
        if(HAS_LTO)
            target_compile_options(${PROJECT_NAME} PRIVATE -flto)
            target_link_options(${PROJECT_NAME} PRIVATE -flto)
        endif()
    endif()

    # Linux-specific: PIC optimizations
    if(NOT APPLE)
        check_cxx_compiler_flag("-fno-semantic-interposition" HAS_NO_SEMANTIC_INTERPOSITION)
        if(HAS_NO_SEMANTIC_INTERPOSITION)
            target_compile_options(${PROJECT_NAME} PRIVATE -fno-semantic-interposition)
        endif()
        check_cxx_compiler_flag("-fno-plt" HAS_NO_PLT)
        if(HAS_NO_PLT)
            target_compile_options(${PROJECT_NAME} PRIVATE -fno-plt)
        endif()
    endif()

    # Platform-specific linker flags for dead code elimination and stripping
    if(APPLE)
        target_link_options(${PROJECT_NAME} PRIVATE
            -Wl,-dead_strip              # macOS: remove unreferenced functions/data
            -Wl,-x                       # discard local symbols
        )
    else()
        target_link_options(${PROJECT_NAME} PRIVATE
            -Wl,--gc-sections            # Linux: garbage-collect unused sections
            -Wl,-s                       # strip all symbol info
            -Wl,--as-needed              # only link needed shared libs
        )
    endif()
endif()

# ── Architecture-specific SIMD flags ─────────────────────────────────────
#
# xxHash selects its SIMD path at COMPILE TIME based on predefined macros
# (__AVX2__, __SSE2__, __ARM_NEON__, etc.). There is NO runtime CPU dispatch
# in header-only mode. If we compile with -mavx2 the binary will SIGILL on
# any CPU that lacks AVX2 — with no fallback.
#
# Strategy (2026 baseline):
#   x86_64 — SSE2 is implicit (always available on x86_64). We add -msse4.2
#            which is universal on all x86_64 server CPUs since 2009 (Nehalem).
#            We intentionally do NOT enable AVX2: xxHash3-SSE2 still runs at
#            ~31 GB/s which is 4-8× faster than NVMe storage, so the AVX2
#            speedup (~59 GB/s) provides no real-world benefit for file hashing
#            while risking SIGILL on older Xeons, certain cloud VMs, and
#            low-power x86 devices.
#   ARM64 — NEON is always available on AArch64 and xxHash auto-detects it.
#            We add armv8-a+crypto (AES/SHA) which is supported by virtually
#            all server-grade ARM64 CPUs (AWS Graviton, Ampere, Apple Silicon).

if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|amd64")
    if(NOT MSVC)
        # SSE4.2: universal on all x86_64 server hardware since 2009.
        # xxHash itself uses SSE2 (always available on x86_64), but SSE4.2
        # enables POPCNT and CRC32C which can help the compiler elsewhere.
        check_cxx_compiler_flag("-msse4.2" HAS_SSE42)
        if(HAS_SSE42)
            target_compile_options(${PROJECT_NAME} PRIVATE -msse4.2)
        endif()

        # NOTE: We deliberately omit -mavx2 and -mbmi2.
        # xxHash has no runtime SIMD dispatch in header-only mode — enabling
        # AVX2 at compile time would make the binary crash (SIGILL) on any
        # CPU without AVX2 support. The SSE2 codepath is already far faster
        # than any storage I/O, so the trade-off is not worth it.
    endif()
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
    # NEON is always available on AArch64 — xxHash enables it automatically.
    # Crypto extensions (AES/SHA/PMULL) are present on essentially all
    # server-grade ARM64 CPUs in 2026.
    if(NOT MSVC)
        check_cxx_compiler_flag("-march=armv8-a+crypto" HAS_ARM_CRYPTO)
        if(HAS_ARM_CRYPTO)
            target_compile_options(${PROJECT_NAME} PRIVATE -march=armv8-a+crypto)
        endif()
    endif()
endif()
