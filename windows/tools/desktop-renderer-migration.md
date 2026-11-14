# Desktop renderer migration: self-host contract

Research handoff, not a new supported version. Windows x64 and macOS ARM64 are separate targets. Neither has a 1.1.0 native acceptance result in this work. Current desktop support files still name 0.71.2.

## Evidence available

| Input | What was actually checked | What it does not establish |
| --- | --- | --- |
| 0.71.2 to 1.0.1 | The previous offline `renderer-migration` inventory, results and browser records cover both platforms. Six staged files per platform (15 source edits); eight component groups on each stock/staged variant. Stock boot without Electron left the root empty on all four baseline/candidate inputs. | No native preload, authenticated Host, live catalog, file transfer or audio service. The earlier runner was not executed again. |
| 1.0.3 | `docs/ARCHITECTURE.md` records 16 old source paths per platform: 10 missing, 6 with changed bytes, 0 unchanged. It also records changed preloads since 1.0.1. | Historical repository evidence only; its inputs were not opened. None of these counts apply to 1.1.0. |
| 1.1.0 Windows x64 | Main supplied a verified ASAR and a valid installer Authenticode result. This investigation checked the header, selected member hashes, 496 main RPC declarations, and two source-bound UI recipes. See the [candidate findings and replay](compat/1.1.0/README.md). | The current registrar matches zero of those declarations. No wire-version negotiation, authorized native self-host setup or chat was verified. |
| 1.1.0 macOS ARM64 | Authenticated header and two real UI members checked. Both Windows rules reject the Mac bytes; independent Mac-bound edits yield identical operations and pass 72 stock/staged file-selection and presentation cases. [Hashes and replay](compat/1.1.0/README.md#mac-ui-cross-check). | Main's map identifies identical regular/VNC preloads but different renderer entries. No macOS signature validation, native launch, pairing or self-host acceptance in this check. |

## Renderer decision

Keep stock code whenever it already gives the desired behavior. Filename stems, bundle size, equal delimiter counts and matching strings are navigation hints, not proof. The current `port-desktop-recipes.mjs` was written to align platform variants of the same baseline, not to discover semantics across upstream releases.

| Candidate | Require on each new platform before reapplication in any authorized artifact |
| --- | --- |
| Host catalog category and no public link for Host-only items | Trace the grouping and link providers to their actual consumers. Include ordinary public, unlisted, team-owned, local and unknown rows; preserve visibility and ownership. Never acquire new sharing rights. |
| Localized empty label and project locale helper | Test empty, loading and query states in both locales. Prove the import resolves, the label changes only in the intended state and stock filtering is untouched. |
| Bot file-library preflight | Trace the active picker to its validator/labels and actual Host contract. Previous controls were 20 MiB per file, 100 files, 100 MiB total; test below/at/above boundaries and refusal reasons. These are not chat attachment limits or proof of upload. The old file dialog export did not carry over. |
| Memo playback speed, tables and keyboard behavior | Verify any speed change reaches the actual player and persists after reopening. Test file and transcript tables separately, and dialog focus/IME without sending a background chat. Preserve existing stock behavior when it passes. None proves real-time calling. |
| Boot HTML, settings, update/about, file/profile editors | Retain stock entry, CSP and update policy. Trace actual providers, reply shapes and persistence; do not transplant a bundled settings view. Do not infer version from the existing literal in `local-services.mjs`. |

For a candidate change, require exact source and target hashes, unique AST roles (binding, caller and exported/imported symbol), negative controls and behavioral replay. Complete transitive linkage is required before calling a whole renderer compatible. Fresh platform-specific evidence is required even when normalized trees look alike. Research recipes contain copy offsets and project-authored additions only; do not bring upstream source, bundles or materialized target files into this repository.

## IPC and protocol

| Boundary in the current shared implementation | Check in the handed-off input, without executing it |
| --- | --- |
| Bootstrap and main RPC (`preload.cjs`, `main.mjs`, `local-services.mjs`) | Trace the actual Electron import/binding, sync boot request and returned fields, probe/invoke directions, declared argument and reply envelopes, required startup methods and event unsubscribe. The existing registrar uses a minifier-specific spelling. Compare with real project handlers; a declaration or a compatibility no-op is not implemented business behavior. Untrusted frames must not receive a capability. |
| Coordinator (`main.mjs`, `gateway.mjs`) | Trace port transfer and recipient, hello/ready version, request IDs, success/failure, cancel, event families and payloads, close/revocation and reconnect cursor. The project implements version 3, not arbitrary future versions. Confirm the new renderer consumes exactly these contracts or identify typed, project-owned changes; never just answer ready. |
| Host boundary (`connection.mjs`, `streams.mjs`, `host/server/index.mjs`) | Pair only through the selected Host, retain encrypted device credentials, require the same saved origin/tunnel for retry, reject redirects and retain server-side device authorization. Events require HTTP 200 with `text/event-stream`. Verify command result, event delivery and persisted state independently. Stopping a client fetch cannot undo a command already processed by the Host. |
| Native dependencies (`local-exec.mjs`, `browser-providers.mjs`, `sounds.mjs`) | Workspace startup expects version-specific assets and native module contracts. Confirm the actual dependencies and platform availability. Unsupported optional features remain unavailable; no fabricated account/entitlement, permission or executable-integrity adaptation. |

The offline inspector accepts exactly one **already provided** preload and its independently recorded file SHA-256 (from the coordinator's package chain):

```sh
node --expose-internals windows/tools/inspect-desktop-preload.mjs <provided-preload.cjs> <expected-preload-sha256>
node --test windows/tools/inspect-desktop-preload.test.mjs
```

It checks bytes before parsing, uses Node's bundled parser offline and reports selected AST call shapes, literal lifecycle observations and what the old registrar would count. No archive, asset traversal, code evaluation, signature verification or output files. A matching call shape does not prove its receiver is Electron; aliases, wrappers and dynamically constructed channels can be absent from the report. No count or successful tool exit approves migration. Do not use the report as a runtime allowlist.

## Project-side verification

- `mac/clients/desktop/{main,local-services,connection}.mjs`: the probe requires a trusted main frame, a declaration and a callable own handler. A workspace edit and the pairing form now share the same saved-origin/tunnel boundary; a fresh pairing is needed to change it.
- `mac/clients/desktop/{gateway,streams}.mjs`: duplicate active IDs are scoped per port, cancellation aborts only that request, late replies are discarded on teardown, an explicitly incompatible hello closes the port, and a non-SSE response is not reported online. Two distinct regressions were reproduced before the fixes: double dispatch and HTTP 200 HTML accepted as event traffic.
- Targeted verification: six synthetic IPC/transport cases; four pairing cases; one late-event/teardown case; two existing persistence/external-link cases; two offline inspector cases. Node fixtures only, with mocked traffic and temporary synthetic files. No full suites, soak, native app, real Host or package build.

## Release boundary

1. Main supplies verified package provenance, target architecture, signer status, and digest-bound renderer/preload inputs for each platform. No independent acquisition or unpacking in this scope.
2. Establish a vendor-supported external self-host configuration/extension mechanism that leaves the original signed app and its integrity checks intact. The documented Windows packaging path changes the executable; a rebuilt/ad-hoc-signed Mac app is not the original signed distribution. Neither path is native acceptance under this requirement.
3. If the signed app offers no authorized integration point, stop the **official-client** migration. A separately owned first-party client against documented, authenticated Host APIs is a distinct option, not evidence that the official app works. Do not replace auth, signing, entitlements or anti-tamper behavior.
4. Only after coordination: native Windows and native macOS, clean test profiles, verified signatures, authorized test Host, pair/reject/revoke, roster and history, send and receive two turns, reconnect without duplicates, cancel, upload and read back an attachment, restart and read back history. Browser-only or HTTP-only success is insufficient. Main owns release notes, the four suites and any release decision.
