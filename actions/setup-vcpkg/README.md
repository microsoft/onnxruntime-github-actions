# Setup vcpkg GitHub Action

This action downloads a specific tagged release archive of vcpkg from an internal mirror, verifies its SHA512 hash for integrity, extracts it, runs the necessary vcpkg bootstrap script (`bootstrap-vcpkg.bat` or `bootstrap-vcpkg.sh`), and caches the resulting installation using `@actions/tool-cache`. Currently this action only runs on Windows.

It simplifies the process of getting a ready-to-use vcpkg instance in your GitHub Actions workflows, ensuring consistency and leveraging caching for speed.

Once set up, it exports the `VCPKG_INSTALLATION_ROOT` environment variable pointing to the cached installation path, which can be used by subsequent steps (e.g., CMake toolchain configuration).

## Inputs

| Input           | Description                                                | Required | Example        |
| --------------- | ---------------------------------------------------------- | :------: | -------------- |
| `vcpkg-version` | The vcpkg tag version to download (e.g., `2023.10.19`)     |  `true`  | `2025.03.19`   |
| `vcpkg-hash`    | The expected SHA512 hash of the downloaded `.zip` archive. |  `true`  | `17e96169...` |

**Finding Hashes:** You typically need to download the specific tag's zip archive (e.g., `https://github.com/microsoft/vcpkg/archive/refs/tags/YYYY.MM.DD.zip`) and calculate its SHA512 hash locally.

## Outputs

| Output       | Description                                          | Example Usage                              |
| ------------ | ---------------------------------------------------- | ------------------------------------------ |
| `vcpkg-root` | The absolute path to the cached vcpkg installation. | `${{ steps.setup_vcpkg.outputs.vcpkg-root }}` |

## Environment Variables

This action sets the following environment variable for subsequent steps in the job:

* **`VCPKG_INSTALLATION_ROOT`**: The absolute path to the cached vcpkg installation directory (same value as the `vcpkg-root` output). This is commonly used by build systems like CMake (`-DCMAKE_TOOLCHAIN_FILE=$VCPKG_INSTALLATION_ROOT/scripts/buildsystems/vcpkg.cmake`).

## Caching

* The action utilizes `@actions/tool-cache` for caching.
* The cache key is based on the tool name (`vcpkg`), the specified `vcpkg-version`, and the runner's architecture/OS.
* It caches the **bootstrapped** version of vcpkg, meaning the `vcpkg` executable should be present and ready to use within the cached directory. Subsequent runs hitting the cache will be significantly faster as they skip download, verification, extraction, and bootstrapping.

## Example Usage

```yaml
name: Build with vcpkg

on: [push]

jobs:
  build:
    runs-on: windows-latest # Or ubuntu-latest, macos-latest

    steps:
    - uses: actions/checkout@v4

    - name: Setup vcpkg
      id: setup_vcpkg # Give it an ID to access outputs
      # Assuming the action is in the same repository
      uses: ./.github/actions/setup-vcpkg
      with:
        # Find specific versions and hashes on the vcpkg releases page or repo
        vcpkg-version: '2025.03.19' # Replace with desired tag
        vcpkg-hash: '17e96169cd3f266c4716fcdc1bb728e6a64f103941ece463a2834d50694eba4fb48f30135503fd466402afa139abc847ef630733c442595d1c34979f261b0114' # Replace with the correct SHA512 hash for the version

    - name: Use vcpkg (CMake Example)
      shell: bash # Or pwsh, cmd
      run: |
        echo "Vcpkg is installed at: $VCPKG_INSTALLATION_ROOT"
        echo "Vcpkg root output: ${{ steps.setup_vcpkg.outputs.vcpkg-root }}"

        # Example CMake configuration using the VCPKG_INSTALLATION_ROOT env var
        cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=<span class="math-inline">VCPKG\_INSTALLATION\_ROOT/scripts/buildsystems/vcpkg\.cmake
\# Or using the output directly \(less common for env vars\)
\# cmake \-B build \-S \. \-DCMAKE\_TOOLCHAIN\_FILE\=</span>{{ steps.setup_vcpkg.outputs.vcpkg-root }}/scripts/buildsystems/vcpkg.cmake

        cmake --build build

```