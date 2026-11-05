const { getCMakeBinDir, getCcacheArchIdentifier } = require('../../src/setup-build-tools/index');
const fs = require('node:fs');
const path = require('node:path');

jest.mock('node:fs');

describe('getCMakeBinDir', () => {
  it('should return the correct bin path for linux', () => {
    const cmakePath = '/path/to/cmake';
    const expectedPath = path.join(cmakePath, 'bin');
    expect(getCMakeBinDir(cmakePath, 'linux')).toBe(expectedPath);
  });

  it('should return the correct bin path for macos when the specific path exists', () => {
    const cmakePath = '/path/to/cmake';
    const macOsBinPath = path.join(cmakePath, 'CMake.app', 'Contents', 'bin');
    fs.existsSync.mockReturnValue(true);
    expect(getCMakeBinDir(cmakePath, 'macos')).toBe(macOsBinPath);
  });

  it('should return the default bin path for macos when the specific path does not exist', () => {
    const cmakePath = '/path/to/cmake';
    const expectedPath = path.join(cmakePath, 'bin');
    fs.existsSync.mockReturnValue(false);
    expect(getCMakeBinDir(cmakePath, 'macos')).toBe(expectedPath);
  });
});

describe('getCcacheArchIdentifier', () => {
  it('should return "aarch64" for Windows ARM64 ccache archives', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });

    try {
      expect(getCcacheArchIdentifier()).toBe('aarch64');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
    }
  });
});
