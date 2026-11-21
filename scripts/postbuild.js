import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

if (!fs.existsSync(distDir)) {
  console.error('Error: ./dist directory does not exist. Run tsc before postbuild.');
  process.exit(1);
}

console.log('Preparing ./dist package...');

// 1. Ensure CLI entrypoint is executable
const cliPath = path.join(distDir, 'cli.js');
if (fs.existsSync(cliPath)) {
  fs.chmodSync(cliPath, 0o755);
}

// 2. Copy essential metadata files from root to dist/
const filesToCopy = ['README.md', 'LICENSE'];
for (const file of filesToCopy) {
  const srcPath = path.join(rootDir, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(distDir, file));
  }
}

// 2b. Copy built-in demo index shell assets into dist/shell/
const shellSrcDir = path.join(rootDir, 'shell');
const shellDestDir = path.join(distDir, 'shell');
if (fs.existsSync(shellSrcDir)) {
  fs.mkdirSync(shellDestDir, { recursive: true });
  for (const entry of fs.readdirSync(shellSrcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isFile()) continue;
    fs.copyFileSync(path.join(shellSrcDir, entry.name), path.join(shellDestDir, entry.name));
  }
}

// 3. Prepare and rewrite package.json for dist/
const pkgPath = path.join(rootDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  // Strip internal scripts and devDependencies from the published package
  delete pkg.scripts;
  delete pkg.devDependencies;

  // Rewrite ./dist/ paths to ./ so all entry points map cleanly to package root
  const rewritten = JSON.parse(JSON.stringify(pkg).replaceAll('./dist/', './'));

  // npm normalizes bin script paths without a leading "./"
  if (typeof rewritten.bin === 'string') {
    rewritten.bin = rewritten.bin.replace(/^\.\//, '');
  } else if (rewritten.bin && typeof rewritten.bin === 'object') {
    for (const [cmd, target] of Object.entries(rewritten.bin)) {
      if (typeof target === 'string') {
        rewritten.bin[cmd] = target.replace(/^\.\//, '');
      }
    }
  }

  const distPkgContent = `${JSON.stringify(rewritten, null, 2)}\n`;

  fs.writeFileSync(path.join(distDir, 'package.json'), distPkgContent, 'utf8');
}

console.log('Successfully prepared ./dist for publishing!');
