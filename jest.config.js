module.exports = {
  testEnvironment: 'node',
  verbose: true,
  testMatch: ['**/test/**/*.test.js'],
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.js'],
  coverageReporters: ['text', 'lcov'],
};