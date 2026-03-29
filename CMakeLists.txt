# fast-fs-hash — Native addon build configuration
#
# Uses cmake-js for Node.js addon compilation. xxHash is included as a
# git submodule at deps/xxHash (pinned to v0.8.3) and built via its
# official cmake_unofficial/CMakeLists.txt as a static library.
#
# xxHash SIMD strategy:
#   x86_64 — 3 binaries: baseline (SSE2), AVX2, AVX-512. Loader picks best at runtime.
#            All use XXH_INLINE_ALL for full inlining — no dispatch overhead.
#   ARM64  — single binary with NEON (always available on AArch64).
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
# is wrong when cross-compiling (e.g. building ARM64 on an x86_64 host).
# Similarly, CMAKE_SYSTEM_PROCESSOR reports the HOST arch on Windows with
# Visual Studio generators.  We derive the true target architecture from
# CMAKE_GENERATOR_PLATFORM (set by -A on MSVC) when available, falling
# back to CMAKE_SYSTEM_PROCESSOR for Makefile/Ninja generators. We then
# add xxh_x86dispatch.c to the xxhash target ourselves, gated on this
# resolved FSH_TARGET_ARCH variable.

set(XXHASH_BUILD_XXHSUM OFF CACHE BOOL "" FORCE)  # don't build the CLI tool
add_subdirectory(deps/xxHash/cmake_unofficial xxhash_build)

# - LZ4 (v1.10.0, single-file embed from deps/lz4)
#
# Minimal embed: lz4.c + lz4.h only (block compression/decompression).
# No SIMD intrinsics — LZ4 relies on compiler auto-vectorization of tight
# memcpy-based wildcopy loops. LZ4_FAST_DEC_LOOP is auto-enabled on
# x86_64 and aarch64 for an unrolled fast decompression path.
# BSD 2-Clause licensed.

add_library(lz4 STATIC "${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4/lz4.c")
target_include_directories(lz4 PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4")
set_target_properties(lz4 PROPERTIES POSITION_INDEPENDENT_CODE ON)

# ─── Determine actual TARGET architecture ───────────────────────────────
#
# CMAKE_SYSTEM_PROCESSOR reports the HOST architecture on Windows when
# cross-compiling with Visual Studio generators (e.g. building ARM64 on an
# x86_64 host: CMAKE_SYSTEM_PROCESSOR="AMD64" but -A ARM64).
# CMAKE_GENERATOR_PLATFORM is set to the -A value and IS the correct
# target architecture for MSVC.  On Makefile/Ninja generators (Linux/Mac)
# it is empty and CMAKE_SYSTEM_PROCESSOR is correct.
if(CMAKE_GENERATOR_PLATFORM)
    set(FSH_TARGET_ARCH "${CMAKE_GENERATOR_PLATFORM}")
else()
    set(FSH_TARGET_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
endif()
message(STATUS "Target architecture: ${FSH_TARGET_ARCH}")

# x86_64: no dispatch — we build separate binaries per ISA level.
# xxh_x86dispatch.c is NOT used. Each variant uses XXH_INLINE_ALL.

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
include_directories(${NATIVE_SRC_DIR}/core)
include_directories(${NATIVE_SRC_DIR}/io)
include_directories(${NATIVE_SRC_DIR}/workers)
include_directories(${NATIVE_SRC_DIR}/file-hash-cache)
include_directories(${NATIVE_SRC_DIR}/file-hash-cache/workers)

# ─── Addon build function ──────────────────────────────────────────────
# Creates a .node shared library target with the given suffix and arch flags.
# On x64, called 3 times (baseline, avx2, avx512). On other archs, called once.

function(fsh_add_addon SUFFIX ARCH_FLAGS)
    set(TARGET_NAME "${PROJECT_NAME}${SUFFIX}")

    add_library(${TARGET_NAME} SHARED
        ${NATIVE_SRC_DIR}/binding.cpp
        ${CMAKE_JS_SRC}
    )

    target_compile_definitions(${TARGET_NAME} PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS)
    target_link_libraries(${TARGET_NAME} PRIVATE xxhash lz4 ${CMAKE_JS_LIB})

    set_target_properties(${TARGET_NAME} PROPERTIES
        PREFIX ""
        SUFFIX ".node"
    )

    # Apply arch-specific compile flags to this target
    if(ARCH_FLAGS)
        target_compile_options(${TARGET_NAME} PRIVATE ${ARCH_FLAGS})
    endif()
endfunction()

# ─── Create addon targets ─────────────────────────────────────────────

if(FSH_TARGET_ARCH MATCHES "x86_64|AMD64|amd64|x64" AND NOT MSVC)
    # x64 GCC/Clang: 3 variants with increasing ISA levels
    fsh_add_addon(""       "")                    # baseline (SSE2)
    fsh_add_addon("_avx2"  "-march=x86-64-v3")   # AVX2 + FMA + BMI
    fsh_add_addon("_avx512" "-march=x86-64-v4")   # AVX-512
elseif(FSH_TARGET_ARCH MATCHES "x86_64|AMD64|amd64|x64" AND MSVC)
    # MSVC x64: 3 variants using /arch flags
    fsh_add_addon(""       "")                    # baseline (SSE2)
    fsh_add_addon("_avx2"  "/arch:AVX2")          # AVX2
    fsh_add_addon("_avx512" "/arch:AVX512")       # AVX-512
else()
    # ARM64 / other: single binary
    fsh_add_addon(""       "")
endif()

# ─── High-performance build configuration ─────────────────────────────
#
# Optimization flags applied to all addon targets + static libraries.
# Uses a function so x64 multi-variant builds all get the same base flags.

include(CheckCXXCompilerFlag)
include(CheckCCompilerFlag)

# Collect all addon target names for bulk flag application
set(FSH_ALL_ADDON_TARGETS)
if(FSH_TARGET_ARCH MATCHES "x86_64|AMD64|amd64|x64")
    list(APPEND FSH_ALL_ADDON_TARGETS ${PROJECT_NAME} ${PROJECT_NAME}_avx2 ${PROJECT_NAME}_avx512)
else()
    list(APPEND FSH_ALL_ADDON_TARGETS ${PROJECT_NAME})
endif()

if(MSVC)
    set(FSH_C_FLAGS /O2 /Oi /Ot /Oy /GL /GS- /DNDEBUG /Gy /Gw)
    target_compile_options(xxhash PRIVATE ${FSH_C_FLAGS})
    target_compile_options(lz4 PRIVATE ${FSH_C_FLAGS})
    foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
        target_compile_options(${T} PRIVATE
            ${FSH_C_FLAGS}
            $<$<COMPILE_LANGUAGE:CXX>:/EHs-c->
            $<$<COMPILE_LANGUAGE:CXX>:/GR->
        )
        set_target_properties(${T} PROPERTIES
            LINK_FLAGS "/LTCG /OPT:REF /OPT:ICF=2 /DEBUG:NONE"
        )
    endforeach()
else()
    set(FSH_C_FLAGS
        -O3 -DNDEBUG -g0
        -fomit-frame-pointer -funroll-loops -fmerge-all-constants
        -fvisibility=hidden -ffunction-sections -fdata-sections
        -fno-unwind-tables -fno-asynchronous-unwind-tables
        -fno-stack-protector -fno-math-errno -fstrict-aliasing
    )

    target_compile_options(xxhash PRIVATE ${FSH_C_FLAGS})
    target_compile_options(lz4 PRIVATE ${FSH_C_FLAGS})

    foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
        target_compile_options(${T} PRIVATE ${FSH_C_FLAGS})
        target_compile_options(${T} PRIVATE
            $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
            $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
            $<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>
        )
    endforeach()

    # LTO (applied to all targets including static libs).
    # Prefer thin LTO on Apple (Clang), regular LTO elsewhere (musl linker
    # may not support LLVM thin-LTO bitcode relocations).
    if(APPLE)
        check_cxx_compiler_flag("-flto=thin" HAS_THIN_LTO)
        if(HAS_THIN_LTO)
            set(FSH_LTO_FLAG -flto=thin)
        endif()
    endif()
    if(NOT FSH_LTO_FLAG)
        check_cxx_compiler_flag("-flto" HAS_LTO)
        if(HAS_LTO)
            set(FSH_LTO_FLAG -flto)
        endif()
    endif()
    if(FSH_LTO_FLAG)
        target_compile_options(xxhash PRIVATE ${FSH_LTO_FLAG})
        target_compile_options(lz4 PRIVATE ${FSH_LTO_FLAG})
        foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
            target_compile_options(${T} PRIVATE ${FSH_LTO_FLAG})
            target_link_options(${T} PRIVATE ${FSH_LTO_FLAG})
        endforeach()
    endif()

    # Linux/FreeBSD PIC optimizations
    if(NOT APPLE)
        check_cxx_compiler_flag("-fno-semantic-interposition" HAS_NO_SEMANTIC_INTERPOSITION)
        if(HAS_NO_SEMANTIC_INTERPOSITION)
            target_compile_options(xxhash PRIVATE -fno-semantic-interposition)
            target_compile_options(lz4 PRIVATE -fno-semantic-interposition)
            foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
                target_compile_options(${T} PRIVATE -fno-semantic-interposition)
            endforeach()
        endif()
        check_cxx_compiler_flag("-fno-plt" HAS_NO_PLT)
        if(HAS_NO_PLT)
            target_compile_options(xxhash PRIVATE -fno-plt)
            target_compile_options(lz4 PRIVATE -fno-plt)
            foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
                target_compile_options(${T} PRIVATE -fno-plt)
            endforeach()
        endif()
    endif()

    # Linker flags for dead code elimination
    foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
        if(APPLE)
            target_link_options(${T} PRIVATE -Wl,-dead_strip -Wl,-x)
        else()
            target_link_options(${T} PRIVATE -Wl,--gc-sections -Wl,-s -Wl,--as-needed)
        endif()
    endforeach()
endif()

# ARM64: add crypto extensions (single binary)
if(FSH_TARGET_ARCH MATCHES "aarch64|arm64|ARM64")
    if(NOT MSVC)
        check_cxx_compiler_flag("-march=armv8-a+crypto" HAS_ARM_CRYPTO)
        if(HAS_ARM_CRYPTO)
            target_compile_options(${PROJECT_NAME} PRIVATE -march=armv8-a+crypto)
        endif()
    endif()
endif()

