# ./actions/setup-cmake/README.md

# Setup CMake Action

This action downloads, verifies (if hash provided), extracts, caches, and optionally adds a specific version of CMake to the system's PATH.

## Features

* Downloads a specific CMake version (e.g., `4.0.0`) or the `"latest"` available release.
* Supports Windows, Linux, and macOS runners.
* Supports common architectures like `x86_64` (x64) and `aarch64` (arm64), using `universal` for modern macOS builds.
* Verifies the download using a provided SHA512 hash **(optional)**.
* Integrates with the GitHub Actions tool cache (`@actions/tool-cache`) for efficiency across workflow runs.
* Optionally uses the `TerrapinRetrievalTool` for downloads (primarily for Windows environments where it's available *and* a hash is provided).
* Optionally adds the CMake `bin` directory to the `PATH` environment variable (default: true).
* Outputs the root installation path and the path to the `bin` directory.

## Inputs

* `cmake-version`: **(Required)** The CMake version to download (e.g., `4.0.0`) or the string `"latest"`.
* `cmake-hash`: (**Optional**) The expected SHA512 hash (hex) of the CMake archive for the target platform/architecture.
    * If provided, the download integrity will be verified using this hash. Terrapin (if enabled/available) will also use this hash.
    * **If omitted, hash verification is skipped, and the Terrapin tool will not be used.**
    * **⚠️ SECURITY WARNING:** Omitting the hash significantly increases the risk of supply chain attacks, as the integrity of the downloaded CMake artifact will not be checked. It is **strongly recommended** to provide a hash whenever possible, especially for production workflows. Pinning to a specific `cmake-version` and providing its corresponding hash is the most secure approach.
* `terrapin-tool-path`: (**Optional**) Path to the `TerrapinRetrievalTool.exe` executable. Defaults to `C:/local/Terrapin/TerrapinRetrievalTool.exe`. Only used on Windows if `disable-terrapin` is `false`, the tool exists, **and `cmake-hash` is provided**.
* `disable-terrapin`: (**Optional**) Boolean. Set to `'true'` to force direct download via `@actions/tool-cache` instead of attempting to use Terrapin. Defaults to `'false'`.
* `add-to-path`: (**Optional**) Boolean. Indicates whether to add the CMake `bin` directory to the `PATH` environment variable. Defaults to `'true'`. Set to `'false'` if you only need to download/cache CMake or want to manage the PATH manually in subsequent steps.

## Outputs

* `cmake-root`: The absolute path to the root directory of the cached CMake installation (e.g., `/_work/_tool/cmake/4.0.0/x64/cmake-4.0.0-linux-x86_64`). Useful for referencing CMake modules or other files within the installation.
* `cmake-path`: The absolute path to the directory containing the CMake executables (e.g., `/_work/_tool/cmake/4.0.0/x64/cmake-4.0.0-linux-x86_64/bin`). This path is added to the system `PATH` environment variable only if the `add-to-path` input is `true` (the default).

## Example Usage

### Recommended: Pin Version with Hash (Adds to PATH)

```yaml
name: Build with Pinned CMake

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest # Or windows-latest, macos-latest

    steps:
    - uses: actions/checkout@v4

    - name: Setup CMake 4.0.0 (Secure, Adds to PATH)
      uses: microsoft/onnxruntime-github-actions/actions/setup-cmake@main
      with:
        cmake-version: '4.0.0'
        cmake-hash: 'example_linux_x64_sha512_hash_here_replace_me'
        # add-to-path: 'true' # This is the default

    - name: Verify CMake and Build
      run: |
        cmake --version # Should work as it's in PATH
        cmake -B build .
        cmake --build build