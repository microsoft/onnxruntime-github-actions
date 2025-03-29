const core = require('@actions/core');
const glob = require('@actions/glob');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = require('@actions/exec');
const github = require('@actions/github');

// Helper Function to Run Exec (same as before)
async function executeCommand(command, args, options = {}) {
    core.info(`Executing: ${command} ${args.join(' ')}`);
    const displayArgs = args.map(arg => (options.sensitive && arg === process.env.GITHUB_TOKEN) ? '***' : arg);
    core.info(`Executing: ${command} ${displayArgs.join(' ')}`);
    const { exitCode, stdout, stderr } = await exec.getExecOutput(command, args, { ignoreReturnCode: true, ...options });
    if (exitCode !== 0) {
        core.error(`Command failed with exit code ${exitCode}`);
        core.error(`stdout: ${stdout}`);
        core.error(`stderr: ${stderr}`);
        throw new Error(`Command "${command} ${displayArgs.join(' ')}" failed with exit code ${exitCode}`);
    }
    core.debug(`stdout: ${stdout}`);
    if (stderr && stderr.trim() !== '') { core.warning(`stderr: ${stderr.trim()}`); }
    return { stdout, stderr };
}

// Helper to parse build args string into array of --build-arg flags (same as before)
function parseBuildArgs(buildArgsString) { const args = []; if (!buildArgsString) return args; const regex = /([\w.-]+)=("[^"]+"|'[^']+'|[^'"\s]+)/g; let match; while ((match = regex.exec(buildArgsString)) !== null) { args.push('--build-arg', match[0]); } return args; }
// Helper to normalize build args string for hashing (same as before)
function normalizeBuildArgsForHashing(buildArgsString) { if (!buildArgsString || buildArgsString.trim() === '') { return ''; } const argsArray = buildArgsString.match(/([\w.-]+)=("[^"]+"|'[^']+'|[^'"\s]+)/g) || []; argsArray.sort(); return argsArray.join('\n'); }
// Helper to hash file content (same as before)
async function hashFileContent(hash, filePath) { try { const stat = await fs.stat(filePath); if (stat.isFile()) { const fileBuffer = await fs.readFile(filePath); hash.update(fileBuffer); core.debug(`Hashed content of: ${filePath}`); } else { core.warning(`Path is not a file, skipping content hashing: ${filePath}`); } } catch (error) { if (error.code === 'ENOENT') { core.warning(`File not found for hashing: ${filePath}. Skipping content.`); } else { core.error(`Error accessing file ${filePath} for hashing: ${error.message}`); throw error; } } }

async function run() {
    let loggedInGhcr = false;
    let loggedInAcrName = ''; // Store the name of the ACR we logged into
    const ghcrRegistry = 'ghcr.io';

    try {
        // --- Get Inputs ---
        const dockerfilePath = core.getInput('dockerfile', { required: true });
        const contextPath = core.getInput('context', { required: true });
        const imageNameBase = core.getInput('image-name', { required: true });
        const buildArgsInput = core.getInput('build-args');
        const hashAlgorithm = core.getInput('hash-algorithm') || 'sha256';
        const shouldPushInput = core.getBooleanInput('push');
        const shouldPull = core.getBooleanInput('pull');
        const skipBuildOnPullHit = core.getBooleanInput('skip-build-on-pull-hit');
        // Login related inputs
        const acrNameToLogin = core.getInput('azure-container-registry-name').trim();
        // login-acr input removed

        // Determine target registry for push/pull logic
        let targetRegistry = '';
        let targetAcrName = ''; // ACR name derived from target image-name, if applicable
        if (imageNameBase.startsWith(`${ghcrRegistry}/`)) {
            targetRegistry = ghcrRegistry;
        } else if (imageNameBase.includes('.azurecr.io/')) {
            targetAcrName = imageNameBase.substring(0, imageNameBase.indexOf('.azurecr.io'));
            targetRegistry = `${targetAcrName}.azurecr.io`;
        } else if (imageNameBase.includes('/')) {
            targetRegistry = imageNameBase.substring(0, imageNameBase.indexOf('/'));
            core.warning(`Detected potential push/pull target registry "${targetRegistry}". Generic login might be required.`);
        } else {
            targetRegistry = 'docker.io';
            core.info(`No registry specified in push/pull target image name, assuming Docker Hub or local.`);
        }
        core.info(`Push/Pull target registry determined as: ${targetRegistry || 'Default (Docker Hub/Local)'}`);

        // Determine if GHCR login is needed (for target push/pull)
        const defaultLoginGhcr = targetRegistry === ghcrRegistry;
        const shouldLoginGhcr = core.getInput('login-ghcr') === '' ? defaultLoginGhcr : core.getBooleanInput('login-ghcr');


        // --- Perform Logins BEFORE Checksum/Build ---

        // ACR Login (Now only triggered if azure-container-registry-name is provided)
        if (acrNameToLogin) {
             core.info(`Attempting Azure login for ACR: ${acrNameToLogin} (likely for base image pulls)...`);
             try {
                 await executeCommand('az', ['login', '--identity', '--allow-no-subscriptions', '--output', 'none']);
                 await executeCommand('az', ['acr', 'login', '--name', acrNameToLogin]);
                 loggedInAcrName = acrNameToLogin; // Store name if successful
                 core.info(`Successfully logged into Azure and ACR: ${acrNameToLogin}`);
             } catch (error) {
                 core.warning(`Azure login or ACR login failed for ${acrNameToLogin}: ${error.message}. Base image pulls or operations involving this registry may fail.`);
             }
        } else {
             core.info("ACR login skipped: `azure-container-registry-name` was not provided.");
        }

        // GHCR Login (if needed for target push/pull)
        if (shouldLoginGhcr) { // No change here, depends on target
            core.info(`Attempting login to GHCR: ${ghcrRegistry}...`);
            const githubToken = process.env.GITHUB_TOKEN;
            if (!githubToken) {
                 core.warning('GITHUB_TOKEN needed for login-ghcr but not found. GHCR operations may fail.');
            } else {
                 try {
                     await executeCommand('docker', ['login', ghcrRegistry, '-u', github.context.actor, '-p', githubToken], { sensitive: true });
                     loggedInGhcr = true; // Mark success
                 } catch (e) { core.warning(`GHCR login failed: ${e.message}`); }
            }
        }

        // --- Calculate Checksum (same as before) ---
        core.info(`Calculating ${hashAlgorithm} checksum...`);
        const hash = crypto.createHash(hashAlgorithm);
        // ... (hashing logic for dockerfile, build-args, context - unchanged) ...
        core.info(`Hashing Dockerfile: ${dockerfilePath}`); await hashFileContent(hash, dockerfilePath);
        const normalizedArgs = normalizeBuildArgsForHashing(buildArgsInput); if (normalizedArgs) { core.info(`Hashing normalized build args:\n${normalizedArgs}`); hash.update(normalizedArgs); } else { core.info('No build args provided to hash.'); }
        core.info(`Hashing context directory: ${contextPath}`);
        const globber = await glob.create(`${contextPath}/**`, { followSymbolicLinks: true, dot: true, ignore: [`${contextPath}/.git/**`] }); const filesToHash = [];
        for await (const file of globber.globGenerator()) { try { const stat = await fs.stat(file); if (stat.isFile()) { const relativePath = path.relative(contextPath, file); filesToHash.push({ absolute: file, relative: relativePath }); } } catch (error) { /* Ignore glob errors */ } } filesToHash.sort((a, b) => a.relative.localeCompare(b.relative)); core.info(`Found ${filesToHash.length} files in context to hash.`);
        for (const fileInfo of filesToHash) { core.debug(`Hashing path: ${fileInfo.relative}`); hash.update(fileInfo.relative.replace(/\\/g, '/')); await hashFileContent(hash, fileInfo.absolute); }
        // Finalize hash and create tag
        const checksum = hash.digest('hex'); const imageTag = `${hashAlgorithm}-${checksum}`; const fullImageNameWithChecksumTag = `${imageNameBase}:${imageTag}`;
        core.info(`Calculated Image Tag: ${imageTag}`); core.info(`Full Image Name: ${fullImageNameWithChecksumTag}`);
        core.setOutput('image-tag', imageTag); core.setOutput('full-image-name', fullImageNameWithChecksumTag);


        // --- Pull Attempt (Image Cache Read) (same logic as before) ---
        let cacheHit = false;
        if (shouldPull) { /* ... docker pull logic ... */
             core.info(`Attempting to pull cached image: ${fullImageNameWithChecksumTag}`); try { const exitCode = await exec.exec('docker', ['pull', fullImageNameWithChecksumTag], { ignoreReturnCode: true }); if (exitCode === 0) { core.info(`Cache hit! Image ${fullImageNameWithChecksumTag} pulled successfully.`); cacheHit = true; } else { core.info(`Cache miss. Image ${fullImageNameWithChecksumTag} not found/pull failed (Exit code: ${exitCode}).`); } } catch (error) { core.warning(`Error during docker pull (treating as cache miss): ${error.message}`); }
        } else { core.info('Skipping cache pull attempt (pull: false).'); }
        core.setOutput('cache-hit', cacheHit.toString());


        // --- Build (Conditional) (same logic as before) ---
        if (cacheHit && skipBuildOnPullHit) {
            core.info('Skipping Docker build step due to cache hit.');
        } else { /* ... docker build logic ... */
             if (cacheHit && !skipBuildOnPullHit) { core.info('Cache hit, but build is not skipped. Proceeding with build...'); }
             else { core.info('Cache miss or pull disabled. Building image...'); }
             const buildCommand = ['build']; buildCommand.push(...parseBuildArgs(buildArgsInput)); buildCommand.push('-t', fullImageNameWithChecksumTag); buildCommand.push('-f', dockerfilePath); buildCommand.push(contextPath);
             await executeCommand('docker', buildCommand);
             core.info(`Image built successfully: ${fullImageNameWithChecksumTag}`);
             cacheHit = false; core.setOutput('cache-hit', 'false');
        }

        // --- Push (Conditional with Branch/Event Logic) (same logic as before) ---
        const eventName = github.context.eventName; const ref = github.context.ref; let branchName = ''; if (ref && ref.startsWith('refs/heads/')) { branchName = ref.substring('refs/heads/'.length); }
        const isAllowedBranch = branchName === 'main' || branchName.startsWith('rel-') || branchName === 'snnn/ci';
        const isEligibleForPush = shouldPushInput && !cacheHit && eventName !== 'pull_request' && isAllowedBranch;
        core.info(`Checking push conditions: shouldPushInput=${shouldPushInput}, cacheHit=${cacheHit}, eventName=${eventName}, branchName=${branchName}, isAllowedBranch=${isAllowedBranch}`);
        if (isEligibleForPush) { /* ... docker push logic ... */
             core.info(`Pushing newly built image to registry: ${fullImageNameWithChecksumTag}`);
             // Check login status for the specific target registry before push
             const isTargetAcr = targetRegistry.endsWith('.azurecr.io');
             const loggedIntoTarget = (targetRegistry === ghcrRegistry && loggedInGhcr) || (isTargetAcr && loggedInAcrName === targetAcrName && loggedInAcrName !== ''); // Check loggedInAcrName matches target ACR name
             if (!loggedIntoTarget && targetRegistry !== 'docker.io') {
                 core.warning(`Push requested but login to target registry ${targetRegistry} might have failed or was not attempted successfully. Push might fail.`);
             }
             await executeCommand('docker', ['push', fullImageNameWithChecksumTag]); core.info('Image pushed successfully.');
        } else { /* ... logging for why push is skipped ... */
             if (!shouldPushInput) { core.info('Skipping push: push input was set to false.'); } else if (cacheHit) { core.info('Skipping push: Image was pulled from cache (cache-hit).'); } else if (eventName === 'pull_request') { core.info('Skipping push: Workflow triggered by a pull_request event.'); } else if (!isAllowedBranch) { core.info(`Skipping push: Branch "${branchName || 'N/A'}" is not in the allowed list.`); } else { core.info(`Skipping push: Conditions not met.`); }
        }

        core.info('Action finished successfully.');

    } catch (error) {
        core.setFailed(`Action failed: ${error.message}`);
    } finally {
        // --- Logouts ---
         if (loggedInGhcr) { try { core.info(`Logging out from GHCR: ${ghcrRegistry}`); await executeCommand('docker', ['logout', ghcrRegistry]); } catch (e) { core.warning(`GHCR logout failed: ${e.message}`); } }
         // Logout from ACR only if we logged in successfully using a specific name
         if (loggedInAcrName) {
             const registryUrl = `${loggedInAcrName}.azurecr.io`;
             try { core.info(`Logging out from ACR: ${registryUrl}`); await executeCommand('docker', ['logout', registryUrl]); } catch (e) { core.warning(`ACR logout failed: ${e.message}`); }
         }
    }
}

// Run the main function if executed directly
if (require.main === module) { run(); }
// Export run for testing or programmatic usage
module.exports = { run };