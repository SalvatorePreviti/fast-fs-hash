# fast-fs-hash — Native addon build configuration
#
# Uses cmake-js for Node.js addon compilation. xxHash is included as a
# git submodule at deps/xxHash (pinned to v0.8.3) and built via its
# official cmake_unofficial/CMakeLists.txt as a static library.
#
# xxHash SIMD strategy:
#   x86_64 — DISPATCH mode: xxh_x86dispatch.c provides runtime CPU dispatch
#     via CPUID, selecting SSE2/AVX2/AVX512 code paths at runtime.
#     GCC/Clang use __attribute__((target(...))); MSVC uses intrinsics directly.
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

# - xxHash (git submodule, built via its official CMake)
#
# xxHash is at deps/xxHash (v0.8.3). We use add_subdirectory to build it
# as a static library via cmake_unofficial/CMakeLists.txt. In bundled mode
# (auto-detected), it produces a static `xxhash` target with correct
# include directories — no install step.
#
# IMPORTANT: We deliberately do NOT set xxHash's DISPATCH variable.
# xxHash's cmake_unofficial uses CMAKE_HOST_SYSTEM_INFORMATION to detect
# the platform — this returns the HOST arch, not the TARGET arch, which
# is wrong when cross-compiling (e.g. building x86_64 on an ARM64 host,
# or building ARM64 on an x86_64 host). Instead, we add xxh_x86dispatch.c
# to the xxhash target ourselves, gated on CMAKE_SYSTEM_PROCESSOR (the
# actual target architecture).

set(XXHASH_BUILD_XXHSUM OFF CACHE BOOL "" FORCE)  # don't build the CLI tool
add_subdirectory(deps/xxHash/cmake_unofficial xxhash_build)

# x86_64 DISPATCH: Runtime CPUID-based SSE2/AVX2/AVX512 selection.
# xxh_x86dispatch.c provides _dispatch variants of all XXH3 functions.
# Our includes.h includes xxh_x86dispatch.h which remaps the standard
# XXH3 API to these dispatch symbols.
#
# MUST be compiled with default flags (no -mavx2 etc.) — the dispatch
# source uses __attribute__((target(...))) / MSVC intrinsics to generate
# per-ISA code paths without requiring global ISA flags.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|amd64")
    target_sources(xxhash PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/deps/xxHash/xxh_x86dispatch.c")
endif()

# - Node.js / N-API headers

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

# Native C++ headers (xxHash headers come from the xxhash target)
include_directories(${NATIVE_SRC_DIR})

# - Compile the addon

add_library(${PROJECT_NAME} SHARED
    ${NATIVE_SRC_DIR}/binding.cpp
    ${CMAKE_JS_SRC}
)

# N-API: don't throw C++ exceptions, use Napi::Error instead.
target_compile_definitions(${PROJECT_NAME} PRIVATE
    NAPI_DISABLE_CPP_EXCEPTIONS
)

# Link xxHash static library + cmake-js libraries
target_link_libraries(${PROJECT_NAME} PRIVATE xxhash ${CMAKE_JS_LIB})

# Output as .node
set_target_properties(${PROJECT_NAME} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
)

# - High-performance build configuration
#
# We build with maximum optimizations since this is a compute-heavy
# native addon: LTO, no-exceptions, no-RTTI, loop unrolling, and
# architecture-specific SIMD flags.
#
# Optimization flags are applied to both our addon AND the xxHash static
# library so that LTO can optimize across TUs (xxhash.c ↔ binding.cpp).
# C++-only flags (-fno-rtti, -fno-exceptions) are applied only to our addon.
# Linker flags apply only to our addon (the final .node shared library).

include(CheckCXXCompilerFlag)
include(CheckCCompilerFlag)

if(MSVC)
    # MSVC: maximum speed, whole-program optimization, no buffer checks,
    # no exceptions, no RTTI, favor speed over size, omit frame pointers.
    set(FSH_C_FLAGS /O2 /Oi /Ot /Oy /GL /GS- /DNDEBUG /Gy /Gw)
    target_compile_options(xxhash PRIVATE ${FSH_C_FLAGS})
    target_compile_options(${PROJECT_NAME} PRIVATE
        ${FSH_C_FLAGS}
        $<$<COMPILE_LANGUAGE:CXX>:/EHs-c->   # disable C++ exceptions
        $<$<COMPILE_LANGUAGE:CXX>:/GR->       # disable RTTI
    )
    # LTCG + aggressive linker optimizations: eliminate dead code, fold identical COMDATs,
    # strip debug info from release builds.
    set_target_properties(${PROJECT_NAME} PROPERTIES
        LINK_FLAGS "/LTCG /OPT:REF /OPT:ICF=2 /DEBUG:NONE"
    )
else()
    # GCC / Clang: aggressive optimizations for throughput-critical code.
    # Common C flags applied to both xxhash and our addon:
    set(FSH_C_FLAGS
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

    target_compile_options(xxhash PRIVATE ${FSH_C_FLAGS})
    target_compile_options(${PROJECT_NAME} PRIVATE ${FSH_C_FLAGS})

    # C++-only flags (would warn on C files) — addon only:
    target_compile_options(${PROJECT_NAME} PRIVATE
        $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
        $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
        $<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>
    )

    # Thin LTO — faster than full LTO, comparable code quality.
    # Applied to both targets so the linker can optimize across TUs.
    check_cxx_compiler_flag("-flto=thin" HAS_THIN_LTO)
    if(HAS_THIN_LTO)
        target_compile_options(xxhash PRIVATE -flto=thin)
        target_compile_options(${PROJECT_NAME} PRIVATE -flto=thin)
        target_link_options(${PROJECT_NAME} PRIVATE -flto=thin)
    else()
        check_cxx_compiler_flag("-flto" HAS_LTO)
        if(HAS_LTO)
            target_compile_options(xxhash PRIVATE -flto)
            target_compile_options(${PROJECT_NAME} PRIVATE -flto)
            target_link_options(${PROJECT_NAME} PRIVATE -flto)
        endif()
    endif()

    # Linux/FreeBSD-specific: PIC optimizations (both targets)
    if(NOT APPLE)
        check_cxx_compiler_flag("-fno-semantic-interposition" HAS_NO_SEMANTIC_INTERPOSITION)
        if(HAS_NO_SEMANTIC_INTERPOSITION)
            target_compile_options(xxhash PRIVATE -fno-semantic-interposition)
            target_compile_options(${PROJECT_NAME} PRIVATE -fno-semantic-interposition)
        endif()
        check_cxx_compiler_flag("-fno-plt" HAS_NO_PLT)
        if(HAS_NO_PLT)
            target_compile_options(xxhash PRIVATE -fno-plt)
            target_compile_options(${PROJECT_NAME} PRIVATE -fno-plt)
        endif()
    endif()

    # Platform-specific linker flags for dead code elimination and stripping
    # (addon only — xxhash is a static lib, no linker flags needed)
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

# - Architecture-specific flags
#
# x86_64: No extra SIMD flags — on Linux, xxh_x86dispatch handles runtime
#         selection via CPUID + __attribute__((target(...))). Adding -mavx2
#         globally would break CPUs without AVX2.
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
