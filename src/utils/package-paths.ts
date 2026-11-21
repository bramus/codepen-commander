import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Candidate package root directories across:
 * - published/compiled `dist/utils/package-paths.js` -> `dist`
 * - local `src/utils/package-paths.ts` -> `<repo>`
 * - test builds `.test-dist/src/utils/package-paths.js` -> `<repo>`
 */
function getPackageRootCandidates(): string[] {
  return [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ];
}

export function readPackageVersion(): string {
  for (const root of getPackageRootCandidates()) {
    const candidate = path.join(root, 'package.json');
    try {
      const pkg = JSON.parse(fsSync.readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && (!pkg.name || pkg.name === 'codepen-commander')) {
        return pkg.version;
      }
    } catch {
      // Try next candidate
    }
  }
  return '0.0.0';
}

export async function resolveBuiltinShellDir(): Promise<{ dir: string; realpath: string }> {
  for (const root of getPackageRootCandidates()) {
    const candidate = path.join(root, 'shell');
    try {
      const stat = await fs.stat(path.join(candidate, 'index.html'));
      if (stat.isFile()) {
        const realpath = await fs.realpath(candidate);
        return { dir: candidate, realpath };
      }
    } catch {
      // Try next candidate
    }
  }

  throw new CliError(
    500,
    'Built-in shell assets could not be located in the codepen-commander package.',
  );
}
