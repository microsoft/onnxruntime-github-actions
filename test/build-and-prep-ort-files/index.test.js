const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { main } = require('../../src/build-and-prep-ort-files/index');

jest.mock('@actions/core', () => ({
  ...jest.requireActual('@actions/core'),
  info: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setFailed: jest.fn(),
}));
jest.mock('@actions/exec');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    mkdir: jest.fn(),
    readFile: jest.fn(),
    appendFile: jest.fn(),
    readdir: jest.fn(),
    copyFile: jest.fn(),
    access: jest.fn(),
    rm: jest.fn(),
    constants: { R_OK: 4 },
  },
}));

describe('build-and-prep-ort-files', () => {
  const originalEnv = process.env;
  const workspace = path.resolve('workspace');
  const buildDir = path.resolve('runner-temp');
  const metadata = jest
    .requireActual('fs')
    .readFileSync(path.join(__dirname, '../../actions/build-and-prep-ort-files/action.yml'), 'utf8');
  const metadataDefault = metadata.match(/default: '([^']+)'/)[1];

  beforeEach(() => {
    process.env = { ...originalEnv, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: buildDir };
    delete process.env['INPUT_ENABLE-TRAINING-OPS'];
    exec.getExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    fs.readFile.mockResolvedValue('standalone ops');
    fs.readdir.mockResolvedValue(['custom.onnx', 'ignored.txt']);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    ['explicit false', 'false', false],
    ['explicit true', 'true', true],
    ['omitted input', undefined, true],
    ['metadata default', metadataDefault, true],
  ])('%s preserves preparation commands and selects training operators', async (_name, input, enabled) => {
    if (input !== undefined) {
      process.env['INPUT_ENABLE-TRAINING-OPS'] = input;
    }

    await main();

    const testDataDir = path.join(buildDir, 'minimal_build_test_data');
    const customOpsDir = path.join(testDataDir, 'custom_ops_model');
    const e2ePath = path.join(workspace, 'onnxruntime/test/testdata/ort_minimal_e2e_test_data');
    const convertScript = path.join(workspace, 'tools/python/convert_onnx_models_to_ort.py');
    const configScript = path.join(workspace, 'tools/python/create_reduced_build_config.py');
    const testDataRoot = path.join(workspace, 'onnxruntime/test/testdata');
    const requiredOps = path.join(testDataDir, 'required_ops.ort_models.config');
    const requiredOpsTypes = path.join(testDataDir, 'required_ops_and_types.ort_models.config');
    const commands = exec.getExecOutput.mock.calls.map(([command, args, options]) => [command, args, options.cwd]);

    expect(commands).toEqual([
      [
        'python3',
        [
          '-m',
          'pip',
          'install',
          '--user',
          '-r',
          path.join(workspace, 'tools/ci_build/github/linux/python/requirements.txt'),
        ],
        workspace,
      ],
      ['python3', [path.join(workspace, 'tools/ci_build/op_registration_validator.py')], workspace],
      ['ccache', ['--version'], workspace],
      ['ccache', ['--zero-stats'], workspace],
      [
        'python3',
        [
          path.join(workspace, 'tools/ci_build/build.py'),
          '--build_dir',
          buildDir,
          '--cmake_generator',
          'Ninja',
          '--config',
          'Debug',
          '--skip_submodule_sync',
          '--parallel',
          '--use_cache',
          '--use_vcpkg',
          '--use_vcpkg_ms_internal_asset_cache',
          '--use_binskim_compliant_compile_flags',
          '--build_wheel',
          '--skip_tests',
          ...(enabled ? ['--enable_training_ops'] : []),
          '--use_nnapi',
          '--use_coreml',
        ],
        workspace,
      ],
      ['ccache', ['--show-stats', '-vv'], workspace],
      [
        'python3',
        ['-m', 'pip', 'install', '--user', '--find-links', path.join(buildDir, 'Debug', 'dist'), 'onnxruntime'],
        workspace,
      ],
      ['python3', [convertScript, e2ePath], os.tmpdir()],
      ['python3', ['-m', 'onnxruntime.tools.convert_onnx_models_to_ort', e2ePath], os.tmpdir()],
      ['python3', [configScript, '--format', 'ORT', testDataRoot, requiredOps], os.tmpdir()],
      [
        'python3',
        [configScript, '--format', 'ORT', '--enable_type_reduction', testDataRoot, requiredOpsTypes],
        os.tmpdir(),
      ],
      [
        'python3',
        [convertScript, '--custom_op_library', path.join(buildDir, 'Debug', 'libcustom_op_library.so'), customOpsDir],
        os.tmpdir(),
      ],
    ]);
    expect(fs.appendFile.mock.calls).toEqual([
      [requiredOps, os.EOL + 'standalone ops'],
      [requiredOpsTypes, os.EOL + 'standalone ops'],
    ]);
    expect(fs.copyFile).toHaveBeenCalledWith(
      path.join(workspace, 'onnxruntime/test/testdata/custom_op_library', 'custom.onnx'),
      path.join(customOpsDir, 'custom.onnx')
    );
    expect(fs.rm).toHaveBeenCalledWith(customOpsDir, { recursive: true, force: true });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('rejects an invalid boolean before running preparation commands', async () => {
    process.env['INPUT_ENABLE-TRAINING-OPS'] = 'invalid';

    await main();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Input does not meet YAML 1.2 "Core Schema" specification: enable-training-ops')
    );
    expect(exec.getExecOutput).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });
});
