const core = require('@actions/core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const glob = require('@actions/glob'); // Ensure glob is required

// Import shared utilities
const { executeCommand, checkPathExists, generateTestSummary } = require('../common/utils');

// List of known EP names (keep local or move to common if used elsewhere?) - Keep local for now
const KNOWN_EPS = new Set([
  'acl',
  'armnn',
  'azure',
  'cann',
  'coreml',
  'cuda',
  'dml',
  'dnnl',
  'migraphx',
  'nnapi',
  'openvino',
  'qnn',
  'rknpu',
  'rocm',
  'snpe',
  'tensorrt',
  'vitisai',
  'vsinpu',
  'webgpu',
  'webnn',
  'xnnpack',
]);
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
      core.info(`nvidia-smi command failed or not found (exit code: ${exitCode}). Assuming no GPU.`);
    }
  } catch (error) {
    core.info(`Error trying to execute nvidia-smi: ${error.message}. Assuming no GPU.`);
  }
  return hasGpu;
}




async function run() {
    // Define buildDir early for use in finally block
    const buildConfig = core.getInput('build_config', { required: true });
    const runnerTempDir = process.env.RUNNER_TEMP;
    if (!runnerTempDir) {
        core.setFailed('RUNNER_TEMP environment variable not set.'); // Fail early if this is missing
        return;
    }
    const buildOutputPath = path.join(runnerTempDir, buildConfig);

    try {
        // --- Get All Inputs ---
        const dockerImage = core.getInput('docker_image', { required: true });
        // buildConfig already obtained
        const runMode = core.getInput('mode', { required: true });
        const containerUser = core.getInput('container_user');
        const epInputString = core.getInput('execution_providers');
        const extraBuildFlags = core.getInput('extra_build_flags');
        const pythonPathPrefix = core.getInput('python_path_prefix'); // Get prefix input
        const allowOpset = core.getInput('allow_released_opset_only');
        const nightlyBuild = core.getInput('nightly_build');

        // --- Validate Mode ---
        let buildPyArg;
        const lowerCaseRunMode = runMode.toLowerCase();
        switch (lowerCaseRunMode) {
            case 'update':
                buildPyArg = '--update';
                break;
            case 'build':
                buildPyArg = '--build';
                break;
            case 'test':
                buildPyArg = '--test';
                break;
            default:
                core.setFailed(`Invalid mode: '${runMode}'.`);
                return;
        }
        core.info(
            `Running mode: ${runMode} (build.py arg: ${buildPyArg}), Container User: ${containerUser || 'Default'}`
        );

        // --- Check if Python bindings are being built ---
        const isPythonBuild = extraBuildFlags.includes('--build_wheel') || extraBuildFlags.includes('--enable_pybind');
        const isWheelBuild = extraBuildFlags.includes('--build_wheel'); // Specifically check for wheel build
        if (isPythonBuild) {
            core.info('Detected Python binding build based on extra_build_flags.');
        }

        // --- Process Execution Providers Input ---
        const epFlags = [];
        const requestedEps = epInputString
            .toLowerCase()
            .split(' ')
            .filter((ep) => ep.trim());
        if (requestedEps.length > 0) {
            core.info(`Requested EPs: ${requestedEps.join(', ')}`);
            for (const ep of requestedEps) {
                if (KNOWN_EPS.has(ep)) {
                    const flag = `--use_${ep}`;
                    core.info(`  Adding flag: ${flag}`);
                    epFlags.push(flag);
                } else {
                    core.setFailed(`Unknown EP: '${ep}'. Allowed: ${knownEpsString}`);
                    return;
                }
            }
        }

        // --- Get Runner Context/Defaults ---
        const workspaceDir = process.env.GITHUB_WORKSPACE;
        const homeDir = os.homedir();
        const homeOnnxDir = path.join(homeDir, '.onnx');
        const hostCacheDir = path.join(homeDir, '.cache');
        const containerHomeDir = containerUser ? `/home/${containerUser}` : '/root';
        if (!workspaceDir) throw new Error('GITHUB_WORKSPACE not set.');

        // --- Check Host Paths ---
        const hostDataOnnxPath = '/data/onnx';
        const hostDataModelsPath = '/data/models';
        const dataOnnxExists = await checkPathExists(hostDataOnnxPath);
        const dataModelsExists = await checkPathExists(hostDataModelsPath);
        const enableOnnxTestsFlag = dataOnnxExists && dataModelsExists;
        core.info(`--enable_onnx_tests will be ${enableOnnxTestsFlag ? 'added' : 'skipped'}.`);

        // --- Check for GPU ---
        const gpuAvailable = await checkGpu();

        // --- Construct build.py command part (without prefix) ---
        const buildPyBaseArgs = [
            'python3', // Prefix removed from here
            'tools/ci_build/build.py',
            `--build_dir build/${buildConfig}`, // Relative path inside container
            `--config ${buildConfig}`,
            '--cmake_generator Ninja',
            '--skip_submodule_sync',
            '--build_shared_lib',
            '--parallel',
            '--use_vcpkg',
            '--use_vcpkg_ms_internal_asset_cache',
            ...(enableOnnxTestsFlag ? ['--enable_onnx_tests'] : []),
            ...epFlags,
            extraBuildFlags,
        ];
        const buildPyBase = buildPyBaseArgs.filter((part) => part).join(' ');
        const buildPyCommandPart = `${buildPyBase} ${buildPyArg}`;
        core.debug(`Build.py command part: ${buildPyCommandPart}`);

        // --- Construct the sequence of commands to run inside Docker ---
        let commandSequence = [];

        // Add python requirements install if needed
        if (isPythonBuild) {
            const pythonRequirementsPath = 'tools/ci_build/github/linux/python/requirements.txt';
            const installReqsCommandPart = `python3 -m pip install --user -r ${pythonRequirementsPath}`;
            commandSequence.push(installReqsCommandPart);
            core.info(`Adding python requirements installation command.`);
        }

        // Add the main build.py command
        commandSequence.push(buildPyCommandPart);

        // Join commands with &&
        let combinedCommands = commandSequence.join(' && ');

        // Prepend the pythonPathPrefix if provided, applying it to the whole sequence
        let fullDockerCommand;
        const trimmedPrefix = pythonPathPrefix ? pythonPathPrefix.trim() : '';
        if (trimmedPrefix !== '') {
            core.info(`Prepending python path prefix/environment setup: ${trimmedPrefix}`);
            // Assume pythonPathPrefix is a valid shell command/assignment prefix like 'export PATH=...' or 'VAR=val'
            fullDockerCommand = `set -ex; ${trimmedPrefix} && ${combinedCommands}`;
        } else {
            fullDockerCommand = `set -ex; ${combinedCommands}`;
        }

        core.debug(`Full command sequence inside Docker: ${fullDockerCommand}`);


        // --- Ensure Host Cache Directory Exists ---
        core.info(`Ensuring host cache directory exists: ${hostCacheDir}`);
        try {
            await fs.mkdir(hostCacheDir, { recursive: true });
            core.info(`Host directory ${hostCacheDir} ensured.`);
        } catch (error) {
            core.warning(`Could not ensure host directory ${hostCacheDir} exists: ${error.message}.`);
        }

        // --- Construct Docker Run Arguments ---
        const dockerArgs = ['run', '--rm'];
        if (gpuAvailable) dockerArgs.push('--gpus', 'all');
        core.info('Adding standard volume mounts: workspace, runner temp build, host cache.');
        dockerArgs.push('--volume', `${workspaceDir}:/onnxruntime_src`);
        dockerArgs.push('--volume', `${runnerTempDir}:/onnxruntime_src/build`);
        dockerArgs.push('--volume', `${hostCacheDir}:${containerHomeDir}/.cache`); // Use determined container home
        if (lowerCaseRunMode === 'test') {
            core.info('Mode is "test", checking test data mounts.');
            if (dataOnnxExists) {
                dockerArgs.push('--volume', `${hostDataOnnxPath}:/data/onnx:ro`);
            } else {
                core.info(`Skipping ${hostDataOnnxPath} mount.`);
            }
            if (dataModelsExists) {
                dockerArgs.push('--volume', `${hostDataModelsPath}:/data/models:ro`);
            } else {
                core.info(`Skipping ${hostDataModelsPath} mount.`);
            }
            core.info(`Ensuring host directory exists: ${homeOnnxDir}`);
            try {
                await fs.mkdir(homeOnnxDir, { recursive: true });
                core.info(`Host directory ${homeOnnxDir} ensured.`);
                dockerArgs.push('--volume', `${homeOnnxDir}:${containerHomeDir}/.onnx`);
            } catch (error) {
                core.warning(`Could not ensure ${homeOnnxDir}: ${error.message}. Skipping mount.`);
            }
        } else {
            core.info(`Mode is "${runMode}", skipping test data mounts.`);
        }
        dockerArgs.push('-w', '/onnxruntime_src');
        dockerArgs.push('-e', `ALLOW_RELEASED_ONNX_OPSET_ONLY=${allowOpset}`);
        dockerArgs.push('-e', `NIGHTLY_BUILD=${nightlyBuild}`);
        dockerArgs.push('-e', 'RUNNER_TEMP=/onnxruntime_src/build');
        dockerArgs.push(dockerImage);
        // Pass the full command sequence
        dockerArgs.push('/bin/bash', '-c', fullDockerCommand);

        // --- Execute Docker Command ---
        core.info('Executing docker command...');
        await executeCommand('docker', dockerArgs);
        core.info('Docker command executed successfully.');

        // --- Verify Wheel Existence if --build_wheel was specified ---
        if (isWheelBuild) {
            core.startGroup('Verify Python Wheel Output');
            const wheelDir = path.join(buildOutputPath, 'dist');
            core.info(`Checking for wheel file in: ${wheelDir}`);
            try {
                await fs.access(wheelDir); // Check if directory exists first
                core.info(`Directory ${wheelDir} exists. Searching for .whl file...`);
                const wheelGlobber = await glob.create(`${wheelDir}/*.whl`, { followSymbolicLinks: false });
                let wheelFound = false;
                for await (const file of wheelGlobber.globGenerator()) {
                    core.info(`Found wheel file: ${path.basename(file)}`);
                    wheelFound = true;
                    break; // Usually only one wheel is expected
                }

                if (!wheelFound) {
                    core.warning(`Wheel directory ${wheelDir} exists, but no .whl file was found inside.`);
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    core.warning(`Wheel output directory ${wheelDir} does not exist.`);
                } else {
                    core.warning(`Error checking for wheel file in ${wheelDir}: ${error.message}`);
                }
            }
            core.endGroup();
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
        // Error is caught, but finally block will still execute
    } finally {
        // --- Generate Test Summary from XML Files ---
        // This runs regardless of whether the try block succeeded or failed
        await generateTestSummary(buildOutputPath); // Pass the specific build output path
    }
}

// Run main if executed directly
if (require.main === module) {
    run();
}
// Export run for testing
module.exports = { run };