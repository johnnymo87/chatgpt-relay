/**
 * Keep the Mac awake while the server runs.
 *
 * A deep-research answer can take 20-60 minutes. If macOS idle-sleeps in
 * the meantime, the SSH tunnel to the remote client drops and the finished
 * answer has nowhere to go (observed 2026-10-26: idle sleep at 18:45 mid-run).
 *
 * `caffeinate -i -s` holds PreventUserIdleSystemSleep and (on AC power)
 * PreventSystemSleep. `-w <pid>` makes caffeinate exit on its own if this
 * server dies, so an assertion can never outlive the daemon.
 */

import { spawn as defaultSpawn } from 'node:child_process';

export function holdAwake({
  platform = process.platform,
  spawn = defaultSpawn,
  pid = process.pid,
  log = () => {},
} = {}) {
  if (platform !== 'darwin') return () => {};

  let child;
  try {
    child = spawn('caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore' });
    child.on('error', (e) => log(`caffeinate failed: ${e.message}`));
  } catch (e) {
    log(`caffeinate failed: ${e.message}`);
    return () => {};
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { child.kill(); } catch { /* already gone */ }
  };
}
