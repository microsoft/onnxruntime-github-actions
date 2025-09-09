const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const github = require('@actions/github');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Import shared utilities
const { executeCommand, verifySHA512, getPlatformIdentifier, getArchIdentifier } = require('../common/utils');

// --- CMake Specific Helper ---
async function getLatestCMakeVersion(githubToken) {
  core.info('Querying GitHub API for the latest CMake release...');
  if (!githubToken) throw new Error('GitHub token not provided to getLatestCMakeVersion.');
  const octokit = github.getOctokit(githubToken);
  try {
    const latestRelease = await octokit.rest.repos.getLatestRelease({ owner: 'Kitware', repo: 'CMake' });
    const tagName = latestRelease.data.tag_name;
    if (!tagName || !tagName.startsWith('v')) {
      throw new Error(`Unexpected tag format for latest CMake release: ${tagName}`);
    }
    const version = tagName.substring(1);
    core.info(`Latest CMake version found: ${version}`);
    return version;
  } catch (error) {
    core.error(`Failed to fetch latest CMake release: ${error.message}`);
    if (error.status === 403 || error.status === 401) {
      core.warning('GitHub API rate limit/auth error checking latest CMake version.');
    }
    throw error; // Re-throw error to fail the action if 'latest' was requested
  }
}

function getCMakeBinDir(cmakePath, platform) {
  if (platform === 'macos') {
    const macOsBinPath = path.join(cmakePath, 'CMake.app', 'Contents', 'bin');
    if (fs.existsSync(macOsBinPath)) {
      return macOsBinPath;
    }
  }
  return path.join(cmakePath, 'bin');
}

function normalizeVcpkgVersion(version) {
  const parts = version.split('.');
  if (parts.length === 3) {
    const year = parts[0];
    const month = parseInt(parts[1], 10).toString();
    const day = parseInt(parts[2], 10).toString();
    return `${year}.${month}.${day}`;
  }
  return version;
}

// --- vcpkg Specific Helpers ---

async function downloadVcpkgZip(version, hash, terrapinPath, disableTerrapin) {
  let downloadedZipPath;
  const downloadUrl = `https://github.com/microsoft/vcpkg/archive/refs/tags/${version}.zip`;

  // Use Terrapin if: path provided, path exists, Terrapin NOT disabled
  // Note: vcpkg requires hash, so hash presence check isn't needed here like for cmake
  const canUseTerrapin = terrapinPath && !disableTerrapin && fs.existsSync(terrapinPath);

  if (canUseTerrapin) {
    core.info(`Using Terrapin Tool for vcpkg at: ${terrapinPath}`);
    const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
    if (!runnerTempDir) throw new Error('Could not determine temporary directory for vcpkg download.');
    downloadedZipPath = path.join(runnerTempDir, `vcpkg-${version}.zip`); // More specific name
    core.info(`Terrapin will download vcpkg to: ${downloadedZipPath}`);
    const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';
    const terrapinArgs = [
      '-b',
      terrapinBaseUrl,
      '-a',
      'true',
      '-u',
      'Environment',
      '-p',
      downloadUrl,
      '-s',
      hash,
      '-d',
      downloadedZipPath,
    ];
    await core.group('Downloading vcpkg via Terrapin Tool', async () => {
      // Quote path in case it contains spaces
      await executeCommand(`"${terrapinPath}"`, terrapinArgs);
    });
    core.info(`Download vcpkg via Terrapin completed.`);
  } else {
    // Log reason for not using Terrapin
    if (terrapinPath && !fs.existsSync(terrapinPath)) {
      core.warning(
        `Terrapin tool path provided but not found at '${terrapinPath}'. Attempting direct download for vcpkg.`
      );
    } else if (disableTerrapin) {
      core.info('Terrapin usage disabled. Attempting direct download for vcpkg.');
    } else {
      core.info('Terrapin tool path not provided or unavailable. Attempting direct download for vcpkg.');
    }
    // Direct download
    downloadedZipPath = await tc.downloadTool(downloadUrl);
    core.info(`Direct download for vcpkg completed. Archive at: ${downloadedZipPath}`);
  }
  // Verify download happened
  if (!fs.existsSync(downloadedZipPath)) {
    throw new Error(`vcpkg download failed: Expected file not found at ${downloadedZipPath}.`);
  }
  return downloadedZipPath;
}

async function extractVcpkgZip(downloadedZipPath) {
  core.info(`Extracting vcpkg archive: ${path.basename(downloadedZipPath)}...`);
  const tempExtractPath = await tc.extractZip(downloadedZipPath);
  core.info(`Extracted vcpkg to temporary location: ${tempExtractPath}`);
  return tempExtractPath;
}

function findActualVcpkgDir(tempExtractPath, vcpkgVersion) {
  const primaryExpectedDir = path.join(tempExtractPath, `vcpkg-${vcpkgVersion}`);
  if (fs.existsSync(primaryExpectedDir) && fs.statSync(primaryExpectedDir).isDirectory()) {
    core.info(`Found extracted vcpkg directory: ${primaryExpectedDir}`);
    return primaryExpectedDir;
  }
  core.warning(
    `Expected vcpkg folder pattern 'vcpkg-${vcpkgVersion}' not found directly in ${tempExtractPath}. Searching...`
  );

  const files = fs.readdirSync(tempExtractPath);
  const directories = files.filter((f) => {
    try {
      return fs.statSync(path.join(tempExtractPath, f)).isDirectory();
    } catch {
      return false;
    }
  });

  if (directories.length === 1) {
    const nestedPath = path.join(tempExtractPath, directories[0]);
    core.warning(`Assuming single nested directory '${directories[0]}' is the correct vcpkg path: ${nestedPath}`);
    return nestedPath;
  }

  // Fallback 2: Check if tag had 'v' prefix but directory doesn't (less common for vcpkg tags)
  if (vcpkgVersion.startsWith('v')) {
    const fallbackVersion = vcpkgVersion.substring(1);
    const fallbackPath = path.join(tempExtractPath, `vcpkg-${fallbackVersion}`);
    if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isDirectory()) {
      core.warning(`Found extracted vcpkg dir matching tag without 'v' prefix: ${fallbackPath}`);
      return fallbackPath;
    }
  }

  throw new Error(
    `Could not reliably find the extracted vcpkg directory inside ${tempExtractPath}. Found directories: ${directories.join(', ')}`
  );
}

async function bootstrapVcpkg(extractedPath) {
  core.info(`Bootstrapping vcpkg in ${extractedPath}...`);
  const platform = process.platform;
  const bootstrapScriptName = platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh';
  const bootstrapScriptPath = path.join(extractedPath, bootstrapScriptName);
  const bootstrapArgs = ['-disableMetrics'];

  if (!fs.existsSync(bootstrapScriptPath)) throw new Error(`Bootstrap script not found at ${bootstrapScriptPath}`);

  await core.group('Running vcpkg bootstrap', async () => {
    const options = { cwd: extractedPath };
    if (platform !== 'win32') {
      await exec.exec('chmod', ['+x', bootstrapScriptPath]);
    }
    core.info(`Executing: ${bootstrapScriptPath} ${bootstrapArgs.join(' ')}`);
    await exec.exec(bootstrapScriptPath, bootstrapArgs, options);
  });
  core.info('vcpkg bootstrapped successfully.');
}

async function cacheVcpkgDir(extractedPath, toolName, version) {
  core.info(`Caching bootstrapped vcpkg directory: ${extractedPath}`);
  const finalPath = await tc.cacheDir(extractedPath, toolName, version);
  core.info(`Successfully cached vcpkg to: ${finalPath}`);
  return finalPath;
}

// --- Shared Helper ---
function cleanupDownload(downloadedPath, toolName = 'Archive') {
  try {
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      fs.unlinkSync(downloadedPath);
      core.info(`Cleaned up downloaded ${toolName} archive: ${downloadedPath}`);
    }
  } catch (e) {
    core.warning(`Failed to delete downloaded ${toolName} archive '${downloadedPath}': ${e.message}`);
  }
}

// --- Main Orchestration Function ---
async function run() {
  let cmakeDownloadedArchivePath; // Track potential CMake download path for cleanup
  let vcpkgDownloadedZipPath; // Track potential vcpkg download path for cleanup

  try {
    // --- Get Combined Inputs ---
    const cmakeVersionInput = core.getInput('cmake-version', { required: true });
    const cmakeHash = core.getInput('cmake-hash'); // Optional
    const vcpkgVersion = core.getInput('vcpkg-version', { required: true });
    const vcpkgHash = core.getInput('vcpkg-hash', { required: true }); // Required
    const terrapinPath = core.getInput('terrapin-tool-path');
    const disableTerrapin = core.getBooleanInput('disable-terrapin');
    const addCMakeToPath = core.getBooleanInput('add-cmake-to-path');
    const githubToken = core.getInput('github-token'); // Use default from action.yml

    const platform = getPlatformIdentifier();
    const arch = getArchIdentifier();
    const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
    if (!runnerTempDir) throw new Error('Runner temporary directory not found.');

    // === CMake Setup ===
    core.startGroup('Setup CMake');
    const cmakeHasHash = cmakeHash && cmakeHash.trim() !== '';
    const cmakeToolName = 'cmake';

    // Resolve CMake Version
    let resolvedCmakeVersion = cmakeVersionInput;
    if (cmakeVersionInput.toLowerCase() === 'latest') {
      core.info('Resolving "latest" CMake version via GitHub API...');
      resolvedCmakeVersion = await getLatestCMakeVersion(githubToken);
    }
    core.info(`Setting up CMake version: ${resolvedCmakeVersion} for ${platform}-${arch}`);

    // CMake Cache Check
    const cmakeCacheKeyArch = `${platform}-${arch}`;
    let cmakeRootPath = tc.find(cmakeToolName, resolvedCmakeVersion, cmakeCacheKeyArch);

    if (cmakeRootPath) {
      core.info(`Found cached CMake at: ${cmakeRootPath}`);
    } else {
      // CMake Cache Miss Logic
      core.info(`CMake version ${resolvedCmakeVersion} (${cmakeCacheKeyArch}) not found in cache. Downloading...`);

      const cmakeFileExtension = platform === 'windows' ? 'zip' : 'tar.gz';
      let cmakeFileName = `cmake-${resolvedCmakeVersion}-${platform}-${arch}`;
      if (platform === 'macos' && arch === 'universal') cmakeFileName = `cmake-${resolvedCmakeVersion}-macos-universal`;
      const cmakeArchiveFileName = `${cmakeFileName}.${cmakeFileExtension}`;
      const cmakeDownloadUrl = `https://github.com/Kitware/CMake/releases/download/v${resolvedCmakeVersion}/${cmakeArchiveFileName}`;
      core.info(`CMake Download URL: ${cmakeDownloadUrl}`);

      // Determine CMake Download Method
      const cmakeCanUseTerrapin =
        platform === 'windows' && cmakeHasHash && !disableTerrapin && fs.existsSync(terrapinPath);
      core.info(`Attempting CMake download via ${cmakeCanUseTerrapin ? 'Terrapin' : 'direct download'}`);
      if (!cmakeHasHash && !cmakeCanUseTerrapin) {
        // Warn only if direct downloading without hash
        core.warning('CMake SECURITY RISK: `cmake-hash` not provided. Integrity will NOT be verified.');
      }

      // Download CMake
      const cmakeTempDownloadPath = path.join(runnerTempDir, cmakeArchiveFileName);
      if (cmakeCanUseTerrapin) {
        const terrapinBaseUrl = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';
        const terrapinArgs = [
          '-b',
          terrapinBaseUrl,
          '-a',
          'true',
          '-u',
          'Environment',
          '-p',
          cmakeDownloadUrl,
          '-s',
          cmakeHash,
          '-d',
          cmakeTempDownloadPath,
        ];
        await core.group('Downloading CMake via Terrapin Tool', async () => {
          await executeCommand(`"${terrapinPath}"`, terrapinArgs);
        });
        cmakeDownloadedArchivePath = cmakeTempDownloadPath; // Track for cleanup
      } else {
        await core.group('Downloading CMake directly', async () => {
          cmakeDownloadedArchivePath = await tc.downloadTool(cmakeDownloadUrl, cmakeTempDownloadPath); // Track for cleanup
        });
      }
      core.info(`CMake download completed. Archive at: ${cmakeDownloadedArchivePath}`);
      if (!fs.existsSync(cmakeDownloadedArchivePath))
        throw new Error(`CMake download failed: File not found at ${cmakeDownloadedArchivePath}`);

      // Verify CMake Hash (if provided)
      if (cmakeHasHash) {
        core.info('Verifying CMake SHA512 hash...');
        const cmakeHashMatch = await verifySHA512(cmakeDownloadedArchivePath, cmakeHash);
        if (!cmakeHashMatch) {
          cleanupDownload(cmakeDownloadedArchivePath, 'CMake (mismatched hash)'); // Attempt cleanup before throwing
          throw new Error('CMake SHA512 hash verification failed!');
        }
        core.info('CMake SHA512 hash verification successful.');
      }

      // Extract CMake
      core.info(`Extracting ${cmakeArchiveFileName}...`);
      let cmakeTempExtractPath;
      if (cmakeFileExtension === 'zip') cmakeTempExtractPath = await tc.extractZip(cmakeDownloadedArchivePath);
      else cmakeTempExtractPath = await tc.extractTar(cmakeDownloadedArchivePath);
      core.info(`Extracted CMake archive to temporary location: ${cmakeTempExtractPath}`);

      // Locate CMake Directory
      const cmakePotentialRoot = path.join(cmakeTempExtractPath, cmakeFileName);
      if (fs.existsSync(cmakePotentialRoot) && fs.statSync(cmakePotentialRoot).isDirectory()) {
        cmakeRootPath = cmakePotentialRoot;
      } else {
        const files = fs.readdirSync(cmakeTempExtractPath);
        const dirs = files.filter((f) => fs.statSync(path.join(cmakeTempExtractPath, f)).isDirectory());
        if (dirs.length === 1) {
          cmakeRootPath = path.join(cmakeTempExtractPath, dirs[0]);
          core.warning(`Assuming single directory '${dirs[0]}' is CMake root.`);
        } else {
          throw new Error(
            `Could not locate extracted CMake directory in ${cmakeTempExtractPath}. Found: ${dirs.join(', ')}`
          );
        }
      }
      core.info(`Located extracted CMake root at: ${cmakeRootPath}`);

      // Cache CMake Directory
      core.info(`Caching CMake directory: ${cmakeRootPath}`);
      cmakeRootPath = await tc.cacheDir(cmakeRootPath, cmakeToolName, resolvedCmakeVersion, cmakeCacheKeyArch);
      core.info(`Successfully cached CMake to: ${cmakeRootPath}`);

      // Cleanup handled in finally block
    } // End CMake cache miss

    // Add CMake to PATH (if requested)
    const cmakeBinPath = getCMakeBinDir(cmakeRootPath, platform);
    if (!fs.existsSync(cmakeBinPath)) throw new Error(`CMake 'bin' directory not found: ${cmakeBinPath}`);

    if (addCMakeToPath) {
      core.info(`Adding ${cmakeBinPath} to PATH.`);
      core.addPath(cmakeBinPath);

      // Verify Installation via PATH
      await core.group('Verifying CMake installation via PATH', async () => {
        try {
          await exec.exec('cmake', ['--version']);
        } catch (error) {
          core.warning(`Verification 'cmake --version' failed: ${error.message}. Check PATH or CMake installation.`);
        }
      });
    } else {
      core.info(`Skipping adding ${cmakeBinPath} to PATH.`);
    }

    // Set CMake Outputs
    core.setOutput('cmake-root', cmakeRootPath);
    core.setOutput('cmake-path', cmakeBinPath);
    core.info(`CMake ${resolvedCmakeVersion} setup complete.`);
    core.endGroup(); // End CMake setup group

    // === vcpkg Setup ===
    core.startGroup('Setup vcpkg');
    const vcpkgToolName = 'vcpkg';
    const normalizedVcpkgVersion = normalizeVcpkgVersion(vcpkgVersion);
    core.info(`Setting up vcpkg version: ${vcpkgVersion} (normalized to ${normalizedVcpkgVersion})`);

    // vcpkg Cache Check
    let finalVcpkgPath = tc.find(vcpkgToolName, normalizedVcpkgVersion); // vcpkg cache key seems simpler

    if (finalVcpkgPath) {
      core.info(`Found cached vcpkg at: ${finalVcpkgPath}`);
    } else {
      // vcpkg Cache Miss Logic
      core.info(`vcpkg version ${vcpkgVersion} not found in cache. Downloading...`);
      vcpkgDownloadedZipPath = await downloadVcpkgZip(vcpkgVersion, vcpkgHash, terrapinPath, disableTerrapin); // Track for cleanup
      await verifySHA512(vcpkgDownloadedZipPath, vcpkgHash); // Throws on mismatch
      const vcpkgTempExtractPath = await extractVcpkgZip(vcpkgDownloadedZipPath);
      const vcpkgExtractedPath = findActualVcpkgDir(vcpkgTempExtractPath, vcpkgVersion);
      await bootstrapVcpkg(vcpkgExtractedPath);
      finalVcpkgPath = await cacheVcpkgDir(vcpkgExtractedPath, vcpkgToolName, normalizedVcpkgVersion);
      // Cleanup handled in finally block
    } // End vcpkg cache miss

    // Set vcpkg Environment Variable & Output
    core.info(`Setting VCPKG_INSTALLATION_ROOT to ${finalVcpkgPath}`);
    core.exportVariable('VCPKG_INSTALLATION_ROOT', finalVcpkgPath);
    core.setOutput('vcpkg-root', finalVcpkgPath);
    core.info('vcpkg setup complete.');
    core.endGroup(); // End vcpkg setup group
  } catch (error) {
    // Fail the action with the error message
    core.setFailed(error.message);
  } finally {
    // Cleanup downloads only if they were actually performed (i.e., path variable is set)
    cleanupDownload(cmakeDownloadedArchivePath, 'CMake');
    cleanupDownload(vcpkgDownloadedZipPath, 'vcpkg');
  }
}

// --- Run ---
if (require.main === module) {
  run();
}

// --- Exports ---
// Export the main run function and utility helpers
module.exports = { run, getCMakeBinDir, normalizeVcpkgVersion };
