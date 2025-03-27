// test/run-build-script-in-docker.test.js
const path = require('path');

// Mock modules FIRST at the top level
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('fs/promises');
jest.mock('os');

// Require mocked modules AFTER jest.mock calls
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs/promises');
const os = require('os');

// Require the module under test (assuming it exports 'run')
// This loads the module once using the top-level mocks
const { run } = require('../src/run-build-script-in-docker/index.js');

// Define variables accessible within describe/it blocks
let inputs;
let envVars;

describe('Run ORT Build Script in Docker Action', () => {
  beforeEach(() => {
    // Reset call history and mock implementations between tests
    jest.clearAllMocks();

    // --- Default Mock Inputs ---
    inputs = {
      docker_image: 'test-image:latest',
      build_config: 'Release',
      mode: 'build',
      container_user: 'onnxruntimedev',
      execution_providers: '',
      extra_build_flags: '',
      python_path_prefix: '',
      allow_released_opset_only: '0',
      nightly_build: '1',
    };
    core.getInput.mockImplementation((name) => inputs[name] || '');

    // --- Default Mock Environment Variables ---
    envVars = {
      GITHUB_WORKSPACE: '/mock/workspace',
      RUNNER_TEMP: '/mock/temp',
      ACTIONS_CACHE_URL: 'http://cache.mock.url',
      ACTIONS_RUNTIME_TOKEN: 'MOCK_TOKEN_123',
    };
    process.env = { ...envVars };

    // --- Mock OS ---
    os.homedir.mockReturnValue('/mock/home');

    // --- Mock FS ---
    fs.stat.mockRejectedValue({ code: 'ENOENT' }); // Default: paths DON'T exist
    fs.mkdir.mockResolvedValue(undefined); // Default: mkdir succeeds

    // --- Mock Exec (Default: nvidia-smi fails (no GPU), others succeed) ---
    // This default implementation will be used unless overridden within an 'it' block
    exec.exec.mockImplementation(async (command) => {
       if (command === 'nvidia-smi') {
         core.info('Mock nvidia-smi: Simulating failure (exit code 1) by default');
         return 1; // Simulate nvidia-smi failure
       }
       core.info(`Mock exec: Simulating success for command: ${command}`);
       return 0; // Simulate success for other commands
    });
  }); // End beforeEach



  it('should add --gpus all if nvidia-smi succeeds', async () => {
     // Arrange: Override exec mock implementation specifically for this test
     exec.exec.mockImplementation(async (command) => {
       if (command === 'nvidia-smi') {
         core.info('Mock nvidia-smi: Simulating success (exit code 0) for this test');
         return 0; // Simulate SUCCESS
       }
       core.info(`Mock exec: Simulating success for command: ${command}`);
       return 0;
     });

     // Act
     await run();

     // Assert
     expect(exec.exec).toHaveBeenCalledWith('nvidia-smi', [], expect.any(Object));
     expect(exec.exec).toHaveBeenCalledWith('docker', expect.any(Array));
     const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
     const dockerArgs = dockerCall[1];
     expect(dockerArgs).toContain('--gpus'); // Verify --gpus IS present
     expect(dockerArgs).toContain('all');
     expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('should run update mode and pass cache vars', async () => {
    // Arrange
    inputs.mode = 'update';

    // Act
    await run();

    // Assert
    expect(exec.exec).toHaveBeenCalledWith('docker', expect.any(Array));
    const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
    const dockerArgs = dockerCall[1];
    const bashCommand = dockerArgs.find(arg => arg.startsWith('set -ex;'));
    expect(bashCommand).toContain('--update');
    expect(dockerArgs).toContain('-e', `ACTIONS_CACHE_URL=${envVars.ACTIONS_CACHE_URL}`);
    expect(dockerArgs).toContain('-e', `ACTIONS_RUNTIME_TOKEN=${envVars.ACTIONS_RUNTIME_TOKEN}`);
    expect(dockerArgs).toContain('-e', 'RUNNER_TEMP=/onnxruntime_src/build');
    expect(core.setSecret).toHaveBeenCalledWith(envVars.ACTIONS_CACHE_URL);
    expect(core.setSecret).toHaveBeenCalledWith(envVars.ACTIONS_RUNTIME_TOKEN);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('should run test mode and add test volumes/flag if host paths exist', async () => {
    // Arrange
    inputs.mode = 'test';
    fs.stat.mockImplementation(async (filePath) => {
      if (filePath === '/data/onnx' || filePath === '/data/models') { return {}; }
      return {}; // Assume others exist
    });

    // Act
    await run();

    // Assert
    const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
    const dockerArgs = dockerCall[1];
    const bashCommand = dockerArgs.find(arg => arg.startsWith('set -ex;'));
    expect(bashCommand).toContain('--test');
    expect(bashCommand).toContain('--enable_onnx_tests');
    expect(dockerArgs).toContain('--volume', `/data/onnx:/data/onnx:ro`);
    expect(dockerArgs).toContain('--volume', `/data/models:/data/models:ro`);
    expect(dockerArgs).toContain('--volume', `${path.join(os.homedir(), '.onnx')}:/home/onnxruntimedev/.onnx`);
    expect(fs.mkdir).toHaveBeenCalledWith(path.join('/mock/home', '.onnx'), { recursive: true });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

   it('should run test mode and skip test volumes/flag if host paths dont exist', async () => {
    // Arrange
    inputs.mode = 'test';
    // Use default fs.stat mock (rejects with ENOENT) from beforeEach

    // Act
    await run();

    // Assert
    const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
    const dockerArgs = dockerCall[1];
    const bashCommand = dockerArgs.find(arg => arg.startsWith('set -ex;'));
    expect(bashCommand).toContain('--test');
    expect(bashCommand).not.toContain('--enable_onnx_tests');
    expect(dockerArgs).not.toContain('/data/onnx:ro');
    expect(dockerArgs).not.toContain('/data/models:ro');
    expect(dockerArgs).toContain('--volume', `${path.join(os.homedir(), '.onnx')}:/home/onnxruntimedev/.onnx`);
    expect(fs.mkdir).toHaveBeenCalledWith(path.join('/mock/home', '.onnx'), { recursive: true });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('should add --use_<ep> flags for requested EPs', async () => {
    // Arrange
    inputs.execution_providers = 'cuda dml tensorRT';

    // Act
    await run();

    // Assert
    const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
    const dockerArgs = dockerCall[1];
    const bashCommand = dockerArgs.find(arg => arg.startsWith('set -ex;'));
    expect(bashCommand).toContain('--use_cuda');
    expect(bashCommand).toContain('--use_dml');
    expect(bashCommand).toContain('--use_tensorrt');
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('should fail if an unknown EP is requested', async () => {
    // Arrange
    inputs.execution_providers = 'cuda fake_ep';

    // Act
    await run();

    // Assert
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Unknown execution provider requested: 'fake_ep'"));
    expect(exec.exec).not.toHaveBeenCalledWith('docker', expect.any(Array));
  });

  it('should use container_user for mount paths', async () => {
    // Arrange
    inputs.container_user = 'testuser123';
    inputs.mode = 'test';

    // Act
    await run();

    // Assert
    const dockerCall = exec.exec.mock.calls.find(call => call[0] === 'docker');
    const dockerArgs = dockerCall[1];
    expect(dockerArgs).toContain('--volume', `${path.join(os.homedir(), '.cache')}:/home/testuser123/.cache`);
    expect(dockerArgs).toContain('--volume', `${path.join(os.homedir(), '.onnx')}:/home/testuser123/.onnx`);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

}); // End describe