const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const github = require('@actions/github'); // To resolve 'latest'
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * Verifies the SHA512 hash of a downloaded file.
 * @param {string} filePath - Path to the file to verify.
 * @param {string} expectedHash - The expected SHA512 hash in hex format.
 * @returns {Promise<boolean>} - True if the hash matches, false otherwise.
 */
async function verifySHA512(filePath, expectedHash) {
    return new Promise((resolve, reject) => {
        core.info(`Calculating SHA512 for file: ${filePath}`);
        const hash = crypto.createHash('sha512');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => {
            const actualHash = hash.digest('hex');
            core.debug(`Actual SHA512: ${actualHash}`); // Use debug for potentially long hashes
            core.debug(`Expected SHA512: ${expectedHash}`);
            resolve(actualHash.toLowerCase() === expectedHash.toLowerCase());
        });
    });
}

/**
 * Gets the runner platform identifier used by CMake release artifacts.
 * @returns {string} 'windows', 'linux', or 'macos'
 */
function getPlatformIdentifier() {
    const platform = process.platform;
    if (platform === 'win32') return 'windows';
    if (platform === 'linux') return 'linux';
    if (platform === 'darwin') return 'macos';
    throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Gets the runner architecture identifier used by CMake release artifacts.
 * @returns {string} e.g., 'x86_64', 'aarch64', 'universal' (for macOS)
 */
function getArchIdentifier() {
    const arch = process.arch;
    const platform = process.platform;

    if (platform === 'darwin') {
        // CMake uses 'universal' for macOS releases covering x64 and arm64 on newer versions
        // Older versions might have used arch-specific names or different universal markers.
        // Sticking with 'universal' as the likely modern choice.
        return 'universal';
    }
    if (arch === 'x64') return 'x86_64';
    if (arch === 'arm64') return 'aarch64';
    // Add more specific architecture handling if needed (e.g., 32-bit)
    // if (platform === 'windows' && arch === 'ia32') return 'win32-x86';
    throw new Error(`Unsupported architecture: ${arch} on platform: ${platform}`);
}

/**
 * Resolves 'latest' to a specific CMake version using the GitHub API.
 * @returns {Promise<string>} The latest CMake version string (e.g., '3.28.3').
 */
async function getLatestCMakeVersion() {
    core.info('Querying GitHub API for the latest CMake release...');
    // Requires GITHUB_TOKEN to be available in the environment
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GitHub token not found. Cannot query for the latest release. Provide github-token input or ensure GITHUB_TOKEN env var is set.');
    }
    const octokit = github.getOctokit(token);
    try {
        const latestRelease = await octokit.rest.repos.getLatestRelease({
            owner: 'Kitware',
            repo: 'CMake',
        });
        const tagName = latestRelease.data.tag_name; // e.g., "v3.28.3"
        if (!tagName || !tagName.startsWith('v')) {
            throw new Error(`Unexpected tag name format for latest release: ${tagName}`);
        }
        const version = tagName.substring(1); // Remove leading 'v'
        core.info(`Latest CMake version found: ${version}`);
        return version;
    } catch (error) {
        core.error(`Failed to fetch latest CMake release: ${error.message}`);
        if (error.status === 403 || error.status === 401) {
            core.warning('GitHub API rate limit likely exceeded or token missing/invalid. Cannot resolve "latest".');
        }
        throw error; // Re-throw to fail the action
    }
}

async function run() {
    try {
        // --- Get Inputs ---
        const cmakeVersionInput = core.getInput('cmake-version', { required: true });
        const cmakeHash = core.getInput('cmake-hash'); // Optional
        const terrapinPath = core.getInput('terrapin-tool-path');
        const disableTerrapin = core.getBooleanInput('disable-terrapin');
        const addToPath = core.getBooleanInput('add-to-path'); // Defaults to true based on action.yml

        const hasHash = cmakeHash && cmakeHash.trim() !== ''; // Check if hash is provided and not empty/whitespace

        const toolName = 'cmake';
        const platform = getPlatformIdentifier();
        const arch = getArchIdentifier();

        // --- Resolve Version ---
        let resolvedCmakeVersion = cmakeVersionInput;
        if (cmakeVersionInput.toLowerCase() === 'latest') {
            if (!hasHash) {
                core.warning('Resolving "latest" CMake version without a `cmake-hash`. The downloaded artifact will not be verified.');
            } else {
                core.warning('Resolving "latest" CMake version. Ensure the provided `cmake-hash` corresponds to the actual latest version for this platform/architecture.');
            }
            resolvedCmakeVersion = await getLatestCMakeVersion();
        }
        core.info(`Setting up CMake version: ${resolvedCmakeVersion} for ${platform}-${arch}`);

        // --- Cache Check ---
        // Include platform and arch in the cache key for uniqueness
        const cacheKeyArch = `${platform}-${arch}`;
        let cmakeRootPath = tc.find(toolName, resolvedCmakeVersion, cacheKeyArch);

        if (cmakeRootPath) {
            core.info(`Found cached CMake at: ${cmakeRootPath}`);
        } else {
            // --- Cache Miss ---
            core.info(`CMake version ${resolvedCmakeVersion} (${cacheKeyArch}) not found in cache. Downloading...`);

            // --- Determine Download URL and File Info ---
            const fileExtension = platform === 'windows' ? 'zip' : 'tar.gz';
            let fileName = `cmake-${resolvedCmakeVersion}-${platform}-${arch}`;

            // Special case for macOS universal build name convention
            if (platform === 'macos' && arch === 'universal') {
                fileName = `cmake-${resolvedCmakeVersion}-macos-universal`;
            }
            // Add other platform/arch specific filename adjustments if needed

            const archiveFileName = `${fileName}.${fileExtension}`;
            const downloadUrl = `https://github.com/Kitware/CMake/releases/download/v${resolvedCmakeVersion}/${archiveFileName}`;
            core.info(`Download URL: ${downloadUrl}`);

            // --- Determine Download Method ---
            // Terrapin can only be used if enabled, on Windows, tool exists, AND a hash is provided.
            const canUseTerrapin = !disableTerrapin && platform === 'windows' && fs.existsSync(terrapinPath);
            const useTerrapin = canUseTerrapin && hasHash; // Terrapin requires hash

            // Logging about download method decision
            if (useTerrapin) {
                core.info(`Using Terrapin Tool at: ${terrapinPath} (hash provided).`);
            } else {
                 if (!disableTerrapin && platform === 'windows' && !fs.existsSync(terrapinPath)) {
                    core.info(`Terrapin retrieval tool not found at '${terrapinPath}'. Using direct download.`);
                 } else if (disableTerrapin){
                    core.info('Terrapin download explicitly disabled. Using direct download.');
                 } else if (canUseTerrapin && !hasHash) {
                     core.warning(`Terrapin is available but will not be used because 'cmake-hash' was not provided. Using direct download.`);
                 } else if (!canUseTerrapin && platform === 'windows') {
                     core.info('Using direct download on Windows.');
                 } else if (platform !== 'windows') {
                     core.info('Using direct download (non-Windows platform).');
                 }

                 // Security warning if hash is missing
                 if (!hasHash) {
                     core.warning('SECURITY RISK: `cmake-hash` was not provided. The integrity of the downloaded CMake artifact will NOT be verified.');
                 }
            }

            // --- Download ---
            let downloadedArchivePath;
            const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
            if (!runnerTempDir) {
                throw new Error('Runner temporary directory environment variable not found.');
            }
            const tempDownloadPath = path.join(runnerTempDir, archiveFileName);

            if (useTerrapin) {
                // This block is only reached if hasHash is true
                const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/'; // Base URL used by Terrapin cache? Confirm if needed.
                const terrapinArgs = [
                    '-b', terrapinBaseUrl,
                    '-a', 'true',
                    '-u', 'Environment',
                    '-p', downloadUrl,     // Actual package URL
                    '-s', cmakeHash,       // SHA512 hash for verification by Terrapin
                    '-d', tempDownloadPath // Download destination
                ];
                await core.group('Downloading CMake via Terrapin Tool', async () => {
                    await exec.exec(`"${terrapinPath}"`, terrapinArgs);
                });
                downloadedArchivePath = tempDownloadPath;
            } else {
                // Direct download using @actions/tool-cache
                await core.group('Downloading CMake directly', async () => {
                    downloadedArchivePath = await tc.downloadTool(downloadUrl, tempDownloadPath);
                });
            }
            core.info(`Download completed. Archive at: ${downloadedArchivePath}`);

            // --- Verify Download Happened ---
            if (!fs.existsSync(downloadedArchivePath)) {
                throw new Error(`Download failed: Expected file not found at ${downloadedArchivePath}`);
            }

            // --- Verify SHA512 Hash (Manual Check, only if hash provided) ---
            if (hasHash) {
                core.info('Verifying SHA512 hash...');
                const hashMatch = await verifySHA512(downloadedArchivePath, cmakeHash);
                if (!hashMatch) {
                    // Clean up potentially compromised file before failing
                    try { fs.unlinkSync(downloadedArchivePath); } catch (e) { core.warning(`Failed to delete mismatched archive: ${e.message}`); }
                    core.setFailed('SHA512 hash verification failed! Downloaded file hash does not match expected hash.');
                    return; // Stop execution
                }
                core.info('SHA512 hash verification successful.');
            } else {
                // If no hash was provided, explicitly state that verification is skipped
                core.info('Skipping SHA512 hash verification as `cmake-hash` was not provided.');
            }

            // --- Extract ---
            core.info(`Extracting ${archiveFileName}...`);
            let tempExtractPath;
            if (fileExtension === 'zip') {
                tempExtractPath = await tc.extractZip(downloadedArchivePath);
            } else { // tar.gz
                tempExtractPath = await tc.extractTar(downloadedArchivePath);
            }
            core.info(`Extracted archive to temporary location: ${tempExtractPath}`);

            // --- Locate Actual Extracted Directory ---
            // CMake archives usually extract into a subdirectory like cmake-3.28.3-windows-x86_64
            const potentialRoot = path.join(tempExtractPath, fileName); // The expected folder name inside the archive
            if (fs.existsSync(potentialRoot) && fs.statSync(potentialRoot).isDirectory()) {
                 cmakeRootPath = potentialRoot;
                 core.info(`Located extracted CMake root at: ${cmakeRootPath}`);
            } else {
                // Fallback: If the top level only contains one directory, assume that's it.
                const files = fs.readdirSync(tempExtractPath);
                const directories = files.filter(f => fs.statSync(path.join(tempExtractPath, f)).isDirectory());
                if (directories.length === 1) {
                    cmakeRootPath = path.join(tempExtractPath, directories[0]);
                    core.warning(`Expected folder '${fileName}' not found directly. Assuming single directory '${directories[0]}' is the root: ${cmakeRootPath}`);
                } else {
                     throw new Error(`Could not locate the extracted CMake directory inside ${tempExtractPath}. Contents: ${files.join(', ')}. Expected pattern: ${fileName}`);
                }
            }

            // --- Clean up downloaded archive ---
            try {
                 fs.unlinkSync(downloadedArchivePath);
                 core.info(`Cleaned up downloaded archive: ${downloadedArchivePath}`);
            } catch (e) {
                core.warning(`Failed to delete downloaded archive: ${e.message}`);
            }


            // --- Cache Directory ---
            core.info(`Caching CMake directory: ${cmakeRootPath}`);
            cmakeRootPath = await tc.cacheDir(cmakeRootPath, toolName, resolvedCmakeVersion, cacheKeyArch);
            core.info(`Successfully cached CMake to: ${cmakeRootPath}`);
        } // End if (cache miss)

        // --- Add CMake bin to PATH (Conditional) ---
        const cmakeBinPath = path.join(cmakeRootPath, 'bin');
        if (!fs.existsSync(cmakeBinPath)) {
             // This error is critical regardless of adding to path, so keep it outside the condition
             throw new Error(`CMake 'bin' directory not found within the cached/extracted path: ${cmakeBinPath}`);
        }

        if (addToPath) { // Check the input value
            core.info(`Adding ${cmakeBinPath} to PATH as 'add-to-path' is true.`);
            core.addPath(cmakeBinPath);
        } else {
            core.info(`Skipping adding ${cmakeBinPath} to PATH as 'add-to-path' is false.`);
        }

        // --- Set Outputs ---
        // Outputs are set regardless of whether it was added to PATH
        core.setOutput('cmake-root', cmakeRootPath);
        core.setOutput('cmake-path', cmakeBinPath); // Output the path even if not added to env PATH

        // --- Final Logging ---
        if (addToPath) {
             core.info(`CMake ${resolvedCmakeVersion} setup complete. Executable directory added to PATH.`);
        } else {
             core.info(`CMake ${resolvedCmakeVersion} setup complete. Executable directory NOT added to PATH (add-to-path: false).`);
        }

        // --- Verify Installation (Optional, only if added to PATH) ---
        if (addToPath) {
             await core.group('Verifying CMake installation via PATH', async () => {
                 try {
                     // Execute cmake from the PATH to verify it's found
                     await exec.exec('cmake', ['--version']);
                 } catch (error) {
                     // Log a warning instead of failing the whole action if verification fails
                     core.warning(`Verification command 'cmake --version' failed: ${error.message}. This might indicate an issue with the PATH or the CMake executable itself.`);
                 }
             });
        } else {
             core.info('Skipping CMake verification via PATH as add-to-path is false.');
        }

    } catch (error) {
        // Catch errors from any step and fail the action
        core.setFailed(error.message);
    }
}

// Run the action if invoked directly
if (require.main === module) {
    run();
}

// Export run function for testing or programmatic use
module.exports = { run, verifySHA512, getPlatformIdentifier, getArchIdentifier, getLatestCMakeVersion };