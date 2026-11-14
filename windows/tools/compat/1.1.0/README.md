# Desktop 1.1.0: renderer research, not native support

**Decision:** two UI-only recipes replay on the exact Windows input. The same edits pass a separate, source-bound [Mac replay](#mac-ui-cross-check); the Windows rules themselves reject the Mac files. The existing desktop registrar is incompatible with the Windows preload, whose digest also appears in the Mac handoff. No sanctioned way to configure the signed official app for this Host was established. Do not install these recipes in the official executable or register new IPC capabilities from this inventory.

## Windows input

- Main attested the original Windows installer's valid Authenticode and verified the 57,252,462-byte ASAR as `ae8f0a14fe65f421881f96fdcb66aaaaed8b28806f79d5239dbefec9ef2ea972`. The coordinator's map identifies internal version 1.1.0; 0/16 legacy recipe sources unchanged, 6 changed, 10 absent. No independent download, signature operation or full archive rehash here.
- Recomputed the SHA-256 of the ASAR header's JSON text: `9fb5f015b88ae9ae5da2033aa1c447b6ea57c26a53bf04bf56b4f4219d4baa6a`. The packed header is 245,816 bytes. The verifier reads and checks exactly three packed files (216,644 bytes combined); it refuses links, unpacked files, non-allowlisted roles, short reads or mismatched digests. It neither extracts to disk nor changes the archive.
- During investigation the small renderer entry, overview, configure and context members were also examined by digest. The overview imports configure. This bounded inspection did not establish an end-to-end import path from the entry to the two staged views; the 5.3 MB eager-app and native main/coordinator were not read. Direct imports exist in the verified header, not proof that every transitive module links at runtime.

## IPC findings

The 160,046-byte `dist/electron-preload/preload.cjs` hashes to `3204c8744260d6070dcffe2192b184bc6cdc9cb5d881d73e8b30c3517e91dac9`. `ipc.mjs` traces the exposed desktop world back to the actual main-edge declaration, instead of counting every RPC-looking string in the bundle.

| Contract | What the actual preload establishes |
| --- | --- |
| Bootstrap and channels | Electron performs a synchronous boot snapshot. Main-edge RPC waits for the served state/notification. Method and probe channels are constructed and invoked; event channels are constructed and subscribed. A literal-only probe scan misses the constructed channel. |
| Declarations vs implementation | The main edge has **496 unique declarations** across 7 groups: 354 with arguments, 142 without. The production desktop registrar recognizes **0** in these bytes. These counts are not numbers of Host capabilities. Do not register all declarations or treat vendor-account methods as self-host features. |
| Request and reply shapes | Persistence reads declare `include`/`exclude`; writes declare `key`/`value`. Path staging declares `filename`/`sourcePath`; the preload wraps native file selection separately from the exposed main map. Media resolution declares `source`, `inline`, `rendition`, `inRoom`, `preview`, `viewSlot`. The client reads `ok`/`value` on success; its diagnostic probe distinguishes a failed envelope with `failure.code = edge/unknown-method`. The current project's positive envelope with `value: false` does not convey that failure. Names alone do not establish argument, result or permission compatibility. |
| Coordinator | The preload has claim/release ownership, invokes a port request, receives the first transferred port, accepts a nullable account slot and forwards outgoing frames unchanged. No literal `hello`/`ready` lifecycle frame or numeric wire version is established by this preload. **Do not infer version 3** from similar IPC names or from the project's gateway. |

## Two staged recipes

The standalone JSON rules use the project byte-recipe format but **no production manifest references them**. The generator takes all `add` bytes from a fixed set of project-authored literals. Unmodified vendor content is represented only by source copy ranges. There are seven edits, 221 project-added bytes, zero vendor-derived `add` bytes, and no materialized vendor target in the repository.

| UI behavior | Source SHA-256 | Staged target SHA-256 |
| --- | --- | --- |
| `file-library.recipe.json`: Bot library preflight **and displayed limits**, from 25 MiB / 200 / 1 GiB to the project's Host library limits of 20 MiB / 100 / 100 MiB. Six edits, 40 added bytes. No upload RPC or chat attachment change. | `60a38f710b8d068949ba7483e745d540077cc6f35a0fdf3fc6c54580eab15885` | `617486d14e970b2d550471f863cf7ec862c1e258bef6ceb9ee44dc489e0929e0` |
| `empty-label.recipe.json`: one connected-apps empty fallback, localized from document language with browser language fallback. Loading, nonempty search and ownership/filtering code remain stock. Two exported consumers, one edit, 181 added bytes. | `4caaa8d32735ecf7950633c063e143b9c02413017b83ac72f2e97423c60fca8f` | `8e3893e1ea1a144f570abc61877c0ccc2572f74857969fc194b4b01706ed18cc` |

## Reproduce without a build

```sh
node --expose-internals windows/tools/compat/1.1.0/verify.mjs <coordinator-verified-windows-app.asar>
```

The verifier regenerates and checks the exact staged rules, replays them **in memory**, re-parses both targets, checks bindings/callers and unchanged imports/exports, and checks the existence of 5 and 12 direct imported files in the authenticated header. It rejects wrong source and target fingerprints for each rule. It invokes only the isolated, fixed-input UI selection/formatting and label helpers with synthetic data; no vendor module initialization, preload execution or permissions.

Results: **32 file-selection cases** (16 stock, 16 staged) and **40 empty/loading/search cases** (20 stock, 20 staged). Also verified three displayed limits on each variant, ordinary/hidden/empty files, accumulated batch limits, trimmed search terms, `zh-CN`/`zh-TW`, and document vs browser locale priority. Localization descriptors/name-list formatting and browser language are fixtures. No browsing, React mount, actual upload, device pairing, chat or packaged-client launch is implied.

## Mac UI cross-check

Main verified the DMG hash and plist, and supplied code-only ASAR SHA-256 `2ce3b335f3d92c7be6ad59da397f8f6bf16c6d29474041ec5cc1e508b65b8e48`. The authenticated map reports identical regular and VNC preload hashes to Windows, different entry HTML/module hashes, and 10 missing, 6 changed, 0 matching legacy source paths. These are handoff observations; neither preload was reread in this check.

Locally verified the Mac header JSON SHA-256 `8eb95ee4e7cf58eaaf6c0e54434ceb887cc4ac2b72920da5c2eed25705cf2f5b` and **two packed UI members only, 56,598 bytes total**. Both Windows rules rejected the Mac inputs. Re-deriving the roles on the actual Mac syntax independently yielded **identical copy offsets, lengths and project-authored additions**, but different source and target hashes. Mac rules and target streams existed only in memory.

| Mac UI member | Mac source SHA-256 | Mac in-memory target SHA-256 | Result |
| --- | --- | --- | --- |
| `chunk-bot-store-files-library-OcCbwi0W.js` | `d52fc853966e3c3fd8a8f2349af04401d618a6489dcb5da2b2074dc15b468edb` | `98d518c22d0aabd3d11883d6b32768a317a0cbd27717714400454b0f2400ddb9` | 32 selection cases passed; all six stock/staged displayed limits matched. |
| `chunk-plugin-detail-sharepoint-write-OvP2TX9_.js` | `8447980f449b88d72d899ca68ac34647902db1dc30358c014e6a11855c1abea4` | `c42a3982dfc211f26eee0aecb55a400662c31decb9ae2e1b738a9c0ebadcf4e6` | 40 locale/loading/search cases passed. |

```sh
node --expose-internals windows/tools/compat/1.1.0/verify.mjs <coordinator-verified-mac-asar> --mac-ui
```

No full rehash, unpack, codesign/Gatekeeper check, signed-app launch, Host contact or native acceptance. Production pins and manifests remain untouched.

**Next gate:** main would need evidence of a sanctioned integration point on an unchanged signature-verified client, the actual wire sender/receiver contract, and approval for native tests on both platforms. In its absence, keep official-client migration blocked; the research recipes are not an installer or a workaround.
