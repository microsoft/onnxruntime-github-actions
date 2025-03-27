import * as esbuild from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const actionsDir = path.join(__dirname, 'actions');
const buildDir = path.join(__dirname, 'build'); // Build output directory

// Shared esbuild options
const sharedEsbuildOptions = {
  bundle: true,       // Bundle dependencies
  platform: 'node',   // Target Node.js environment
  target: 'node20',   // Target Node.js version (must match action.yml)
  minify: true,       // Minify output code
  sourcemap: true    // Generate source maps for debugging
};

async function build() {
  try {
    // Clean previous build directory
    console.log(`Cleaning build directory: ${buildDir}`);
    await fs.rm(buildDir, { recursive: true, force: true });
    await fs.mkdir(buildDir, { recursive: true });

    // Find all action source directories in src/
    const actionSources = await fs.readdir(srcDir, { withFileTypes: true });

    // Process each action directory
    for (const dirent of actionSources) {
      if (dirent.isDirectory()) {
        const actionName = dirent.name;
        const entryPoint = path.join(srcDir, actionName, 'index.js');
        const actionYmlSrc = path.join(actionsDir, actionName, 'action.yml');
        const outDir = path.join(buildDir, actionName); // Output like build/action-name/
        const distDir = path.join(outDir, 'dist');     // Subdir for JS output
        const outFile = path.join(distDir, 'index.js'); // Final JS file path
        const actionYmlDest = path.join(outDir, 'action.yml'); // Final action.yml path

        console.log(`Building action: ${actionName}`);

        // Ensure output directories exist
        await fs.mkdir(distDir, { recursive: true });

        // Run esbuild to bundle JavaScript
        await esbuild.build({
          ...sharedEsbuildOptions,
          entryPoints: [entryPoint],
          outfile: outFile,
        });
        console.log(`  -> Bundled JS to ${outFile}`);

        // Copy the corresponding action.yml
        try {
           await fs.copyFile(actionYmlSrc, actionYmlDest);
           console.log(`  -> Copied action.yml to ${actionYmlDest}`);
        } catch (copyError) {
           console.error(`  -> ERROR copying action.yml for ${actionName} from ${actionYmlSrc}: ${copyError}`);
           // Decide if build should fail if action.yml is missing
           throw copyError;
        }
      }
    }
    console.log('Build completed successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1); // Exit with error code
  }
}

// Execute the build function
build();