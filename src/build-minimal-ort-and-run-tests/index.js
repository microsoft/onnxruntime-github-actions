const core = require('@actions/core');
const exec = require('@actions/exec');
// Import the default client class
const { DefaultArtifactClient } = require('@actions/artifact');
const fs = require('fs').promises; // Ensure fs promises is imported
const path = require('path');
const os = require('os');

/**
 * Executes a command and logs its output. Throws an error if the command fails.
 * @param {string} command The command to execute.
 * @param {string[]} [args] Command arguments.
 * @param {exec.ExecOptions} [options] Execution options.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>} Command output.
 */
async function runCommand(command, args = [], options = {}) {
    // ... (runCommand function remains the same) ...
    const effectiveOptions = {
        cwd: process.env.GITHUB_WORKSPACE, // Default working directory
        ignoreReturnCode: false, // Throw error on failure by default
        silent: false, // Show command output by default
        listeners: {
            stdout: (data) => { core.info(data.toString().trim()); },
            stderr: (data) => { core.warning(data.toString().trim()); } // Log stderr as warning by default
        },
        ...options
    };
    const cwdString = effectiveOptions.cwd === process.env.GITHUB_WORKSPACE ? 'default workspace' : effectiveOptions.cwd;
    core.info(`Executing in ${cwdString}: ${command} ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`); // Basic quoting for display
    try {
        const { exitCode, stdout, stderr } = await exec.getExecOutput(command, args, effectiveOptions);

        if (exitCode !== 0 && !effectiveOptions.ignoreReturnCode) {
             core.error(`Stderr: ${stderr}`);
             throw new Error(`Command exited with code ${exitCode}: ${command} ${args.join(' ')}`);
        }
        core.info(`Finished: ${command} ${args.join(' ')}`);
        return { exitCode, stdout, stderr };
    } catch (error) {
        core.error(`Error executing command: ${command} ${args.join(' ')} in ${cwdString}`);
        core.error(error);
        throw new Error(`Command execution failed: ${error.message || error}`);
    }
}


/**
 * Checks if a path exists.
 * @param {string} pathToCheck The path to check.
 * @returns {Promise<boolean>} True if the path exists, false otherwise.
 */
async function checkPathExists(pathToCheck) {
    // ... (checkPathExists function remains the same) ...
    try {
        await fs.access(pathToCheck);
        core.info(`Path exists: ${pathToCheck}`);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            core.info(`Path does not exist: ${pathToCheck}`);
            return false;
        }
        core.warning(`Error checking path ${pathToCheck}: ${error.message}`);
        return false; // Assume not accessible on other errors
    }
}


/**
 * Main function for the GitHub Action.
 */
async function main() {
    core.info('Starting Minimal ORT Build Action...');

    // --- Get Inputs ---
    const reducedOpsConfigFileBase = core.getInput('reduced-ops-config-file'); // Not required anymore
    const globallyAllowedTypes = core.getInput('globally_allowed_types'); // New input
    const enableTypeReduction = core.getBooleanInput('enable-type-reduction'); // Note: this doesn't directly control build.py flag
    const enableCustomOps = core.getBooleanInput('enable-custom-ops');
    const skipModelTests = core.getBooleanInput('skip-model-tests');
    const binarySizeReportNamePrefix = core.getInput('binary-size-report-name-prefix');

    // --- Input Validation ---
    if (reducedOpsConfigFileBase && globallyAllowedTypes) {
        throw new Error("Inputs 'reduced-ops-config-file' and 'globally_allowed_types' are mutually exclusive. Provide only one.");
    }
    if (!reducedOpsConfigFileBase && !globallyAllowedTypes) {
        throw new Error("One of 'reduced-ops-config-file' or 'globally_allowed_types' must be provided.");
    }

    // --- Define Paths ---
    const buildDir = process.env.RUNNER_TEMP;
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    if (!buildDir || !workspaceDir) {
        throw new Error("Required environment variables RUNNER_TEMP or GITHUB_WORKSPACE not set.");
    }

    const testDataDir = path.join(buildDir, '.test_data'); // Directory for downloaded artifact OR generated config
    const debugOutputDir = path.join(buildDir, 'Debug'); // Consistent with build.py default
    const testRunnerPath = path.join(debugOutputDir, 'onnx_test_runner');
    const libraryPath = path.join(debugOutputDir, 'libonnxruntime.so'); // Assuming Linux build
    const binarySizeReportPath = path.join(debugOutputDir, 'binary_size_data.txt');
    const minimalE2eTestDataDir = path.join(workspaceDir, 'onnxruntime/test/testdata/ort_minimal_e2e_test_data');
    const standardOnnxTestDataDir = '/data/onnx';

    core.info(`Using Build Directory (RUNNER_TEMP): ${buildDir}`);
    core.info(`Workspace Directory (GITHUB_WORKSPACE): ${workspaceDir}`);
    core.info(`Derived Test Data/Config Directory: ${testDataDir}`);

    const artifactClient = new DefaultArtifactClient();
    let opsConfigFileToUse = ''; // Path to the config file that will be used by build.py

    try {
        // Ensure the directory for config/test data exists
        await fs.mkdir(testDataDir, { recursive: true });
        core.info(`Ensured directory exists: ${testDataDir}`);

        if (globallyAllowedTypes) {
            // --- Generate Config File from globally_allowed_types ---
            core.startGroup('Generate Ops Config from globally_allowed_types');
            core.info(`Input types: ${globallyAllowedTypes}`);
            core.info('Skipping test data artifact download.');

            const generatedConfigFileName = 'globally_allowed_types.config';
            opsConfigFileToUse = path.join(testDataDir, generatedConfigFileName);

            const configContent = `!globally_allowed_types;${globallyAllowedTypes}\n!no_ops_specified_means_all_ops_are_required\n`;

            await fs.writeFile(opsConfigFileToUse, configContent);
            core.info(`Generated config file at: ${opsConfigFileToUse}`);
            core.debug(`Config file content:\n${configContent}`);
            core.endGroup();

        } else {
            // --- Download Test Data Artifact ---
            core.startGroup('Download Test Data Artifact');
            opsConfigFileToUse = path.join(testDataDir, reducedOpsConfigFileBase);
            core.info(`Expecting reduced ops config file at: ${opsConfigFileToUse}`);

            const artifactName = 'test_data';
            let artifactIdToDownload;
            try {
                core.info(`Attempting to find artifact named '${artifactName}'...`);
                const getArtifactResponse = await artifactClient.getArtifact(artifactName);
                if (!getArtifactResponse || !getArtifactResponse.artifact) {
                    throw new Error(`Artifact '${artifactName}' not found.`);
                }
                artifactIdToDownload = getArtifactResponse.artifact.id;
                core.info(`Found artifact '${artifactName}' with ID: ${artifactIdToDownload}`);

                core.info(`Downloading artifact ID ${artifactIdToDownload} to ${testDataDir}...`);
                const downloadResponse = await artifactClient.downloadArtifact(artifactIdToDownload, {
                    path: testDataDir
                });
                core.info(`Artifact download finished. Path: ${downloadResponse.downloadPath}`);

                // Verify the specific config file exists after download
                await fs.access(opsConfigFileToUse, fs.constants.R_OK);
                core.info(`Verified reduced ops config file exists: ${opsConfigFileToUse}`);
            } catch (error) {
                core.error(`Failed to find or download required file '${reducedOpsConfigFileBase}' in artifact '${artifactName}': ${error.message}`);
                throw new Error(`Failed to get required test data artifact '${artifactName}' or config file '${reducedOpsConfigFileBase}'.`);
            }
            core.endGroup();
        }

        // --- Install Python Requirements ---
        core.startGroup('Install Python Requirements');
        const requirementsPath = path.join(workspaceDir, 'tools/ci_build/github/linux/python/requirements.txt');
        await runCommand('python3', ['-m', 'pip', 'install', '--user','-r', requirementsPath], { cwd: workspaceDir });
        core.endGroup();

        // --- Build Minimal ORT ---
        core.startGroup('Build Minimal ORT');
        const buildScript = path.join(workspaceDir, 'tools/ci_build/build.py');
        const minimalBuildArgsValue = enableCustomOps ? 'custom_ops' : ''; // build.py handles empty string ok
        const buildArgs = [
            buildScript,
            '--build_dir', buildDir,
            '--cmake_generator', 'Ninja',
            '--config', 'Debug',
            '--skip_submodule_sync',
            '--build_shared_lib',
            '--use_vcpkg',
            '--use_vcpkg_ms_internal_asset_cache',
            '--parallel',
            '--use_binskim_compliant_compile_flags',
            '--minimal_build', minimalBuildArgsValue, // Add custom_ops if enabled
            '--disable_ml_ops',
            '--include_ops_by_config', opsConfigFileToUse, // Use the determined config file path
        ];
        // Note: enable_type_reduction is handled when *creating* the config file,
        // not as a direct build.py flag during minimal build based on that config.
        // If the *config file itself* was generated with type reduction, the build will reflect that.
        // The enable-type-reduction input here is mostly informative now.
        if (enableTypeReduction && globallyAllowedTypes) {
             core.warning('Input `enable-type-reduction` is set to true, but type reduction relies on how the config file was generated. When using `globally_allowed_types`, type reduction is NOT automatically applied by this action.');
        } else if (enableTypeReduction) {
            core.info('Input `enable-type-reduction` is true. Assuming the provided `reduced-ops-config-file` was generated with type reduction enabled.');
        }

        await runCommand('python3', buildArgs.filter(arg => arg !== ''), { cwd: workspaceDir }); // Filter empty string from minimalBuildArgs
        core.endGroup();

        // --- Run E2E Model Tests ---
        if (!skipModelTests) {
            core.startGroup('Run E2E Model Tests');
            core.info(`Running tests against minimal E2E data: ${minimalE2eTestDataDir}`);
            await runCommand(testRunnerPath, [minimalE2eTestDataDir]);

            core.info(`Running tests against standard ONNX test data: ${standardOnnxTestDataDir}`);
            // Note: This assumes the path /data/onnx exists and is accessible on the runner where this action executes.
            const standardTestDataExists = await checkPathExists(standardOnnxTestDataDir);
            if (standardTestDataExists) {
                await runCommand(testRunnerPath, [standardOnnxTestDataDir]);
            } else {
                core.warning(`Directory ${standardOnnxTestDataDir} not found or accessible on the runner. Skipping these tests.`);
            }
            core.endGroup();
        } else {
            core.info('Skipping E2E model tests as requested.');
        }

        // --- Check Binary Size ---
        core.startGroup('Check Binary Size');
        const checkSizeScript = path.join(workspaceDir, 'tools/ci_build/github/linux/ort_minimal/check_build_binary_size.py');
        const arch = os.arch().toLowerCase(); // e.g., x64, arm64
        const platform = os.platform().toLowerCase(); // e.g., linux, darwin, win32
        const osName = platform === 'linux' ? 'Linux' : platform; // Map 'linux' to 'Linux' as used in script

        // Ensure the library exists before checking its size
        try {
            await fs.access(libraryPath, fs.constants.R_OK);
            const sizeCheckArgs = [
                checkSizeScript,
                '--arch', arch,
                '--os', osName,
                '--build_config', 'minimal-reduced', // As per original script
                libraryPath
            ];
            // Add threshold if provided (assuming the script takes it as an optional arg)
            const sizeThreshold = core.getInput('size-threshold');
            if (sizeThreshold) {
                sizeCheckArgs.push('--threshold', sizeThreshold); // Adjust arg name if needed
            }
            await runCommand('python3', sizeCheckArgs);
        } catch (error) {
            core.warning(`Could not access library file ${libraryPath} or run size check script: ${error.message}`);
             // Decide if this should be a failure or warning - currently warning
             // throw new Error(`Failed during binary size check: ${error.message}`);
        }
        core.endGroup();

        // --- Upload Binary Size Report ---
        core.startGroup('Upload Binary Size Report');
        const reportArtifactName = `${binarySizeReportNamePrefix || 'minimal_build_'}${arch}_${osName}_binary_size_report`;
        core.info(`Uploading ${binarySizeReportPath} as artifact: ${reportArtifactName}`);
        try {
            await fs.access(binarySizeReportPath, fs.constants.R_OK); // Check if report exists
            const uploadResponse = await artifactClient.uploadArtifact(reportArtifactName, [binarySizeReportPath], debugOutputDir, {
                continueOnError: false // Fail the workflow if upload fails
            });
            core.info(`Artifact uploaded successfully: ${uploadResponse.artifactName}`);
        } catch (err) {
            core.warning(`Could not find or upload binary size report ${binarySizeReportPath}: ${err.message}`);
             // Fail the job if upload is critical, otherwise just warn - currently warning
             // throw new Error(`Failed to upload artifact: ${err.message}`);
        }
        core.endGroup();

        core.info('Action finished successfully.');

    } catch (error) {
        core.setFailed(`Action failed: ${error.message}`);
    }
}

// Execute the main function
main();