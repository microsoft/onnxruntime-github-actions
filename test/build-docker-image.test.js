const core = require('@actions/core');
const exec = require('@actions/exec'); // Needed for attemptPullCache mock
const github = require('@actions/github');
const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const glob = require('@actions/glob');
const { Volume } = require('memfs');

// --- Mock Dependencies ---
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/github', () => ({ // Mock github context
    context: {
        eventName: 'push', // Default event
        ref: 'refs/heads/main', // Default ref
        repo: {
            owner: 'test-owner',
            repo: 'test-repo',
        },
        actor: 'test-actor',
    }
}));
jest.mock('@actions/glob');

// --- Mock Shared Utils ---
// Mock only the specific utils *used by the helpers being tested* initially
// We need hashFileContent and normalizeBuildArgsForHashing for calculateChecksum
const mockHashFileContent = jest.fn();
const mockNormalizeBuildArgsForHashing = jest.fn(args => args || ''); // Simple pass-through mock
const mockExecuteCommand = jest.fn(); // Mock executeCommand used by performLogins
jest.mock('../src/common/utils', () => ({
    executeCommand: mockExecuteCommand,
    hashFileContent: mockHashFileContent,
    normalizeBuildArgsForHashing: mockNormalizeBuildArgsForHashing,
    // Include others only if directly called by the helpers under test
    parseBuildArgs: jest.fn(args => args ? ['--build-arg', args] : []), // Simple mock for buildImage later
}));

// --- Mock crypto ---
const mockUpdate = jest.fn();
const mockDigest = jest.fn();
const mockHash = { update: mockUpdate, digest: mockDigest };
jest.mock('node:crypto', () => ({
    createHash: jest.fn(() => mockHash),
}));

// --- memfs Mocking Setup ---
const { vol } = require('./memfs-volume.js'); // Get volume instance
jest.mock('fs', () => require('./memfs-volume.js').fs);
jest.mock('node:fs', () => require('./memfs-volume.js').fs);
jest.mock('node:fs/promises', () => require('./memfs-volume.js').fs.promises); // Mock promises API
// --- ------------------- ---

// --- Import Subject Under Test ---
// Import all exported functions from the refactored module
const buildDockerImage = require('../src/build-docker-image/index.js');

// --- Test Suite ---
describe('Build Docker Image Action - Helper Functions', () => {

    let originalEnv;

    // Helper to setup core.getInput mocks for a test
    const setupInputs = (inputs) => {
        core.getInput.mockImplementation(name => inputs[name] || ''); // Default to empty string if not specified
        // Handle getBooleanInput based on string value
        core.getBooleanInput.mockImplementation(name => (inputs[name] || '').toLowerCase() === 'true');
    };

     // Helper function to ensure directory exists in memfs before writing
     const ensureDirExistsSync = (filePath) => {
        const dir = path.dirname(filePath);
        if (!vol.existsSync(dir)) {
             vol.mkdirSync(dir, { recursive: true });
        }
   };

    beforeEach(() => {
        jest.clearAllMocks();
        vol.reset(); // Clear memfs
        originalEnv = { ...process.env }; // Store original env
        process.env = { ...originalEnv }; // Reset env vars

        // Reset specific mock implementations if needed (defaults set in jest.mock)
        mockExecuteCommand.mockResolvedValue({ stdout: '', stderr: '' });
        mockHashFileContent.mockClear();
        mockNormalizeBuildArgsForHashing.mockImplementation(args => args || '');
        mockUpdate.mockClear();
        mockDigest.mockReturnValue('mockchecksum'); // Default checksum

        // Mock glob create/globGenerator
        const mockGlobber = {
             globGenerator: async function* () { yield* []; } // Default: yield no files
        };
        glob.create.mockResolvedValue(mockGlobber);
    });

    afterEach(() => {
        process.env = originalEnv; // Restore original env
    });

    // --- Tests for getInputsAndConfig ---
    describe('getInputsAndConfig', () => {
        const defaultInputs = {
            dockerfile: 'src/app/Dockerfile',
            'image-name': 'ghcr.io/test-owner/test-repo/myimg',
            'build-args': 'A=1 B=2',
            'hash-algorithm': 'sha512',
            'push': 'true',
            'pull': 'false',
            'skip-build-on-pull-hit': 'false',
            'azure-container-registry-name': 'myacr',
            'login-ghcr': '', // Test default detection
        };

        it('should parse inputs correctly and derive context/registry', () => {
            setupInputs(defaultInputs);
            const config = buildDockerImage.getInputsAndConfig();

            expect(core.getInput).toHaveBeenCalledWith('dockerfile', { required: true });
            expect(core.getInput).toHaveBeenCalledWith('image-name', { required: true });
            // ... check other inputs called ...

            expect(config.dockerfilePath).toBe('src/app/Dockerfile');
            expect(config.imageNameBase).toBe('ghcr.io/test-owner/test-repo/myimg');
            expect(config.buildArgsInput).toBe('A=1 B=2');
            expect(config.hashAlgorithm).toBe('sha512');
            expect(config.shouldPushInput).toBe(true);
            expect(config.shouldPull).toBe(false);
            expect(config.skipBuildOnPullHit).toBe(false);
            expect(config.acrNameToLogin).toBe('myacr');
            expect(path.normalize(config.contextPath)).toBe(path.normalize('src/app'));
            expect(config.targetRegistry).toBe('ghcr.io');
            expect(config.targetAcrName).toBe(''); // Not an ACR target image
            expect(config.shouldLoginGhcr).toBe(true); // Defaulted to true because target is GHCR
            expect(config.attemptAcrLogin).toBe(true); // True because acrNameToLogin has value
        });

        it('should handle Dockerfile in root', () => {
            setupInputs({ ...defaultInputs, dockerfile: 'Dockerfile' });
            const config = buildDockerImage.getInputsAndConfig();
            expect(config.contextPath).toBe('.');
        });

        it('should detect ACR target registry and NOT attempt login if acr name input is missing', () => { // Test name updated
            setupInputs({
                 ...defaultInputs, // Includes dockerfile, build-args etc.
                'image-name': 'anotheracr.azurecr.io/myimg', // ACR target
                'login-ghcr':'false', // Explicitly false for GHCR
                'azure-container-registry-name': '' // Explicitly empty ACR name input
            });
             const config = buildDockerImage.getInputsAndConfig();

             expect(config.targetRegistry).toBe('anotheracr.azurecr.io');
             expect(config.targetAcrName).toBe('anotheracr');
             expect(config.shouldLoginGhcr).toBe(false);
             // --- MODIFIED ASSERTION ---
             // Login is NOT attempted because azure-container-registry-name was not provided
             expect(config.attemptAcrLogin).toBe(false);
             // --------------------------
         });

         it('should attempt ACR login if azure-container-registry-name is provided', () => {
            setupInputs({
                ...defaultInputs,
                'image-name': 'ghcr.io/foo/bar', // Target is not ACR
                'azure-container-registry-name': 'mybaseacr' // But ACR name IS provided
            });
            const config = buildDockerImage.getInputsAndConfig();
            expect(config.attemptAcrLogin).toBe(true); // Should be true now
            expect(config.acrNameToLogin).toBe('mybaseacr');
        });

          it('should respect login-ghcr input override', () => {
            setupInputs({ ...defaultInputs, 'login-ghcr':'false' }); // Target is GHCR, but override login flag
             const config = buildDockerImage.getInputsAndConfig();
             expect(config.targetRegistry).toBe('ghcr.io');
             expect(config.shouldLoginGhcr).toBe(false); // Login overridden
         });

         it('should handle empty optional inputs', () => {
             setupInputs({ dockerfile: 'Dockerfile.web', 'image-name': 'myimage' }); // Minimal inputs
             const config = buildDockerImage.getInputsAndConfig();
             expect(config.buildArgsInput).toBe('');
             expect(config.hashAlgorithm).toBe('sha256'); // Default
             expect(config.shouldPushInput).toBe(false); // Default
             expect(config.shouldPull).toBe(true); // Default
             expect(config.skipBuildOnPullHit).toBe(true); // Default
             expect(config.acrNameToLogin).toBe('');
             expect(config.contextPath).toBe('.');
             expect(config.targetRegistry).toBe('docker.io'); // Default inferred
             expect(config.shouldLoginGhcr).toBe(false); // Default
             expect(config.attemptAcrLogin).toBe(false); // Default
         });
    });
    
    // --- Tests for calculateChecksum ---
    describe('calculateChecksum', () => {
        const testDockerfilePath = path.normalize('/workspace/src/app/Dockerfile');
        const testContextPath = path.normalize('/workspace/src/app');
        const testFilePath1 = path.join(testContextPath, 'file1.txt');
        const testFilePath2 = path.join(testContextPath, 'subdir', 'file2.js');
        const testBuildArgs = 'ARG1=Value1 ARG2=Value2';
        const testConfig = {
             dockerfilePath: testDockerfilePath,
             contextPath: testContextPath,
             buildArgsInput: testBuildArgs,
             hashAlgorithm: 'sha256'
         };

        // Mock globber to return specific files
        const mockFiles = [testFilePath1, testFilePath2];
        const mockGlobber = {
             globGenerator: async function* () { yield* mockFiles; }
        };

        beforeEach(() => {
             // Reset hash mocks
             mockUpdate.mockClear();
             mockDigest.mockReturnValue('abcdef123456'); // Fixed checksum result for tests
             crypto.createHash.mockImplementation(() => ({ update: mockUpdate, digest: mockDigest }));

             // Setup memfs volume with files to hash
             ensureDirExistsSync(testDockerfilePath);
             vol.writeFileSync(testDockerfilePath, 'FROM ubuntu\nCOPY . .');
             ensureDirExistsSync(testFilePath1);
             vol.writeFileSync(testFilePath1, 'content1');
             ensureDirExistsSync(testFilePath2);
             vol.writeFileSync(testFilePath2, 'content2');

             // Setup glob mock
             glob.create.mockResolvedValue(mockGlobber);

             // Setup hashFileContent mock to simulate reading from vol and updating hash mock
             mockHashFileContent.mockImplementation(async (hash, filePath) => {
                 try {
                     const content = vol.readFileSync(filePath); // Use vol directly
                     hash.update(content);
                 } catch (e) { /* ignore */ }
             });
             // Setup normalizeBuildArgsForHashing mock
             mockNormalizeBuildArgsForHashing.mockReturnValue('ARG1=Value1\nARG2=Value2'); // Simulate normalization
        });

        it('should create hash object with specified algorithm', async () => {
            await buildDockerImage.calculateChecksum(testConfig);
            expect(crypto.createHash).toHaveBeenCalledWith('sha256');
        });

        it('should hash Dockerfile content', async () => {
             await buildDockerImage.calculateChecksum(testConfig);
             // Check that hashFileContent was called for the Dockerfile
             expect(mockHashFileContent).toHaveBeenCalledWith(expect.anything(), testDockerfilePath);
             // We mocked hashFileContent, check the internal mockUpdate isn't called directly by it
             // Instead, check the *effect* of hashFileContent mock:
             // This requires hashFileContent mock to actually call hash.update, let's adjust
             mockHashFileContent.mockImplementation(async(hash, filePath) => {
                 hash.update(vol.readFileSync(filePath)); // Simulate update
             });
             await buildDockerImage.calculateChecksum(testConfig);
             expect(mockUpdate).toHaveBeenCalledWith(Buffer.from('FROM ubuntu\nCOPY . .'));
         });

         it('should hash normalized build args', async () => {
             const normalized = 'ARG1=Value1\nARG2=Value2';
             mockNormalizeBuildArgsForHashing.mockReturnValue(normalized);
             await buildDockerImage.calculateChecksum(testConfig);
             expect(mockNormalizeBuildArgsForHashing).toHaveBeenCalledWith(testBuildArgs);
             expect(mockUpdate).toHaveBeenCalledWith(normalized);
         });

         it('should hash context files found by glob (relative path + content)', async () => {
             // Reset mockUpdate count for this test
             mockUpdate.mockClear();
              // Mock hashFileContent to simulate hashing
             mockHashFileContent.mockImplementation(async (hash, filePath) => {
                 hash.update(vol.readFileSync(filePath));
             });

             await buildDockerImage.calculateChecksum(testConfig);

             // Check glob was created
             expect(glob.create).toHaveBeenCalledWith(`${testContextPath}/**`, expect.anything());

             // Check hash updated with relative paths and content (order matters due to sort)
             // file1.txt comes before subdir/file2.js
             const relPath1 = path.relative(testContextPath, testFilePath1).replace(/\\/g, '/');
             const relPath2 = path.relative(testContextPath, testFilePath2).replace(/\\/g, '/');

             expect(mockUpdate).toHaveBeenCalledWith(relPath1);
             expect(mockHashFileContent).toHaveBeenCalledWith(expect.anything(), testFilePath1); // Checks if helper called
             // Verify update called within the mock helper implementation
             expect(mockUpdate).toHaveBeenCalledWith(Buffer.from('content1'));

             expect(mockUpdate).toHaveBeenCalledWith(relPath2);
             expect(mockHashFileContent).toHaveBeenCalledWith(expect.anything(), testFilePath2);
             expect(mockUpdate).toHaveBeenCalledWith(Buffer.from('content2'));
         });

         it('should return the final hex digest', async () => {
             const expectedChecksum = 'abcdef123456';
             mockDigest.mockReturnValue(expectedChecksum);
             const result = await buildDockerImage.calculateChecksum(testConfig);
             expect(mockDigest).toHaveBeenCalledWith('hex');
             expect(result).toBe(expectedChecksum);
         });
    });

    // Add describe blocks for other helpers:
    // describe('attemptPullCache', () => { /* ... */ });
    // describe('buildImage', () => { /* ... */ });
    // describe('pushImage', () => { /* ... */ });
    // describe('performLogouts', () => { /* ... */ });

});