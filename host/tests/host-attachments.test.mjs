import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentsMountedOnBox, syncTurnAttachments } from '../runtime/host-attachments.mjs';

const AGENT = 'aba7fe88-9c09-476b-a88e-4369163afb7d';
// The Host runs on Linux; managed attachment paths are matched as POSIX paths.
const posixOnly = { skip: process.platform === 'win32' && 'POSIX Host paths' };
const library = { createContext: () => ({ withCancel: () => [{}, () => {}] }) };
const recordingBox = () => {
  const uploads = [];
  return { uploads, remoteBox: { uploadFile: async (_ctx, agentId, path, bytes) => { uploads.push({ agentId, path, bytes: bytes.length }); } } };
};

test('only the read-only memory mount at the Host path counts as shared attachments', () => {
  const on = { GROKBOT_HOST_MEMORY_MOUNTS: '1' };
  assert.equal(agentsMountedOnBox('/data/runtime/host-data/agents', on), true);
  assert.equal(agentsMountedOnBox('/data/runtime/host-data/agents', {}), false);
  assert.equal(agentsMountedOnBox('/data/runtime/host-data/agents', { GROKBOT_HOST_MEMORY_MOUNTS: '0' }), false);
  assert.equal(agentsMountedOnBox('/srv/other/agents', on), false);
});

test('attachments are still copied to a Bot computer that does not mount Host data', posixOnly, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-attachments-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attachments = join(root, 'agents', AGENT, 'attachments');
  await mkdir(attachments, { recursive: true });
  const file = join(attachments, 'notes.txt');
  await writeFile(file, 'hello');
  for (const env of [{}, { GROKBOT_HOST_MEMORY_MOUNTS: '1' }]) {
    const { uploads, remoteBox } = recordingBox();
    await syncTurnAttachments({ remoteBox, getAgentId: () => AGENT }, { attachedFilePaths: [file, file] }, library, root, env);
    assert.deepEqual(uploads, [{ agentId: AGENT, path: file, bytes: 5 }]);
  }
});

test('attachments under the read-only memory mount are not written to the Bot computer again', posixOnly, async () => {
  const { uploads, remoteBox } = recordingBox();
  const path = `/data/runtime/host-data/agents/${AGENT}/attachments/notes.txt`;
  // Returns before touching the file system: the Bot already reads this path through the mount.
  await syncTurnAttachments({ remoteBox, getAgentId: () => AGENT }, { attachedFilePaths: [path], selectedImages: [{ path }] },
    library, '/data/runtime/host-data', { GROKBOT_HOST_MEMORY_MOUNTS: '1' });
  assert.deepEqual(uploads, []);
});
