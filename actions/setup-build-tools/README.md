# Setup Build Tools (CMake & vcpkg) Action

## Description

This GitHub Action streamlines the setup of essential C/C++ build tools by downloading, verifying, extracting, and caching specified versions of both **CMake** and **vcpkg**.

It performs the setup for CMake first, followed by vcpkg. It leverages `@actions/tool-cache` for efficiency across workflow runs. Additionally, it can automatically add the required CMake version to the system `PATH` and sets the `VCPKG_INSTALLATION_ROOT` environment variable for use in subsequent build steps.

This action combines and replaces the functionality of the previous separate `setup-cmake` and `setup-vcpkg` actions.

## Features

- Installs specific versions of CMake (including `latest`) and vcpkg (by tag).
- Supports Windows, Linux, and macOS runners.
- Verifies downloads using provided SHA512 hashes (optional for CMake, required for vcpkg).
- Integrates with GitHub Actions tool cache (`@actions/tool-cache`).
- Optionally uses the `TerrapinRetrievalTool` for accelerated and verified downloads on Windows (when hashes are provided).
- Optionally adds the installed CMake `bin` directory to the `PATH`.
- Sets the `VCPKG_INSTALLATION_ROOT` environment variable.

## Inputs

| Input                | Description                                                                                                                                                                       | Required | Default                                       |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: | :-------------------------------------------- |
| `cmake-version`      | The CMake version to download (e.g., `3.29.0`) or the string `"latest"` to fetch the newest release via GitHub API.                                                               |  `true`  | -                                             |
| `cmake-hash`         | **Optional.** The expected SHA512 hash (hex) of the CMake archive for the target platform/architecture. Required for download verification and enabling Terrapin usage for CMake. | `false`  | -                                             |
| `add-cmake-to-path`  | If `'true'`, adds the `bin` directory of the installed CMake version to the `PATH` environment variable.                                                                          | `false`  | `'true'`                                      |
| `vcpkg-version`      | The vcpkg tag version to download (e.g., `2023.10.19`). Find tags on the [vcpkg releases page](https://github.com/microsoft/vcpkg/tags).                                          |  `true`  | -                                             |
| `vcpkg-hash`         | The expected SHA512 hash (hex) for the specified vcpkg tag's `.zip` archive. Required for download verification and enabling Terrapin usage for vcpkg.                            |  `true`  | -                                             |
| `terrapin-tool-path` | Path to the `TerrapinRetrievalTool.exe` executable. Used for both CMake and vcpkg downloads on Windows if applicable (hashes provided, Terrapin not disabled).                    | `false`  | `C:/local/Terrapin/TerrapinRetrievalTool.exe` |
| `disable-terrapin`   | If set to `'true'`, Terrapin usage will be bypassed for both CMake and vcpkg, forcing direct downloads via `@actions/tool-cache`.                                                 | `false`  | `'false'`                                     |
| `github-token`       | GitHub token used for fetching the `"latest"` CMake version via the GitHub API. Defaults to the workflow's token.                                                                 | `false`  | `${{ github.token }}`                         |

**Finding Hashes:** You typically need to download the specific release archive (e.g., CMake `.tar.gz`/`.zip` or vcpkg `.zip` for a tag) and calculate its SHA512 hash locally using tools like `sha512sum` (Linux/macOS) or `Get-FileHash -Algorithm SHA512` (PowerShell).

**⚠️ SECURITY WARNING:** Omitting the `cmake-hash` significantly increases the risk of supply chain attacks, as the integrity of the downloaded CMake artifact will not be checked, and Terrapin cannot be used for CMake. It is **strongly recommended** to provide `cmake-hash` whenever possible, especially for production workflows. Pinning to a specific `cmake-version` and providing its corresponding hash is the most secure approach. The `vcpkg-hash` is **required**.

## Outputs

| Output       | Description                                                                                            |
| :----------- | :----------------------------------------------------------------------------------------------------- |
| `cmake-root` | The absolute path to the root directory of the cached CMake installation.                              |
| `cmake-path` | The absolute path to the directory containing the CMake executables (e.g., `.../cmake-<version>/bin`). |
| `vcpkg-root` | The absolute path to the root directory of the cached and bootstrapped vcpkg instance.                 |

## Environment Variables

This action sets the following environment variable for subsequent steps in the job:

- **`VCPKG_INSTALLATION_ROOT`**: The absolute path to the cached vcpkg installation directory (same value as the `vcpkg-root` output). This is commonly used by build systems like CMake (`-DCMAKE_TOOLCHAIN_FILE=$VCPKG_INSTALLATION_ROOT/scripts/buildsystems/vcpkg.cmake`).

Additionally, if `add-cmake-to-path` is `'true'` (the default), the action adds the path specified by the `cmake-path` output to the system `PATH`.

## Caching

- The action utilizes `@actions/tool-cache` for caching both CMake and vcpkg installations.
- The **CMake** cache key is based on the tool name (`cmake`), the resolved `cmake-version`, and the runner's platform/architecture (e.g., `linux-x86_64`).
- The **vcpkg** cache key is based on the tool name (`vcpkg`) and the `vcpkg-version`.
- It caches the **bootstrapped** version of vcpkg, meaning the `vcpkg` executable should be present and ready to use within the cached directory.
- Subsequent workflow runs hitting the cache will be significantly faster as they skip download, verification, extraction, and bootstrapping (for vcpkg).
