#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
execFileSync('python3', [path.join(root, 'scripts/build/_odt_policies_convert.py')], {
  cwd: root,
  stdio: 'inherit',
});
