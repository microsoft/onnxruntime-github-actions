// test/common/utils.test.js

const core = require('@actions/core');
const exec = require('@actions/exec');
const crypto = require('node:crypto');
const fs = require('node:fs'); // Use sync fs for mocks if needed
const fsPromises = require('node:fs/promises'); // Import promises API separately
const path = require('node:path');

// Import the module to test
const utils = require('../../src/common/utils'); // Adjust path as needed

// Mock dependencies
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/glob'); 
// Mocking crypto
const mockUpdate = jest.fn();
const mockDigest = jest.fn();
const mockHash = { update: mockUpdate, digest: mockDigest };
jest.mock('node:crypto', () => ({
  createHash: jest.fn(() => mockHash),
}));

// Mocking fs and fs.promises
// Keep actual path and os, mock fs parts needed
const mockStream = {
  on: jest.fn((event, callback) => {
    if (event === 'data') {
      // Simulate receiving data chunks
      callback(Buffer.from('chunk1'));
      callback(Buffer.from('chunk2'));
    } else if (event === 'end') {
      // Simulate the end event after data
      setImmediate(callback); // Ensure 'end' fires after 'data' potentially
    } else if (event === 'error') {
      // Store error callback to trigger it in tests
      mockStream._errorCallback = callback;
    }
    return mockStream; // Allow chaining
  }),
  _triggerError: (err) => {
    // Helper to trigger error
    if (mockStream._errorCallback) {
      mockStream._errorCallback(err);
    }
  },
  _errorCallback: null,
  pipe: jest.fn(), // Add pipe if it's ever used by chance
};
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'), // Keep other parts
  createReadStream: jest.fn(() => mockStream),
}));
// Mock fsPromises separately
jest.mock('node:fs/promises', () => ({
  stat: jest.fn(),
  readFile: jest.fn(),
}));

// Hold original process properties
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalEnv = process.env;

describe('Common Utils', () => {
  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Reset specific mock implementations if needed
    mockUpdate.mockClear();
    mockDigest.mockClear();
    mockStream.on.mockClear();
    mockStream._errorCallback = null;
    // Reset fs promises mocks
    fsPromises.stat.mockClear();
    fsPromises.readFile.mockClear();
    // Reset exec mock
    exec.getExecOutput.mockClear();

    // Restore process properties
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true });
    process.env = { ...originalEnv };
  });

  // --- executeCommand ---
  describe('executeCommand', () => {
    it('should execute command successfully and return stdout/stderr', async () => {
      const mockResult = { exitCode: 0, stdout: 'Success output', stderr: 'Warning info' };
      exec.getExecOutput.mockResolvedValue(mockResult);

      const result = await utils.executeCommand('my-cmd', ['arg1', 'arg2']);

      expect(exec.getExecOutput).toHaveBeenCalledWith(
        'my-cmd',
        ['arg1', 'arg2'],
        expect.objectContaining({ ignoreReturnCode: true })
      );
      expect(core.info).toHaveBeenCalledWith('Executing: my-cmd arg1 arg2');
      expect(core.debug).toHaveBeenCalledWith(`stdout: ${mockResult.stdout}`);
      expect(core.warning).toHaveBeenCalledWith(`stderr: ${mockResult.stderr}`);
      expect(result).toEqual({ stdout: mockResult.stdout, stderr: mockResult.stderr });
    });

    it('should mask GITHUB_TOKEN when sensitive option is true', async () => {
      process.env.GITHUB_TOKEN = 'my-secret-token';
      const mockResult = { exitCode: 0, stdout: '', stderr: '' };
      exec.getExecOutput.mockResolvedValue(mockResult);

      await utils.executeCommand('login', ['-p', 'my-secret-token'], { sensitive: true });

      expect(core.info).toHaveBeenCalledWith('Executing: login -p ***');
      // Ensure the actual execution still received the real token
      expect(exec.getExecOutput).toHaveBeenCalledWith(
        'login',
        ['-p', 'my-secret-token'],
        expect.objectContaining({ sensitive: true, ignoreReturnCode: true })
      );
      delete process.env.GITHUB_TOKEN;
    });

    it('should throw error and log details on non-zero exit code', async () => {
      const mockResult = { exitCode: 1, stdout: 'Some output', stderr: 'Error occurred' };
      exec.getExecOutput.mockResolvedValue(mockResult);

      await expect(utils.executeCommand('fail-cmd', ['--bad'])).rejects.toThrow(
        'Command "fail-cmd --bad" failed with exit code 1'
      );

      expect(exec.getExecOutput).toHaveBeenCalledWith(
        'fail-cmd',
        ['--bad'],
        expect.objectContaining({ ignoreReturnCode: true })
      );
      expect(core.error).toHaveBeenCalledWith('Command failed with exit code 1');
      expect(core.error).toHaveBeenCalledWith(`stdout: ${mockResult.stdout}`);
      expect(core.error).toHaveBeenCalledWith(`stderr: ${mockResult.stderr}`);
    });

    it('should not mask token if sensitive is false', async () => {
      process.env.GITHUB_TOKEN = 'my-secret-token';
      const mockResult = { exitCode: 0, stdout: '', stderr: '' };
      exec.getExecOutput.mockResolvedValue(mockResult);

      await utils.executeCommand('login', ['-p', 'my-secret-token'], { sensitive: false }); // Sensitive false

      expect(core.info).toHaveBeenCalledWith('Executing: login -p my-secret-token'); // Not masked
      expect(exec.getExecOutput).toHaveBeenCalledWith(
        'login',
        ['-p', 'my-secret-token'],
        expect.objectContaining({ sensitive: false, ignoreReturnCode: true })
      );
      delete process.env.GITHUB_TOKEN;
    });
  });

  // --- verifySHA512 ---
  describe('verifySHA512', () => {
    const testFilePath = '/path/to/file.zip';
    const correctHash = 'a1b2c3d4';
    const incorrectHash = 'e5f6g7h8';

    it('should return true for matching hash (case-insensitive)', async () => {
      mockDigest.mockReturnValue(correctHash.toUpperCase()); // Simulate hash calculation result

      const result = await utils.verifySHA512(testFilePath, correctHash.toLowerCase());

      expect(result).toBe(true);
      expect(fs.createReadStream).toHaveBeenCalledWith(testFilePath);
      expect(crypto.createHash).toHaveBeenCalledWith('sha512');
      expect(mockUpdate).toHaveBeenCalledTimes(2); // Called twice in mock stream
      expect(mockDigest).toHaveBeenCalledWith('hex');
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Verification Result for file.zip: Match'));
    });

    it('should return false for non-matching hash', async () => {
      mockDigest.mockReturnValue(incorrectHash); // Simulate different hash result

      const result = await utils.verifySHA512(testFilePath, correctHash);

      expect(result).toBe(false);
      expect(mockDigest).toHaveBeenCalledWith('hex');
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Verification Result for file.zip: Mismatch'));
    });

    it('should reject if stream emits error', async () => {
      const streamError = new Error('Read error');
      // Need to trigger the error callback stored in the mock
      mockStream.on.mockImplementation((event, callback) => {
        if (event === 'error') {
          // Trigger error immediately for this test
          callback(streamError);
        }
        return mockStream; // Allow chaining if needed elsewhere
      });

      await expect(utils.verifySHA512(testFilePath, correctHash)).rejects.toThrow(streamError);
      expect(fs.createReadStream).toHaveBeenCalledWith(testFilePath);
    });
  });

  // --- hashFileContent ---
  describe('hashFileContent', () => {
    const testFilePath = '/path/to/hash/me.txt';
    const mockFileContent = Buffer.from('file content');
    // Create a fresh mock hash object for these tests
    let localMockUpdate;
    let localMockDigest;
    let localMockHash;

    beforeEach(() => {
      localMockUpdate = jest.fn();
      localMockDigest = jest.fn();
      localMockHash = { update: localMockUpdate, digest: localMockDigest };
    });

    it('should read file and update hash if file exists', async () => {
      fsPromises.stat.mockResolvedValue({ isFile: () => true });
      fsPromises.readFile.mockResolvedValue(mockFileContent);

      await utils.hashFileContent(localMockHash, testFilePath);

      expect(fsPromises.stat).toHaveBeenCalledWith(testFilePath);
      expect(fsPromises.readFile).toHaveBeenCalledWith(testFilePath);
      expect(localMockUpdate).toHaveBeenCalledWith(mockFileContent);
      expect(core.debug).toHaveBeenCalledWith(`Hashed content of: ${testFilePath}`);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('should warn and not update hash if path is not a file', async () => {
      fsPromises.stat.mockResolvedValue({ isFile: () => false }); // Simulate directory or other

      await utils.hashFileContent(localMockHash, testFilePath);

      expect(fsPromises.stat).toHaveBeenCalledWith(testFilePath);
      expect(fsPromises.readFile).not.toHaveBeenCalled();
      expect(localMockUpdate).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledWith(`Path is not a file, skipping content hashing: ${testFilePath}`);
    });

    it('should warn and not update hash if file not found (ENOENT)', async () => {
      const enoentError = new Error('File not found');
      enoentError.code = 'ENOENT';
      fsPromises.stat.mockRejectedValue(enoentError); // Simulate stat failing

      await utils.hashFileContent(localMockHash, testFilePath);

      expect(fsPromises.stat).toHaveBeenCalledWith(testFilePath);
      expect(fsPromises.readFile).not.toHaveBeenCalled();
      expect(localMockUpdate).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledWith(`File not found for hashing: ${testFilePath}. Skipping content.`);
    });

    it('should throw other errors encountered during stat', async () => {
      const otherError = new Error('Permission denied');
      fsPromises.stat.mockRejectedValue(otherError);

      await expect(utils.hashFileContent(localMockHash, testFilePath)).rejects.toThrow(otherError);

      expect(fsPromises.stat).toHaveBeenCalledWith(testFilePath);
      expect(core.error).toHaveBeenCalledWith(
        `Error accessing file ${testFilePath} for hashing: ${otherError.message}`
      );
    });
  });

  // --- parseBuildArgs ---
  describe('parseBuildArgs', () => {
    it('should return empty array for empty or null input', () => {
      expect(utils.parseBuildArgs('')).toEqual([]);
      expect(utils.parseBuildArgs(null)).toEqual([]);
      expect(utils.parseBuildArgs(undefined)).toEqual([]);
    });

    it('should parse simple key-value pairs', () => {
      expect(utils.parseBuildArgs('KEY1=VAL1 KEY2=VAL2')).toEqual([
        '--build-arg',
        'KEY1=VAL1',
        '--build-arg',
        'KEY2=VAL2',
      ]);
    });

    it('should parse pairs with quotes', () => {
      expect(utils.parseBuildArgs('A=1 B=\'Hello World\' C="Another Arg"')).toEqual([
        '--build-arg',
        'A=1',
        '--build-arg',
        "B='Hello World'",
        '--build-arg',
        'C="Another Arg"',
      ]);
    });

    it('should handle extraneous whitespace', () => {
      expect(utils.parseBuildArgs('  KEY1=VAL1   KEY2=VAL2  ')).toEqual([
        '--build-arg',
        'KEY1=VAL1',
        '--build-arg',
        'KEY2=VAL2',
      ]);
    });

    it('should handle args without spaces', () => {
      expect(utils.parseBuildArgs('KEY1=VAL1')).toEqual(['--build-arg', 'KEY1=VAL1']);
    });
    it('should handle complex values within quotes', () => {
      expect(utils.parseBuildArgs('A=1 KEY="Value with = sign"')).toEqual([
        '--build-arg',
        'A=1',
        '--build-arg',
        'KEY="Value with = sign"',
      ]);
    });
  });

  // --- normalizeBuildArgsForHashing ---
  describe('normalizeBuildArgsForHashing', () => {
    it('should return empty string for empty or null input', () => {
      expect(utils.normalizeBuildArgsForHashing('')).toBe('');
      expect(utils.normalizeBuildArgsForHashing(null)).toBe('');
      expect(utils.normalizeBuildArgsForHashing(undefined)).toBe('');
    });

    it('should sort arguments alphabetically', () => {
      expect(utils.normalizeBuildArgsForHashing('B=2 A=1 C=3')).toBe('A=1\nB=2\nC=3');
    });

    it('should handle quoted values during sort', () => {
      expect(utils.normalizeBuildArgsForHashing('B=\'World\' A="Hello" C=1')).toBe('A="Hello"\nB=\'World\'\nC=1');
    });

    it('should return single arg with no newline', () => {
      expect(utils.normalizeBuildArgsForHashing('ONLY=arg')).toBe('ONLY=arg');
    });
  });

  // --- getPlatformIdentifier ---
  describe('getPlatformIdentifier', () => {
    it('should return "windows" for win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(utils.getPlatformIdentifier()).toBe('windows');
    });
    it('should return "linux" for linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(utils.getPlatformIdentifier()).toBe('linux');
    });
    it('should return "macos" for darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(utils.getPlatformIdentifier()).toBe('macos');
    });
    it('should throw for unsupported platform', () => {
      Object.defineProperty(process, 'platform', { value: 'aix' });
      expect(() => utils.getPlatformIdentifier()).toThrow('Unsupported platform: aix');
    });
  });

  // --- getArchIdentifier ---
  describe('getArchIdentifier', () => {
    it('should return "x86_64" for linux x64', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      expect(utils.getArchIdentifier()).toBe('x86_64');
    });
    it('should return "aarch64" for linux arm64', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      expect(utils.getArchIdentifier()).toBe('aarch64');
    });
    it('should return "x86_64" for windows x64', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      expect(utils.getArchIdentifier()).toBe('x86_64');
    });
    it('should return "aarch64" for windows arm64', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      expect(utils.getArchIdentifier()).toBe('aarch64');
    });
    it('should return "universal" for darwin (any arch)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      expect(utils.getArchIdentifier()).toBe('universal');
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      expect(utils.getArchIdentifier()).toBe('universal');
    });
    it('should throw for unsupported architecture', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 's390x' });
      expect(() => utils.getArchIdentifier()).toThrow('Unsupported architecture: s390x on platform: linux');
    });
  });

  // --- checkPathExists ---
  describe('checkPathExists', () => {
    const testPath = '/some/test/path';

    it('should return true if fs.stat resolves', async () => {
      fsPromises.stat.mockResolvedValue({}); // Resolve with dummy object

      const result = await utils.checkPathExists(testPath);

      expect(result).toBe(true);
      expect(fsPromises.stat).toHaveBeenCalledWith(testPath);
      expect(core.debug).toHaveBeenCalledWith(`Path check: Found '${testPath}'.`);
    });

    it('should return false if fs.stat rejects with ENOENT', async () => {
      const enoentError = new Error('Not found');
      enoentError.code = 'ENOENT';
      fsPromises.stat.mockRejectedValue(enoentError);

      const result = await utils.checkPathExists(testPath);

      expect(result).toBe(false);
      expect(fsPromises.stat).toHaveBeenCalledWith(testPath);
      expect(core.debug).toHaveBeenCalledWith(`Path check: '${testPath}' not found.`);
    });

    it('should return false and warn if fs.stat rejects with other error', async () => {
      const otherError = new Error('Permission denied');
      otherError.code = 'EACCES'; // Example other error code
      fsPromises.stat.mockRejectedValue(otherError);

      const result = await utils.checkPathExists(testPath);

      expect(result).toBe(false);
      expect(fsPromises.stat).toHaveBeenCalledWith(testPath);
      expect(core.warning).toHaveBeenCalledWith(
        `Path check: Error checking '${testPath}': ${otherError.message}. Assuming it does not exist.`
      );
    });
  });
});
