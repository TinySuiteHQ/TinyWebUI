// An installed TinyWebUI keeps its files in one per-user folder per platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { userDataDir, isInstalled } from '../src/config/data_dir.ts';

test('each platform gets its usual application data folder', () => {
  assert.equal(userDataDir({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'TinyWebUI'));
  assert.equal(userDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Local', 'TinyWebUI'));
  assert.equal(userDataDir({}, 'linux', '/home/a'), join('/home/a', '.local', 'share', 'tinywebui'));
  assert.equal(userDataDir({ XDG_DATA_HOME: '/data/a' }, 'linux', '/home/a'), join('/data/a', 'tinywebui'));
  // A relative XDG_DATA_HOME is invalid by the spec, so it is ignored.
  assert.equal(userDataDir({ XDG_DATA_HOME: 'rel' }, 'linux', '/home/a'), join('/home/a', '.local', 'share', 'tinywebui'));
});

test('only a copy under node_modules counts as installed', () => {
  assert.equal(isInstalled(pathToFileURL('/home/a/.npm/_npx/abc/node_modules/tinywebui/bin/tinywebui.js').href), true);
  assert.equal(isInstalled(pathToFileURL('/home/a/src/TinyWebUI/bin/tinywebui.ts').href), false);
});
