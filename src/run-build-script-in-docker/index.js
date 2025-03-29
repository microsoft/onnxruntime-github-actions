const core = require('@actions/core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

// Import shared utilities
const { executeCommand, checkPathExists } = require('../common/utils'); // Import helpers

// List of known EP names (keep local or move to common if used elsewhere?) - Keep local for now
const KNOWN_EPS = new Set([ 'acl', 'armnn', 'azure', 'cann', 'coreml', 'cuda', 'dml', 'dnnl', 'migraphx', 'nnapi', 'openvino', 'qnn', 'rknpu', 'rocm', 'snpe', 'tensorrt', 'vitisai', 'vsinpu', 'webgpu', 'webnn', 'xnnpack']);
const knownEpsString = Array.from(KNOWN_EPS).sort().join(', ');

// checkGpu uses exec directly for failure tolerance/specific handling, keep as is or adapt helper?
// Keep direct exec here as error handling is specific (warning, not throwing)
async function checkGpu() {
    let hasGpu = false;
    try {
        const options = { ignoreReturnCode: true, silent: true }; // Don't fail action if nvidia-smi not found
        core.info('Checking for NVIDIA GPU using nvidia-smi...');
        // Use direct exec here because we want to check the exit code and *not* throw
        const exitCode = await require('@actions/exec').exec('nvidia-smi', [], options);
        if (exitCode === 0) {
            core.info('NVIDIA GPU detected via nvidia-smi.');
            hasGpu = true;
        } else {
            core.warning(`nvidia-smi command failed or not found (exit code: ${exitCode}). Assuming no GPU.`);
        }
    } catch (error) {
        core.warning(`Error trying to execute nvidia-smi: ${error.message}. Assuming no GPU.`);
    }
    return hasGpu;
}


async function run() {
    try {
        // --- Get All Inputs (unchanged) ---
        const dockerImage = core.getInput('docker_image', { required: true });
        const buildConfig = core.getInput('build_config', { required: true });
        const runMode = core.getInput('mode', { required: true });
        const containerUser = core.getInput('container_user');
        const epInputString = core.getInput('execution_providers');
        const extraBuildFlags = core.getInput('extra_build_flags');
        const pythonPathPrefix = core.getInput('python_path_prefix');
        const allowOpset = core.getInput('allow_released_opset_only');
        const nightlyBuild = core.getInput('nightly_build');

        // --- Validate Mode (unchanged) ---
        let buildPyArg; let shouldPassCacheVars = false; const lowerCaseRunMode = runMode.toLowerCase();
        switch (lowerCaseRunMode) { case 'update': buildPyArg = '--update'; shouldPassCacheVars = true; break; case 'build': buildPyArg = '--build'; break; case 'test': buildPyArg = '--test'; break; default: core.setFailed(`Invalid mode: '${runMode}'.`); return; }
        core.info(`Running mode: ${runMode} (build.py arg: ${buildPyArg}), Pass Cache Vars: ${shouldPassCacheVars}, Container User: ${containerUser || 'Default'}`);

        // --- Process Execution Providers Input (unchanged) ---
        const epFlags = []; const requestedEps = epInputString.toLowerCase().split(' ').filter(ep => ep.trim());
        if (requestedEps.length > 0) { /* ... EP flag logic ... */ core.info(`Requested EPs: ${requestedEps.join(', ')}`); for (const ep of requestedEps) { if (KNOWN_EPS.has(ep)) { const flag = `--use_${ep}`; core.info(`  Adding flag: ${flag}`); epFlags.push(flag); } else { core.setFailed(`Unknown EP: '${ep}'. Allowed: ${knownEpsString}`); return; } } }

        // --- Get Runner Context/Defaults (unchanged) ---
        const workspaceDir = process.env.GITHUB_WORKSPACE; const runnerTempDir = process.env.RUNNER_TEMP; const homeDir = os.homedir(); const homeOnnxDir = path.join(homeDir, '.onnx'); const hostCacheDir = path.join(homeDir, '.cache'); const containerHomeDir = containerUser ? `/home/${containerUser}` : '/root'; // Adjust based on user? Defaulting home might be tricky.
        if (!workspaceDir) throw new Error('GITHUB_WORKSPACE not set.'); if (!runnerTempDir) throw new Error('RUNNER_TEMP not set.');

        // --- Check Host Paths (uses checkPathExists util) ---
        const hostDataOnnxPath = '/data/onnx'; const hostDataModelsPath = '/data/models';
        const dataOnnxExists = await checkPathExists(hostDataOnnxPath); // USE UTIL
        const dataModelsExists = await checkPathExists(hostDataModelsPath); // USE UTIL
        const enableOnnxTestsFlag = dataOnnxExists && dataModelsExists;
        core.info(`--enable_onnx_tests will be ${enableOnnxTestsFlag ? 'added' : 'skipped'}.`);

        // --- Check for GPU (uses local checkGpu) ---
        const gpuAvailable = await checkGpu();

        // --- Construct build.py Command (unchanged) ---
        const buildPyBaseArgs = [ pythonPathPrefix, 'python3', 'tools/ci_build/build.py', `--build_dir build/${buildConfig}`, `--config ${buildConfig}`, '--cmake_generator Ninja', '--skip_submodule_sync', '--build_shared_lib', '--parallel', '--use_vcpkg', '--use_vcpkg_ms_internal_asset_cache', ...(enableOnnxTestsFlag ? ['--enable_onnx_tests'] : []), ...epFlags, extraBuildFlags, ];
        const buildPyBase = buildPyBaseArgs.filter(part => part).join(' '); const fullBuildPyCommand = `${buildPyBase} ${buildPyArg}`;
        core.debug(`Constructed build.py command: ${fullBuildPyCommand}`);

        // --- Ensure Host Cache Directory Exists (unchanged) ---
        core.info(`Ensuring host cache directory exists: ${hostCacheDir}`);
        try { await fs.mkdir(hostCacheDir, { recursive: true }); core.info(`Host directory ${hostCacheDir} ensured.`); } catch (error) { core.warning(`Could not ensure host directory ${hostCacheDir} exists: ${error.message}.`); }

        // --- Construct Docker Run Arguments (unchanged) ---
        const dockerArgs = ['run', '--rm']; if (gpuAvailable) dockerArgs.push('--gpus', 'all');
        core.info('Adding standard volume mounts: workspace, runner temp, host cache.');
        dockerArgs.push('--volume', `${workspaceDir}:/onnxruntime_src`); dockerArgs.push('--volume', `${runnerTempDir}:/onnxruntime_src/build`); dockerArgs.push('--volume', `${hostCacheDir}:${containerHomeDir}/.cache`); // Use determined container home
        if (lowerCaseRunMode === 'test') { /* ... test volume mount logic ... */ core.info('Mode is "test", checking test data mounts.'); if (dataOnnxExists) { dockerArgs.push('--volume', `${hostDataOnnxPath}:/data/onnx:ro`); } else { core.info(`Skipping ${hostDataOnnxPath} mount.`); } if (dataModelsExists) { dockerArgs.push('--volume', `${hostDataModelsPath}:/data/models:ro`); } else { core.info(`Skipping ${hostDataModelsPath} mount.`); } core.info(`Ensuring host directory exists: ${homeOnnxDir}`); try { await fs.mkdir(homeOnnxDir, { recursive: true }); core.info(`Host directory ${homeOnnxDir} ensured.`); dockerArgs.push('--volume', `${homeOnnxDir}:${containerHomeDir}/.onnx`); } catch (error) { core.warning(`Could not ensure ${homeOnnxDir}: ${error.message}. Skipping mount.`); } }
        else { core.info(`Mode is "${runMode}", skipping test data mounts.`); }
        dockerArgs.push('-w', '/onnxruntime_src'); dockerArgs.push('-e', `ALLOW_RELEASED_ONNX_OPSET_ONLY=${allowOpset}`); dockerArgs.push('-e', `NIGHTLY_BUILD=${nightlyBuild}`);
        if (shouldPassCacheVars) { /* ... cache var passing logic ... */ core.info('Passing cache env vars into container.'); const cacheUrl = process.env.ACTIONS_CACHE_URL || ''; const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || ''; if (cacheUrl) core.setSecret(cacheUrl); if (runtimeToken) core.setSecret(runtimeToken); if (cacheUrl) dockerArgs.push('-e', `ACTIONS_CACHE_URL=${cacheUrl}`); else core.info('ACTIONS_CACHE_URL not found.'); if (runtimeToken) dockerArgs.push('-e', `ACTIONS_RUNTIME_TOKEN=${runtimeToken}`); else core.info('ACTIONS_RUNTIME_TOKEN not found.'); dockerArgs.push('-e', 'RUNNER_TEMP=/onnxruntime_src/build'); }
        else { core.info('Skipping passing cache env vars.'); }
        dockerArgs.push(dockerImage); dockerArgs.push('/bin/bash', '-c', `set -ex; ${fullBuildPyCommand}`);

        // --- Execute Docker Command (uses executeCommand util) ---
        core.info('Executing docker command...');
        await executeCommand('docker', dockerArgs); // USE UTIL
        core.info('Docker command executed successfully.');

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
    }
}

// Run main if executed directly
if (require.main === module) { run(); }
// Export run for testing
module.exports = { run };