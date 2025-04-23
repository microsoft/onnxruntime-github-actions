const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const glob = require('@actions/glob');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');

// --- SHA256 Verification Helper ---
/**
 * Verifies the SHA256 hash of a file.
 * @param {string} filePath - Path to the file to verify.
 * @param {string} expectedHash - The expected SHA256 hash in hex format.
 * @returns {Promise<boolean>} - True if the hash matches, false otherwise. Throws on file access error.
 */
async function verifySHA256(filePath, expectedHash) {
  core.info(`Calculating SHA256 for file: ${filePath}`);
  const hash = crypto.createHash('sha256');
  // Use fs.createReadStream for potentially large files
  const stream = require('node:fs').createReadStream(filePath); // Sync require is ok inside async func

  return new Promise((resolve, reject) => {
    stream.on('error', (err) => reject(new Error(`Error reading file ${filePath}: ${err.message}`)));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actualHash = hash.digest('hex');
      core.debug(`Actual SHA256: ${actualHash}`);
      core.debug(`Expected SHA256: ${expectedHash}`);
      const match = actualHash.toLowerCase() === expectedHash.toLowerCase();
      core.info(`SHA256 Verification Result for ${path.basename(filePath)}: ${match ? 'Match' : 'Mismatch'}`);
      resolve(match);
    });
  });
}

// --- File Permission Check Helpers ---
/**
 * Checks if a file has execute permissions set for user, group, or others.
 * @param {string} filePath - The path to the file.
 * @returns {Promise<boolean>} - True if any execute bit is set, false otherwise.
 */
async function hasExecutePermission(filePath) {
  try {
    const stats = await fs.stat(filePath);
    // Check if any of the execute bits (owner, group, others) are set
    // Mode is a number, use bitwise AND with 0o111 (binary 001 001 001)
    return (stats.mode & 0o111) !== 0;
  } catch (error) {
    core.warning(`Could not stat file ${filePath} for permissions check: ${error.message}`);
    return false; // Treat inaccessible files as not having execute permission for safety
  }
}

/**
 * Finds C/C++ header and source files, filtering out paths matching ignore patterns.
 *
 * @param {string[]} ignorePatterns An array of glob patterns to ignore.
 * @returns {Promise<string[]>} A promise that resolves with an array of file paths.
 */
async function findCFiles(ignorePatterns) {
  // Define the glob patterns for C/C++ files
  const patterns = [
    '**/*.c',   // C source files
    '**/*.cpp', // C++ source files
    '**/*.cc',  // C++ source files (alternative extension)
    '**/*.h',   // C/C++ header files
    '**/*.hpp'  // C++ header files (alternative extension)
  ];

  // Combine the include patterns and ignore patterns
  // The globber will automatically handle ignoring files matching ignorePatterns
  const allPatterns = patterns.concat(
    ignorePatterns.map(pattern => `!${pattern}`) // Prepend '!' to ignore patterns
  );

  try {
    // Create a globber instance with the combined patterns
    // followSymbolicLinks: false is generally recommended for safety/performance
    // in actions, unless specifically needed.
    const globber = await glob.create(allPatterns.join('\n'), {
      followSymbolicLinks: false,
      implicitDescendants: false,
      matchDirectories: false,
      excludeHiddenFiles: true,
    });

    // Execute the glob search
    console.log(`Searching for C/C++ files, ignoring: ${ignorePatterns.join(', ')}`);
    const files = await globber.glob();
    console.log(`Found ${files.length} files.`);

    // Return the array of found file paths
    return files;

  } catch (error) {
    console.error("Error finding files:", error);
    // Re-throw the error or handle it as appropriate for your action
    throw error;
  }
}

// --- Main Orchestration Function ---
async function run() {
  core.info('Starting Format and Lint Check Action...');
  if (process.platform !== 'linux') {
      core.setFailed(`This action only runs on Linux. Detected platform: ${process.platform}`);
      return;
  }

  let llvmToolPath = '';
  let clangFormatPath = ''; // Will hold the absolute path or just 'clang-format' if in PATH
  const filesNeedingFormatting = [];
  const filesWithIncorrectPermissions = [];

  try {
    // --- Get Inputs (remains the same) ---
    const llvmVersion = core.getInput('llvm-version', { required: true });
    const llvmHash = core.getInput('llvm-sha256-hash', { required: true });
    const ignorePatternsInput = core.getInput('ignore-patterns');
    const ignorePatterns = ignorePatternsInput ? ignorePatternsInput.split('\n').filter(p => p.trim()) : [];

    // --- Setup LLVM/Clang (remains the same) ---
    core.startGroup(`Setup LLVM/Clang (${llvmVersion})`);
    const toolName = 'llvm';
    llvmToolPath = tc.find(toolName, llvmVersion);
    if (llvmToolPath) {
      core.info(`Found cached LLVM ${llvmVersion} at: ${llvmToolPath}`);
    } else {
      // ... (Download, Verify Hash, Extract, Cache logic remains the same) ...
       core.info(`LLVM ${llvmVersion} not found in cache. Downloading...`);
       const archiveFileName = `LLVM-${llvmVersion}-Linux-X64.tar.xz`;
       const downloadUrl = `https://github.com/llvm/llvm-project/releases/download/llvmorg-${llvmVersion}/${archiveFileName}`;
       core.info(`Download URL: ${downloadUrl}`);
       let downloadedArchivePath;
       try {
           downloadedArchivePath = await tc.downloadTool(downloadUrl);
       } catch (downloadError) {
           core.error(`Failed to download LLVM archive: ${downloadError.message}`);
           if (downloadError.message.includes('404')) {
               core.error(`Please double-check the llvm-version ('${llvmVersion}') and that a 'Linux-X64.tar.xz' asset exists for it.`);
           }
           throw downloadError;
       }
       core.info(`Downloaded archive to: ${downloadedArchivePath}`);
       core.info('Verifying SHA256 hash...');
       const hashMatch = await verifySHA256(downloadedArchivePath, llvmHash);
       if (!hashMatch) throw new Error('LLVM archive SHA256 hash verification failed!');
       core.info('SHA256 hash verification successful.');
       core.info(`Extracting ${archiveFileName}...`);
       const extractedPath = await tc.extractTar(downloadedArchivePath, undefined, ['-xJ']);
       core.info(`Extracted archive to temporary location: ${extractedPath}`);
       const dirs = await fs.readdir(extractedPath, { withFileTypes: true });
       const llvmSubDir = dirs.find(d => d.isDirectory() && d.name.startsWith('LLVM-'));
       if (!llvmSubDir) throw new Error(`Could not find expected LLVM subdirectory inside ${extractedPath}`);
       const actualExtractedRoot = path.join(extractedPath, llvmSubDir.name);
       core.info(`Found extracted LLVM root: ${actualExtractedRoot}`);
       core.info(`Caching directory: ${actualExtractedRoot}`);
       llvmToolPath = await tc.cacheDir(actualExtractedRoot, toolName, llvmVersion);
       core.info(`Successfully cached LLVM to: ${llvmToolPath}`);
    }
    const llvmBinPath = path.join(llvmToolPath, 'bin');
    if (!await fs.stat(llvmBinPath).then(s => s.isDirectory()).catch(() => false)) {
        throw new Error(`LLVM 'bin' directory not found at: ${llvmBinPath}`);
    }
    core.info(`Adding LLVM bin directory to PATH: ${llvmBinPath}`);
    core.addPath(llvmBinPath);
    try {
      // Verify clang-format exists in PATH *and* store the command name/path
      // Use 'which' to confirm it's findable and potentially get full path if needed later
      let whichOutput = '';
      await exec.exec('which', ['clang-format'], { silent: true, listeners: { stdout: (data) => { whichOutput += data.toString(); } } });
      clangFormatPath = whichOutput.trim(); // Store the path/command found
      if (!clangFormatPath) throw new Error("'which clang-format' failed or returned empty.");
      core.info(`Using clang-format found at: ${clangFormatPath}`); // Log the path being used
      core.info('Running clang-format --version:');
      await exec.exec(clangFormatPath, ['--version']);
    } catch (err) {
      throw new Error(`clang-format not found in PATH or failed to execute after adding ${llvmBinPath}. Error: ${err.message}`);
    }
    core.endGroup(); // End LLVM setup   

    core.startGroup('Checking C/C++ Formatting with clang-format');
    // Ensure files are absolute paths for clang-format when using --files
    const filesToCheckFormatting = await findCFiles(ignorePatterns);

    if (filesToCheckFormatting.length === 0) {
        core.info('No C/C++ files (.h, .cc, .cpp) found to format.');
    } else {
        core.info(`Checking formatting for ${filesToCheckFormatting.length} C/C++ file(s) using --files argument...`);

        // 1. Create a temporary file path
        const tempDir = process.env.RUNNER_TEMP || os.tmpdir(); // Prefer RUNNER_TEMP
        const tempFileName = `clang-format-files-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
        tempFilePath = path.join(tempDir, tempFileName);
        core.debug(`Creating temporary file list at: ${tempFilePath}`);

        // 2. Write the absolute file paths to the temporary file (one per line)
        const fileListContent = filesToCheckFormatting.join('\n');
        await fs.writeFile(tempFilePath, fileListContent, { encoding: 'utf8' });
        core.debug(`Wrote ${filesToCheckFormatting.length} filenames to ${tempFilePath}`);

        // 3. Prepare clang-format arguments
        const clangFormatArgs = ['--dry-run', '-Werror', `--files=${tempFilePath}`];

        // Log the command structure for debugging
        core.debug(`Executing: ${clangFormatPath} ${clangFormatArgs.join(' ')}`);

        let clangFormatOutput = ''; // Capture output
        const options = {
            ignoreReturnCode: true, // Check exit code manually
            silent: false,          // Allow clang-format output to show
            listeners: {
                stdout: (data) => { clangFormatOutput += data.toString(); },
                stderr: (data) => { clangFormatOutput += data.toString(); }
            }
        };

        // 4. Execute clang-format
        const exitCode = await exec.exec(clangFormatPath, clangFormatArgs, options);

        if (exitCode !== 0) {
          core.error(`clang-format check failed (exit code: ${exitCode}). Some files need formatting.`);
          core.warning(`clang-format output (potentially noisy):\n${clangFormatOutput}`);
  
          // Collect filenames for the error message (optional but helpful)
          const filesList = filesToCheckFormatting
              .map(f => path.relative(process.env.GITHUB_WORKSPACE || '.', f))
              .join(', '); // Join for a concise list, adjust if needed  
          
          core.setFailed(`Clang-format check failed. The following files need formatting: ${filesList}. Please run clang-format ${llvmVersion} locally.`);  
        } else {
            core.info('clang-format check passed. All checked C/C++ files are correctly formatted.');
        }
    }
    core.endGroup();
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    core.debug(error.stack); // Log stack trace on debug
  }
}

// --- Run ---
if (require.main === module) {
  run();
}

module.exports = { run }; 