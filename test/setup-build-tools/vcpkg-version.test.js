const { normalizeVcpkgVersion } = require('../../src/setup-build-tools/index');

describe('normalizeVcpkgVersion', () => {
  it('should remove leading zeros from month and day', () => {
    expect(normalizeVcpkgVersion('2025.08.27')).toBe('2025.8.27');
  });

  it('should not change version string if it is already normalized', () => {
    expect(normalizeVcpkgVersion('2025.8.27')).toBe('2025.8.27');
  });

  it('should handle version strings with no leading zeros', () => {
    expect(normalizeVcpkgVersion('2025.10.10')).toBe('2025.10.10');
  });

  it('should return the original string if it is not in the expected format', () => {
    expect(normalizeVcpkgVersion('2025.08')).toBe('2025.08');
  });
});
