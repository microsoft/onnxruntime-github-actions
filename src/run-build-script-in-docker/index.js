const core = require('@actions/core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const glob = require('@actions/glob'); // Ensure glob is required

// Import shared utilities
const { executeCommand, checkPathExists } = require('../common/utils'); // Import helpers

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
      core.warning(`nvidia-smi command failed or not found (exit code: ${exitCode}). Assuming no GPU.`);
    }
  } catch (error) {
    core.warning(`Error trying to execute nvidia-smi: ${error.message}. Assuming no GPU.`);
  }
  return hasGpu;
}

// --- Helper Function to Generate Test Summary ---
async function generateTestSummary(baseDir) {
    core.startGroup('Generate Test Result Summary');
    const xmlPattern = path.join(baseDir, '**/*.results.xml').replace(/\\/g, '/'); // Normalize for glob
    let totalTests = 0;
    let totalFailures = 0;
    let totalErrors = 0;
    let totalSkipped = 0;
    let filesProcessed = 0;
    const failedFiles = [];
    const processedFiles = [];

    core.info(`Searching for test result files matching: ${xmlPattern}`);

    try {
        // Check if base directory exists first
        await fs.access(baseDir);
        core.info(`Base directory ${baseDir} exists.`);

        const globber = await glob.create(xmlPattern, { followSymbolicLinks: false });
        for await (const file of globber.globGenerator()) {
            filesProcessed++;
            const fileName = path.relative(baseDir, file) || path.basename(file); // Get relative path for display
            processedFiles.push(fileName);
            core.debug(`Processing file: ${file}`);
            try {
                const content = await fs.readFile(file, 'utf8');
                // Simple Regex to find the first <testsuite> or <testsuites> tag and extract counts
                // It assumes attributes are present and well-formed. Handles optional skipped/disabled.
                const testsuiteRegex = /<testsuite(?:s)?\s+[^>]*?tests="(\d+)"[^>]*?failures="(\d+)"[^>]*?errors="(\d+)"(?:[^>]*?(?:skipped|disabled)="(\d+)")?/;
                const match = content.match(testsuiteRegex);

                if (match) {
                    totalTests += parseInt(match[1] || '0', 10);
                    totalFailures += parseInt(match[2] || '0', 10);
                    totalErrors += parseInt(match[3] || '0', 10);
                    totalSkipped += parseInt(match[4] || '0', 10); // Group 4 is skipped/disabled
                    core.debug(` -> Found Tests: ${match[1]}, Failures: ${match[2]}, Errors: ${match[3]}, Skipped/Disabled: ${match[4] || '0'}`);
                } else {
                    core.warning(`Could not find parsable <testsuite(s)> tag with counts in ${fileName}`);
                    failedFiles.push(`${fileName} (parse error)`);
                }
            } catch (readError) {
                core.warning(`Error reading test result file ${fileName}: ${readError.message}`);
                failedFiles.push(`${fileName} (read error)`);
            }
        }

        if (filesProcessed === 0) {
            core.info('No test result XML files found.');
        } else {
            core.info(`Processed ${filesProcessed} test result XML file(s).`);
            // --- Generate Job Summary ---
            let summaryMarkdown = `## Test Results Summary\n\n`;
            summaryMarkdown += `Processed **${filesProcessed}** \`*.results.xml\` file(s) from \`${path.basename(baseDir)}\`.\n\n`; // Use basename for clarity

            const totalProblems = totalFailures + totalErrors;
            const overallStatus = totalProblems === 0 ? '✅ Passed' : '❌ Failed';

            summaryMarkdown += `| Metric          | Count |\n`;
            summaryMarkdown += `| --------------- | ----: |\n`;
            summaryMarkdown += `| **Total Tests** | ${totalTests} |\n`;
            summaryMarkdown += `| Failures        | ${totalFailures > 0 ? `**${totalFailures}** ❌` : totalFailures} |\n`;
            summaryMarkdown += `| Errors          | ${totalErrors > 0 ? `**${totalErrors}** ❌` : totalErrors} |\n`;
            summaryMarkdown += `| Skipped         | ${totalSkipped} |\n`;
            summaryMarkdown += `| **Overall** | **${overallStatus}** |\n\n`;


            if (failedFiles.length > 0) {
                summaryMarkdown += `⚠️ **Issues processing some files:**\n`;
                summaryMarkdown += failedFiles.map(f => `- \`${f}\``).join('\n') + '\n\n';
            }

            summaryMarkdown += `<details><summary>Processed Files (${processedFiles.length})</summary>\n\n`;
            summaryMarkdown += processedFiles.map(f => `- \`${f}\``).join('\n') + '\n';
            summaryMarkdown += `</details>\n`;

            // Add to GitHub Job Summary (append=true ensures it adds even if step failed)
            await core.summary.addRaw(summaryMarkdown, true).write();
            core.info("Test result summary added to GitHub Job Summary.");
        }

    } catch (error) {
         if (error.code === 'ENOENT') {
            core.info(`Test result base directory ${baseDir} not found. Skipping summary generation.`);
        } else {
            core.warning(`Error accessing test result directory ${baseDir} or globbing files: ${error.message}`);
        }
    } finally {
        core.endGroup();
    }
}


async function run() {
    // Define buildDir early for use in finally block
    const buildConfig = core.getInput('build_config', { required: true });
    const runnerTempDir = process.env.RUNNER_TEMP;
    if (!runnerTempDir) {
        core.setFailed('RUNNER_TEMP environment variable not set.'); // Fail early if this is missing
        return;
    }
    const buildOutputPath = path.join(runnerTempDir, 'build', buildConfig);

    try {
        // --- Get All Inputs (unchanged) ---
        const dockerImage = core.getInput('docker_image', { required: true });
        // buildConfig already obtained
        const runMode = core.getInput('mode', { required: true });
        const containerUser = core.getInput('container_user');
        const epInputString = core.getInput('execution_providers');
        const extraBuildFlags = core.getInput('extra_build_flags');
        const pythonPathPrefix = core.getInput('python_path_prefix');
        const allowOpset = core.getInput('allow_released_opset_only');
        const nightlyBuild = core.getInput('nightly_build');

        // --- Validate Mode (unchanged) ---
        let buildPyArg;
        let shouldPassCacheVars = false;
        const lowerCaseRunMode = runMode.toLowerCase();
        switch (lowerCaseRunMode) {
            case 'update':
                buildPyArg = '--update';
                shouldPassCacheVars = true;
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
            `Running mode: ${runMode} (build.py arg: ${buildPyArg}), Pass Cache Vars: ${shouldPassCacheVars}, Container User: ${containerUser || 'Default'}`
        );

        // --- Check if Python bindings are being built ---
        const isPythonBuild = extraBuildFlags.includes('--build_wheel') || extraBuildFlags.includes('--enable_pybind');
        const isWheelBuild = extraBuildFlags.includes('--build_wheel'); // Specifically check for wheel build
        if (isPythonBuild) {
            core.info('Detected Python binding build based on extra_build_flags.');
        }

        // --- Process Execution Providers Input (unchanged) ---
        const epFlags = [];
        const requestedEps = epInputString
            .toLowerCase()
            .split(' ')
            .filter((ep) => ep.trim());
        if (requestedEps.length > 0) {
            /* ... EP flag logic ... */ core.info(`Requested EPs: ${requestedEps.join(', ')}`);
            for (const ep of requestedEps) {
                if (KNOWN_EPS.has(ep)) {
                    const flag = `--use_${ep}`;
                    core.info(`  Adding flag: ${flag}`);
                    epFlags.push(flag);
                } else {
                    core.setFailed(`Unknown EP: '${ep}'. Allowed: ${knownEpsString}`);
                    return;
                }
            }
        }

        // --- Get Runner Context/Defaults (unchanged) ---
        const workspaceDir = process.env.GITHUB_WORKSPACE;
        // runnerTempDir already obtained
        const homeDir = os.homedir();
        const homeOnnxDir = path.join(homeDir, '.onnx');
        const hostCacheDir = path.join(homeDir, '.cache');
        const containerHomeDir = containerUser ? `/home/${containerUser}` : '/root'; // Adjust based on user? Defaulting home might be tricky.
        if (!workspaceDir) throw new Error('GITHUB_WORKSPACE not set.');
        // runnerTempDir checked earlier

        // --- Check Host Paths (uses checkPathExists util) ---
        const hostDataOnnxPath = '/data/onnx';
        const hostDataModelsPath = '/data/models';
        const dataOnnxExists = await checkPathExists(hostDataOnnxPath); // USE UTIL
        const dataModelsExists = await checkPathExists(hostDataModelsPath); // USE UTIL
        const enableOnnxTestsFlag = dataOnnxExists && dataModelsExists;
        core.info(`--enable_onnx_tests will be ${enableOnnxTestsFlag ? 'added' : 'skipped'}.`);

        // --- Check for GPU (uses local checkGpu) ---
        const gpuAvailable = await checkGpu();

        // --- Construct build.py Command (unchanged) ---
        const buildPyBaseArgs = [
            pythonPathPrefix,
            'python3',
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
        const fullBuildPyCommand = `${buildPyBase} ${buildPyArg}`;
        core.debug(`Constructed build.py command: ${fullBuildPyCommand}`);

        // --- Construct the full command to run inside Docker ---
        let fullDockerCommand = `set -ex; ${fullBuildPyCommand}`;
        if (isPythonBuild) {
            const pythonRequirementsPath = 'tools/ci_build/github/linux/python/requirements.txt';
            const installReqsCommand = `python3 -m pip install --user -r ${pythonRequirementsPath}`;
            fullDockerCommand = `set -ex; ${installReqsCommand} && ${fullBuildPyCommand}`;
            core.info(`Prepending python requirements installation for Python build.`);
            core.debug(`Full command inside Docker: ${fullDockerCommand}`);
        } else {
            core.debug(`Full command inside Docker: ${fullDockerCommand}`);
        }

        // --- Ensure Host Cache Directory Exists (unchanged) ---
        core.info(`Ensuring host cache directory exists: ${hostCacheDir}`);
        try {
            await fs.mkdir(hostCacheDir, { recursive: true });
            core.info(`Host directory ${hostCacheDir} ensured.`);
        } catch (error) {
            core.warning(`Could not ensure host directory ${hostCacheDir} exists: ${error.message}.`);
        }

        // --- Construct Docker Run Arguments (unchanged logic, uses modified command) ---
        const dockerArgs = ['run', '--rm'];
        if (gpuAvailable) dockerArgs.push('--gpus', 'all');
        core.info('Adding standard volume mounts: workspace, runner temp, host cache.');
        dockerArgs.push('--volume', `${workspaceDir}:/onnxruntime_src`);
        // Mount the parent of the build output dir for simplicity
        dockerArgs.push('--volume', `${runnerTempDir}/build:/onnxruntime_src/build`); // Mount $RUNNER_TEMP/build -> /onnxruntime_src/build
        dockerArgs.push('--volume', `${hostCacheDir}:${containerHomeDir}/.cache`); // Use determined container home
        if (lowerCaseRunMode === 'test') {
            /* ... test volume mount logic ... */ core.info('Mode is "test", checking test data mounts.');
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
        if (shouldPassCacheVars) {
            /* ... cache var passing logic ... */ core.info('Passing cache env vars into container.');
            const cacheUrl = process.env.ACTIONS_CACHE_URL || '';
            const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN || '';
            if (cacheUrl) core.setSecret(cacheUrl);
            if (runtimeToken) core.setSecret(runtimeToken);
            if (cacheUrl) dockerArgs.push('-e', `ACTIONS_CACHE_URL=${cacheUrl}`);
            else core.info('ACTIONS_CACHE_URL not found.');
            if (runtimeToken) dockerArgs.push('-e', `ACTIONS_RUNTIME_TOKEN=${runtimeToken}`);
            else core.info('ACTIONS_RUNTIME_TOKEN not found.');
            // Map RUNNER_TEMP inside container correctly based on volume mount
            dockerArgs.push('-e', 'RUNNER_TEMP=/onnxruntime_src/build');
        } else {
            core.info('Skipping passing cache env vars.');
        }
        dockerArgs.push(dockerImage);
        // Pass the potentially modified command
        dockerArgs.push('/bin/bash', '-c', fullDockerCommand);

        // --- Execute Docker Command (uses executeCommand util) ---
        core.info('Executing docker command...');
        await executeCommand('docker', dockerArgs); // USE UTIL
        core.info('Docker command executed successfully.');

        // --- Verify Wheel Existence if --build_wheel was specified ---
        if (isWheelBuild) {
            core.startGroup('Verify Python Wheel Output');
            const wheelDir = path.join(buildOutputPath, 'dist'); // Use buildOutputPath
            core.info(`Checking for wheel file in: ${wheelDir}`);
            try {
                await fs.access(wheelDir); // Check if directory exists first
                core.info(`Directory ${wheelDir} exists. Searching for .whl file...`);
                // Use glob to find files ending with .whl
                const wheelGlobber = await glob.create(`${wheelDir}/*.whl`, { followSymbolicLinks: false });
                let wheelFound = false;
                for await (const file of wheelGlobber.globGenerator()) {
                    core.info(`Found wheel file: ${path.basename(file)}`);
                    wheelFound = true;
                    // Usually only one wheel is expected, break after finding the first one
                    break;
                }

                if (!wheelFound) {
                    core.warning(`Wheel directory ${wheelDir} exists, but no .whl file was found inside.`);
                    // Consider setting failed if wheel is critical? core.setFailed(...)
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    core.warning(`Wheel output directory ${wheelDir} does not exist.`);
                    // Consider setting failed if wheel is critical? core.setFailed(...)
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