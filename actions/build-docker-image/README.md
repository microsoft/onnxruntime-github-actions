# Build Docker Image Action

This GitHub Action builds a Docker image using the standard `docker build` command. It implements an image-level caching strategy by tagging images with a checksum derived from the Dockerfile, build context, and build arguments. It attempts to pull a matching checksum-tagged image from the specified registry before building, and optionally pushes newly built images back to the registry on specific branches. It also handles registry logins for GHCR and ACR.

The build context is automatically determined as the directory containing the specified Dockerfile.

## Inputs

| Input                           | Description                                                                                                                                                                  | Required | Default     |
| :------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: | :---------- |
| `dockerfile`                    | Path to the Dockerfile (relative to repository root). The directory containing this file will be used as the build context.                                                  |   Yes    |             |
| `image-name`                    | Base image name _without_ tag (e.g., `ghcr.io/owner/repo/img`, `myacr.azurecr.io/myimg`). A calculated checksum tag will be appended for caching and potential push/pull.    |   Yes    |             |
| `build-args`                    | String of build arguments (e.g., `"ARG1=VAL1 ARG2=VAL2"`) to pass to `docker build` AND include in the cache checksum calculation.                                           |    No    | `""`        |
| `hash-algorithm`                | Hash algorithm for checksum (e.g., `sha256`, `sha512`). Must be supported by Node.js crypto module.                                                                          |    No    | `"sha256"`  |
| `push`                          | Set to `true` to push the checksum-tagged image if it was built (cache miss) **AND** if the workflow runs on an allowed branch (`main`, `rel-*`, `snnn/ci`) and is not a PR. |    No    | `"false"`   |
| `pull`                          | Set to `true` to attempt pulling the checksum-tagged image from the registry before building to check for a cache hit.                                                       |    No    | `"true"`    |
| `login-ghcr`                    | Attempt login to `ghcr.io` using `GITHUB_TOKEN`. Defaults to `true` if `image-name` starts with `ghcr.io/`, otherwise `false`. Needs `packages: write` permission.           |    No    | _(dynamic)_ |
| `azure-container-registry-name` | If provided, the action will attempt `az login --identity` and `az acr login` with this name _before_ the build (useful for pulling base images from a private ACR).         |    No    | `""`        |
| `skip-build-on-pull-hit`        | If `pull` is `true` and the image is pulled successfully (cache hit), set this to `true` to skip the `docker build` step entirely.                                           |    No    | `"true"`    |

## Outputs

| Output            | Description                                                                                                     |
| :---------------- | :-------------------------------------------------------------------------------------------------------------- |
| `cache-hit`       | `"true"` if a cached image was pulled successfully based on the checksum tag, `"false"` otherwise.              |
| `image-tag`       | The calculated checksum tag used for the image (e.g., `sha256-abcdef123...`).                                   |
| `full-image-name` | The full image name including the calculated checksum tag (e.g., `ghcr.io/owner/repo/img:sha256-abcdef123...`). |

## Caching Mechanism

This action implements **image-level caching** using checksums:

1.  **Checksum Calculation:** A checksum (default: SHA256) is calculated based on:
    - The content of the specified `dockerfile`.
    - The normalized content of the `build-args` input string.
    - The runner's User ID (`BUILD_UID`) on non-Windows platforms.
    - The relative paths and content of **all** files within the derived build `context` directory (excluding `.git/**`). **Note:** This does _not_ currently respect `.dockerignore`. Changes to ignored files will still invalidate the cache.
2.  **Image Tag:** The checksum is used to create a tag in the format `<hash-algorithm>-<checksum>`.
3.  **Pull Attempt (`pull: true`):** The action attempts to pull `<image-name>:<checksum-tag>` from the registry specified in `image-name`. If successful, it's a cache hit.
4.  **Build (`skip-build-on-pull-hit: false` or Cache Miss):** If the pull fails (cache miss) or skipping is disabled, `docker build` is executed, tagging the new image with the `<image-name>:<checksum-tag>`. The action also applies a local convenience tag `<image-name>:latest`.
5.  **Push (`push: true`):** If the image was _built_ (cache miss) _and_ the workflow was triggered by a push (not `pull_request`) _and_ the branch is `main`, starts with `rel-`, or is `snnn/ci`, the newly built `<image-name>:<checksum-tag>` is pushed to the registry.

This provides a reasonably robust cache that only updates from specific branches, preventing feature branches from overwriting the cache used by others, while still allowing all builds to benefit from pulling existing cached images.

## Authentication

- **GHCR:** If `login-ghcr` is `true` (which is the default if `image-name` starts with `ghcr.io/`), the action attempts to log in using the workflow's `GITHUB_TOKEN`. Ensure the workflow has `permissions: packages: write`.
- **ACR:** If `azure-container-registry-name` is provided, the action attempts to log in using `az login --identity` and `az acr login --name <registry-name>`. This requires Azure credentials (like workload identity federation) to be configured for the runner environment. This login happens _before_ the build, making it suitable for accessing private ACR base images specified in the `Dockerfile`.

## Usage Example

```yaml
name: Build App

on:
  push:
    branches: [main, 'rel-*', 'snnn/ci'] # Trigger on branches allowed to push cache
  pull_request:
    branches: [main] # Trigger on PRs targeting main
  workflow_dispatch:

# Grant permissions needed for logins and potentially push
permissions:
  contents: read
  packages: write # Needed for login-ghcr: true and push: true to GHCR
  id-token: write # Required for Azure Workload Identity Federation (if using az login)

jobs:
  build_docker:
    name: Build App Docker Image
    runs-on: ubuntu-latest # Or windows-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      # Optional: Needed if using Azure login for base images or target registry
      # - name: Set up Azure login
      #   uses: azure/login@v1
      #   with:
      #     client-id: ${{ secrets.AZURE_CLIENT_ID }}
      #     tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      #     subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      # Setup Node.js to build the action itself (if testing local changes)
      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install Action Dependencies
        run: npm ci # In the root of the actions repo
      - name: Build Actions
        run: npm run build # In the root of the actions repo

      # Run the build-docker-image action
      - name: Build Docker Image w/ Cache
        id: docker_build # Give step an ID to access outputs
        uses: ./actions/build-docker-image # Use local path during development/CI
        with:
          dockerfile: src/app/Dockerfile # Path to your Dockerfile
          image-name: ghcr.io/${{ github.repository_owner }}/${{ github.repository }}/my-app # Base name for GHCR
          build-args: "VERSION=${{ github.sha }} BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
          push: true # Allow pushing from allowed branches if build occurs
          pull: true # Attempt to pull cache first
          login-ghcr: true # Login to GHCR
          # azure-container-registry-name: 'myacrnaforkbaseimages' # Optional: If base image is from ACR
          skip-build-on-pull-hit: true

      - name: Test Built Image (if build happened or cache hit)
        # Use outcome check OR cache-hit output
        if: steps.docker_build.outcome == 'success'
        run: |
          echo "Cache hit: ${{ steps.docker_build.outputs.cache-hit }}"
          echo "Image tag: ${{ steps.docker_build.outputs.image-tag }}"
          echo "Using image: ${{ steps.docker_build.outputs.full-image-name }}"
          # Example: Run a command in the container
          docker run --rm ${{ steps.docker_build.outputs.full-image-name }} --version

      - name: Use Simpler :latest Tag Locally (if build happened or cache hit)
        # This uses the local tag created by the action if a build occurred
        if: steps.docker_build.outputs.cache-hit == 'false' && steps.docker_build.outcome == 'success'
        run: |
          echo "Running container using simpler :latest tag..."
          docker run --rm ghcr.io/${{ github.repository_owner }}/${{ github.repository }}/my-app:latest echo "Hello from :latest tag"
```
