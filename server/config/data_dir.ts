/*
 * Where an installed TinyWebUI (npx, or npm install -g) keeps its files when
 * nothing says otherwise: one folder per user, the platform's usual place for
 * application data, rather than whichever folder the command ran in. Config,
 * keys, database and embedding models all sit there, beside the config, so
 * one person has one of each and knows where to back it up or delete it.
 * A clone and the Docker image keep using the working directory and their
 * explicit paths.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The per-user data folder on `platform`. */
export function userDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'TinyWebUI');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'TinyWebUI');
  // XDG: a relative value is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(xdg, 'tinywebui');
}

/** Whether `moduleUrl` runs from an installed package rather than a checkout. */
export const isInstalled = (moduleUrl: string): boolean => fileURLToPath(moduleUrl).split(sep).includes('node_modules');
