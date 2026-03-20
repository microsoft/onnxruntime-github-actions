const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const github = require('@actions/github');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require("node:crypto");
const fs = require('node:fs');
const os = require('node:os');

// Import shared utilities
const { executeCommand, verifySHA512, getPlatformIdentifier, getArchIdentifier, addPath, exportVariable } = require('../common/utils');

const TERRAPIN_BASE_URL = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';

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

function terrapinAvailable(terrapinPath, allowTerrapin) {
  if (!allowTerrapin) {
    core.info('Terrapin usage disabled.');
    return false;
  }

  if (!terrapinPath) {
    core.info('Terrapin tool path not provided or unavailable.');
    return false;
  }

  if (!fs.existsSync(terrapinPath)) {
    core.warning(`Terrapin tool path provided but not found at '${terrapinPath}'.`);
    return false;
  }

  core.info(`Using Terrapin tool @ ${terrapinPath}`);
  return true;
}

// PRECONDITION: `terrapinTool` != null <> `terrapinTool` exists on disk and we should use it
async function downloadArchive(terrapinTool, downloadUrl, hash) {
  // Not robust/correct, but whatever. Keep the extension for the file b/c some tools try to infer behaviour from it.
  // e.g. `tar`
  const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
  if (!runnerTempDir) throw new Error('Could not determine temporary directory for download.');

  // Not robust/correct, but whatever. Keep the filename for the file b/c some tools try to infer behaviour from it.
  // e.g. `tar` can infer the compression type.
  const baseName = path.basename(downloadUrl);
  const downloadedFile = path.join(runnerTempDir, `${crypto.randomUUID()}_${baseName}`); // random name to avoid conflicts/security issues

  // Use Terrapin if: path provided, path exists, Terrapin NOT disabled
  // Note: vcpkg requires hash, so hash presence check isn't needed here like for cmake
  if (terrapinTool) {
    // Quote command path in case it contains spaces. Underlying API is poorly designed and doesn't handle this.
    await core.group(`Downloading ${downloadUrl} via Terrapin Tool`, async () => await executeCommand(`"${terrapinTool}"`, [
      '-b',
      TERRAPIN_BASE_URL,
      '-a',
      'true',
      '-u',
      'Environment',
      '-p',
      downloadUrl,
      '-s',
      hash,
      '-d',
      downloadedFile,
    ]));
  } else {
    const result = await core.group(`Downloading ${downloadUrl} directly`, async () => await tc.downloadTool(downloadUrl, downloadedFile));
    assert.strictEqual(result, downloadedFile, `Unexpected download location returned by tool-cache: ${result} (expected: ${downloadedFile})`);
  }

  if (!fs.existsSync(downloadedFile)) { // Verify download happened
    throw new Error(`vcpkg download failed: Expected file not found at ${downloadedFile}.`);
  }

  try {
    // Ostensibly terrapin should already have validated this on that branch, but I cannot confirm given the lack of documentation/access to the tool.
    if (!await verifySHA512(downloadedFile, hash)) // does *NOT* throws on mismatch
      throw new Error(`SHA512 hash mismatch for downloaded file at ${downloadedFile}.`);
  } catch (error) {
    fs.unlinkSync(downloadedFile); // do not leave unverified files around
    throw error;
  }
  return downloadedFile;
}

async function downloadVcpkgZip(terrapinTool, version, hash) {
  return await downloadArchive(terrapinTool, `https://github.com/microsoft/vcpkg/archive/refs/tags/${version}.zip`, hash)
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
function cleanupDownload(downloadedPath) {
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
    const cmakeHash = core.getInput('cmake-hash', { required: true });
    const vcpkgVersion = core.getInput('vcpkg-version', { required: true });
    const vcpkgHash = core.getInput('vcpkg-hash', { required: true });
    const terrapinPath = core.getInput('terrapin-tool-path');
    const allowTerrapin = !core.getBooleanInput('disable-terrapin'); // keep logic positive to minimise double negatives
    const addCMakeToPath = core.getBooleanInput('add-cmake-to-path');
    const githubToken = core.getInput('github-token'); // Use default from action.yml

    const platform = getPlatformIdentifier();
    const arch = getArchIdentifier();
    const runnerTempDir = process.env.RUNNER_TEMP || os.tmpdir();
    if (!runnerTempDir) throw new Error('Runner temporary directory not found.');

    const terrapinTool = terrapinAvailable(terrapinPath, allowTerrapin) ? terrapinPath : null;

    // === CMake Setup ===
    core.startGroup('Setup CMake');
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
      const cmakeFileName = platform === 'macos' && arch === 'universal'
        ? `cmake-${resolvedCmakeVersion}-macos-universal`
        : `cmake-${resolvedCmakeVersion}-${platform}-${arch}`;
      const cmakeDownloadUrl = `https://github.com/Kitware/CMake/releases/download/v${resolvedCmakeVersion}/${cmakeFileName}.${cmakeFileExtension}`;
      const cmakeDownloadedArchivePath = await downloadArchive(terrapinTool, cmakeDownloadUrl, cmakeHash);

      core.debug(`Extracting ${cmakeDownloadedArchivePath}...`);
      const cmakeTempExtractPath = cmakeFileExtension === 'zip'
        ? await tc.extractZip(cmakeDownloadedArchivePath)
        : await tc.extractTar(cmakeDownloadedArchivePath);
      core.debug(`Extracted CMake archive to temporary location: ${cmakeTempExtractPath}`);

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
      addPath(cmakeBinPath);

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
      vcpkgDownloadedZipPath = await downloadVcpkgZip(terrapinTool, vcpkgVersion, vcpkgHash); // Track for cleanup
      const vcpkgTempExtractPath = await extractVcpkgZip(vcpkgDownloadedZipPath);
      const vcpkgExtractedPath = findActualVcpkgDir(vcpkgTempExtractPath, vcpkgVersion);
      await bootstrapVcpkg(vcpkgExtractedPath);
      finalVcpkgPath = await cacheVcpkgDir(vcpkgExtractedPath, vcpkgToolName, normalizedVcpkgVersion);
      // Cleanup handled in finally block
    } // End vcpkg cache miss

    // Set vcpkg Environment Variable & Output
    core.info(`Setting VCPKG_INSTALLATION_ROOT to ${finalVcpkgPath}`);
    exportVariable('VCPKG_INSTALLATION_ROOT', finalVcpkgPath);
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
