// Shared utility functions for GitHub Actions

const core = require('@actions/core');
const exec = require('@actions/exec');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const glob = require('@actions/glob');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

// --- Execution Helper ---

/**
 * Executes a command and logs details, handling errors and sensitive arguments.
 * Throws an error if the command fails (exit code != 0).
 * @param {string} command The command to execute.
 * @param {string[]} args Command arguments.
 * @param {object} options Options for exec.getExecOutput (e.g., {sensitive: true} for masking GITHUB_TOKEN).
 * @returns {Promise<{stdout: string, stderr: string}>} Command output.
 */
async function executeCommand(command, args, options = {}) {
  // Mask sensitive arguments BEFORE logging the command execution line
  const displayArgs = args.map((arg) =>
    options.sensitive && process.env.GITHUB_TOKEN && arg === process.env.GITHUB_TOKEN
      ? '***' // Mask GITHUB_TOKEN if sensitive option is true
      : // Add more conditions here for other sensitive args if needed
        arg
  );

  // Log the command with potentially masked arguments
  core.info(`Executing: ${command} ${displayArgs.join(' ')}`);

  const { exitCode, stdout, stderr } = await exec.getExecOutput(command, args, { ignoreReturnCode: true, ...options });

  if (exitCode !== 0) {
    // Log full output only on error
    core.error(`Command failed with exit code ${exitCode}`);
    core.error(`stdout: ${stdout}`);
    core.error(`stderr: ${stderr}`);
    // Use displayArgs in error message for security
    throw new Error(`Command "${command} ${displayArgs.join(' ')}" failed with exit code ${exitCode}`);
  }

  // Log debug output on success
  core.debug(`stdout: ${stdout}`);
  if (stderr && stderr.trim() !== '') {
    core.warning(`stderr: ${stderr.trim()}`); // Log non-empty stderr as warning even on success
  }
  return { stdout, stderr };
}

// --- Hashing and Verification ---

/**
 * Verifies the SHA512 hash of a file.
 * @param {string} filePath - Path to the file to verify.
 * @param {string} expectedHash - The expected SHA512 hash in hex format.
 * @returns {Promise<boolean>} - True if the hash matches, false otherwise.
 */
async function verifySHA512(filePath, expectedHash) {
  core.info(`Calculating SHA512 for file: ${filePath}`);
  const hash = crypto.createHash('sha512');
  // Use fs.createReadStream for potentially large files
  const stream = require('node:fs').createReadStream(filePath); // Use sync require inside async func

  return new Promise((resolve, reject) => {
    stream.on('error', (err) => reject(err));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actualHash = hash.digest('hex');
      core.debug(`Actual SHA512: ${actualHash}`);
      core.debug(`Expected SHA512: ${expectedHash}`);
      const match = actualHash.toLowerCase() === expectedHash.toLowerCase();
      core.info(`SHA512 Verification Result for ${path.basename(filePath)}: ${match ? 'Match' : 'Mismatch'}`);
      resolve(match);
    });
  });
}

/**
 * Updates a hash object with the content of a file if it exists and is a file.
 * Logs warnings if the file doesn't exist or isn't a file.
 * @param {crypto.Hash} hash The hash object to update.
 * @param {string} filePath Path to the file.
 */
async function hashFileContent(hash, filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      const fileBuffer = await fs.readFile(filePath);
      hash.update(fileBuffer);
      core.debug(`Hashed content of: ${filePath}`);
    } else {
      core.warning(`Path is not a file, skipping content hashing: ${filePath}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      core.warning(`File not found for hashing: ${filePath}. Skipping content.`);
    } else {
      core.error(`Error accessing file ${filePath} for hashing: ${error.message}`);
      throw error; // Re-throw other errors
    }
  }
}

// --- Argument Parsing/Normalization ---

/**
 * Parses build args string into an array of --build-arg flags for docker build.
 * Handles simple quoting for values.
 * @param {string} buildArgsString Input build args string (e.g., "K1=V1 K2='V 2' K3=\"V 3\"").
 * @returns {string[]} Array of arguments like ['--build-arg', 'K1=V1', '--build-arg', 'K2=V 2'].
 */
function parseBuildArgs(buildArgsString) {
  const args = [];
  if (!buildArgsString || buildArgsString.trim() === '') return args;

  // Regex to match KEY=VALUE pairs, handling simple quotes
  // KEY: sequence of word chars, dots, hyphens
  // VALUE: EITHER double-quoted string OR single-quoted string OR unquoted non-space sequence
  const regex = /([\w.-]+)=("[^"]+"|'[^']+'|[^'"\s]+)/g;
  let match;
  while ((match = regex.exec(buildArgsString)) !== null) {
    // match[0] is the full K=V string, potentially with quotes around V
    args.push('--build-arg', match[0]);
  }
  return args;
}

/**
 * Normalizes build arguments string for consistent hashing.
 * Splits "K1=V1 K2='V 2'" into ["K1=V1", "K2='V 2'"], sorts them, and joins with newline.
 * @param {string} buildArgsString Input build args string.
 * @returns {string} Normalized string (sorted key-value pairs joined by newline).
 */
function normalizeBuildArgsForHashing(buildArgsString) {
  if (!buildArgsString || buildArgsString.trim() === '') {
    return '';
  }
  const argsArray = buildArgsString.match(/([\w.-]+)=("[^"]+"|'[^']+'|[^'"\s]+)/g) || [];
  argsArray.sort(); // Sort alphabetically by "KEY=VALUE" string
  return argsArray.join('\n'); // Join with newline for consistent hashing input
}

// --- Platform Helpers ---

/**
 * Gets the runner platform identifier ('windows', 'linux', or 'macos').
 * @returns {string}
 */
function getPlatformIdentifier() {
  const platform = process.platform;
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Gets the runner architecture identifier (e.g., 'x86_64', 'aarch64', 'universal').
 * @returns {string}
 */
function getArchIdentifier() {
  const arch = process.arch;
  const platform = process.platform;

  if (platform === 'darwin') return 'universal'; // Assume universal for macOS for simplicity
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';

  throw new Error(`Unsupported architecture: ${arch} on platform: ${platform}`);
}

// --- Filesystem Helpers ---

/**
 * Checks if a path exists on the host filesystem.
 * @param {string} filePath The path to check.
 * @returns {Promise<boolean>} True if the path exists, false otherwise.
 */
async function checkPathExists(filePath) {
  try {
    await fs.stat(filePath);
    core.debug(`Path check: Found '${filePath}'.`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      core.debug(`Path check: '${filePath}' not found.`);
      return false;
    } else {
      // Log other errors as warnings but treat as non-existent
      core.warning(`Path check: Error checking '${filePath}': ${error.message}. Assuming it does not exist.`);
      return false;
    }
  }
}

// --- GitHub Actions Specific Helpers ---

async function generateTestSummary(baseDir) {
  core.startGroup('Generate Test Result Summary');
  const xmlPattern = path.join(baseDir, '**/*.results.xml').replace(/\\/g, '/'); // Normalize for glob
  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  let filesProcessed = 0;
  const failedFiles = [];
  const processedFiles = [];

  // Configure the XML parser
  const parserOptions = {
      ignoreAttributes: false,    // We need attributes
      attributeNamePrefix: "",    // Use attribute names directly (e.g., tests, not @​_tests)
      parseAttributeValue: true,  // Attempt to convert attribute values to numbers/booleans
      allowBooleanAttributes: true, // If boolean attributes are used (e.g., disabled="true")
      trimValues: true,           // Trim whitespace from values
      stopNodes: ["*.testcase"]   // Optimization: Stop parsing deeper inside testcase tags
  };
  const parser = new XMLParser(parserOptions);

  core.info(`Searching for test result files matching: ${xmlPattern}`);

  try {
    // Check if base directory exists first
    await fs.access(baseDir); // Throws if doesn't exist or no permissions
    core.info(`Base directory ${baseDir} exists.`);

    const globber = await glob.create(xmlPattern, { followSymbolicLinks: false });
    for await (const file of globber.globGenerator()) {
        filesProcessed++;
        const fileName = path.relative(baseDir, file) || path.basename(file); // Get relative path for display
        processedFiles.push(fileName);
        core.debug(`Processing file: ${file}`);
        let fileContent;

        try {
            // 1. Read File
            fileContent = await fs.readFile(file, 'utf8');

            // 2. Validate XML Syntax (optional but recommended)
            const validationResult = XMLValidator.validate(fileContent);
            if (validationResult !== true) {
                // Log detailed validation error
                const err = validationResult.err;
                core.warning(`Invalid XML syntax in ${fileName}: ${err.msg} (Line: ${err.line}, Col: ${err.col})`);
                failedFiles.push(`${fileName} (syntax error)`);
                continue; // Skip to next file
            }

            // 3. Parse XML
            const result = parser.parse(fileContent);

            // 4. Find top-level tag (<testsuites> or <testsuite>) and its attributes
            // fast-xml-parser creates an object where the root tag is the key
            const rootKey = Object.keys(result)[0]; // Get the first key (should be the root tag)
            const topLevelTag = result[rootKey];

            if (!rootKey || !topLevelTag) {
                core.warning(`Could not find expected root tag (e.g., <testsuites>) in ${fileName}.`);
                failedFiles.push(`${fileName} (structure error - no root)`);
                continue; // Skip to next file
            }

             // Check if it's an array (multiple testsuite tags under testsuites) or single object
            // We only care about the *summary* attributes on the top-level tag itself
            const attrs = topLevelTag; // Attributes are properties with parseAttributeValue=true

            if (typeof attrs !== 'object' || attrs === null) {
                 core.warning(`Expected attributes object not found on root tag <${rootKey}> in ${fileName}.`);
                 failedFiles.push(`${fileName} (structure error - no attributes)`);
                 continue;
            }


            // 5. Extract counts safely (handle missing attributes, rely on parseAttributeValue)
            const tests = Number(attrs.tests || 0);
            const failures = Number(attrs.failures || 0);
            const errors = Number(attrs.errors || 0);
            // JUnit often uses 'disabled' but 'skipped' is also common. Prioritize 'skipped'.
            const skipped = Number(attrs.skipped || attrs.disabled || 0);

            // Validate that extracted values are numbers
            if (isNaN(tests) || isNaN(failures) || isNaN(errors) || isNaN(skipped)) {
                 core.warning(`Non-numeric test counts found in attributes of root tag <${rootKey}> in ${fileName}. Found: tests=${attrs.tests}, failures=${attrs.failures}, errors=${attrs.errors}, skipped/disabled=${attrs.skipped || attrs.disabled}`);
                 failedFiles.push(`${fileName} (attribute format error)`);
                 continue; // Skip counts from this file
            }

            // 6. Add to totals
            totalTests += tests;
            totalFailures += failures;
            totalErrors += errors;
            totalSkipped += skipped;
            core.debug(
                ` -> Parsed Counts - Tests: ${tests}, Failures: ${failures}, Errors: ${errors}, Skipped/Disabled: ${skipped}`
            );

        } catch (error) {
            // Catch errors from readFile, XMLValidator.validate, or parser.parse
            // Log specific error codes if available
            const errorCode = error.code ? ` (${error.code})` : '';
            core.warning(`Error processing file ${fileName}${errorCode}: ${error.message}`);
            failedFiles.push(`${fileName} (processing error)`);
        }
    } // End for loop

    // --- Generate Summary Markdown ---
    if (filesProcessed === 0) {
      core.info('No test result XML files found.');
    } else {
      core.info(`Processed ${filesProcessed} test result XML file(s).`);
      let summaryMarkdown = `## Test Results Summary\n\n`;
      summaryMarkdown += `Processed **${filesProcessed}** \`*.results.xml\` file(s) from \`${path.basename(
        baseDir
      )}\`.\n\n`;

      const totalProblems = totalFailures + totalErrors;
      const overallStatus = totalProblems === 0 ? '✅ Passed' : '❌ Failed';

      summaryMarkdown += `| Metric          | Count |\n`;
      summaryMarkdown += `| --------------- | ----: |\n`;
      summaryMarkdown += `| **Total Tests** | ${totalTests} |\n`;
      summaryMarkdown += `| Failures        | ${
        totalFailures > 0 ? `**${totalFailures}** ❌` : totalFailures
      } |\n`;
      summaryMarkdown += `| Errors          | ${totalErrors > 0 ? `**${totalErrors}** ❌` : totalErrors} |\n`;
      summaryMarkdown += `| Skipped         | ${totalSkipped} |\n`;
      summaryMarkdown += `| **Overall** | **${overallStatus}** |\n\n`;

      if (failedFiles.length > 0) {
        summaryMarkdown += `⚠️ **Issues processing some files:**\n`;
        summaryMarkdown += failedFiles.map((f) => `- \`${f}\``).join('\n') + '\n\n';
      }

      summaryMarkdown += `<details><summary>Processed Files (${processedFiles.length})</summary>\n\n`;
      summaryMarkdown += processedFiles.map((f) => `- \`${f}\``).join('\n') + '\n';
      summaryMarkdown += `</details>\n`;

      // Add to GitHub Job Summary
      try {
        await core.summary.addRaw(summaryMarkdown, true).write();
        core.info("Test result summary added to GitHub Job Summary.");
      } catch (summaryError) {
        core.error(`Failed to write job summary: ${summaryError.message}`);
      }
    }

  } catch (error) {
    // Handle errors accessing baseDir or creating globber
    if (error.code === 'ENOENT') {
      core.info(`Test result base directory ${baseDir} not found. Skipping summary generation.`);
    } else {
      core.error(`Error reading test result directory ${baseDir} or globbing files: ${error.message}`);
    }
  } finally {
    core.endGroup();
  }
}

// Export all utility functions
module.exports = {
  executeCommand,
  verifySHA512,
  hashFileContent,
  parseBuildArgs,
  normalizeBuildArgsForHashing,
  getPlatformIdentifier,
  getArchIdentifier,
  checkPathExists,
  generateTestSummary,
};
