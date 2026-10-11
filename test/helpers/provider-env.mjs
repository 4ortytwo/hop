import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import before application modules: provider paths are captured at module load.
// Override inherited settings so direct test runs and child CLIs use only fixtures.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-test-env-'));
for (const [key, directory] of Object.entries({
  CODEX_HOME: 'codex',
  CLAUDE_CONFIG_DIR: 'claude',
  HOP_CLAUDE_DESKTOP_DIR: 'claude-desktop',
  HOP_DIR: 'hop',
})) process.env[key] = path.join(root, directory);

after(() => fs.rmSync(root, { recursive: true, force: true }));
