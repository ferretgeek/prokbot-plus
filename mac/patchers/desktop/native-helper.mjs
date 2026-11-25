import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Grok Bot 1.3.0 universal helper: Swift Array<String> backing the stdio
// peer policy, one entry in each architecture. The UID/signature checks stay intact.
// The Apple Silicon and Intel downloads carry separately signed builds of the same
// universal helper, with the team at the same offsets.
const digests = new Set([
  '62d2486a2ac6fd75a563ddc6cee9b1593a57ced8b05e83c4ca77d646c43c6fcb', // darwin-arm64 DMG
  '6b5478fa2864175e18b7e1221705fc4051f865af104ef5cf9ac8c6da4829f7c9', // darwin-x64 DMG
]);
const teamOffsets = [0x257f68, 0x6c1b18];
export async function patchNativeHelperTeam(filename, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Computer helper requires a certificate Team ID');
  const bytes = await readFile(filename);
  if (!digests.has(createHash('sha256').update(bytes).digest('hex'))) throw new Error('Unsupported computer helper binary');
  for (const offset of teamOffsets) {
    if (bytes.subarray(offset, offset + 10).toString() !== 'DCNK4UB866' || bytes[offset + 15] !== 0xea)
      throw new Error('Computer helper peer policy fingerprint mismatch');
    bytes.write(teamId, offset, 'ascii');
  }
  await writeFile(filename, bytes);
  return { trustedTeam: teamId, architectures: ['x86_64', 'arm64'], sameUserRequired: true, signatureRequired: true };
}
