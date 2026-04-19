/**
 * Test runner — downloads VS Code, launches it with our extension, runs mocha tests.
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // __dirname after compile with new tsconfig: <repo>/out/test
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testWorkspace = path.resolve(__dirname, '../../test-workspace');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspace,
        '--disable-extensions', // disable other extensions
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
