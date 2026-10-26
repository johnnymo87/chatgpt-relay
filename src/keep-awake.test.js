import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { holdAwake } from './keep-awake.js';

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.killed = 0;
    child.kill = () => { child.killed++; };
    calls.push({ cmd, args, child });
    return child;
  };
  return { spawn, calls };
}

test('on darwin, spawns caffeinate tied to the server pid', () => {
  const { spawn, calls } = fakeSpawn();
  holdAwake({ platform: 'darwin', spawn, pid: 4242 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'caffeinate');
  assert.deepEqual(calls[0].args, ['-i', '-s', '-w', '4242']);
});

test('release kills caffeinate exactly once', () => {
  const { spawn, calls } = fakeSpawn();
  const release = holdAwake({ platform: 'darwin', spawn, pid: 1 });
  release();
  release();
  assert.equal(calls[0].child.killed, 1);
});

test('off darwin, does nothing', () => {
  const { spawn, calls } = fakeSpawn();
  const release = holdAwake({ platform: 'linux', spawn });
  release();
  assert.equal(calls.length, 0);
});

test('spawn error is logged, not thrown', () => {
  const { spawn, calls } = fakeSpawn();
  const logs = [];
  holdAwake({ platform: 'darwin', spawn, log: (m) => logs.push(m) });
  calls[0].child.emit('error', new Error('ENOENT'));
  assert.match(logs[0], /ENOENT/);
});
