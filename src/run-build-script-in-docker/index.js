const core = require('@actions/core');
const exec = require('@actions/exec');
const path = require('path');
const os = require('os');
const fs = require('fs/promises'); // Import file system promises

// List of known Execution Provider names
const KNOWN_EPS = new Set([
  'acl', 'armnn', 'azure', 'cann', 'coreml', 'cuda', 'dml', 'dnnl',
  'migraphx', 'nnapi', 'openvino', 'qnn', 'rknpu', 'rocm', 'snpe',
  'tensorrt', 'vitisai', 'vsinpu', 'webgpu', 'webnn', 'xnnpack',
]);
// Create a sorted list string for error messages
const knownEpsString = Array.from(KNOWN_EPS).sort().join(', ');

/**
 * Checks if a path exists on the host filesystem.
 * @param {string} filePath The path to check.
 * @returns {Promise<boolean>} True if the path exists, false otherwise.
 */
async function checkPathExists (filePath) {
  try {
    await fs.stat(filePath);
    core.info(`Host path check: Found '${filePath}'.`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      core.info(`Host path check: '${filePath}' not found.`);
      return false;
    } else {
      core.warning(`Host path check: Error checking '${filePath}': ${error.message}. Assuming it does not exist.`);
      return false;
    }
  }
}

async function checkGpu () {
  let hasGpu = false;
  try {
    const options = { ignoreReturnCode: true, silent: true };
    core.info('Checking for NVIDIA GPU using nvidia-smi...');
    const exitCode = await exec.exec('nvidia-smi', [], options);
    if (exitCode === 0) {
      core.info('NVIDIA GPU detected via nvidia-smi.');
      hasGpu = true;
    } else {
      core.warning(`nvidia-smi failed or not found (exit code: ${exitCode}). Assuming no GPU.`);
    }
  } catch (error) {
    core.warning(`Error trying to execute nvidia-smi: ${error.message}. Assuming no GPU.`);
  }
  return hasGpu;
}

async function run () {
  try {
    // --- Get All Inputs ---
    const dockerImage = core.getInput('docker_image', { required: true });
    const buildConfig = core.getInput('build_config', { required: true });
    const runMode = core.getInput('mode', { required: true });
    const containerUser = core.getInput('container_user');
    const epInputString = core.getInput('execution_providers');
    const extraBuildFlags = core.getInput('extra_build_flags');
    const pythonPathPrefix = core.getInput('python_path_prefix');
    const allowOpset = core.getInput('allow_released_opset_only');
    const nightlyBuild = core.getInput('nightly_build');

    // --- Validate Mode and Determine Derived Settings ---
    let buildPyArg;
    let shouldPassCacheVars = false;
    const lowerCaseRunMode = runMode.toLowerCase();

    switch (lowerCaseRunMode) {
      case 'update': buildPyArg = '--update'; shouldPassCacheVars = true; break;
      case 'build': buildPyArg = '--build'; break;
      case 'test': buildPyArg = '--test'; break;
      default: core.setFailed(`Invalid mode: '${runMode}'. Use 'update', 'build', or 'test'.`); return;
    }
    core.info(`Running mode: ${runMode} (build.py arg: ${buildPyArg}), Pass Cache Vars: ${shouldPassCacheVars}, Container User: ${containerUser}`);
    // --- End Validate Mode ---

    // --- Process Execution Providers Input ---
    const epFlags = [];
    const requestedEps = epInputString.toLowerCase().split(' ').filter(ep => ep.trim());
    if (requestedEps.length > 0) {
      core.info(`Requested Execution Providers: ${requestedEps.join(', ')}`);
      for (const ep of requestedEps) {
        if (KNOWN_EPS.has(ep)) {
          const flag = `--use_${ep}`;
          core.info(`  Adding build flag: ${flag}`);
          epFlags.push(flag);
        } else {
          // --- Fail on unknown EP ---
          core.setFailed(`Unknown execution provider requested: '${ep}'. Allowed values are: ${knownEpsString}`);
          return; // Stop processing immediately
          // --- End Fail ---
        }
      }
    }
    // --- End Process EPs ---

    // --- Get Runner Context/Defaults ---
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const runnerTempDir = process.env.RUNNER_TEMP;
    const homeDir = os.homedir();
    const homeOnnxDir = path.join(homeDir, '.onnx');
    const hostCacheDir = path.join(homeDir, '.cache');
    const containerHomeDir = `/home/${containerUser}`;

    if (!workspaceDir) throw new Error('GITHUB_WORKSPACE environment variable not set.');
    if (!runnerTempDir) throw new Error('RUNNER_TEMP environment variable not set.');

    // --- Check Host Paths for Test Data ---
    const hostDataOnnxPath = '/data/onnx';
    const hostDataModelsPath = '/data/models';
    const dataOnnxExists = await checkPathExists(hostDataOnnxPath);
    const dataModelsExists = await checkPathExists(hostDataModelsPath);
    const enableOnnxTestsFlag = dataOnnxExists && dataModelsExists;
    core.info(`--enable_onnx_tests will be ${enableOnnxTestsFlag ? 'added' : 'skipped'} based on host test data path existence.`);
    // --- End Check Host Paths ---

    // --- Check for GPU ---
    const gpuAvailable = await checkGpu();

    // --- Construct build.py Command ---
    const buildPyBaseArgs = [
      pythonPathPrefix, 'python3', 'tools/ci_build/build.py',
      `--build_dir build/${buildConfig}`, `--config ${buildConfig}`,
      '--cmake_generator Ninja', '--skip_submodule_sync', '--build_shared_lib',
      '--parallel', '--use_vcpkg', '--use_vcpkg_ms_internal_asset_cache',
      ...(enableOnnxTestsFlag ? ['--enable_onnx_tests'] : []),
      ...epFlags,
      extraBuildFlags,
    ];
    const buildPyBase = buildPyBaseArgs.filter(part => part).join(' ');
    const fullBuildPyCommand = `${buildPyBase} ${buildPyArg}`;
    core.debug(`Constructed build.py command: ${fullBuildPyCommand}`);
    // --- End Construct build.py Command ---

    // --- Ensure Host Cache Directory Exists ---
    core.info(`Ensuring host cache directory exists: ${hostCacheDir}`);
    try { /* ... mkdir ... */ await fs.mkdir(hostCacheDir, { recursive: true }); core.info(`Host directory ${hostCacheDir} ensured.`); } catch (error) { /* ... core.warning ... */ core.warning(`Could not ensure host directory ${hostCacheDir} exists: ${error.message}. Proceeding with mount attempt.`); }
    // --- End Ensure Host Cache Directory ---

    // --- Construct Docker Run Arguments ---
    const dockerArgs = ['run', '--rm'];
    if (gpuAvailable) dockerArgs.push('--gpus', 'all');

    // Add Volume Mounts
    core.info('Adding standard volume mounts: workspace, runner temp, host cache.');
    dockerArgs.push('--volume', `${workspaceDir}:/onnxruntime_src`);
    dockerArgs.push('--volume', `${runnerTempDir}:/onnxruntime_src/build`);
    dockerArgs.push('--volume', `${hostCacheDir}:${containerHomeDir}/.cache`);

    // Conditionally add test-related volume mounts
    if (lowerCaseRunMode === 'test') {
      core.info('Mode is "test", checking host paths for optional test data volume mounts.');
      if (dataOnnxExists) { dockerArgs.push('--volume', `${hostDataOnnxPath}:/data/onnx:ro`); } else { core.info(`Skipping ${hostDataOnnxPath} mount as host path does not exist.`); }
      if (dataModelsExists) { dockerArgs.push('--volume', `${hostDataModelsPath}:/data/models:ro`); } else { core.info(`Skipping ${hostDataModelsPath} mount as host path does not exist.`); }
      core.info(`Ensuring host directory exists for test mount: ${homeOnnxDir}`);
      try {
        await fs.mkdir(homeOnnxDir, { recursive: true });
        core.info(`Host directory ${homeOnnxDir} ensured.`);
        dockerArgs.push('--volume', `${homeOnnxDir}:${containerHomeDir}/.onnx`);
      } catch (error) {
        core.warning(`Could not ensure host directory ${homeOnnxDir} exists: ${error.message}. Skipping mount.`);
      }
    } else {
      core.info(`Mode is "${runMode}", skipping test data volume mounts.`);
    }

    dockerArgs.push('-w', '/onnxruntime_src');
    dockerArgs.push('-e', `ALLOW_RELEASED_ONNX_OPSET_ONLY=${allowOpset}`);
    dockerArgs.push('-e', `NIGHTLY_BUILD=${nightlyBuild}`);

    // Pass Cache Vars Conditionally
    if (shouldPassCacheVars) {
      core.info('Passing cache environment variables into container for update mode.');
      const cacheUrl = process.env.ACTIONS_CACHE_URL || '';
      const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || '';
      if (cacheUrl) core.setSecret(cacheUrl);
      if (runtimeToken) core.setSecret(runtimeToken);
      if (cacheUrl) dockerArgs.push('-e', `ACTIONS_CACHE_URL=${cacheUrl}`); else core.info('ACTIONS_CACHE_URL not found.');
      if (runtimeToken) dockerArgs.push('-e', `ACTIONS_RUNTIME_TOKEN=${runtimeToken}`); else core.info('ACTIONS_RUNTIME_TOKEN not found.');
      dockerArgs.push('-e', 'RUNNER_TEMP=/onnxruntime_src/build');
    } else {
      core.info('Skipping passing cache environment variables into container.');
    }

    dockerArgs.push(dockerImage);
    dockerArgs.push('/bin/bash', '-c', `set -ex; ${fullBuildPyCommand}`);
    // --- End Construct Docker Arguments ---

    // --- Execute Docker Command ---
    core.info('Executing docker command...');
    core.debug(`docker ${dockerArgs.join(' ')}`);
    await exec.exec('docker', dockerArgs);
    core.info('Docker command executed successfully.');
    // --- End Execute Docker Command ---
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();
