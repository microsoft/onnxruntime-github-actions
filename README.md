# ONNX Runtime GitHub Actions

This repository contains reusable GitHub Actions designed primarily for CI/CD pipelines within the ONNX Runtime organization's projects. It consolidates multiple actions into a single Node.js project to simplify maintenance and avoid checking compiled JavaScript code into consuming repositories.

This project uses `esbuild` to compile the JavaScript source code for each action. The compiled output is **not** committed to the `main` branch. Instead, releases are created based on Git tags, and the compiled actions are attached as downloadable assets to GitHub Releases.

## Project Structure

* `/src`: Contains the source TypeScript/JavaScript code for each action in its own subdirectory.
* `/actions`: Contains the `action.yml` metadata file for each action in its own subdirectory.
* `/build`: (Generated, not committed to `main`) Contains the compiled output after running `npm run build`. Each action has a subdirectory here containing its `action.yml` and `dist/index.js`.
* `package.json`: Manages dependencies and build scripts for all actions.
* `esbuild.config.mjs`: Configuration file for the `esbuild` bundler.

## Available Actions

1.  **`build-docker-image`**
    * Builds a Docker image, with optional caching and pushing via Azure Container Registry. This Action is Linux only.
    * See: [`actions/build-docker-image/action.yml`](./actions/build-docker-image/action.yml)
	* See details: [`.github/actions/build-docker-image/README.md`](./.github/actions/build-docker-image/README.md)    

2.  **`run-build-script-in-docker`**
    * Runs the ONNX Runtime `tools/ci_build/build.py` script inside a specified Docker container. This Action is Linux only.
    * Supports different modes (`update`, `build`, `test`).
    * Includes auto-detection for NVIDIA GPUs (`--gpus all`).
    * Manages common volume mounts (workspace, cache, test data).
    * Handles enabling execution providers via `--use_<ep>` flags.
    * See: [`actions/run-build-script-in-docker/action.yml`](./actions/run-build-script-in-docker/action.yml)

3.  **`setup-vcpkg`**
    * Downloads, verifies, bootstraps, and caches a specific tagged version of vcpkg. This Action is Windows only.
    * Sets the `VCPKG_INSTALLATION_ROOT` environment variable for subsequent steps.
    * Leverages `@actions/tool-cache` for efficient caching.
    * See: [`.github/actions/setup-vcpkg/action.yml`](./.github/actions/setup-vcpkg/action.yml)
    * See details: [`.github/actions/setup-vcpkg/README.md`](./.github/actions/setup-vcpkg/README.md)

## Usage (for Consumers)

Because the compiled action code (in the `build/` directory) is not present on the `main` branch or directly associated with version tags in the repository filesystem, you **cannot** use the actions directly like this:

```yaml
# --- THIS WILL NOT WORK ---
# uses: microsoft/onnxruntime-github-actions/build/run-build-script-in-docker@vX.Y.Z
```

Instead, you must download the compiled action bundle from the corresponding GitHub Release asset and reference it locally:

1. Find the Release: Go to the Releases page of this repository.
2. Identify Version: Find the release tag (e.g., v0.0.2) corresponding to the version you want to use.
3. Download Asset: Download the .zip asset attached to that release (e.g., onnxruntime-actions-v0.0.2.zip).
4. Use in Workflow: Add steps to your workflow to download and unzip the asset, then reference the action using its local path.

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

      # 1. Download the specific version of the action bundle
      - name: Download ORT Actions Asset (v0.0.2) # <-- Adjust version as needed
        uses: dsaltares/fetch-gh-release-asset@1.1.0 # Action to download assets
        with:
          repo: 'microsoft/onnxruntime-github-actions'   # The repo containing the actions
          version: 'tags/v0.0.2'                          # The specific tag/version to use
          file: 'onnxruntime-actions-v0.0.2.zip'         # The asset filename (matches release workflow output)
          target: 'onnxruntime-actions.zip'             # Local filename to save as
        env:
          # Use default token for public repos, provide PAT for private if necessary
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # 2. Unzip the downloaded actions
      - name: Unzip ORT Actions
        run: |
          mkdir -p ./.github/_downloaded_actions # Create a directory to hold them
          unzip onnxruntime-actions.zip -d ./.github/_downloaded_actions
          echo "Unzipped contents:"
          ls -lR ./.github/_downloaded_actions # Verify structure

      # 3. Use the action via its local path
      - name: Run Build Script in Docker
        # Reference the action.yml inside the unzipped structure
        uses: ./.github/_downloaded_actions/run-build-script-in-docker
        with:
          # Provide inputs for the action
          docker_image: 'your-build-image:latest'
          build_config: 'Release'
          mode: 'build' # Or 'update', 'test'
          execution_providers: 'cuda tensorrt'
          # ... other inputs ...

```


# Integration Test

Before making a release, please use the following steps to do an integration test with ONNX Runtime's main repo. While the standard release process involves tags and downloadable assets (as described in the "Usage" section), we need to test changes in a consuming repository *before* an official release is tagged, using the direct `uses:` syntax. This can be achieved by temporarily committing the compiled `build/` directory to a specific branch or commit.

**Note:** This method involves committing build artifacts to the Git repository, which is generally discouraged for the `main` branch as it increases repository size and complicates diffs. Use this approach primarily on short-lived development/feature branches for integration testing purposes.

**Steps that should be done in this repo:**

1.  **Create a Branch:** Create a new development branch in *this* repository (e.g., `dev/feature-xyz`).
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
2.  Modify the `uses:` line for the action you want to test to point to the specific branch or commit SHA in *this* actions repository:

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
    *(Replace `<full_commit_sha_from_actions_repo>` with the actual SHA obtained in step 6 above).*

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
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
