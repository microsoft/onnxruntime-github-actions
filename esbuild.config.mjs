// c:\src\onnxruntime-github-actions\esbuild.config.mjs
// Updated: 2025-03-28 - Added skip for 'common' directory

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
  bundle: true,        // Bundle dependencies
  platform: 'node',    // Target Node.js environment
  target: 'node20',    // Target Node.js version (must match action.yml)
  minify: true,        // Minify output code
  sourcemap: 'linked'  // Generate linked source maps for debugging
  // Consider adding external: ['@actions/*'] if you want to rely on runner's modules,
  // but bundling is usually safer for distribution. Default behavior bundles them.
};

async function build() {
  try {
    // Clean previous build directory
    console.log(`Cleaning build directory: ${buildDir}`);
    await fs.rm(buildDir, { recursive: true, force: true });
    await fs.mkdir(buildDir, { recursive: true });

    // Find all potential action source directories in src/
    const actionSources = await fs.readdir(srcDir, { withFileTypes: true });

    // Process each potential action directory
    for (const dirent of actionSources) {
      if (dirent.isDirectory()) {
        const actionName = dirent.name;

        // --- Skip the common directory ---
        if (actionName === 'common') {
          console.log(`Skipping common directory: ${actionName}`);
          continue; // Move to the next directory entry
        }
        // --------------------------------

        const entryPoint = path.join(srcDir, actionName, 'index.js');
        const actionYmlSrc = path.join(actionsDir, actionName, 'action.yml');
        // Output structure: build/action-name/action.yml and build/action-name/dist/index.js
        const outDir = path.join(buildDir, actionName);
        const distDir = path.join(outDir, 'dist');
        const outFile = path.join(distDir, 'index.js');
        const actionYmlDest = path.join(outDir, 'action.yml');

        console.log(`Building action: ${actionName}`);

        // Ensure output directories exist
        await fs.mkdir(distDir, { recursive: true });

        // Check if entry point exists before trying to build
        try {
            await fs.access(entryPoint);
        } catch (err) {
            console.warn(`  -> WARNING: Entry point not found at ${entryPoint}. Skipping build for ${actionName}.`);
            continue; // Skip if index.js doesn't exist
        }


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
            // Log error but maybe don't fail the whole build? Or fail? Let's fail for now.
            console.error(`  -> ERROR copying action.yml for ${actionName} from ${actionYmlSrc}: ${copyError.message}`);
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