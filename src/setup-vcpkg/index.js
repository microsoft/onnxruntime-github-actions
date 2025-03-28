const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec'); // Import exec
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Helper function to verify SHA512 hash
async function verifySHA512(filePath, expectedHash) {
    return new Promise((resolve, reject) => {
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
        const toolName = 'vcpkg';
        const downloadUrl = `https://github.com/microsoft/vcpkg/archive/refs/tags/${vcpkgVersion}.zip`;
        const extractedFolderName = `vcpkg-${vcpkgVersion}`;

        core.info(`Setting up vcpkg version: ${vcpkgVersion}`);

        // --- Cache Check ---
        let vcpkgPath = tc.find(toolName, vcpkgVersion);

        if (vcpkgPath) {
            core.info(`Found cached vcpkg at: ${vcpkgPath}`);
        } else {
            core.info(`vcpkg version ${vcpkgVersion} not found in cache. Downloading from ${downloadUrl}`);

            // --- Download ---
            const vcpkgZipPath = await tc.downloadTool(downloadUrl);
            core.info(`Downloaded vcpkg zip to: ${vcpkgZipPath}`);

            // --- Verify Hash ---
            core.info('Verifying SHA512 hash...');
            const hashMatch = await verifySHA512(vcpkgZipPath, vcpkgHash);
            if (!hashMatch) {
                throw new Error('SHA512 hash verification failed!');
            }
            core.info('Hash verification successful.');

            // --- Extract ---
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

            core.info(`Bootstrapping vcpkg in ${extractedPath}...`);
            const bootstrapScriptName = process.platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh';
            const bootstrapScriptPath = path.join(extractedPath, bootstrapScriptName);
            const bootstrapArgs = ['-disableMetrics']; // Common argument for CI

            // Ensure the script exists before trying to run it
            if (!fs.existsSync(bootstrapScriptPath)) {
                throw new Error(`Bootstrap script not found at ${bootstrapScriptPath}`);
            }

            await core.group('Running vcpkg bootstrap', async () => {
                const options = { cwd: extractedPath }; // Execute in the extracted vcpkg directory

                // On non-Windows, make sure the script is executable
                if (process.platform !== 'win32') {
                    await exec.exec('chmod', ['+x', bootstrapScriptPath]);
                }

                // Execute the bootstrap script
                core.info(`Executing: ${bootstrapScriptPath} ${bootstrapArgs.join(' ')}`);
                await exec.exec(bootstrapScriptPath, bootstrapArgs, options);
            });
            core.info('vcpkg bootstrapped successfully.');
            // --- !! End Bootstrap Section !! ---


            // --- Cache Directory (now caches the bootstrapped version) ---
            core.info(`Caching bootstrapped directory: ${extractedPath}`);
            vcpkgPath = await tc.cacheDir(extractedPath, toolName, vcpkgVersion);
            core.info(`Successfully cached vcpkg to: ${vcpkgPath}`);
        }

        // --- Set Environment Variable ---
        core.info(`Setting VCPKG_INSTALLATION_ROOT to ${vcpkgPath}`);
        core.exportVariable('VCPKG_INSTALLATION_ROOT', vcpkgPath);

        // --- Set Output ---
        core.setOutput('vcpkg-root', vcpkgPath);

        core.info('vcpkg setup complete.');

    } catch (error) {
        core.setFailed(error.message);
    }
}

// Only call run() automatically if this script is the main entry point
if (require.main === module) {
  run();
}

// Always export run for testing or other programmatic usage
module.exports = { run };