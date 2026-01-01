import { test } from 'node:test';
import assert from 'node:assert';
import { discoverSessionId } from './session.js';

test('discoverSessionId returns null when no runtime files exist', () => {
  const result = discoverSessionId({ ppid: 99999 });
  // With a fake PPID, no file will exist
  assert.strictEqual(result, null);
});

test('discoverSessionId returns null when tmux vars set but no pane-map file', () => {
  const result = discoverSessionId({
    ppid: 99999,
    tmux: '/tmp/tmux-501/default,12345,0',
    tmuxPane: '%99'
  });
  assert.strictEqual(result, null);
});
