const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const path = require('path');
const fs = require('fs'); // Needed for verifySHA512 stream
const crypto = require('crypto'); // Needed for verifySHA512

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
            core.info(`Actual SHA512: ${actualHash}`);
            core.info(`Expected SHA512: ${expectedHash}`);
            resolve(actualHash.toLowerCase() === expectedHash.toLowerCase());
        });
    });
}

async function run() {
    try {
        // --- Get Inputs ---
        const vcpkgVersion = core.getInput('vcpkg-version', { required: true });
        const vcpkgHash = core.getInput('vcpkg-hash', { required: true });
        const terrapinPath = core.getInput('terrapin-tool-path', { required: true });

        const toolName = 'vcpkg';
        const extractedFolderName = `vcpkg-${vcpkgVersion}`;

        core.info(`Setting up vcpkg version: ${vcpkgVersion}`);
        core.info(`Using Terrapin Tool at: ${terrapinPath}`);

        // --- Cache Check ---
        let vcpkgPath = tc.find(toolName, vcpkgVersion);

        if (vcpkgPath) {
            core.info(`Found cached vcpkg at: ${vcpkgPath}`);
        } else {
            // --- Cache Miss ---
            core.info(`vcpkg version ${vcpkgVersion} not found in cache. Downloading via Terrapin Tool...`);

            // --- Determine Download Destination ---
            const runnerTempDir = process.env.RUNNER_TEMP;
            if (!runnerTempDir) {
                throw new Error('RUNNER_TEMP environment variable is not defined.');
            }
            const vcpkgZipPath = path.join(runnerTempDir, 'vcpkg.zip');
            core.info(`Terrapin will download to: ${vcpkgZipPath}`);

            // --- Execute Terrapin Download ---
            // Note: Terrapin might *also* verify the hash via -s argument.
            const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';
            const terrapinPackageUrl = `https://github.com/microsoft/vcpkg/archive/refs/tags/${vcpkgVersion}.zip`;
            const terrapinArgs = [
                '-b', terrapinBaseUrl,
                '-a', 'true',
                '-u', 'Environment',
                '-p', terrapinPackageUrl,
                '-s', vcpkgHash, // Hash for verification by Terrapin
                '-d', vcpkgZipPath
            ];

            await core.group('Downloading vcpkg via Terrapin Tool', async () => {
                await exec.exec(`"${terrapinPath}"`, terrapinArgs);
            });
            core.info(`Download via Terrapin completed.`);

            // --- Verify Download Happened ---
            if (!fs.existsSync(vcpkgZipPath)) {
                throw new Error(`Download failed: Expected file not found at ${vcpkgZipPath} after Terrapin execution.`);
            }

            // --- Verify SHA512 Hash (Manual Check) ---
            core.info('Verifying SHA512 hash (manual check)...');
            const hashMatch = await verifySHA512(vcpkgZipPath, vcpkgHash);
            if (!hashMatch) {
                // Use core.setFailed for clear failure indication in GitHub Actions UI
                core.setFailed('SHA512 hash verification failed! Downloaded file hash does not match expected hash.');
                return; // Stop execution if hash fails
            }
            core.info('Manual hash verification successful.');
            // --- End Manual Hash Check ---


            // --- Extract ---
            core.info(`Extracting ${vcpkgZipPath}...`);
            const tempExtractPath = await tc.extractZip(vcpkgZipPath);
            core.info(`Extracted vcpkg to temporary location: ${tempExtractPath}`);

            let extractedPath = path.join(tempExtractPath, extractedFolderName);
             if (!fs.existsSync(extractedPath)) {
                 const files = fs.readdirSync(tempExtractPath);
                 core.warning(`Expected folder '${extractedFolderName}' not found directly. Contents: ${files.join(', ')}`);
                 if (files.length === 1 && fs.statSync(path.join(tempExtractPath, files[0])).isDirectory()) {
                     core.warning(`Assuming first directory '${files[0]}' is the correct one.`);
                     extractedPath = path.join(tempExtractPath, files[0]);
                 } else {
                    throw new Error(`Could not find the extracted vcpkg directory inside ${tempExtractPath}. Expected name pattern: ${extractedFolderName}`);
                 }
            }

            // --- Bootstrap vcpkg ---
            core.info(`Bootstrapping vcpkg in ${extractedPath}...`);
            const bootstrapScriptName = process.platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh';
            const bootstrapScriptPath = path.join(extractedPath, bootstrapScriptName);
            const bootstrapArgs = ['-disableMetrics'];

            if (!fs.existsSync(bootstrapScriptPath)) {
                throw new Error(`Bootstrap script not found at ${bootstrapScriptPath}`);
            }

            await core.group('Running vcpkg bootstrap', async () => {
                const options = { cwd: extractedPath };
                if (process.platform !== 'win32') {
                    await exec.exec('chmod', ['+x', bootstrapScriptPath]);
                }
                core.info(`Executing: ${bootstrapScriptPath} ${bootstrapArgs.join(' ')}`);
                await exec.exec(bootstrapScriptPath, bootstrapArgs, options);
            });
            core.info('vcpkg bootstrapped successfully.');

            // --- Cache Directory ---
            core.info(`Caching bootstrapped directory: ${extractedPath}`);
            vcpkgPath = await tc.cacheDir(extractedPath, toolName, vcpkgVersion);
            core.info(`Successfully cached vcpkg to: ${vcpkgPath}`);
        }

        // --- Set Environment Variable & Output ---
        core.info(`Setting VCPKG_INSTALLATION_ROOT to ${vcpkgPath}`);
        core.exportVariable('VCPKG_INSTALLATION_ROOT', vcpkgPath);
        core.setOutput('vcpkg-root', vcpkgPath);

        core.info('vcpkg setup complete.');

    } catch (error) {
        // Catch errors from exec, hash check failure (via setFailed), etc.
        // If core.setFailed was already called, this will likely just reiterate.
        // If an exception was thrown (e.g., download failed, file not found), this catches it.
        core.setFailed(error.message);
    }
}

if (require.main === module) {
  run();
}

// Always export run for testing or other programmatic usage
module.exports = { run };