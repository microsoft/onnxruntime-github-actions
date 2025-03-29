const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec'); // Keep direct exec for chmod and bootstrap script
const path = require('node:path');
const fs = require('node:fs'); // Keep direct sync fs for existsSync, readdirSync, statSync, unlinkSync
const os = require('node:os'); // For tmpdir fallback

// Import shared utilities
const { verifySHA512, executeCommand } = require('../common/utils');

// --- Helper Functions ---

/**
 * Gets and validates the action inputs.
 */
function getInputs() {
    const vcpkgVersion = core.getInput('vcpkg-version', { required: true });
    const vcpkgHash = core.getInput('vcpkg-hash', { required: true });
    const terrapinPath = core.getInput('terrapin-tool-path'); // Default handled by core.getInput if specified in action.yml
    return { vcpkgVersion, vcpkgHash, terrapinPath };
}

/**
 * Attempts to download the vcpkg zip file either using Terrapin or tc.downloadTool.
 * Returns the path to the downloaded zip file.
 */
async function downloadVcpkgZip(version, hash, terrapinPath) {
    let downloadedZipPath;
    const downloadUrl = `https://github.com/microsoft/vcpkg/archive/refs/tags/${version}.zip`;

    if (terrapinPath && fs.existsSync(terrapinPath)) { // Check existence *before* deciding path
        core.info(`Using Terrapin Tool at: ${terrapinPath}`);
        const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
        if (!runnerTempDir) throw new Error('Could not determine temporary directory.');

        // Use a consistent naming convention based on the source code
        downloadedZipPath = path.join(runnerTempDir, 'vcpkg.zip');
        core.info(`Terrapin will download to: ${downloadedZipPath}`);

        const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';
        const terrapinArgs = [ '-b', terrapinBaseUrl, '-a', 'true', '-u', 'Environment', '-p', downloadUrl, '-s', hash, '-d', downloadedZipPath ];

        await core.group('Downloading vcpkg via Terrapin Tool', async () => {
            // Ensure quotes around path if it might contain spaces
             await executeCommand(`"${terrapinPath}"`, terrapinArgs);
        });
        core.info(`Download via Terrapin completed.`);
    } else {
        if (terrapinPath) {
             core.warning(`Terrapin tool path provided but not found at '${terrapinPath}'. Attempting direct download.`);
        } else {
             core.info('Terrapin tool path not provided. Attempting direct download.');
        }
        downloadedZipPath = await tc.downloadTool(downloadUrl);
        core.info(`Direct download completed. Archive at: ${downloadedZipPath}`);
    }

    // Verify download happened *after* the attempt
    if (!fs.existsSync(downloadedZipPath)) {
        throw new Error(`Download failed: Expected file not found at ${downloadedZipPath}.`);
    }
    return downloadedZipPath;
}

/**
 * Extracts the Vcpkg zip file and returns the path to the extraction directory.
 */
async function extractVcpkgZip(downloadedZipPath) {
    core.info(`Extracting ${path.basename(downloadedZipPath)}...`);
    const tempExtractPath = await tc.extractZip(downloadedZipPath);
    core.info(`Extracted vcpkg to temporary location: ${tempExtractPath}`);
    return tempExtractPath;
}

/**
 * Locates the actual vcpkg source directory within the extraction folder.
 * Handles cases where it's nested inside another directory.
 */
function findActualVcpkgDir(tempExtractPath, vcpkgVersion) {
    // Expected primary directory name based on the tag
    const primaryExpectedDir = path.join(tempExtractPath, `vcpkg-${vcpkgVersion}`);
    if (fs.existsSync(primaryExpectedDir)) {
        core.info(`Found extracted vcpkg directory: ${primaryExpectedDir}`);
        return primaryExpectedDir;
    }
    core.warning(`Expected folder pattern 'vcpkg-${vcpkgVersion}' not found directly in ${tempExtractPath}.`);

    // Fallback 1: Look for a *single* subdirectory inside the extraction path
    const files = fs.readdirSync(tempExtractPath);
    core.debug(`Contents of ${tempExtractPath}: ${files.join(', ')}`);
    const directories = files.filter(f => {
         try { return fs.statSync(path.join(tempExtractPath, f)).isDirectory(); }
         catch { return false; } // Ignore errors like permission denied during check
    });

    if (directories.length === 1) {
        const nestedPath = path.join(tempExtractPath, directories[0]);
        core.warning(`Assuming single nested directory '${directories[0]}' is the correct one: ${nestedPath}`);
        return nestedPath;
    }

    // Fallback 2: Check if tag had 'v' prefix but directory doesn't
    if (vcpkgVersion.startsWith('v')) {
        const fallbackVersion = vcpkgVersion.substring(1);
        const fallbackPath = path.join(tempExtractPath, `vcpkg-${fallbackVersion}`);
        if (fs.existsSync(fallbackPath)) {
             core.warning(`Found extracted dir matching tag without 'v' prefix: ${fallbackPath}`);
             return fallbackPath;
        }
    }

    throw new Error(`Could not reliably find the extracted vcpkg directory inside ${tempExtractPath}. Found directories: ${directories.join(', ')}`);
}


/**
 * Runs the vcpkg bootstrap script.
 */
async function bootstrapVcpkg(extractedPath) {
    core.info(`Bootstrapping vcpkg in ${extractedPath}...`);
    const platform = process.platform; // Get platform info internally
    const bootstrapScriptName = platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh';
    const bootstrapScriptPath = path.join(extractedPath, bootstrapScriptName);
    const bootstrapArgs = ['-disableMetrics'];

    if (!fs.existsSync(bootstrapScriptPath)) {
        throw new Error(`Bootstrap script not found at ${bootstrapScriptPath}`);
    }

    await core.group('Running vcpkg bootstrap', async () => {
        const options = { cwd: extractedPath };
        if (platform !== 'win32') {
            await exec.exec('chmod', ['+x', bootstrapScriptPath]); // Keep direct exec
        }
        core.info(`Executing: ${bootstrapScriptPath} ${bootstrapArgs.join(' ')}`);
        await exec.exec(bootstrapScriptPath, bootstrapArgs, options); // Keep direct exec
    });
    core.info('vcpkg bootstrapped successfully.');
}

/**
 * Caches the bootstrapped vcpkg directory.
 */
async function cacheVcpkgDir(extractedPath, toolName, version) {
    core.info(`Caching bootstrapped directory: ${extractedPath}`);
    const finalPath = await tc.cacheDir(extractedPath, toolName, version);
    core.info(`Successfully cached vcpkg to: ${finalPath}`);
    return finalPath;
}

/**
 * Cleans up the downloaded zip file.
 */
function cleanupDownload(downloadedZipPath) {
     try {
        if (downloadedZipPath && fs.existsSync(downloadedZipPath)) {
             fs.unlinkSync(downloadedZipPath);
             core.info(`Cleaned up downloaded archive: ${downloadedZipPath}`);
        }
     } catch (e) { core.warning(`Failed to delete downloaded archive: ${e.message}`); }
}


// --- Main Orchestration Function ---
async function run() {
    let downloadedZipPath; // Keep track for cleanup
    let finalVcpkgPath;
    try {
        const { vcpkgVersion, vcpkgHash, terrapinPath } = getInputs();
        const toolName = 'vcpkg';

        core.info(`Setting up vcpkg version: ${vcpkgVersion}`);

        // Check cache first
        finalVcpkgPath = tc.find(toolName, vcpkgVersion);

        if (finalVcpkgPath) {
            core.info(`Found cached vcpkg at: ${finalVcpkgPath}`);
        } else {
            // Cache Miss Flow
            core.info(`vcpkg version ${vcpkgVersion} not found in cache.`);

            downloadedZipPath = await downloadVcpkgZip(vcpkgVersion, vcpkgHash, terrapinPath);
            await verifySHA512(downloadedZipPath, vcpkgHash); // verifySHA512 throws/fails action if mismatch
            const tempExtractPath = await extractVcpkgZip(downloadedZipPath);
            const extractedPath = findActualVcpkgDir(tempExtractPath, vcpkgVersion);
            await bootstrapVcpkg(extractedPath);
            finalVcpkgPath = await cacheVcpkgDir(extractedPath, toolName, vcpkgVersion);
        }

        // Set Environment Variable & Output
        core.info(`Setting VCPKG_INSTALLATION_ROOT to ${finalVcpkgPath}`);
        core.exportVariable('VCPKG_INSTALLATION_ROOT', finalVcpkgPath);
        core.setOutput('vcpkg-root', finalVcpkgPath);

        core.info('vcpkg setup complete.');

    } catch (error) {
        core.setFailed(error.message);
    } finally {
        // Cleanup downloaded zip regardless of success/failure if path was determined
        if (!finalVcpkgPath && downloadedZipPath) { // Only cleanup if we didn't find in cache initially
             cleanupDownload(downloadedZipPath);
        }
    }
}

// Run main if executed directly
if (require.main === module) { run(); }

// Export run and helpers for testing
module.exports = {
    run,
    getInputs,
    downloadVcpkgZip,
    extractVcpkgZip,
    findActualVcpkgDir,
    bootstrapVcpkg,
    cacheVcpkgDir,
    cleanupDownload,
};