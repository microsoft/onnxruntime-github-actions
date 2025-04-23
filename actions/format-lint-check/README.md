# actions/format-lint-check/README.md

# Format and Lint Check Action

## Description

This GitHub Action runs on Linux runners and performs the following tasks:

1.  **Installs LLVM/Clang:** Downloads a specific version of the official LLVM release binaries (`LLVM-<version>-Linux-X64.tar.xz`) from GitHub Releases, verifies its SHA256 hash, extracts it, caches it using `@actions/tool-cache`, and adds the `bin` directory to the `PATH`.
2.  **Checks C/C++ Formatting:** Uses the installed `clang-format` to verify if C/C++ source files (`.h`, `.cc`, `.cpp`) within the specified directories adhere to the formatting rules defined by `.clang-format` files (searched upwards from file locations). It fails the action if any file needs formatting.
3.  **Checks Shell Script Permissions:** Verifies that all found shell scripts (`.sh`) have at least one execute bit set.
4.  **Checks Source/Text File Permissions:** Verifies that common source and text files (`.h`, `.cc`, `.cpp`, `.md`, `.txt`) do **not** have any execute bits set.
