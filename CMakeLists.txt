# fast-fs-hash — Native addon build configuration
#
# Uses cmake-js for Node.js addon compilation. xxHash is included as a
# git submodule at deps/xxHash (pinned to v0.8.3).
#
# xxHash SIMD strategy:
#   x86_64 (GCC/Clang) — xxh_x86dispatch.c provides runtime CPU dispatch
#     via CPUID, selecting SSE2/AVX2/AVX512 code paths compiled with
#     __attribute__((target(...))). No -mavx2 flags needed at build time.
#   x86_64 (MSVC) — dispatch is not supported (no target attributes).
#     Uses xxhash.c which compiles to SSE2 (always available on x86_64).
#   ARM64 — xxhash.c with NEON (always available on AArch64, auto-detected).
#
# Build:
#   npm run build:native
#   npm run build:native:release

cmake_minimum_required(VERSION 3.15)
project(fast_fs_hash LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Native C++ source directory
set(NATIVE_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/packages/fast-fs-hash/src/native)

# ── xxHash (git submodule) ────────────────────────────────────────────────

# xxHash is included as a git submodule at deps/xxHash, pinned to v0.8.3.
# We only use the header + .c source directly — no need for xxHash's CMake targets.
set(XXHASH_DIR ${CMAKE_CURRENT_SOURCE_DIR}/deps/xxHash)

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
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# xxHash header directory
include_directories(${XXHASH_DIR})

# Native C++ headers
include_directories(${NATIVE_SRC_DIR})

# ── Compile the addon ────────────────────────────────────────────────────

add_library(${PROJECT_NAME} SHARED
    ${NATIVE_SRC_DIR}/binding.cpp
    ${CMAKE_JS_SRC}
)

# ── xxHash implementation ────────────────────────────────────────────────
#
# On x86_64 with GCC/Clang: xxh_x86dispatch.c compiles multiple SIMD
# variants (SSE2, AVX2, AVX512) using __attribute__((target(...))) and
# selects the best one at runtime via CPUID. Must be compiled with base
# flags only (no -mavx2 etc.) — the target attributes handle per-function ISA.
#
# On MSVC or non-x86: xxhash.c with the platform's native SIMD.
# MSVC lacks __attribute__((target(...))), so dispatch would compile all
# paths to the same SSE2 code — no point in the extra complexity.

if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|amd64" AND NOT MSVC)
    target_sources(${PROJECT_NAME} PRIVATE ${XXHASH_DIR}/xxh_x86dispatch.c)
else()
    target_sources(${PROJECT_NAME} PRIVATE ${XXHASH_DIR}/xxhash.c)
endif()

# N-API: don't throw C++ exceptions, use Napi::Error instead.
target_compile_definitions(${PROJECT_NAME} PRIVATE
    NAPI_DISABLE_CPP_EXCEPTIONS
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
#
# Flags are split by language (C vs CXX) using generator expressions
# because xxh_x86dispatch.c is compiled as C and C++-only flags like
# -fno-rtti and -fno-exceptions would produce warnings.

include(CheckCXXCompilerFlag)
include(CheckCCompilerFlag)

if(MSVC)
    # MSVC: maximum speed, whole-program optimization, no buffer checks,
    # no exceptions, no RTTI, favor speed over size, omit frame pointers.
    target_compile_options(${PROJECT_NAME} PRIVATE
        /O2 /Oi /Ot /Oy /GL /GS- /DNDEBUG
        $<$<COMPILE_LANGUAGE:CXX>:/EHs-c->   # disable C++ exceptions
        $<$<COMPILE_LANGUAGE:CXX>:/GR->       # disable RTTI
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
    # Common flags for both C and C++:
    target_compile_options(${PROJECT_NAME} PRIVATE
        -O3
        -DNDEBUG
        -g0                           # no debug info
        -fomit-frame-pointer
        -funroll-loops
        -fmerge-all-constants
        -fvisibility=hidden           # hide all symbols by default — biggest size win
        -ffunction-sections           # each function in its own section (enables dead stripping)
        -fdata-sections               # each data object in its own section
        -fno-unwind-tables            # remove .eh_frame unwind tables
        -fno-asynchronous-unwind-tables  # remove async unwind tables
        -fno-stack-protector          # no stack canaries (no exception unwinding anyway)
        -fno-math-errno               # don't set errno on math ops
        -fstrict-aliasing             # strict aliasing for better optimization
    )

    # C++-only flags (would warn on C files):
    target_compile_options(${PROJECT_NAME} PRIVATE
        $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
        $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
        $<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>
    )

    # Thin LTO — faster than full LTO, comparable code quality.
    # Applied to both C and C++ so the linker can optimize across TUs.
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

    # Linux/FreeBSD-specific: PIC optimizations
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
            -Wl,--gc-sections            # Linux/FreeBSD: garbage-collect unused sections
            -Wl,-s                       # strip all symbol info
            -Wl,--as-needed              # only link needed shared libs
        )
    endif()
endif()

# ── Architecture-specific flags ──────────────────────────────────────────
#
# x86_64: No extra SIMD flags — xxh_x86dispatch.c handles runtime selection
#         via CPUID + __attribute__((target(...))). Adding -mavx2 globally
#         would break CPUs without AVX2 since our own C++ code would also
#         be compiled with AVX2 instructions.
#
# ARM64:  NEON is always available on AArch64 and xxHash auto-detects it.
#         We add armv8-a+crypto (AES/SHA/PMULL) which is supported by
#         virtually all server-grade ARM64 CPUs (AWS Graviton, Ampere,
#         Apple Silicon). Not needed for xxHash, but benefits our C++ code.

if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
    if(NOT MSVC)
        check_cxx_compiler_flag("-march=armv8-a+crypto" HAS_ARM_CRYPTO)
        if(HAS_ARM_CRYPTO)
            target_compile_options(${PROJECT_NAME} PRIVATE -march=armv8-a+crypto)
        endif()
    endif()
endif()
