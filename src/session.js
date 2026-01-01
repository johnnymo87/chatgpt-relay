import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover Claude Code session ID from runtime files.
 * @param {object} opts - Options
 * @param {number} opts.ppid - Parent process ID
 * @param {string} opts.tmux - TMUX env var
 * @param {string} opts.tmuxPane - TMUX_PANE env var
 * @returns {string|null} Session ID or null
 */
export function discoverSessionId(opts = {}) {
  const ppid = opts.ppid ?? process.ppid;
  const tmux = opts.tmux ?? process.env.TMUX;
  const tmuxPane = opts.tmuxPane ?? process.env.TMUX_PANE;
  const homeDir = os.homedir();

  // Try ppid-map first
  const ppidMapPath = path.join(homeDir, '.claude/runtime/ppid-map', String(ppid));
  if (fs.existsSync(ppidMapPath)) {
    return fs.readFileSync(ppidMapPath, 'utf8').trim();
  }

  // Try pane-map if in tmux
  if (tmux && tmuxPane) {
    const socketPath = tmux.split(',')[0];
    const socketName = path.basename(socketPath);
    const paneNum = tmuxPane.replace('%', '');
    const paneKey = `${socketName}-${paneNum}`;
    const paneMapPath = path.join(homeDir, '.claude/runtime/pane-map', paneKey);

    if (fs.existsSync(paneMapPath)) {
      return fs.readFileSync(paneMapPath, 'utf8').trim();
    }
  }

  return null;
}
