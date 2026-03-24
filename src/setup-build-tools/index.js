const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

// Import shared utilities
const { executeCommand, verifySHA512, getPlatformIdentifier, getArchIdentifier, addPath, exportVariable } = require('../common/utils');

const TERRAPIN_BASE_URL = 'https://vcpkg.storage.devpackages.microsoft.io/artifacts/';

// --- CMake Specific Helper ---

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

async function cacheTool(terrapinTool, toolName, version, url, hash, extract) {
  const archKey = `${getPlatformIdentifier()}-${getArchIdentifier()}`;
  const cachedDir = tc.find(toolName, version, archKey);
  if (cachedDir) {
    core.info(`Found cached ${toolName} at: ${cachedDir}`);
    return cachedDir;
  }

  const downloadFile = await downloadArchive(terrapinTool, url, hash)
  let extractDir;
  try {
    extractDir = await extract(downloadFile);
  } finally {
    try {
      fs.unlinkSync(downloadFile);
      core.debug(`Cleaned up downloaded archive: ${downloadFile}`);
    } catch (e) {
      core.warning(`Failed to delete downloaded archive '${downloadFile}': ${e.message}`);
    }
  }

  const toolDir = await tc.cacheDir(extractDir, toolName, version, archKey);
  core.debug(`Cached ${toolName} at: ${toolDir}`);
  return toolDir;
}

async function run__ccache(terrapinTool, version, hash, addToPath) {
  const platform = getPlatformIdentifier();
  const platformSuffix =
    platform === 'macos' ? 'darwin.tar.gz' :
      platform == 'linux' ? `linux-${getArchIdentifier()}-musl-static.tar.xz` :
        platform === 'windows' ? `windows-${getArchIdentifier()}.zip` :
          new Error(`Unsupported platform for CCache download: ${platform}`);

  const ccacheDir = await cacheTool(
    terrapinTool,
    "ccache", version,
    `https://github.com/ccache/ccache/releases/download/v${version}/ccache-${version}-${platformSuffix}`, hash,
    async (download) => {
      core.debug(`Extracting ${download}...`);
      const extractDir = platform === 'windows'
        ? await tc.extractZip(download)
        : await tc.extractTar(download, undefined, 'x'); // infer extract type from extension
      core.debug(`Extracted archive to temporary location: ${extractDir}`);

      const dirs = fs.readdirSync(extractDir).filter((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
      if (dirs.length !== 1) throw new Error(
        `Could not locate extracted ccache directory in ${extractDir}. Found: ${dirs.join(', ')}`
      );

      core.warning(`Assuming single directory '${dirs[0]}' is CCache root.`);
      return path.join(extractDir, dirs[0]);
    });
  core.info(`Located extracted CCache root at: ${ccacheDir}`);

  if (addToPath) {
    core.info(`Adding ${ccacheDir} to PATH.`);
    addPath(ccacheDir);

    try {
      // Verify Installation via PATH
      await exec.exec('ccache', ['--version']);
    } catch (error) {
      throw new Error(`Verification 'ccache --version' failed: ${error.message}. Check PATH or CCache installation.`, { cause: error });
    }
  } else {
    core.info(`Skipping adding ${ccacheDir} to PATH.`);
  }

  // for now they're the same, but let's keep it separate for consistency with CMake
  core.setOutput('ccache-root', ccacheDir);
  core.setOutput('ccache-path', ccacheDir);
}

async function run__cmake(terrapinTool, version, hash, addToPath) {
  const platform = getPlatformIdentifier();
  const arch = getArchIdentifier();
  const cmakeFileExtension = platform === 'windows' ? 'zip' : 'tar.gz';
  const cmakeFileName = `cmake-${version}-${platform}-${arch}`;

  const cmakeDir = await cacheTool(
    terrapinTool,
    "cmake", version,
    `https://github.com/Kitware/CMake/releases/download/v${version}/${cmakeFileName}.${cmakeFileExtension}`, hash,
    async (download) => {
      core.debug(`Extracting ${download}...`);
      const extractDir = cmakeFileExtension === 'zip'
        ? await tc.extractZip(download)
        : await tc.extractTar(download);
      core.debug(`Extracted archive to temporary location: ${extractDir}`);

      // Locate CMake Directory
      const maybeRoot = path.join(extractDir, cmakeFileName);
      if (fs.existsSync(maybeRoot) && fs.statSync(maybeRoot).isDirectory())
        return maybeRoot;

      const dirs = fs.readdirSync(extractDir).filter((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
      if (dirs.length !== 1) throw new Error(
        `Could not locate extracted CMake directory in ${extractDir}. Found: ${dirs.join(', ')}`
      );

      core.warning(`Assuming single directory '${dirs[0]}' is CMake root.`);
      return path.join(extractDir, dirs[0]);
    });
  core.info(`Located extracted CMake root at: ${cmakeDir}`);

  // Add CMake to PATH (if requested)
  const binPath = getCMakeBinDir(cmakeDir, platform);
  if (!fs.existsSync(binPath)) throw new Error(`CMake 'bin' directory not found: ${binPath}`);

  if (addToPath) {
    core.info(`Adding ${binPath} to PATH.`);
    addPath(binPath);

    try {
      // Verify Installation via PATH
      await exec.exec('cmake', ['--version']);
    } catch (error) {
      throw new Error(`Verification 'cmake --version' failed: ${error.message}. Check PATH or CMake installation.`, { cause: error });
    }
  } else {
    core.info(`Skipping adding ${binPath} to PATH.`);
  }

  // Set CMake Outputs
  core.setOutput('cmake-root', cmakeDir);
  core.setOutput('cmake-path', binPath);
}

async function run__vcpkg(terrapinTool, version, hash) {
  const vcpkgDir = await cacheTool(
    terrapinTool,
    "vcpkg", normalizeVcpkgVersion(version),
    `https://github.com/microsoft/vcpkg/archive/refs/tags/${version}.zip`, hash,
    async (download) => {
      const extracted = await extractVcpkgZip(download);
      const extractedActual = findActualVcpkgDir(extracted, version);
      await bootstrapVcpkg(extractedActual);
      return extractedActual;
    });
  exportVariable('VCPKG_INSTALLATION_ROOT', vcpkgDir);
  core.setOutput('vcpkg-root', vcpkgDir);
}

// --- Main Orchestration Function ---
async function run() {
  try {
    const ccacheVersion = core.getInput('ccache-version', { required: true });
    const ccacheHash = core.getInput('ccache-hash', { required: true });
    const addCCacheToPath = core.getBooleanInput('add-ccache-to-path');

    const cmakeVersion = core.getInput('cmake-version', { required: true });
    const cmakeHash = core.getInput('cmake-hash', { required: true });
    const addCMakeToPath = core.getBooleanInput('add-cmake-to-path');

    const vcpkgVersion = core.getInput('vcpkg-version', { required: true });
    const vcpkgHash = core.getInput('vcpkg-hash', { required: true });

    const terrapinPath = core.getInput('terrapin-tool-path');
    const allowTerrapin = !core.getBooleanInput('disable-terrapin'); // keep logic positive to minimise double negatives

    const terrapinTool = terrapinAvailable(terrapinPath, allowTerrapin) ? terrapinPath : null;
    await core.group(`Setup ccache`, async () => { await run__ccache(terrapinTool, ccacheVersion, ccacheHash, addCCacheToPath) });
    await core.group(`Setup cmake`, async () => { await run__cmake(terrapinTool, cmakeVersion, cmakeHash, addCMakeToPath) });
    await core.group(`Setup vcpkg`, async () => { await run__vcpkg(terrapinTool, vcpkgVersion, vcpkgHash) });
  } catch (error) {
    // Fail the action with the error message
    core.setFailed(error.message);
  }
}

// --- Run ---
if (require.main === module) {
  run();
}

// --- Exports ---
// Export the main run function and utility helpers
module.exports = { run, getCMakeBinDir, normalizeVcpkgVersion };
