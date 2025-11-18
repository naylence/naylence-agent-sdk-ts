#!/usr/bin/env node

/**
 * Injects the package version into src/version.ts
 * Run automatically via prebuild script in package.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const versionFilePath = path.join(
      projectRoot,
      'src/version.ts'
    );

    // Read package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    if (!version || typeof version !== 'string') {
      console.error('Error: Could not find valid version in package.json');
      process.exit(1);
    }

    // Generate version.ts content
    const content = `// This file is auto-generated during build - do not edit manually
// Generated from package.json version: ${version}

/**
 * The package version, injected at build time.
 * @internal
 */
export const VERSION = '${version}';
`;

    // Write the file
    fs.writeFileSync(versionFilePath, content, 'utf-8');
    console.log(`✓ Injected version ${version} into version.ts`);
  } catch (error) {
    console.error('Error injecting version:', error.message);
    process.exit(1);
  }
}

main();
