import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const assets = {
  'ping-1-open-blip': 'tmp-1-open-blip-D1y74m9N.wav',
  'ping-2-tick': 'tmp-2-tick-DY1KrPne.wav',
  'ping-3-double-tick': 'tmp-3-double-tick-CdEXJqnB.wav',
  'ping-4-chime-a': 'tmp-4-chime-a-CH10PUxT.wav',
  'ping-5-chime-b': 'tmp-5-chime-b-B3aR0Am-.wav',
};
export async function createSounds(profile, payload) {
  const directory = path.join(profile, 'notification-sounds');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const filename of Object.values(assets)) {
    await writeFile(path.join(directory, filename), await readFile(path.join(payload, 'renderer/assets', filename)), { mode: 0o600 });
  }
  const children = new Set();
  return {
    play(sound) {
      if (!assets[sound]) return;
      const file = path.join(directory, assets[sound]);
      // Windows has no command-line player; the system SoundPlayer reads the path from the environment.
      const child = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          '(New-Object System.Media.SoundPlayer $env:GROKBOT_SOUND_FILE).PlaySync()'],
          { stdio: 'ignore', windowsHide: true, env: { ...process.env, GROKBOT_SOUND_FILE: file } })
        : spawn('/usr/bin/afplay', [file], { stdio: 'ignore' });
      children.add(child); child.once('exit', () => children.delete(child)); child.once('error', () => children.delete(child));
    },
    stop() { for (const child of children) child.kill(); children.clear(); },
  };
}
