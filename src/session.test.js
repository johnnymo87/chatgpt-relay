import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSessionId } from './session.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-relay-session-test-'));
}

test('discoverSessionId returns null when no runtime files exist', () => {
  const result = discoverSessionId({ ppid: 99999, homeDir: tempHome() });
  assert.strictEqual(result, null);
});

test('discoverSessionId returns null when tmux vars set but no pane-map file', () => {
  const result = discoverSessionId({
    ppid: 99999,
    tmux: '/tmp/tmux-501/default,12345,0',
    tmuxPane: '%99',
    homeDir: tempHome()
  });
  assert.strictEqual(result, null);
});
