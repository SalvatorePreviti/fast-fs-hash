# fast-fs-hash — Native addon build configuration
#
# Uses cmake-js for Node.js addon compilation.
#
# xxHash (v0.8.3, header-only): included via XXH_INLINE_ALL — all functions
# are static inline, no compiled library needed. On x86_64, separate binaries
# are built per ISA level (SSE2/AVX2/AVX-512) with the appropriate -march flag,
# so the compiler auto-vectorizes using the target's SIMD instructions.
# ARM64 uses NEON (always available on AArch64), single binary.
#
# LZ4 (v1.10.0, single-file embed): lz4.c is compiled directly into each
# addon target. No separate static library.
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

# - xxHash (v0.8.3, header-only via XXH_INLINE_ALL)
#
# XXH_INLINE_ALL in includes.h makes all xxHash functions static inline —
# no compiled library needed, just the include path.

include_directories("${CMAKE_CURRENT_SOURCE_DIR}/deps/xxHash")

# - LZ4 (v1.10.0, single-file embed from deps/lz4)
#
# Compiled directly into each addon target. No SIMD intrinsics — LZ4
# relies on compiler auto-vectorization of tight memcpy-based wildcopy
# loops. LZ4_FAST_DEC_LOOP is auto-enabled on x86_64 and aarch64.
# BSD 2-Clause licensed.

set(LZ4_SRC "${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4/lz4.c")
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4")

# Determine actual TARGET architecture
#
# CMAKE_SYSTEM_PROCESSOR reports the HOST architecture on Windows when
# cross-compiling with Visual Studio generators (e.g. building ARM64 on an
# x86_64 host: CMAKE_SYSTEM_PROCESSOR="AMD64" but -A ARM64).
# CMAKE_GENERATOR_PLATFORM is set to the -A value and IS the correct
# target architecture for MSVC.  On Makefile/Ninja generators (Linux/Mac)
# it is empty and CMAKE_SYSTEM_PROCESSOR is correct.
#
# On macOS, cmake-js --arch x64 sets CMAKE_OSX_ARCHITECTURES=x86_64
# but leaves CMAKE_SYSTEM_PROCESSOR as the host arch (arm64).
# We check CMAKE_OSX_ARCHITECTURES first for macOS cross-compilation.
if(CMAKE_GENERATOR_PLATFORM)
    set(FSH_TARGET_ARCH "${CMAKE_GENERATOR_PLATFORM}")
elseif(CMAKE_OSX_ARCHITECTURES)
    set(FSH_TARGET_ARCH "${CMAKE_OSX_ARCHITECTURES}")
else()
    set(FSH_TARGET_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
endif()
message(STATUS "Target architecture: ${FSH_TARGET_ARCH}")

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

# Native C++ headers
include_directories(${NATIVE_SRC_DIR})
include_directories(${NATIVE_SRC_DIR}/core)
include_directories(${NATIVE_SRC_DIR}/io)
include_directories(${NATIVE_SRC_DIR}/workers)
include_directories(${NATIVE_SRC_DIR}/file-hash-cache)
include_directories(${NATIVE_SRC_DIR}/file-hash-cache/workers)

# Addon build function
# Creates a .node shared library target with the given suffix and arch flags.
# On x64, called 3 times (baseline, avx2, avx512). On other archs, called once.

function(fsh_add_addon SUFFIX ARCH_FLAGS)
    set(TARGET_NAME "${PROJECT_NAME}${SUFFIX}")

    add_library(${TARGET_NAME} SHARED
        ${NATIVE_SRC_DIR}/binding.cpp
        ${LZ4_SRC}
        ${CMAKE_JS_SRC}
    )

    target_compile_definitions(${TARGET_NAME} PRIVATE
        NAPI_DISABLE_CPP_EXCEPTIONS
        # Hide LZ4 symbols — override LZ4's default visibility("default") so
        # the linker can dead-strip unused functions (we only use compress_default,
        # compress_fast, decompress_safe, compressBound).
        LZ4LIB_VISIBILITY=
        # Disable LZ4 stream allocation functions (createStream, freeStream, etc.)
        # — we never use them and they pull in malloc/free wrappers.
        LZ4_STATIC_LINKING_ONLY_DISABLE_MEMORY_ALLOCATION
    )
    target_link_libraries(${TARGET_NAME} PRIVATE ${CMAKE_JS_LIB})

    set_target_properties(${TARGET_NAME} PROPERTIES
        PREFIX ""
        SUFFIX ".node"
    )

    # Apply arch-specific compile flags to this target
    if(ARCH_FLAGS)
        target_compile_options(${TARGET_NAME} PRIVATE ${ARCH_FLAGS})
    endif()
endfunction()

# Create addon targets

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

# High-performance build configuration
#
# Optimization flags applied to all addon targets.

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
        -fno-common
    )

    foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
        target_compile_options(${T} PRIVATE ${FSH_C_FLAGS})
        target_compile_options(${T} PRIVATE
            $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions>
            $<$<COMPILE_LANGUAGE:CXX>:-fno-rtti>
            $<$<COMPILE_LANGUAGE:CXX>:-fvisibility-inlines-hidden>
        )
    endforeach()

    # LTO — prefer thin LTO on Apple (Clang), regular LTO elsewhere (musl
    # linker may not support LLVM thin-LTO bitcode relocations).
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
        foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
            target_compile_options(${T} PRIVATE ${FSH_LTO_FLAG})
            target_link_options(${T} PRIVATE ${FSH_LTO_FLAG})
        endforeach()
    endif()

    # Linux/FreeBSD PIC optimizations
    if(NOT APPLE)
        check_cxx_compiler_flag("-fno-semantic-interposition" HAS_NO_SEMANTIC_INTERPOSITION)
        if(HAS_NO_SEMANTIC_INTERPOSITION)
            foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
                target_compile_options(${T} PRIVATE -fno-semantic-interposition)
            endforeach()
        endif()
        check_cxx_compiler_flag("-fno-plt" HAS_NO_PLT)
        if(HAS_NO_PLT)
            foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
                target_compile_options(${T} PRIVATE -fno-plt)
            endforeach()
        endif()
    endif()

    # Linker flags for dead code elimination
    foreach(T IN LISTS FSH_ALL_ADDON_TARGETS)
        if(APPLE)
            target_link_options(${T} PRIVATE -Wl,-dead_strip -Wl,-x -Wl,-dead_strip_dylibs)
        else()
            target_link_options(${T} PRIVATE -Wl,--gc-sections -Wl,-s -Wl,--as-needed)
        endif()
    endforeach()
endif()

# ARM64: NEON is baseline on AArch64 — no extra -march flags needed.
# Neither xxHash nor LZ4 uses ARM crypto extensions (AES/SHA), so +crypto
# would only let the compiler auto-vectorize with AES instructions, which
# provides no benefit here and causes SIGILL under QEMU user-mode emulation.
