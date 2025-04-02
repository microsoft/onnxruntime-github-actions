// test/setup-vcpkg.test.js
// Updated: 2025-03-28 - Attempt 14: Final fixes for helper tests

const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const exec = require('@actions/exec');
const path = require('path');
const os = require('os');
const { Volume } = require('memfs');

// --- Mock Dependencies ---
jest.mock('../src/common/utils', () => ({
  executeCommand: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  verifySHA512: jest.fn().mockResolvedValue(true),
}));
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/tool-cache');

try {
  jest.mock('fs', () => require('./memfs-volume.js').fs);
  jest.mock('node:fs', () => require('./memfs-volume.js').fs);
  jest.mock('node:fs/promises', () => require('./memfs-volume.js').fs.promises);
} catch (e) {
  console.error('Failed to mock fs, ensure test/memfs-volume.js exists and memfs is installed.', e);
  process.exit(1);
}
// --- ------------------- ---
jest.mock('os', () => ({ ...jest.requireActual('os'), tmpdir: jest.fn() }));

// --- Import modules AFTER mocks ---
const { vol } = require('./memfs-volume.js'); // Get volume control object
const utils = require('../src/common/utils'); // Mocked utils
const setupVcpkg = require('../src/setup-vcpkg/index.js'); // Import all exports
const {
  run,
  getInputs,
  downloadVcpkgZip,
  extractVcpkgZip,
  findActualVcpkgDir,
  bootstrapVcpkg,
  cacheVcpkgDir,
  cleanupDownload,
} = setupVcpkg; // Destructure functions

// --- Test Suite ---
describe('Setup vcpkg Action - Helper Functions', () => {
  // Updated describe name

  // --- Test Constants ---
  const TEST_VERSION = '2025.01.01';
  const TEST_HASH = 'a1b2c3d4e5f6fedcba9876543210abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const TEST_TERRAPIN_PATH = path.normalize('C:/test/tools/TerrapinTool.exe');
  const TEST_RUNNER_TEMP = path.normalize('/runner/_temp');
  const TEST_VCPKG_CACHE_DIR = path.normalize('/opt/hostedtoolcache/vcpkg/' + TEST_VERSION + '/x64');
  const TEST_DOWNLOAD_ZIP_PATH = path.join(TEST_RUNNER_TEMP, 'vcpkg.zip');
  const TEST_DOWNLOAD_URL = `https://github.com/microsoft/vcpkg/archive/refs/tags/${TEST_VERSION}.zip`;
  const TEST_TEMP_EXTRACT_PATH = path.join(TEST_RUNNER_TEMP, 'temp_extract');
  const TEST_EXTRACTED_VCPKG_DIR_EXACT = path.join(TEST_TEMP_EXTRACT_PATH, `vcpkg-${TEST_VERSION}`);
  const TEST_EXTRACTED_VCPKG_DIR_NESTED = path.join(TEST_TEMP_EXTRACT_PATH, 'nested-dir');
  const TEST_FINAL_CACHED_PATH = path.normalize('/tc/vcpkg/' + TEST_VERSION + '/x64');

  let originalEnv, originalPlatform;

  // Helper function to ensure directory exists in memfs before writing
  const ensureDirExistsSync = (filePath) => {
    const dir = path.dirname(filePath);
    if (!vol.existsSync(dir)) {
      vol.mkdirSync(dir, { recursive: true });
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    vol.reset();
    originalEnv = { ...process.env };
    originalPlatform = process.platform;
    process.env = { ...originalEnv, RUNNER_TEMP: TEST_RUNNER_TEMP };
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });

    // Default core mocks
    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'vcpkg-version':
          return TEST_VERSION;
        case 'vcpkg-hash':
          return TEST_HASH;
        case 'terrapin-tool-path':
          return TEST_TERRAPIN_PATH;
        default:
          return '';
      }
    });
    core.group.mockImplementation(async (name, fn) => await fn());
    core.setFailed.mockImplementation((msg) => {
      throw new Error(`MOCK_setFailed: ${msg}`);
    });

    // Default util mocks
    utils.executeCommand.mockResolvedValue({ stdout: '', stderr: '' });
    utils.verifySHA512.mockResolvedValue(true);

    // Default tc mocks
    tc.find.mockReturnValue('');
    tc.downloadTool.mockImplementation(async (url, dest) => {
      const finalDest = dest || TEST_DOWNLOAD_ZIP_PATH;
      ensureDirExistsSync(finalDest);
      vol.writeFileSync(finalDest, 'zip content');
      return finalDest;
    });
    tc.extractZip.mockImplementation(async (zipPath, dest) => {
      const extractDest = dest || TEST_TEMP_EXTRACT_PATH;
      const vcpkgDir = path.join(extractDest, `vcpkg-${TEST_VERSION}`);
      ensureDirExistsSync(vcpkgDir);
      vol.mkdirSync(vcpkgDir);
      const platform = process.platform;
      const scriptName = platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh';
      ensureDirExistsSync(path.join(vcpkgDir, scriptName));
      vol.writeFileSync(path.join(vcpkgDir, scriptName), 'bootstrap script');
      return extractDest;
    });
    tc.cacheDir.mockResolvedValue(TEST_FINAL_CACHED_PATH);

    // Default exec mock
    exec.exec.mockResolvedValue(0);

    // Default os mock
    os.tmpdir.mockReturnValue(path.normalize('/fallback_tmp'));
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  };

  // --- Tests for getInputs ---
  describe('getInputs', () => {
    it('should return values from core.getInput', () => {
      const inputs = getInputs(); // Use imported helper
      expect(inputs).toEqual({
        vcpkgVersion: TEST_VERSION,
        vcpkgHash: TEST_HASH,
        terrapinPath: TEST_TERRAPIN_PATH,
      });
      expect(core.getInput).toHaveBeenCalledWith('vcpkg-version', { required: true });
      expect(core.getInput).toHaveBeenCalledWith('vcpkg-hash', { required: true });
      expect(core.getInput).toHaveBeenCalledWith('terrapin-tool-path');
    });
  });

  // --- Tests for downloadVcpkgZip ---
  describe('downloadVcpkgZip', () => {
    it('should use Terrapin when path exists', async () => {
      ensureDirExistsSync(TEST_TERRAPIN_PATH);
      vol.writeFileSync(TEST_TERRAPIN_PATH, 'exe');
      utils.executeCommand.mockImplementationOnce(async (cmd, args) => {
        ensureDirExistsSync(TEST_DOWNLOAD_ZIP_PATH);
        vol.writeFileSync(TEST_DOWNLOAD_ZIP_PATH, 'zip content');
        return { stdout: '', stderr: '' };
      });

      const result = await downloadVcpkgZip(TEST_VERSION, TEST_HASH, TEST_TERRAPIN_PATH); // Use imported helper

      expect(vol.existsSync(TEST_TERRAPIN_PATH)).toBe(true);
      expect(utils.executeCommand).toHaveBeenCalledTimes(1);
      expect(utils.executeCommand).toHaveBeenCalledWith(
        `"${TEST_TERRAPIN_PATH}"`,
        expect.arrayContaining([TEST_DOWNLOAD_URL, TEST_HASH, TEST_DOWNLOAD_ZIP_PATH])
      );
      expect(tc.downloadTool).not.toHaveBeenCalled();
      expect(result).toBe(TEST_DOWNLOAD_ZIP_PATH);
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(true);
    });

    it('should use tc.downloadTool when Terrapin path is empty', async () => {
      const result = await downloadVcpkgZip(TEST_VERSION, TEST_HASH, ''); // Use imported helper
      expect(utils.executeCommand).not.toHaveBeenCalled();
      expect(tc.downloadTool).toHaveBeenCalledWith(TEST_DOWNLOAD_URL);
      expect(result).toBe(TEST_DOWNLOAD_ZIP_PATH);
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(true);
    });

    it('should use tc.downloadTool when Terrapin file does not exist', async () => {
      const result = await downloadVcpkgZip(TEST_VERSION, TEST_HASH, TEST_TERRAPIN_PATH); // Use imported helper
      expect(utils.executeCommand).not.toHaveBeenCalled();
      expect(tc.downloadTool).toHaveBeenCalledWith(TEST_DOWNLOAD_URL);
      expect(result).toBe(TEST_DOWNLOAD_ZIP_PATH);
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(true);
    });

    it('should throw if download file does not exist after attempt', async () => {
      tc.downloadTool.mockResolvedValue(TEST_DOWNLOAD_ZIP_PATH); // Return path but DO NOT write to vol
      await expect(downloadVcpkgZip(TEST_VERSION, TEST_HASH, '')) // Use imported helper
        .rejects.toThrow(`Download failed: Expected file not found at ${TEST_DOWNLOAD_ZIP_PATH}`);
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(false);
    });
  });

  // --- Tests for extractVcpkgZip ---
  describe('extractVcpkgZip', () => {
    it('should call tc.extractZip and return path', async () => {
      const result = await extractVcpkgZip(TEST_DOWNLOAD_ZIP_PATH); // Use imported helper
      expect(tc.extractZip).toHaveBeenCalledWith(TEST_DOWNLOAD_ZIP_PATH);
      expect(result).toBe(TEST_TEMP_EXTRACT_PATH);
    });
  });

  // --- Tests for findActualVcpkgDir ---
  describe('findActualVcpkgDir', () => {
    it('should return primary path if it exists', () => {
      ensureDirExistsSync(TEST_EXTRACTED_VCPKG_DIR_EXACT);
      vol.mkdirSync(TEST_EXTRACTED_VCPKG_DIR_EXACT);
      const result = findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, TEST_VERSION); // Use imported helper
      expect(result).toBe(TEST_EXTRACTED_VCPKG_DIR_EXACT);
      expect(core.info).toHaveBeenCalledWith(`Found extracted vcpkg directory: ${result}`);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('should return nested path if only one directory exists and primary does not', () => {
      const nestedDirName = 'single-nested-dir-0123';
      const expectedPath = path.join(TEST_TEMP_EXTRACT_PATH, nestedDirName);
      ensureDirExistsSync(expectedPath);
      vol.mkdirSync(expectedPath);
      ensureDirExistsSync(path.join(TEST_TEMP_EXTRACT_PATH, 'some_file.txt'));
      vol.writeFileSync(path.join(TEST_TEMP_EXTRACT_PATH, 'some_file.txt'), 'data');

      const result = findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, TEST_VERSION); // Use imported helper

      expect(result).toBe(expectedPath);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(`Expected folder pattern 'vcpkg-${TEST_VERSION}' not found`)
      );
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(`Assuming single nested directory '${nestedDirName}'`)
      );
    });

    it('should return path without v prefix if version has v and that path exists (and not single dir)', () => {
      const versionWithV = 'v' + TEST_VERSION;
      const pathWithoutV = path.join(TEST_TEMP_EXTRACT_PATH, `vcpkg-${TEST_VERSION}`);
      const pathWithV = path.join(TEST_TEMP_EXTRACT_PATH, `vcpkg-${versionWithV}`);
      const otherDirPath = path.join(TEST_TEMP_EXTRACT_PATH, 'another_dir');

      // Arrange: Create ONLY the dir without 'v' AND another dir
      ensureDirExistsSync(pathWithoutV);
      vol.mkdirSync(pathWithoutV);
      ensureDirExistsSync(otherDirPath);
      vol.mkdirSync(otherDirPath);

      // Spy on core.warning
      const warningSpy = jest.spyOn(core, 'warning');

      // Act
      const result = findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, versionWithV); // Use imported helper

      // Assert
      expect(result).toBe(pathWithoutV);
      expect(vol.existsSync(pathWithV)).toBe(false); // Check primary was checked (and implicitly failed)
      expect(vol.readdirSync(TEST_TEMP_EXTRACT_PATH)).toEqual(
        expect.arrayContaining([`vcpkg-${TEST_VERSION}`, 'another_dir'])
      ); // Check dir contents were read
      expect(vol.existsSync(pathWithoutV)).toBe(true); // Check fallback was checked (and implicitly succeeded)
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Expected folder pattern 'vcpkg-${versionWithV}' not found`)
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Found extracted dir matching tag without 'v' prefix`)
      );
      expect(warningSpy).not.toHaveBeenCalledWith(expect.stringContaining('Assuming single nested directory'));

      warningSpy.mockRestore();
    });

    it('should throw if primary path missing and multiple directories exist', () => {
      const dir1 = path.join(TEST_TEMP_EXTRACT_PATH, 'dir1');
      const dir2 = path.join(TEST_TEMP_EXTRACT_PATH, 'dir2');
      ensureDirExistsSync(dir1);
      vol.mkdirSync(dir1);
      ensureDirExistsSync(dir2);
      vol.mkdirSync(dir2);

      expect(() => findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, TEST_VERSION)) // Use imported helper
        .toThrow(/Could not reliably find.+Found directories: (dir1, dir2|dir2, dir1)/);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(`Expected folder pattern 'vcpkg-${TEST_VERSION}' not found`)
      );
    });

    it('should throw if primary path missing and only files exist', () => {
      const file1 = path.join(TEST_TEMP_EXTRACT_PATH, 'file1.txt');
      const file2 = path.join(TEST_TEMP_EXTRACT_PATH, 'file2.dat');
      ensureDirExistsSync(file1);
      vol.writeFileSync(file1, 'content');
      ensureDirExistsSync(file2);
      vol.writeFileSync(file2, 'content');

      expect(() => findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, TEST_VERSION)) // Use imported helper
        .toThrow(/Could not reliably find.+Found directories: $/);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(`Expected folder pattern 'vcpkg-${TEST_VERSION}' not found`)
      );
    });

    it('should throw if primary path missing and v-prefix fallback also missing', () => {
      const versionWithV = 'v' + TEST_VERSION;
      // Arrange: Create only files, no directories
      const otherFilePath1 = path.join(TEST_TEMP_EXTRACT_PATH, 'some_other_file.txt');
      const otherFilePath2 = path.join(TEST_TEMP_EXTRACT_PATH, 'another_file');
      ensureDirExistsSync(otherFilePath1);
      vol.writeFileSync(otherFilePath1, 'data');
      ensureDirExistsSync(otherFilePath2);
      vol.writeFileSync(otherFilePath2, 'data');

      const warningSpy = jest.spyOn(core, 'warning');

      // Act & Assert
      expect(() => findActualVcpkgDir(TEST_TEMP_EXTRACT_PATH, versionWithV)) // Use imported helper
        .toThrow(/Could not reliably find.+Found directories: $/);

      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Expected folder pattern 'vcpkg-${versionWithV}' not found`)
      );
      expect(warningSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(`Found extracted dir matching tag without 'v' prefix`)
      );
      expect(warningSpy).not.toHaveBeenCalledWith(expect.stringContaining('Assuming single nested directory'));

      warningSpy.mockRestore();
    });
  }); // End describe findActualVcpkgDir

  // --- Tests for bootstrapVcpkg ---
  describe('bootstrapVcpkg', () => {
    it('should run .bat on Windows', async () => {
      setPlatform('win32');
      const scriptPath = path.join(TEST_EXTRACTED_VCPKG_DIR_EXACT, 'bootstrap-vcpkg.bat');
      ensureDirExistsSync(scriptPath);
      vol.writeFileSync(scriptPath, 'echo Bootstrapping...');
      await bootstrapVcpkg(TEST_EXTRACTED_VCPKG_DIR_EXACT); // Use imported helper
      expect(vol.existsSync(scriptPath)).toBe(true); // Verify test setup
      expect(exec.exec).toHaveBeenCalledWith(scriptPath, ['-disableMetrics'], { cwd: TEST_EXTRACTED_VCPKG_DIR_EXACT });
      expect(exec.exec).not.toHaveBeenCalledWith('chmod', expect.any(Array));
    });

    it('should chmod and run .sh on Linux', async () => {
      setPlatform('linux');
      const scriptPath = path.join(TEST_EXTRACTED_VCPKG_DIR_EXACT, 'bootstrap-vcpkg.sh');
      ensureDirExistsSync(scriptPath);
      vol.writeFileSync(scriptPath, '#!/bin/sh');
      await bootstrapVcpkg(TEST_EXTRACTED_VCPKG_DIR_EXACT); // Use imported helper
      expect(vol.existsSync(scriptPath)).toBe(true); // Verify test setup
      expect(exec.exec).toHaveBeenCalledWith('chmod', ['+x', scriptPath]);
      expect(exec.exec).toHaveBeenCalledWith(scriptPath, ['-disableMetrics'], { cwd: TEST_EXTRACTED_VCPKG_DIR_EXACT });
    });

    it('should throw if script not found', async () => {
      setPlatform('win32');
      ensureDirExistsSync(TEST_EXTRACTED_VCPKG_DIR_EXACT);
      vol.mkdirSync(TEST_EXTRACTED_VCPKG_DIR_EXACT); // Dir exists, script doesn't
      await expect(bootstrapVcpkg(TEST_EXTRACTED_VCPKG_DIR_EXACT)).rejects.toThrow(/Bootstrap script not found/); // Use imported helper
    });

    it('should throw if script execution fails', async () => {
      setPlatform('linux');
      const scriptPath = path.join(TEST_EXTRACTED_VCPKG_DIR_EXACT, 'bootstrap-vcpkg.sh');
      ensureDirExistsSync(scriptPath);
      vol.writeFileSync(scriptPath, '#!/bin/sh');
      const execError = new Error('Bootstrap failed miserably');
      exec.exec.mockImplementation(async (cmd, args) => {
        if (cmd === scriptPath) throw execError;
        return 0;
      });
      await expect(bootstrapVcpkg(TEST_EXTRACTED_VCPKG_DIR_EXACT)).rejects.toThrow(execError); // Use imported helper
      expect(exec.exec).toHaveBeenCalledWith('chmod', ['+x', scriptPath]); // Chmod still called
    });
  }); // End describe bootstrapVcpkg

  // --- Tests for cacheVcpkgDir ---
  describe('cacheVcpkgDir', () => {
    it('should call tc.cacheDir and return result', async () => {
      const result = await cacheVcpkgDir(TEST_EXTRACTED_VCPKG_DIR_EXACT, 'vcpkg', TEST_VERSION); // Use imported helper
      expect(tc.cacheDir).toHaveBeenCalledWith(TEST_EXTRACTED_VCPKG_DIR_EXACT, 'vcpkg', TEST_VERSION);
      expect(result).toBe(TEST_FINAL_CACHED_PATH);
    });
  }); // End describe cacheVcpkgDir

  // --- Tests for cleanupDownload ---
  describe('cleanupDownload', () => {
    it('should delete file if it exists', () => {
      // Renamed for clarity
      ensureDirExistsSync(TEST_DOWNLOAD_ZIP_PATH);
      vol.writeFileSync(TEST_DOWNLOAD_ZIP_PATH, 'delete me');
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(true);

      cleanupDownload(TEST_DOWNLOAD_ZIP_PATH); // Use imported helper

      // Assert effect - file no longer exists
      expect(vol.existsSync(TEST_DOWNLOAD_ZIP_PATH)).toBe(false);
      // Optionally spy if specific call verification is needed, but effect is good
    });

    it('should not throw or warn if file path is null/undefined', () => {
      expect(() => cleanupDownload(null)).not.toThrow(); // Use imported helper
      expect(() => cleanupDownload(undefined)).not.toThrow();
      expect(core.warning).not.toHaveBeenCalled(); // Check no warning logged
    });

    it('should not throw or warn if file does not exist', () => {
      // vol is empty, file doesn't exist
      expect(() => cleanupDownload(TEST_DOWNLOAD_ZIP_PATH)).not.toThrow(); // Use imported helper
      expect(core.warning).not.toHaveBeenCalled();
    });
  }); // End describe cleanupDownload
}); // End describe Action
