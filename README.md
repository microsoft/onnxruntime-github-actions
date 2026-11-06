# ONNX Runtime GitHub Actions

This repository contains reusable GitHub Actions designed primarily for CI/CD pipelines within the ONNX Runtime organization's projects. It consolidates multiple actions into a single Node.js project to simplify maintenance and avoid checking compiled JavaScript code into consuming repositories.

This project uses `esbuild` to compile the JavaScript source code for each action. The compiled output is **not** committed to the `main` branch. Instead, the release workflow builds the actions and commits the compiled output before creating a GitHub Release.

## Project Structure

- `/src`: Contains the source TypeScript/JavaScript code for each action in its own subdirectory.
- `/actions`: Contains the `action.yml` metadata file for each action in its own subdirectory.
- `/build`: (Generated, not committed to `main`) Contains the compiled output after running `npm run build`. Each action has a subdirectory here containing its `action.yml` and `dist/index.js`.
- `package.json`: Manages dependencies and build scripts for all actions.
- `esbuild.config.mjs`: Configuration file for the `esbuild` bundler.

## Available Actions

1.  **`build-docker-image`**

    - Builds a Docker image, with optional caching and pushing via Azure Container Registry. This Action is Linux only.
    - See: [`actions/build-docker-image/action.yml`](./actions/build-docker-image/action.yml)
    - See details: [`.github/actions/build-docker-image/README.md`](./.github/actions/build-docker-image/README.md)

2.  **`run-build-script-in-docker`**

    - Runs the ONNX Runtime `tools/ci_build/build.py` script inside a specified Docker container. This Action is Linux only.
    - Supports different modes (`update`, `build`, `test`).
    - Includes auto-detection for NVIDIA GPUs (`--gpus all`).
    - Manages common volume mounts (workspace, cache, test data).
    - Handles enabling execution providers via `--use_<ep>` flags.
    - See: [`actions/run-build-script-in-docker/action.yml`](./actions/run-build-script-in-docker/action.yml)

3.  **`setup-build-tools`**

    - Sets up specified versions of CMake and vcpkg for build environments.
    - Downloads, verifies (via SHA512 hash), extracts, and caches the tools using `@actions/tool-cache`.
    - Runs CMake setup first, then vcpkg setup (including bootstrapping).
    - Optionally adds the installed CMake version to the system `PATH`.
    - Sets the `VCPKG_INSTALLATION_ROOT` environment variable for use with toolchain files.
    - Supports Windows, Linux, and macOS runners.
    - See: [`actions/setup-build-tools/action.yml`](./actions/setup-build-tools/action.yml)
    - See details: [`actions/setup-build-tools/README.md`](./actions/setup-build-tools/README.md)

## Usage (for Consumers)

Reference an action directly using a published release tag. Replace `vX.Y.Z` with the desired version from the [Releases page](https://github.com/microsoft/onnxruntime-github-actions/releases):

```yaml
uses: microsoft/onnxruntime-github-actions/run-build-script-in-docker@vX.Y.Z
```

Example Workflow Snippet:

```yaml
name: Example Workflow Using ORT Actions

on: [push]

jobs:
  build_with_ort_action:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Consumer Repo
        uses: actions/checkout@v4

      - name: Run Build Script in Docker
        uses: microsoft/onnxruntime-github-actions/run-build-script-in-docker@vX.Y.Z
        with:
          # Provide inputs for the action
          docker_image: 'your-build-image:latest'
          build_config: 'Release'
          mode: 'build' # Or 'update', 'test'
          execution_providers: 'cuda tensorrt'
          # ... other inputs ...
```

## Integration Test

Before making a release, please use the following steps to do an integration test with ONNX Runtime's main repo. To test changes in a consuming repository _before_ an official release is tagged, temporarily commit the compiled `build/` directory to a development branch. Unlike published release tags, these test commits keep the actions under `build/`, so their `uses:` paths include that directory.

**Note:** This method involves committing build artifacts to the Git repository, which is generally discouraged for the `main` branch as it increases repository size and complicates diffs. Use this approach primarily on short-lived development/feature branches for integration testing purposes.

**Steps that should be done in this repo:**

1.  **Create a Branch:** Create a new development branch in _this_ repository (e.g., `dev/feature-xyz`).
2.  **Make Changes:** Modify the action source code (`src/`) and/or metadata (`actions/`).
3.  **Build:** Run `npm run build` from the repository root. This generates the output in the `build/` directory.
4.  **Commit Build Output:** Stage and commit **both** your source code changes AND the entire generated `build/` directory. You may need to bypass the `.gitignore` for the `build/` directory:
    ```bash
    git add src/ actions/ # Stage source changes
    git add --force build/ # Force staging of the ignored build directory
    git commit -m "feat: Update action XYZ (including build output for testing)"
    ```
5.  **Push Branch:** Push your development branch to the origin: `git push origin dev/feature-xyz`.
6.  **Get Commit SHA (Recommended):** After pushing, get the full commit SHA of your latest commit on the development branch (e.g., using `git rev-parse HEAD` or from the GitHub UI).

**Steps that should be done in the main ONNX Runtime repo**

1.  Create a dev branch
2.  Modify the `uses:` line for the action you want to test to point to the specific branch or commit SHA in _this_ actions repository:

    ```yaml
    steps:
      - name: Run Pre-Release Build Script in Docker
        # Option 1: Using the branch name (updates automatically if branch changes)
        # uses: microsoft/onnxruntime-github-actions/build/run-build-script-in-docker@dev/feature-xyz

        # Option 2: Using the specific commit SHA (safer - pins to exact version)
        uses: microsoft/onnxruntime-github-actions/build/run-build-script-in-docker@<full_commit_sha_from_actions_repo>
        with:
          # ... inputs ...
    ```

    _(Replace `<full_commit_sha_from_actions_repo>` with the actual SHA obtained in step 6 above)._

## Creating a Release

Releases are automated by [`.github/workflows/release.yml`](./.github/workflows/release.yml), which runs when a tag matching `v*.*.*` is pushed. You need permission to push tags, and repository rules must allow the workflow to force-update the release tag.

1. Complete the [integration test](#integration-test), merge the intended source changes into `main` without the temporary build artifacts, and ensure CI passes.
2. Choose a new version tag for the release (it should be of the form `vX.Y.Z`, where `X`, `Y`, and `Z` are numbers). Fetch the latest `main`, tag the desired source commit, and push the tag:

   ```bash
   git fetch origin
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

   Replace `vX.Y.Z` with the chosen version. To release a specific source commit instead of the latest `main`, replace `origin/main` with its full SHA. The workflow uses the tag name as the release version.

3. Wait for the release workflow to succeed on the [Actions page](https://github.com/microsoft/onnxruntime-github-actions/actions/workflows/release.yml), then confirm the release appears on the [Releases page](https://github.com/microsoft/onnxruntime-github-actions/releases).

The workflow installs dependencies with `npm ci`, runs `npm run build`, copies the compiled actions and essential documentation into a separate artifact history, force-updates the remote tag to the artifact commit, and creates a GitHub Release with generated notes.

**Important:** After the workflow succeeds, the remote release tag points to the artifact commit, not the source commit you originally tagged. Your local tag still points to the source commit. Do not push it again or use it as the released artifact SHA. The artifact commit message records the source commit SHA.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
