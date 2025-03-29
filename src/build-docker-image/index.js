// src/build-docker-image/index.js
// Updated: 2025-03-29 - Add BUILD_UID to checksum calculation

const core = require('@actions/core');
const glob = require('@actions/glob');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = require('@actions/exec');
const github = require('@actions/github');
const os = require('node:os');

// Import shared utilities
const {
    executeCommand,
    hashFileContent,
    parseBuildArgs,
    normalizeBuildArgsForHashing
} = require('../common/utils');


// --- Helper Functions ---

/**
 * Gets inputs and derives initial configuration.
 */
function getInputsAndConfig() {
    const dockerfilePath = core.getInput('dockerfile', { required: true });
    const imageNameBase = core.getInput('image-name', { required: true });
    const buildArgsInput = core.getInput('build-args');
    const hashAlgorithm = core.getInput('hash-algorithm') || 'sha256';
    const shouldPushInputString = core.getInput('push');
    const shouldPullString = core.getInput('pull');
    const skipBuildOnPullHitString = core.getInput('skip-build-on-pull-hit');
    const acrNameToLogin = core.getInput('azure-container-registry-name').trim();
    const shouldLoginGhcrInput = core.getInput('login-ghcr');
    const contextPath = path.dirname(dockerfilePath) || '.';
    core.info(`Dockerfile path: ${dockerfilePath}`);
    core.info(`Derived Context path: ${contextPath}`);
    const ghcrRegistry = 'ghcr.io';
    let targetRegistry = ''; let targetAcrName = '';
    if (imageNameBase.startsWith(`${ghcrRegistry}/`)) { targetRegistry = ghcrRegistry; }
    else if (imageNameBase.includes('.azurecr.io/')) { targetAcrName = imageNameBase.substring(0, imageNameBase.indexOf('.azurecr.io')); targetRegistry = `${targetAcrName}.azurecr.io`; }
    else if (imageNameBase.includes('/')) { targetRegistry = imageNameBase.substring(0, imageNameBase.indexOf('/')); core.warning(`Detected potential push/pull target registry "${targetRegistry}".`); }
    else { targetRegistry = 'docker.io'; core.info(`No registry specified in push/pull target image name.`); }
    core.info(`Push/Pull target registry determined as: ${targetRegistry || 'Default (Docker Hub/Local)'}`);
    const shouldPushInput = core.getBooleanInput('push');
    const shouldPull = (shouldPullString === '') ? true : core.getBooleanInput('pull');
    const skipBuildOnPullHit = (skipBuildOnPullHitString === '') ? true : core.getBooleanInput('skip-build-on-pull-hit');
    const defaultLoginGhcr = targetRegistry === ghcrRegistry;
    const shouldLoginGhcr = shouldLoginGhcrInput === '' ? defaultLoginGhcr : core.getBooleanInput('login-ghcr');
    const attemptAcrLogin = (acrNameToLogin !== '');
    return { dockerfilePath, imageNameBase, buildArgsInput, hashAlgorithm, shouldPushInput, shouldPull, skipBuildOnPullHit, acrNameToLogin, contextPath, targetRegistry, targetAcrName, shouldLoginGhcr, attemptAcrLogin, ghcrRegistry };
}

/**
 * Performs logins to ACR and GHCR based on configuration.
 */
async function performLogins(config) {
    let loggedInAcrName = ''; let loggedInGhcr = false;
    if (config.attemptAcrLogin) { core.info(`Attempting Azure login for ACR: ${config.acrNameToLogin}...`); try { await executeCommand('az', ['login', '--identity', '--allow-no-subscriptions', '--output', 'none']); await executeCommand('az', ['acr', 'login', '--name', config.acrNameToLogin]); loggedInAcrName = config.acrNameToLogin; core.info(`Successfully logged into Azure and ACR: ${config.acrNameToLogin}`); } catch (error) { core.warning(`Azure login/ACR login failed for ${config.acrNameToLogin}: ${error.message}.`); } }
    else { core.info("ACR login skipped: `azure-container-registry-name` was not provided."); }
    if (config.shouldLoginGhcr) { core.info(`Attempting login to GHCR: ${config.ghcrRegistry}...`); const githubToken = process.env.GITHUB_TOKEN; if (!githubToken) { core.warning('GITHUB_TOKEN needed but not found.'); } else { try { const loginArgs = ['login', config.ghcrRegistry, '-u', github.context.actor, '--password-stdin']; const loginOptions = { input: Buffer.from(githubToken), sensitive: true }; await executeCommand('docker', loginArgs, loginOptions); loggedInGhcr = true; } catch (e) { core.warning(`GHCR login failed: ${e.message}`); } } }
    else { core.info('GHCR login skipped: Not required.'); }
    return { loggedInAcrName, loggedInGhcr };
}

/**
 * Calculates the checksum based on Dockerfile, context, args, and UID.
 */
async function calculateChecksum(config, uid) {
    core.info(`Calculating ${config.hashAlgorithm} checksum...`);
    const hash = crypto.createHash(config.hashAlgorithm);

    // 1. Hash Dockerfile
    core.info(`Hashing Dockerfile: ${config.dockerfilePath}`);
    await hashFileContent(hash, config.dockerfilePath);

    // 2. Hash Normalized Build Args
    const normalizedArgs = normalizeBuildArgsForHashing(config.buildArgsInput);
    if (normalizedArgs) { core.info(`Hashing normalized build args:\n${normalizedArgs}`); hash.update(normalizedArgs); }
    else { core.info('No build args provided to hash.'); }

    // --- 3. Hash BUILD_UID ---
    // Hash the UID value itself to factor it into the checksum
    const uidString = `BUILD_UID=${uid}`;
    core.info(`Hashing runner UID context: ${uidString}`);
    hash.update(uidString);
    // -------------------------

    // --- 4. Hash Context Directory Files --- (Index changed from 3 to 4)
    core.info(`Hashing context directory: ${config.contextPath}`);
    const globber = await glob.create(`${config.contextPath}/**`, { followSymbolicLinks: true, dot: true, ignore: [`${config.contextPath}/.git/**`] }); const filesToHash = [];
    for await (const file of globber.globGenerator()) { try { const stat = await fs.stat(file); if (stat.isFile()) { const relativePath = path.relative(config.contextPath, file); filesToHash.push({ absolute: file, relative: relativePath }); } } catch (error) { /* Ignore glob errors */ } } filesToHash.sort((a, b) => a.relative.localeCompare(b.relative)); core.info(`Found ${filesToHash.length} files in context to hash.`);
    for (const fileInfo of filesToHash) { core.debug(`Hashing path: ${fileInfo.relative}`); hash.update(fileInfo.relative.replace(/\\/g, '/')); await hashFileContent(hash, fileInfo.absolute); }

    return hash.digest('hex');
}

/**
 * Attempts to pull the checksum-tagged image. Returns true on success (cache hit).
 */
async function attemptPullCache(fullImageNameWithTag, shouldPull) {
    if (!shouldPull) { core.info('Skipping cache pull attempt (pull: false).'); return false; } core.info(`Attempting to pull cached image: ${fullImageNameWithTag}`); try { const exitCode = await exec.exec('docker', ['pull', fullImageNameWithTag], { ignoreReturnCode: true }); if (exitCode === 0) { core.info(`Cache hit! Image ${fullImageNameWithTag} pulled successfully.`); return true; } else { core.info(`Cache miss. Image ${fullImageNameWithTag} not found or pull failed (Exit code: ${exitCode}).`); return false; } } catch (error) { core.warning(`Error during docker pull (treating as cache miss): ${error.message}`); return false; }
}

/**
 * Copies deps.txt from source to context if it doesn't exist.
 */
async function ensureDepsFile(contextPath) {
    const repoDir = process.env.GITHUB_WORKSPACE; if (!repoDir) { core.warning('GITHUB_WORKSPACE not set, cannot copy deps.txt.'); return; } const dstDepsFile = path.join(contextPath, 'scripts', 'deps.txt'); const srcDepsFile = path.join(repoDir, 'cmake', 'deps.txt'); try { await fs.access(dstDepsFile); core.info('deps.txt already exists in context.'); } catch { core.info(`Attempting to copy deps.txt to: ${dstDepsFile}`); try { await fs.access(srcDepsFile); await fs.mkdir(path.dirname(dstDepsFile), { recursive: true }); await fs.copyFile(srcDepsFile, dstDepsFile); core.info(`Copied deps.txt from ${srcDepsFile}`); } catch (copyError) { if (copyError.code === 'ENOENT' && copyError.path === srcDepsFile) { core.info(`Source deps.txt (${srcDepsFile}) not found. Skipping copy.`); } else { core.warning(`Failed to copy deps.txt: ${copyError.message}.`); } } }
}


/**
 * Builds the Docker image using docker build, including UID arg.
 * <<< Added uid parameter >>>
 */
async function buildImage(config, fullImageNameWithTag, uid) { // <-- Added uid parameter
    core.info('Building image...');
    const buildCommand = ['build'];

    // Add user-provided build args first
    buildCommand.push(...parseBuildArgs(config.buildArgsInput));

    // --- Add BUILD_UID build-arg ---
    // Use the UID passed as a parameter
    if (uid !== -1) {
        core.info(`Adding --build-arg BUILD_UID=${uid}`);
        buildCommand.push('--build-arg', `BUILD_UID=${uid}`);
    } else {
         // This case should only happen on Windows or if os.userInfo() failed earlier
         core.info('Skipping BUILD_UID build-arg (UID is -1).');
    }
    // -------------------------------

    // Add tag, Dockerfile, context
    buildCommand.push('-t', fullImageNameWithTag);
    buildCommand.push('-f', config.dockerfilePath);
    buildCommand.push(config.contextPath);

    await executeCommand('docker', buildCommand);
    core.info(`Image built successfully: ${fullImageNameWithTag}`);
}

/**
 * Tags the locally built/pulled image with a simpler :latest tag.
 */
async function tagImageLocally(fullImageNameWithTag, imageNameBase) {
    const localTag = `${imageNameBase}:latest`; try { core.info(`Applying local tag: ${localTag}`); await executeCommand('docker', ['tag', fullImageNameWithTag, localTag]); core.info(`Successfully tagged image locally as ${localTag}`); } catch (error) { core.warning(`Failed to apply local tag ${localTag}: ${error.message}`); }
}


/**
 * Pushes the checksum-tagged image if conditions are met.
 */
async function pushImage(config, loginResult, fullImageNameWithTag, cacheHit) {
    const eventName = github.context.eventName; const ref = github.context.ref; let branchName = ''; if (ref && ref.startsWith('refs/heads/')) { branchName = ref.substring('refs/heads/'.length); } const isAllowedBranch = branchName === 'main' || branchName.startsWith('rel-') || branchName === 'snnn/ci'; const isEligibleForPush = config.shouldPushInput && !cacheHit && eventName !== 'pull_request' && isAllowedBranch; core.info(`Checking push conditions: shouldPushInput=${config.shouldPushInput}, cacheHit=${cacheHit}, eventName=${eventName}, branchName=${branchName}, isAllowedBranch=${isAllowedBranch}`); if (isEligibleForPush) { core.info(`Pushing newly built image to registry: ${fullImageNameWithTag}`); const isTargetAcr = config.targetRegistry.endsWith('.azurecr.io'); const loggedIntoTarget = (config.targetRegistry === config.ghcrRegistry && loginResult.loggedInGhcr) || (isTargetAcr && loginResult.loggedInAcrName === config.targetAcrName && loginResult.loggedInAcrName !== ''); if (!loggedIntoTarget && config.targetRegistry !== 'docker.io') { core.warning(`Push requested but login to target registry ${config.targetRegistry} failed or wasn't attempted. Push might fail.`); } await executeCommand('docker', ['push', fullImageNameWithTag]); core.info('Image pushed successfully.'); } else { /* ... logging skip reasons ... */ }
}

/**
 * Performs docker logout if logins were successful.
 */
async function performLogouts(loginResult, config) {
     if (loginResult.loggedInGhcr) { try { core.info(`Logging out from GHCR: ${config.ghcrRegistry}`); await executeCommand('docker', ['logout', config.ghcrRegistry]); } catch (e) { core.warning(`GHCR logout failed: ${e.message}`); } } if (loginResult.loggedInAcrName) { const registryUrl = `${loginResult.loggedInAcrName}.azurecr.io`; try { core.info(`Logging out from ACR: ${registryUrl}`); await executeCommand('docker', ['logout', registryUrl]); } catch (e) { core.warning(`ACR logout failed: ${e.message}`); } }
}


// --- Main Orchestration Function ---
async function run() {
    let loginResult = { loggedInGhcr: false, loggedInAcrName: '' };
    let fullImageNameWithChecksumTag = '';
    let config = {};

    try {
        config = getInputsAndConfig();

        // --- Determine UID early ---
        let uid = -1; // Default UID if detection fails or on Windows
        try {
             if (process.platform !== 'win32') {
                 uid = os.userInfo().uid;
             }
             if (uid === -1 && process.platform !== 'win32') {
                  core.warning('Could not determine valid UID on non-Windows platform.');
             } else if (uid !== -1) {
                  core.info(`Determined runner UID: ${uid}`);
             } else {
                  core.info('Running on Windows or UID not applicable, using default UID context for hashing.');
             }
        } catch (uidError) {
             core.warning(`Failed to get runner UID (${uidError.message}), using default UID context for hashing.`);
        }
        // -------------------------

        loginResult = await performLogins(config);

        // Pass UID to calculateChecksum
        const checksum = await calculateChecksum(config, uid); // <-- Pass UID
        const imageTag = `${config.hashAlgorithm}-${checksum}`;
        fullImageNameWithChecksumTag = `${config.imageNameBase}:${imageTag}`;

        core.info(`Calculated Image Tag: ${imageTag}`);
        core.info(`Full Image Name: ${fullImageNameWithChecksumTag}`);
        core.setOutput('image-tag', imageTag);
        core.setOutput('full-image-name', fullImageNameWithChecksumTag);

        let cacheHit = await attemptPullCache(fullImageNameWithChecksumTag, config.shouldPull);
        core.setOutput('cache-hit', cacheHit.toString());

        let builtImage = false;
        if (cacheHit && config.skipBuildOnPullHit) {
            core.info('Skipping Docker build step due to cache hit.');
        } else {
             if (cacheHit) core.info('Cache hit, but build is not skipped.');
             else core.info('Cache miss or pull disabled. Building image...');

             await ensureDepsFile(config.contextPath); // Ensure deps copied before build

             // Pass UID to buildImage
             await buildImage(config, fullImageNameWithChecksumTag, uid); // <-- Pass UID
             builtImage = true;
             cacheHit = false;
             core.setOutput('cache-hit', 'false');

             // Tag locally AFTER successful build
             await tagImageLocally(fullImageNameWithChecksumTag, config.imageNameBase);
        }

        await pushImage(config, loginResult, fullImageNameWithChecksumTag, cacheHit);

        core.info('Action finished successfully.');

    } catch (error) {
        core.setFailed(`Action failed: ${error.message}`);
    } finally {
        await performLogouts(loginResult, config);
    }
}

// --- Run ---
if (require.main === module) { run(); }

// --- Exports ---
module.exports = {
    run,
    getInputsAndConfig,
    performLogins,
    calculateChecksum, // Expose potentially modified helper
    attemptPullCache,
    ensureDepsFile,
    buildImage,       // Expose potentially modified helper
    tagImageLocally,
    pushImage,
    performLogouts
};