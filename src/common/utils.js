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
  const xmlPattern = path.join(baseDir, '**/*.results.xml').replace(/\\/g, '/');
  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  let filesProcessed = 0;
  const failedFiles = [];
  const processedFiles = [];
  const allTestCases = []; // <--- NEW: Array to store individual test cases {suite, case, time}

  const parserOptions = {
      ignoreAttributes: false,
      attributeNamePrefix: "", // No prefix for attributes
      parseAttributeValue: true, // Convert attribute values to primitive types if possible
      allowBooleanAttributes: true,
      trimValues: true,
      ignoreDeclaration: true
  };
  const parser = new XMLParser(parserOptions);

  core.info(`Searching for test result files matching: ${xmlPattern}`);

  try {
    await fs.access(baseDir);
    core.info(`Base directory ${baseDir} exists.`);

    const globber = await glob.create(xmlPattern, { followSymbolicLinks: false });
    for await (const file of globber.globGenerator()) {
        filesProcessed++;
        const fileName = path.relative(baseDir, file) || path.basename(file);
        processedFiles.push(fileName);
        core.debug(`--- Processing file: ${fileName} ---`);
        let fileContent;

        // Reset counters for the current file before processing
        let fileTests = 0, fileFailures = 0, fileErrors = 0, fileSkipped = 0;

        try {
            fileContent = await fs.readFile(file, 'utf8');
            const validationResult = XMLValidator.validate(fileContent);
            if (validationResult !== true) {
                const err = validationResult.err;
                core.warning(`Invalid XML syntax in ${fileName}: ${err.msg} (Line: ${err.line}, Col: ${err.col})`);
                failedFiles.push(`${fileName} (syntax error)`);
                continue;
            }

            const result = parser.parse(fileContent);
            core.debug(`Parsed XML structure: ${JSON.stringify(result, null, 2)}`);

            const rootKey = Object.keys(result)[0];
            if (!rootKey) {
                core.warning(`Could not determine root tag in ${fileName}.`);
                failedFiles.push(`${fileName} (structure error - no root key)`);
                continue;
            }
            const topLevelData = result[rootKey]; // This is the object/array under the root tag

            core.debug(`Root Key: ${rootKey}, Top Level Data Type: ${typeof topLevelData}`);

            let suitesToProcess = [];

            if (rootKey === 'testsuites') {
                // Root is <testsuites>, contains potentially multiple <testsuite>
                if (topLevelData && topLevelData.testsuite) {
                    suitesToProcess = Array.isArray(topLevelData.testsuite)
                        ? topLevelData.testsuite
                        : [topLevelData.testsuite];
                    core.debug(`Found ${suitesToProcess.length} <testsuite> elements under <testsuites>`);
                } else {
                     core.debug(`<testsuites> root found, but no child <testsuite> elements detected.`);
                     // Check <testsuites> attributes for summary (less common)
                    if (typeof topLevelData === 'object' && topLevelData !== null) {
                        const attrs = topLevelData;
                        const t = Number(attrs.tests || 0);
                        const f = Number(attrs.failures || 0);
                        const e = Number(attrs.errors || 0);
                        const s = Number(attrs.skipped || attrs.disabled || 0);
                        if (!isNaN(t) && !isNaN(f) && !isNaN(e) && !isNaN(s) && (t > 0 || f > 0 || e > 0 || s > 0)) {
                            fileTests = t; fileFailures = f; fileErrors = e; fileSkipped = s;
                            core.debug(`Using summary counts found directly on <testsuites> tag.`);
                        }
                    }
                }
            } else if (rootKey === 'testsuite') {
                // Root is a single <testsuite>
                if (topLevelData) {
                    suitesToProcess = [topLevelData]; // Process this single suite
                    core.debug(`Root is a single <testsuite> element.`);
                }
            } else {
                core.warning(`Unexpected root tag <${rootKey}> found in ${fileName}. Skipping counts.`);
                failedFiles.push(`${fileName} (unexpected root tag)`);
                continue; // Skip count aggregation for this file
            }

            // Iterate through the identified testsuite objects
            for (const suite of suitesToProcess) {
                if (typeof suite === 'object' && suite !== null) {
                    core.debug(`Processing suite object: ${JSON.stringify(suite, null, 2)}`);
                    const suiteName = suite.name || 'UnknownSuite'; // Get suite name
                    const attrs = suite;

                    // Aggregate counts from suite attributes
                    const t = Number(attrs.tests || 0);
                    const f = Number(attrs.failures || 0);
                    const e = Number(attrs.errors || 0);
                    const s = Number(attrs.skipped ?? attrs.disabled ?? 0);

                    if (isNaN(t) || isNaN(f) || isNaN(e) || isNaN(s)) {
                         core.warning(`Non-numeric test counts found in attributes of a <testsuite name="${suiteName}"> tag in ${fileName}.`);
                    } else {
                        fileTests += t;
                        fileFailures += f;
                        fileErrors += e;
                        fileSkipped += s;
                    }

                    // --- NEW: Process individual test cases ---
                    if (suite.testcase) {
                        const testCases = Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase];
                        core.debug(` Found ${testCases.length} <testcase> elements in suite "${suiteName}"`);
                        for (const tc of testCases) {
                            if (typeof tc === 'object' && tc !== null) {
                                const caseName = tc.name;
                                const caseTime = tc.time; // Should be parsed as number by parseAttributeValue: true

                                // Check if data is valid for sorting
                                if (caseName && typeof caseTime === 'number' && !isNaN(caseTime)) {
                                    allTestCases.push({
                                        suite: suiteName,
                                        case: caseName,
                                        time: caseTime
                                    });
                                    core.debug(`  Added test case: ${suiteName} / ${caseName} / ${caseTime}`);
                                } else {
                                    core.debug(`  Skipping test case with missing name or invalid time: ${JSON.stringify(tc)}`);
                                }
                            }
                        }
                    } else {
                         core.debug(` No <testcase> elements found in suite "${suiteName}"`);
                    }
                    // --- End NEW ---

                } else {
                    core.warning(`Encountered non-object item in suitesToProcess for ${fileName}. Skipping item.`);
                }
            } // End loop through suitesToProcess

             // Add file totals to overall totals outside the suite loop
             totalTests += fileTests;
             totalFailures += fileFailures;
             totalErrors += fileErrors;
             totalSkipped += fileSkipped;
             core.debug(` -> Aggregated Counts for ${fileName} - Tests: ${fileTests}, Failures: ${fileFailures}, Errors: ${fileErrors}, Skipped: ${fileSkipped}`);
             core.debug(` -> Running Totals - Tests: ${totalTests}, Failures: ${totalFailures}, Errors: ${totalErrors}, Skipped: ${totalSkipped}`);


        } catch (error) {
            const errorCode = error.code ? ` (${error.code})` : '';
            core.warning(`Error processing file ${fileName}${errorCode}: ${error.message}`);
            core.debug(error.stack); // Log stack for debug
            failedFiles.push(`${fileName} (processing error)`);
        }
        core.debug(`--- Finished processing file: ${fileName} ---`);
    } // End for loop over files

    // --- Generate Summary Markdown ---
    if (filesProcessed === 0) {
      core.info('No test result XML files found.');
    } else {
      core.info(`Processed ${filesProcessed} test result XML file(s).`);

      // --- Generate overall summary table ---
      let summaryMarkdown = `## Test Results Summary\n\n`;
      summaryMarkdown += `Processed **${filesProcessed}** \`*.results.xml\` file(s) from \`${path.basename(
        baseDir
      )}\`.\n\n`;

      const totalProblems = totalFailures + totalErrors;
      const overallStatus = totalProblems === 0 ? '✅ Passed' : '❌ Failed';

      summaryMarkdown += `| Metric        | Count |\n`;
      summaryMarkdown += `| ------------- | ----: |\n`;
      summaryMarkdown += `| Total Tests   | ${totalTests} |\n`;
      summaryMarkdown += `| Failures      | ${
        totalFailures > 0 ? `**${totalFailures}** ❌` : totalFailures
      } |\n`;
      summaryMarkdown += `| Errors        | ${totalErrors > 0 ? `**${totalErrors}** ❌` : totalErrors} |\n`;
      summaryMarkdown += `| Skipped       | ${totalSkipped} |\n`;
      summaryMarkdown += `| **Overall** | **${overallStatus}** |\n\n`;

      // --- NEW: Generate Top 10 Slowest Tests ---
      if (allTestCases.length > 0) {
            // Sort by time descending
            allTestCases.sort((a, b) => b.time - a.time);
            const slowestTests = allTestCases.slice(0, 10);

            summaryMarkdown += `### Top ${slowestTests.length} Slowest Tests\n\n`;
            summaryMarkdown += `| Rank | Time (s) | Suite Name      | Test Case Name  |\n`;
            summaryMarkdown += `| ---- | -------- | --------------- | --------------- |\n`;
            slowestTests.forEach((test, index) => {
                // Format time to 3 decimal places
                const timeFormatted = test.time.toFixed(3);
                // Escape pipe characters in names to prevent breaking markdown table
                const suiteEscaped = test.suite.replace(/([\\|])/g, '\\$1');
                const caseEscaped = test.case.replace(/([\\|])/g, '\\$1');
                summaryMarkdown += `| ${index + 1} | ${timeFormatted} | ${suiteEscaped} | ${caseEscaped} |\n`;
            });
            summaryMarkdown += '\n';
      } else {
           summaryMarkdown += `No individual test case times found to determine slowest tests.\n\n`;
      }
      // --- End NEW ---


      if (failedFiles.length > 0) {
        summaryMarkdown += `⚠️ **Issues processing some files:**\n`;
        summaryMarkdown += failedFiles.map((f) => `- \`${f}\``).join('\n') + '\n\n';
      }

      summaryMarkdown += `<details><summary>Processed Files (${processedFiles.length})</summary>\n\n`;
      summaryMarkdown += processedFiles.map((f) => `- \`${f}\``).join('\n') + '\n';
      summaryMarkdown += `</details>\n`;

      try {
        await core.summary.addRaw(summaryMarkdown, true).write();
        core.info("Test result summary added to GitHub Job Summary.");
      } catch (summaryError) {
        core.error(`Failed to write job summary: ${summaryError.message}`);
      }
    }

  } catch (error) {
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
