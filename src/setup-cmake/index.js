const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec'); // Keep direct exec for verification step? Or use helper?
const github = require('@actions/github');
const path = require('node:path');
const fs = require('node:fs'); // Keep direct fs for sync operations
const os = require('node:os'); // Keep direct os for tmpdir

// Import shared utilities
const {
    executeCommand,
    verifySHA512,
    getPlatformIdentifier,
    getArchIdentifier
} = require('../common/utils');

// --- getLatestCMakeVersion (Keep here as it's specific and uses github) ---
async function getLatestCMakeVersion() {
    core.info('Querying GitHub API for the latest CMake release...');
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    if (!token) { throw new Error('GitHub token not found.'); }
    const octokit = github.getOctokit(token);
    try {
        const latestRelease = await octokit.rest.repos.getLatestRelease({ owner: 'Kitware', repo: 'CMake' });
        const tagName = latestRelease.data.tag_name;
        if (!tagName || !tagName.startsWith('v')) { throw new Error(`Unexpected tag format: ${tagName}`); }
        const version = tagName.substring(1);
        core.info(`Latest CMake version found: ${version}`);
        return version;
    } catch (error) { /* ... error handling ... */ core.error(`Failed to fetch latest CMake release: ${error.message}`); if (error.status === 403 || error.status === 401) { core.warning('GitHub API rate limit/auth error.'); } throw error; }
}

async function run() {
    try {
        // --- Get Inputs ---
        const cmakeVersionInput = core.getInput('cmake-version', { required: true });
        const cmakeHash = core.getInput('cmake-hash'); // Optional
        const terrapinPath = core.getInput('terrapin-tool-path');
        const disableTerrapin = core.getBooleanInput('disable-terrapin');
        const addToPath = core.getBooleanInput('add-to-path');

        const hasHash = cmakeHash && cmakeHash.trim() !== '';
        const toolName = 'cmake';
        const platform = getPlatformIdentifier(); // USE UTIL
        const arch = getArchIdentifier(); // USE UTIL

        // --- Resolve Version ---
        let resolvedCmakeVersion = cmakeVersionInput;
        if (cmakeVersionInput.toLowerCase() === 'latest') {
             if (!hasHash) { core.warning('Resolving "latest" without hash.'); }
             else { core.warning('Resolving "latest". Ensure hash matches.'); }
             resolvedCmakeVersion = await getLatestCMakeVersion(); // USE LOCAL HELPER
        }
        core.info(`Setting up CMake version: ${resolvedCmakeVersion} for ${platform}-${arch}`);

        // --- Cache Check ---
        const cacheKeyArch = `${platform}-${arch}`;
        let cmakeRootPath = tc.find(toolName, resolvedCmakeVersion, cacheKeyArch);

        if (cmakeRootPath) {
            core.info(`Found cached CMake at: ${cmakeRootPath}`);
        } else {
            // --- Cache Miss ---
            core.info(`CMake version ${resolvedCmakeVersion} (${cacheKeyArch}) not found in cache. Downloading...`);

            // Determine Download URL/File Info (logic unchanged)
            const fileExtension = platform === 'windows' ? 'zip' : 'tar.gz';
            let fileName = `cmake-${resolvedCmakeVersion}-${platform}-${arch}`;
            if (platform === 'macos' && arch === 'universal') { fileName = `cmake-${resolvedCmakeVersion}-macos-universal`; }
            const archiveFileName = `${fileName}.${fileExtension}`;
            const downloadUrl = `https://github.com/Kitware/CMake/releases/download/v${resolvedCmakeVersion}/${archiveFileName}`;
            core.info(`Download URL: ${downloadUrl}`);

            // Determine Download Method (logic unchanged, uses fs.existsSync)
            const canUseTerrapin = !disableTerrapin && platform === 'windows' && fs.existsSync(terrapinPath);
            const useTerrapin = canUseTerrapin && hasHash;
            // ... (Logging about download method - unchanged) ...
            if (useTerrapin) { core.info(`Using Terrapin Tool at: ${terrapinPath} (hash provided).`); }
            else { /* ... logging for direct download reasons ... */ }
            if (!hasHash) { core.warning('SECURITY RISK: `cmake-hash` not provided. Integrity will NOT be verified.'); }


            // Download (use executeCommand for Terrapin)
            let downloadedArchivePath;
            const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
            if (!runnerTempDir) { throw new Error('Runner temporary directory not found.'); }
            const tempDownloadPath = path.join(runnerTempDir, archiveFileName);

            if (useTerrapin) {
                const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';
                const terrapinArgs = [ '-b', terrapinBaseUrl, '-a', 'true', '-u', 'Environment', '-p', downloadUrl, '-s', cmakeHash, '-d', tempDownloadPath ];
                await core.group('Downloading CMake via Terrapin Tool', async () => {
                    await executeCommand(`"${terrapinPath}"`, terrapinArgs); // USE UTIL
                });
                downloadedArchivePath = tempDownloadPath;
            } else {
                await core.group('Downloading CMake directly', async () => {
                    downloadedArchivePath = await tc.downloadTool(downloadUrl, tempDownloadPath); // Keep using tc.downloadTool
                });
            }
            core.info(`Download completed. Archive at: ${downloadedArchivePath}`);

            // Verify Download Happened (uses fs.existsSync)
            if (!fs.existsSync(downloadedArchivePath)) { throw new Error(`Download failed: File not found at ${downloadedArchivePath}`); }

            // Verify SHA512 Hash (uses verifySHA512 util)
            if (hasHash) {
                core.info('Verifying SHA512 hash...');
                const hashMatch = await verifySHA512(downloadedArchivePath, cmakeHash); // USE UTIL
                if (!hashMatch) {
                    try { fs.unlinkSync(downloadedArchivePath); } catch (e) { core.warning(`Failed to delete mismatched archive: ${e.message}`); }
                    core.setFailed('SHA512 hash verification failed!');
                    return;
                }
                core.info('SHA512 hash verification successful.');
            } else {
                core.info('Skipping SHA512 hash verification as `cmake-hash` was not provided.');
            }

            // Extract (uses tc.extractZip/Tar)
            core.info(`Extracting ${archiveFileName}...`);
            let tempExtractPath;
            if (fileExtension === 'zip') { tempExtractPath = await tc.extractZip(downloadedArchivePath); }
            else { tempExtractPath = await tc.extractTar(downloadedArchivePath); }
            core.info(`Extracted archive to temporary location: ${tempExtractPath}`);

            // Locate Actual Extracted Directory (uses sync fs, keep as is)
            const potentialRoot = path.join(tempExtractPath, fileName);
            if (fs.existsSync(potentialRoot) && fs.statSync(potentialRoot).isDirectory()) { cmakeRootPath = potentialRoot; }
            else { /* ... fallback logic using readdirSync ... */
                const files = fs.readdirSync(tempExtractPath); const directories = files.filter(f => fs.statSync(path.join(tempExtractPath, f)).isDirectory());
                if (directories.length === 1) { cmakeRootPath = path.join(tempExtractPath, directories[0]); core.warning(`Assuming single directory '${directories[0]}' is root.`); }
                else { throw new Error(`Could not locate extracted CMake directory in ${tempExtractPath}.`); }
            }
             core.info(`Located extracted CMake root at: ${cmakeRootPath}`);

            // Clean up downloaded archive (uses sync fs)
            try { fs.unlinkSync(downloadedArchivePath); core.info(`Cleaned up downloaded archive: ${downloadedArchivePath}`); }
            catch (e) { core.warning(`Failed to delete downloaded archive: ${e.message}`); }

            // Cache Directory (uses tc.cacheDir)
            core.info(`Caching CMake directory: ${cmakeRootPath}`);
            cmakeRootPath = await tc.cacheDir(cmakeRootPath, toolName, resolvedCmakeVersion, cacheKeyArch);
            core.info(`Successfully cached CMake to: ${cmakeRootPath}`);
        } // End cache miss


        // Add CMake bin to PATH (Conditional)
        const cmakeBinPath = path.join(cmakeRootPath, 'bin');
        if (!fs.existsSync(cmakeBinPath)) { throw new Error(`CMake 'bin' directory not found: ${cmakeBinPath}`); }
        if (addToPath) { core.info(`Adding ${cmakeBinPath} to PATH.`); core.addPath(cmakeBinPath); }
        else { core.info(`Skipping adding ${cmakeBinPath} to PATH.`); }

        // Set Outputs
        core.setOutput('cmake-root', cmakeRootPath);
        core.setOutput('cmake-path', cmakeBinPath);

        // Final Logging
        if (addToPath) { core.info(`CMake ${resolvedCmakeVersion} setup complete. Added to PATH.`); }
        else { core.info(`CMake ${resolvedCmakeVersion} setup complete. NOT added to PATH.`); }

        // Verify Installation (Optional, only if added to PATH - keep direct exec)
        if (addToPath) {
             await core.group('Verifying CMake installation via PATH', async () => {
                 try { await exec.exec('cmake', ['--version']); } // Keep direct exec for simple verification
                 catch (error) { core.warning(`Verification 'cmake --version' failed: ${error.message}.`); }
             });
        } else { core.info('Skipping CMake verification via PATH.'); }

    } catch (error) {
        core.setFailed(error.message);
    }
}

// Run main if executed directly
if (require.main === module) { run(); }
// Export run for testing
module.exports = { run, getLatestCMakeVersion }; // Export local helper too if needed for tests