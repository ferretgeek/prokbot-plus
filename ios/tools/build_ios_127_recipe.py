"""Rebuild the iOS 1.27.0 (29519) bytecode resources from the stock bundle.

This is an offline release-engineering helper. It consumes artifacts extracted
from user-supplied app bundles and never embeds those artifacts in the repo. It
replays the pinned 1.26.0 gateway recipe in memory to obtain the verified 1.26.0
patch bodies, ports them semantically onto stock 1.27.0 (remapping strings,
closure targets, environment slots, jump widths, and function metadata), builds
the unpaired bundle, the dynamically-filled gateway template and its metadata,
validates an actual URL/token injection, and optionally writes the three
deterministic byte patches used by the release patcher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from dataclasses import replace
from pathlib import Path
from typing import Mapping


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ios.release import bytepatch  # noqa: E402
from ios.tools.build_ios_126_recipe import (  # noqa: E402
    EMPTY_ARRAY_STUB,
    GATEWAY_BODY_CAPACITY,
    GATEWAY_OPCODE_NAMES,
    RECIPE_NAMES,
    RET_THIS_STUB,
    STUB_NAMES,
    build_gateway_body,
    build_recipes,
    equal_length_cover_body,
    inject_gateway,
    metadata_record,
    require_clean,
    sha256,
    write_artifact,
)
from ios.tools.hbc98.audit import (  # noqa: E402
    _FUNCTION_INDEX_OPERANDS,
    _STRING_INDEX_OPERANDS,
    audit_hbc,
)
from ios.tools.hbc98.model import (  # noqa: E402
    FunctionEdit,
    FunctionMetadata,
    HBCFile,
    NewFunction,
    STRING_SWITCH,
    UINT_SWITCH,
    remap_exception_handlers,
)
from ios.tools.hbc98.opcodes import OPERAND_WIDTHS, OpcodeSet  # noqa: E402
from ios.tools.hbc98.requirements import (  # noqa: E402
    body_requirements,
    effective_header,
    require_metadata,
)
from ios.tools.hbc98.strings import (  # noqa: E402
    _reencode_with_promotions,
    ascii_string_map,
    hbc_strings,
    unique_string,
)


EXPECTED_STOCK_126_SHA256 = (
    '619c8a542355f6ff64695f3c4f2ec7cb4835e8a284040fa423ccda655ffcb08f'
)
EXPECTED_STOCK_127_SHA256 = (
    '6a8a877981bbaa3fc05040f5b5e01781b8f6e07dd1e110d8cca07904d6483498'
)
EXPECTED_UNPAIRED_127_SHA256 = (
    '71908b73b5f4522b8b5d439b446577b969661085eb3877c34a00ccdcab7509d5'
)
EXPECTED_GATEWAY_127_SHA256 = (
    'db2abf3a2a01a437c75a1475b2ba96eb2c12b4fcfa6493cc473115a17660e3d9'
)
NATIVE_PLUGIN_ENTRIES_OFFSET = 31099614

BACKEND_CALL_FUNCTION = 28177
BACKEND_CALL_PUBLIC_FUNCTION = 28179
BACKEND_LOCAL_BYPASS_RPCS = (
    # Connectors / MCP / Marketplace
    'aiserver.v1.DashboardService/ListMarketplacePlugins',
    'aiserver.v1.DashboardService/ListMarketplaces',
    'aiserver.v1.DashboardService/GetEffectiveUserPlugins',
    'aiserver.v1.DashboardService/GetAvailableMcpServers',
    'aiserver.v1.DashboardService/ListSandMcpTools',
    'aiserver.v1.DashboardService/ValidateMcpOAuthTokens',
    'aiserver.v1.DashboardService/InstallUserPlugin',
    'aiserver.v1.DashboardService/UninstallUserPlugin',
    'aiserver.v1.DashboardService/RenameMcpOAuthAccount',
    'aiserver.v1.DashboardService/DeleteMcpOAuthAccount',
    'aiserver.v1.DashboardService/CheckHttpMcpStatus',
    'aiserver.v1.DashboardService/CompleteMcpOAuth',
    # Speech / Voice
    'aiserver.v1.AiService/TranscribeAudio',
    'aiserver.v1.GrokBotService/MintSandVoiceCallSecret',
    # Auto-review local preference overrides (intercepted by GBConnectors.m)
    'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
    'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
    # Native Pages / Canvases (intercepted by GBConnectors.m -> /local/mobile-rpc/*)
    'aiserver.v1.DashboardService/ListUserCanvases',
    'aiserver.v1.DashboardService/GetCanvasMetadata',
    'aiserver.v1.DashboardService/GetCanvasPayload',
    'aiserver.v1.DashboardService/SetCanvasVisibility',
    'aiserver.v1.DashboardService/SetPageAddress',
    'aiserver.v1.DashboardService/GetCanvasShareAccess',
    'aiserver.v1.DashboardService/UpdateCanvasShareAccess',
    'aiserver.v1.DashboardService/RefreshCanvasSources',
)

BUILD_PINNED_GATE_FUNCTION = 19464
PINNED_ENABLED_FEATURE_GATES = (
    # Enable inline native Page preview cards in chat (Statsig is disabled in local mode).
    'cloud_canvas_skill',
    'grok_bot_canvas_skill',
)

STOCK_127_FUNCTION_COUNT = 91316
NEW_FUNCTION_START = STOCK_127_FUNCTION_COUNT
NEW_FUNCTION_COUNT = 6
OLD_NEW_FUNCTION_START = 85263

GATEWAY_SHELL_FUNCTION = 24672
CHAT_AVATAR_FUNCTION = 42779
CHAT_AVATAR_DEFAULT_STATIC_INDEX = 13630
CHAT_AVATAR_LIVE_INDEX = 15025
CHAT_AVATAR_LOAD_OFFSET = 52
NATIVE_PLUGIN_ENTRIES_FUNCTION = 45655
MOBILE_SESSION_CONVERGENCE_FUNCTION = 17786

SKILL_DETAIL_MODULE_FUNCTION = 6697
SKILL_DETAIL_ORIGINAL_FUNCTION = 56088
SKILL_DETAIL_LEGACY_FUNCTION = 52498
REACT_127_MODULE_ID = 50

BUILD_LIVE_FUNCTION = 31201
STAMP_SENDER_FUNCTION = 31207
STAMP_SENDER_DEV_GATEWAY_ENV_SLOT = 60

UNPAIRED_COVERS = {
    17072: bytes.fromhex('96007600'),  # canRecord -> false
    17319: bytes.fromhex('93007600'),  # record -> undefined
    17392: RET_THIS_STUB,              # AppsFlyerService.start -> return this
    19240: bytes.fromhex('93007600'),  # log -> undefined
    19479: bytes.fromhex('95007600'),  # isStatsigDisabled -> true
    19498: bytes.fromhex('96007600'),  # shouldFetch -> false
    19577: bytes.fromhex('96007600'),  # sandStatsigNetworkUrlAllowed -> false
    20937: RET_THIS_STUB,              # BrazeService.start -> return this
    21679: bytes.fromhex('93007600'),  # SandSentry.init -> undefined
}

# BackendAnalyticsSink.send (32 bytes) and BackendLogSink.submit (34 bytes).
UNPAIRED_PROMISE_TRUE = {
    17271: ('send', 32),
    32772: ('submit', 34),
}
UNPAIRED_CACHE_FIXES = frozenset(UNPAIRED_PROMISE_TRUE)
UNPAIRED_ALL_TARGETS = frozenset(UNPAIRED_COVERS) | UNPAIRED_CACHE_FIXES

GATEWAY_EXTRA_COVERS = {
    MOBILE_SESSION_CONVERGENCE_FUNCTION: bytes.fromhex('96007600'),  # false
    24993: bytes.fromhex('93007600'),  # ingestInboundNudge -> undefined
    25038: bytes.fromhex('93007600'),  # tellHost -> undefined
    25043: bytes.fromhex('93007600'),  # startUsageBeat -> undefined
    25045: bytes.fromhex('93007600'),  # startSpokenDrain -> undefined
    44895: bytes.fromhex('94007600'),  # VoiceSettingsGroup -> null
    61964: bytes.fromhex('96007600'),  # isResumptionEnabled -> false
}

# 1.26.0 -> 1.27.0 mapping for the 22 complex/full-replaced functions.
PORTED_FUNCTIONS = {
    23694: 24995,  # harnessFor
    23724: 25026,  # finish
    23734: 25036,  # settleTheRecord
    25140: 26597,  # session
    25141: 26598,  # callTool
    25263: 26719,  # settleAgentSpeech
    25292: 26748,  # openAfterUserFirstGrace
    26512: 28069,  # mintSandVoiceCallSecret
    26615: 28177,  # call
    26617: 28179,  # callPublic
    37398: 39401,  # useResolvedFeatureGate
    42668: 44896,  # VoiceSettingsSelect
    57958: 61963,  # isEnabled
    58682: 62728,  # (voice tool drain helper)
    60516: 64660,  # isVoiceCallEnabled
    63512: 67866,  # resolveLocalTool
    67871: 72314,  # (voice gate helper)
    67872: 72315,  # _t2
    67874: 72317,  # t14
    67875: 72318,  # t17
    68701: 73416,  # _t3
    71503: 76444,  # t20
}

# Complete closure-target remapping from gateway 1.26.0 -> gateway 1.27.0.
CLOSURE_TARGET_MAP = {
    **PORTED_FUNCTIONS,
    58010: 62015,  # ?anon_0_finish
    58681: 62727,  # settleAgentSpeech sibling closure
    59428: 63513,  # ?anon_0_call
    59430: 63515,  # ?anon_0_callPublic
    65551: 69906,  # useResolvedFeatureGate t0
    65552: 69907,  # useResolvedFeatureGate t1
    SKILL_DETAIL_LEGACY_FUNCTION: SKILL_DETAIL_ORIGINAL_FUNCTION,
    **{
        OLD_NEW_FUNCTION_START + offset: NEW_FUNCTION_START + offset
        for offset in range(NEW_FUNCTION_COUNT)
    },
}

# Expected function names for ported targets so mismatches fail fast.
EXPECTED_PORTED_NAMES = {
    24995: 'harnessFor',
    25026: 'finish',
    25036: 'settleTheRecord',
    26597: 'session',
    26598: 'callTool',
    26719: 'settleAgentSpeech',
    26748: 'openAfterUserFirstGrace',
    28069: 'mintSandVoiceCallSecret',
    28177: 'call',
    28179: 'callPublic',
    39401: 'useResolvedFeatureGate',
    44896: 'VoiceSettingsSelect',
    61963: 'isEnabled',
    62728: '',
    64660: 'isVoiceCallEnabled',
    67866: 'resolveLocalTool',
    72314: '',
    72315: '_t2',
    72317: 't14',
    72318: 't17',
    73416: '_t3',
    76444: 't20',
}


def _encode_ins(opcodes: OpcodeSet, name: str, *operands: int) -> bytes:
    op_id = opcodes.ids[name]
    out = bytearray([op_id])
    for val, typ in zip(operands, opcodes.operands(name)):
        if typ in ('Reg8', 'UInt8'):
            out.append(val & 0xFF)
        elif typ == 'Addr8':
            out.extend(struct.pack('<b', val))
        elif typ == 'UInt16':
            out.extend(struct.pack('<H', val))
        elif typ in ('UInt32', 'Reg32'):
            out.extend(struct.pack('<I', val))
        elif typ in ('Addr32', 'Imm32'):
            out.extend(struct.pack('<i', val))
        else:
            raise ValueError(f'Unsupported operand type {typ} for {name}')
    return bytes(out)


def _unique_str_idx(strs, text: str) -> int:
    matches = [item.index for item in strs if item.text == text]
    if len(matches) != 1:
        raise ValueError(f'Expected unique string {text!r}, got {matches}')
    return matches[0]


def _encode_load_const_string(opcodes: OpcodeSet, reg: int, str_id: int) -> bytes:
    if str_id < 65536:
        return _encode_ins(opcodes, 'LoadConstString', reg, str_id)
    return _encode_ins(opcodes, 'LoadConstStringLongIndex', reg, str_id)


def _encode_get_by_id(
    opcodes: OpcodeSet, dst: int, obj: int, cache: int, str_id: int
) -> bytes:
    if str_id < 65536:
        return _encode_ins(opcodes, 'GetById', dst, obj, cache, str_id)
    return _encode_ins(opcodes, 'GetByIdLong', dst, obj, cache, str_id)


def _encode_define_own_by_id(
    opcodes: OpcodeSet, obj: int, val: int, cache: int, str_id: int
) -> bytes:
    if str_id < 65536:
        return _encode_ins(opcodes, 'DefineOwnById', obj, val, cache, str_id)
    return _encode_ins(opcodes, 'DefineOwnByIdLong', obj, val, cache, str_id)


def _string_variant_for_width(name: str, target_index: int, opcodes: OpcodeSet) -> str:
    """Choose the narrowest valid opcode variant for a remapped string index."""

    if name in ('GetByIdShort', 'GetById', 'GetByIdLong'):
        if target_index < 256:
            return 'GetByIdShort'
        if target_index < 65536:
            return 'GetById'
        return 'GetByIdLong'
    if name in ('LoadConstString', 'LoadConstStringLongIndex'):
        return 'LoadConstString' if target_index < 65536 else 'LoadConstStringLongIndex'
    for base in (
        'TryGetById',
        'PutByIdLoose',
        'PutByIdStrict',
        'TryPutByIdLoose',
        'TryPutByIdStrict',
        'DefineOwnById',
    ):
        long_name = base + 'Long'
        if name in (base, long_name):
            return base if target_index < 65536 else long_name
    operand_types = opcodes.operands(name)
    idx_pos = _STRING_INDEX_OPERANDS[name][0]
    width = OPERAND_WIDTHS[operand_types[idx_pos]]
    if target_index < (1 << (width * 8)):
        return name
    for suffix in ('LongIndex', 'Long'):
        candidate = name + suffix
        if candidate in opcodes.ids:
            return candidate
    raise ValueError(f'No wider opcode variant for {name} (string {target_index})')


def _closure_variant_for_width(name: str, target_index: int, opcodes: OpcodeSet) -> str:
    base = name[:-len('LongIndex')] if name.endswith('LongIndex') else name
    long_name = base + 'LongIndex'
    if target_index < 65536 and base in opcodes.ids:
        return base
    if long_name in opcodes.ids:
        return long_name
    raise ValueError(f'No closure opcode variant for {name} (function {target_index})')


def port_function_body(
    source: HBCFile,
    target: HBCFile,
    source_index: int,
    *,
    closure_map: Mapping[int, int],
    source_strings,
    target_strings,
    target_by_text: Mapping[str, int],
    env_slot_remap: Mapping[tuple[int, int], int] | None = None,
    react_require_fix: bool = False,
) -> bytes:
    """Semantically port a patched HBC-98 body from 1.26.0 to 1.27.0.

    Every string operand is remapped by exact text lookup, every closure target
    is remapped through ``closure_map``, opcode widths are adjusted to match the
    new indices, and all relative jump displacements are re-encoded cleanly.
    """

    opcodes = target.opcodes
    header = effective_header(source, source_index)
    body = source.data[header.offset:header.offset + header.bytecode_size]
    instructions = opcodes.decode(body, 0, len(body))

    names = [ins.name for ins in instructions]
    operands = [list(ins.operands) for ins in instructions]

    if any(name in (STRING_SWITCH, UINT_SWITCH) for name in names):
        raise ValueError(f'Function {source_index} contains switch tables')

    for idx_i, ins in enumerate(instructions):
        name = names[idx_i]
        vals = operands[idx_i]

        if name in _STRING_INDEX_OPERANDS:
            for pos in _STRING_INDEX_OPERANDS[name]:
                old_sid = vals[pos]
                if old_sid >= len(source_strings):
                    raise ValueError(
                        f'fn#{source_index} offset {ins.offset}: invalid string {old_sid}'
                    )
                text = source_strings[old_sid].text
                if text not in target_by_text:
                    raise ValueError(
                        f'fn#{source_index} offset {ins.offset}: string {text!r} missing in 1.27.0'
                    )
                new_sid = target_by_text[text]
                new_name = _string_variant_for_width(name, new_sid, opcodes)
                names[idx_i] = new_name
                vals[pos] = new_sid

        elif name in _FUNCTION_INDEX_OPERANDS:
            for pos in _FUNCTION_INDEX_OPERANDS[name]:
                old_fid = vals[pos]
                if old_fid not in closure_map:
                    raise ValueError(
                        f'fn#{source_index} offset {ins.offset}: unmapped closure fn#{old_fid}'
                    )
                new_fid = closure_map[old_fid]
                names[idx_i] = _closure_variant_for_width(name, new_fid, opcodes)
                vals[pos] = new_fid

        elif env_slot_remap and name == 'LoadFromEnvironment':
            env_reg, slot = vals[1], vals[2]
            key = (env_reg, slot)
            if key in env_slot_remap:
                vals[2] = env_slot_remap[key]

    if react_require_fix:
        # In added fn#85263 (SkillDetail publish UI), the legacy 1.16 wrapper
        # loaded React via ``__r(3)``. In 1.27.0 React is module ID 50.
        fixed_react = False
        for idx_i in range(len(instructions) - 2):
            if (
                names[idx_i] in ('GetById', 'GetByIdShort', 'GetByIdLong')
                and target_strings[operands[idx_i][-1]].text == '__r'
                and names[idx_i + 1] == 'LoadConstUInt8'
                and operands[idx_i + 1][1] == 3
                and names[idx_i + 2] == 'Call2'
            ):
                operands[idx_i + 1][1] = REACT_127_MODULE_ID
                fixed_react = True
        if not fixed_react:
            raise ValueError(
                f'fn#{source_index}: expected __r(3) React require call not found'
            )

    reencoded = _reencode_with_promotions(instructions, names, operands, opcodes)
    opcodes.decode(reencoded, 0, len(reencoded))
    return reencoded


def build_promise_true_prefix(stock: HBCFile) -> bytes:
    """Assemble ``return Promise.resolve(true)`` using stock 1.27.0 string IDs."""

    opcodes = stock.opcodes
    strs = hbc_strings(stock)
    promise_id = _unique_str_idx(strs, 'Promise')
    resolve_id = _unique_str_idx(strs, 'resolve')
    if resolve_id >= 256:
        raise ValueError(f'resolve string index {resolve_id} does not fit GetByIdShort')
    prefix = (
        _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_ins(opcodes, 'TryGetById', 2, 1, 0, promise_id)
        + _encode_ins(opcodes, 'GetByIdShort', 1, 2, 1, resolve_id)
        + _encode_ins(opcodes, 'LoadConstTrue', 0)
        + _encode_ins(opcodes, 'Call2', 1, 1, 2, 0)
        + _encode_ins(opcodes, 'Ret', 1)
    )
    if len(prefix) != 22:
        raise AssertionError(f'Unexpected Promise.resolve(true) prefix size: {len(prefix)}')
    return prefix


def promise_true_equal_length_body(stock: HBCFile, index: int, expected_name: str, expected_size: int) -> bytes:
    header = effective_header(stock, index)
    strs = hbc_strings(stock)
    if strs[header.function_name].text != expected_name:
        raise ValueError(
            f'Function {index} is {strs[header.function_name].text!r}, expected {expected_name!r}'
        )
    original = stock.data[header.offset:header.offset + header.bytecode_size]
    if len(original) != expected_size:
        raise ValueError(
            f'Function {index} ({expected_name}) is {len(original)} bytes, expected {expected_size}'
        )
    prefix = build_promise_true_prefix(stock)
    instructions = stock.opcodes.decode(original, 0, len(original))
    boundary = next(
        (ins.offset for ins in instructions if ins.offset >= len(prefix)),
        len(original),
    )
    body = prefix + b'\x00' * (boundary - len(prefix)) + original[boundary:]
    if len(body) != len(original):
        raise AssertionError(f'Promise stub changed function {index} length')
    stock.opcodes.decode(body, 0, len(body))
    return body


def enable_chat_avatar_motion(stock: HBCFile, body: bytes) -> bytes:
    """Change only ChatAvatar's default motion value from static to live."""

    footer_start = len(stock.data) - 20
    if CHAT_AVATAR_FUNCTION >= len(stock.function_headers):
        raise ValueError('ChatAvatar function is outside the stock table')
    header = effective_header(stock, CHAT_AVATAR_FUNCTION)
    if header.offset < stock.body_start or header.offset + header.bytecode_size > footer_start:
        raise ValueError('ChatAvatar body is outside the stock bytecode')
    if len(body) != header.bytecode_size:
        raise ValueError('ChatAvatar patch changed the function size')

    strings = hbc_strings(stock)
    name = strings[header.function_name].text
    if name != 'ChatAvatar':
        raise ValueError(
            f'Function {CHAT_AVATAR_FUNCTION} is {name!r}, expected ChatAvatar'
        )
    if strings[CHAT_AVATAR_DEFAULT_STATIC_INDEX].text != 'static':
        raise ValueError('ChatAvatar default static string index moved')
    if strings[CHAT_AVATAR_LIVE_INDEX].text != 'live':
        raise ValueError('ChatAvatar live string index moved')

    instructions = stock.opcodes.decode(body, 0, len(body))
    matches = [
        ins for ins in instructions
        if ins.name == 'LoadConstString'
        and ins.offset == CHAT_AVATAR_LOAD_OFFSET
        and ins.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
    ]
    if len(matches) != 1:
        raise ValueError('ChatAvatar default static branch is not unique')
    if sum(
        ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and ins.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
        for ins in instructions
    ) != 1:
        raise ValueError('ChatAvatar references static more than once')
    operand_types = stock.opcodes.operands(matches[0].name)
    encoded = matches[0].offset + 1 + sum(
        OPERAND_WIDTHS[item] for item in operand_types[:-1]
    )
    width = OPERAND_WIDTHS[operand_types[-1]]
    if CHAT_AVATAR_LIVE_INDEX >= 1 << (width * 8):
        raise ValueError('ChatAvatar live string index does not fit its operand')
    output = bytearray(body)
    output[encoded:encoded + width] = CHAT_AVATAR_LIVE_INDEX.to_bytes(width, 'little')
    patched = bytes(output)
    stock.opcodes.decode(patched, 0, len(patched))
    return patched


def assert_chat_avatar_motion(file: HBCFile, label: str) -> None:
    """Verify the generated bundle exposes live as ChatAvatar's default."""

    header = effective_header(file, CHAT_AVATAR_FUNCTION)
    strings = hbc_strings(file)
    if strings[header.function_name].text != 'ChatAvatar':
        raise AssertionError(f'{label} changed the ChatAvatar function identity')
    instructions = file.opcodes.decode(
        file.data[header.offset:header.offset + header.bytecode_size],
        0,
        header.bytecode_size,
    )
    defaults = [
        ins for ins in instructions
        if ins.name == 'LoadConstString' and ins.offset == CHAT_AVATAR_LOAD_OFFSET
    ]
    if len(defaults) != 1 or defaults[0].operands[-1] != CHAT_AVATAR_LIVE_INDEX:
        raise AssertionError(f'{label} does not default ChatAvatar to live')
    if any(
        ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and ins.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
        for ins in instructions
    ):
        raise AssertionError(f'{label} still references static in ChatAvatar')


def assert_native_plugin_entries_hidden(file: HBCFile, label: str) -> None:
    """Verify useNativePluginEntries returns [] to hide official native entries."""

    header = effective_header(file, NATIVE_PLUGIN_ENTRIES_FUNCTION)
    strings = hbc_strings(file)
    if strings[header.function_name].text != 'useNativePluginEntries':
        raise AssertionError(
            f'{label} changed the useNativePluginEntries function identity'
        )
    body = file.data[header.offset:header.offset + header.bytecode_size]
    instructions = file.opcodes.decode(body, 0, len(body))
    if (
        len(instructions) < 2
        or instructions[0].name != 'NewArray'
        or instructions[0].operands != (0, 0)
        or instructions[1].name != 'Ret'
        or instructions[1].operands != (0,)
    ):
        raise AssertionError(
            f'{label} does not return [] from useNativePluginEntries'
        )


def build_unpaired(stock: HBCFile) -> tuple[bytes, dict[str, object]]:
    """Build the equal-size unpaired bundle used before Host pairing."""

    if len(stock.function_headers) != STOCK_127_FUNCTION_COUNT:
        raise ValueError(
            f'Expected stock function count {STOCK_127_FUNCTION_COUNT}, '
            f'found {len(stock.function_headers)}'
        )

    replacements: dict[int, FunctionEdit] = {}
    records: list[dict[str, object]] = []
    for index, stub in UNPAIRED_COVERS.items():
        body, boundary = equal_length_cover_body(stock, index, stub)
        header = effective_header(stock, index)
        metadata = FunctionMetadata.from_header(header)
        requirements = body_requirements(stock.opcodes, body)
        require_metadata(requirements, metadata, label=f'unpaired cover {index}')
        replacements[index] = FunctionEdit(body=body)
        records.append(
            {
                'function': index,
                'action': f'cover-{STUB_NAMES[stub]}',
                'boundary': boundary,
                'bodyBytes': len(body),
                'bodySha256': sha256(body),
                'requirements': requirements.as_dict(),
            }
        )

    avatar_header = effective_header(stock, CHAT_AVATAR_FUNCTION)
    avatar_original = stock.data[
        avatar_header.offset:avatar_header.offset + avatar_header.bytecode_size
    ]
    replacements[CHAT_AVATAR_FUNCTION] = FunctionEdit(
        body=enable_chat_avatar_motion(stock, avatar_original)
    )
    records.append(
        {
            'function': CHAT_AVATAR_FUNCTION,
            'action': 'chat-avatar-motion-live',
            'bodyBytes': avatar_header.bytecode_size,
        }
    )

    for index, (expected_name, expected_size) in UNPAIRED_PROMISE_TRUE.items():
        header = effective_header(stock, index)
        body = promise_true_equal_length_body(stock, index, expected_name, expected_size)
        metadata = replace(
            FunctionMetadata.from_header(header),
            read_cache_size=max(header.read_cache_size, 2),
        )
        requirements = body_requirements(stock.opcodes, body)
        require_metadata(requirements, metadata, label=f'unpaired Promise stub {index}')
        replacements[index] = FunctionEdit(body=body, metadata=metadata)
        records.append(
            {
                'function': index,
                'action': 'promise-resolve-true',
                'bodyBytes': len(body),
                'bodySha256': sha256(body),
                'requirements': requirements.as_dict(),
                'metadata': metadata_record(metadata),
            }
        )

    output = stock.write(replacements=replacements)
    target = HBCFile.parse(output, strict=True)
    if len(output) != len(stock.data):
        raise AssertionError('Unpaired bundle changed the stock file size')
    if len(target.function_headers) != len(stock.function_headers):
        raise AssertionError('Unpaired bundle changed the function count')
    require_clean(target, 'Generated 1.27.0 unpaired bundle')
    assert_chat_avatar_motion(target, 'Generated 1.27.0 unpaired bundle')

    for index in range(len(stock.function_headers)):
        before_h = effective_header(stock, index)
        after_h = effective_header(target, index)
        if (before_h.offset, before_h.bytecode_size) != (after_h.offset, after_h.bytecode_size):
            raise AssertionError(f'Function {index} body offset or size changed')

    changed_bodies: set[int] = set()
    target_groups = {group.offset: group for group in target.body_groups}
    for group in stock.body_groups:
        other = target_groups[group.offset]
        if group.bytes != other.bytes:
            changed_bodies.update(group.function_indexes)
    expected_changed = set(UNPAIRED_ALL_TARGETS) | {CHAT_AVATAR_FUNCTION}
    if changed_bodies != expected_changed:
        raise AssertionError(
            f'Unexpected unpaired function bodies changed: {sorted(changed_bodies)}'
        )
    if target.sections['string_storage'].data != stock.sections['string_storage'].data:
        raise AssertionError('Unpaired bundle unexpectedly changed string storage')
    footer = len(target.data) - 20
    if hashlib.sha1(target.data[:footer]).digest() != target.data[footer:]:
        raise AssertionError('Unpaired footer SHA-1 is incorrect')

    summary = {
        'bytes': len(output),
        'sha256': sha256(output),
        'functions': len(target.function_headers),
        'changedBodies': sorted(changed_bodies),
        'chatAvatarMotion': 'live',
        'readCacheMetadataFixes': sorted(UNPAIRED_CACHE_FIXES),
        'stringStorageChanged': False,
        'records': records,
    }
    return output, summary


def build_backend_call_bypass_body(
    stock: HBCFile,
    fn_idx: int,
    strs,
    target_by_text: Mapping[str, int],
) -> bytes:
    """Build BackendClient.call / callPublic with local-intercepted RPC bypasses.

    In dev-gateway mode ``auth.validAccessToken()`` returns ``undefined`` because
    there is no Cursor cloud OAuth session. RPCs intercepted locally by
    ``GBConnectors.m`` / ``GBSpeech.m`` / ``GBVoice.m`` must skip the cloud token
    lookup and call ``this.post(path, body, undefined, options)`` directly so
    their HTTPS POST reaches ``NSURLProtocol``.
    """

    opcodes = stock.opcodes
    eh = effective_header(stock, fn_idx)
    stock_body = stock.data[eh.offset:eh.offset + eh.bytecode_size]
    if len(stock_body) != 32:
        raise ValueError(
            f'BackendClient fn#{fn_idx} stock body is {len(stock_body)} bytes, expected 32'
        )
    # Confirm stock_body decodes cleanly as the standard async wrapper.
    opcodes.decode(stock_body, 0, len(stock_body))

    post_id = _unique_str_idx(strs, 'post')
    apply_id = _unique_str_idx(strs, 'apply')
    apply_ins = (
        _encode_ins(opcodes, 'GetByIdShort', 7, 2, 1, apply_id)
        if apply_id < 256
        else _encode_get_by_id(opcodes, 7, 2, 1, apply_id)
    )
    bypass_tail = (
        _encode_ins(opcodes, 'LoadParam', 1, 0)
        + _encode_get_by_id(opcodes, 2, 1, 0, post_id)
        + _encode_ins(opcodes, 'LoadParam', 3, 2)
        + _encode_ins(opcodes, 'LoadConstUndefined', 4)
        + _encode_ins(opcodes, 'LoadParam', 5, 3)
        + _encode_ins(opcodes, 'NewArray', 6, 4)
        + _encode_ins(opcodes, 'DefineOwnByIndex', 6, 0, 0)
        + _encode_ins(opcodes, 'DefineOwnByIndex', 6, 3, 1)
        + _encode_ins(opcodes, 'DefineOwnByIndex', 6, 4, 2)
        + _encode_ins(opcodes, 'DefineOwnByIndex', 6, 5, 3)
        + apply_ins
        + _encode_ins(opcodes, 'Call3', 8, 7, 2, 1, 6)
        + _encode_ins(opcodes, 'Ret', 8)
    )

    prefix_load = _encode_ins(opcodes, 'LoadParam', 0, 1)
    load_chunks: list[bytes] = []
    for rpc_path in BACKEND_LOCAL_BYPASS_RPCS:
        sid = target_by_text.get(rpc_path)
        if sid is None:
            raise ValueError(f'Missing RPC path string in 1.27.0 HBC: {rpc_path!r}')
        load_chunks.append(_encode_load_const_string(opcodes, 1, sid))

    jump_len = 7  # JStrictEqualLong: op(1) + Addr32(4) + Reg8(1) + Reg8(1)
    checks_len = sum(len(chunk) + jump_len for chunk in load_chunks)
    bypass_offset = len(prefix_load) + checks_len + len(stock_body)

    out = bytearray(prefix_load)
    for chunk in load_chunks:
        out.extend(chunk)
        jump_offset = len(out)
        out.extend(_encode_ins(opcodes, 'JStrictEqualLong', bypass_offset - jump_offset, 0, 1))
    out.extend(stock_body)
    if len(out) != bypass_offset:
        raise AssertionError('BackendClient bypass offset mismatch')
    out.extend(bypass_tail)
    body = bytes(out)
    opcodes.decode(body, 0, len(body))
    return body


def assert_backend_local_bypass(file: HBCFile, label: str) -> None:
    """Verify BackendClient.call and callPublic bypass every local-intercepted RPC."""

    strs = hbc_strings(file)
    expected = set(BACKEND_LOCAL_BYPASS_RPCS)
    for fn_idx in (BACKEND_CALL_FUNCTION, BACKEND_CALL_PUBLIC_FUNCTION):
        eh = effective_header(file, fn_idx)
        body = file.data[eh.offset:eh.offset + eh.bytecode_size]
        insns = file.opcodes.decode(body, 0, len(body))
        matched = {
            strs[ins.operands[1]].text
            for ins in insns
            if ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
            and strs[ins.operands[1]].text in expected
        }
        missing = sorted(expected - matched)
        if missing:
            raise AssertionError(
                f'{label}: fn#{fn_idx} missing local RPC bypasses: {missing}'
            )


def build_pinned_feature_gates_body(
    stock: HBCFile,
    fn_idx: int,
    strs,
    target_by_text: Mapping[str, int],
) -> bytes:
    """Prepend locally pinned feature gates to ``buildPinnedGate``.

    Because local/self-hosted builds disable Statsig (``isStatsigDisabled -> true``),
    every ``useFeatureGate`` / ``useFeatureGateWhen`` / ``resolveFeatureGate`` call
    falls back to ``GENERATED_FLAG_DEFAULTS``. Pinning selected gates in
    ``buildPinnedGate`` cleanly enables them across all gate hooks before falling
    through to the stock ``multiAccount`` check.

    Register note: stock ``buildPinnedGate`` has ``non_pointer_reg_count == 1``
    (``r0`` holds non-pointers such as booleans/undefined; ``r1+`` hold pointers).
    Keep string values in ``r2``/``r3`` and only write ``true`` into ``r0``.
    """

    opcodes = stock.opcodes
    eh = effective_header(stock, fn_idx)
    if strs[eh.function_name].text != 'buildPinnedGate':
        raise ValueError(
            f'Function {fn_idx} is {strs[eh.function_name].text!r}, expected buildPinnedGate'
        )
    if eh.non_pointer_reg_count != 1 or eh.frame_size < 4:
        raise ValueError(
            f'buildPinnedGate fn#{fn_idx} register layout changed: '
            f'non_pointer={eh.non_pointer_reg_count}, frame_size={eh.frame_size}'
        )
    stock_body = stock.data[eh.offset:eh.offset + eh.bytecode_size]
    if len(stock_body) != 61:
        raise ValueError(
            f'buildPinnedGate fn#{fn_idx} stock body is {len(stock_body)} bytes, expected 61'
        )
    stock_insns = opcodes.decode(stock_body, 0, len(stock_body))
    if not stock_insns or stock_insns[0].name != 'GetParentEnvironment':
        raise ValueError(f'buildPinnedGate fn#{fn_idx} prologue moved')

    prefix_load = _encode_ins(opcodes, 'LoadParam', 2, 1)
    load_chunks: list[bytes] = []
    for gate_name in PINNED_ENABLED_FEATURE_GATES:
        sid = target_by_text.get(gate_name)
        if sid is None:
            raise ValueError(f'Missing feature gate string in 1.27.0 HBC: {gate_name!r}')
        load_chunks.append(_encode_load_const_string(opcodes, 3, sid))

    jump_len = 7  # JStrictEqualLong: op(1) + Addr32(4) + Reg8(1) + Reg8(1)
    ret_true = _encode_ins(opcodes, 'LoadConstTrue', 0) + _encode_ins(opcodes, 'Ret', 0)
    skip_ret = _encode_ins(opcodes, 'Jmp', 2 + len(ret_true))
    if len(skip_ret) != 2 or len(ret_true) != 4:
        raise AssertionError('Unexpected buildPinnedGate return stub size')

    checks_len = sum(len(chunk) + jump_len for chunk in load_chunks)
    ret_true_offset = len(prefix_load) + checks_len + len(skip_ret)

    out = bytearray(prefix_load)
    for chunk in load_chunks:
        out.extend(chunk)
        jump_offset = len(out)
        out.extend(_encode_ins(opcodes, 'JStrictEqualLong', ret_true_offset - jump_offset, 2, 3))
    out.extend(skip_ret)
    if len(out) != ret_true_offset:
        raise AssertionError('buildPinnedGate return-true offset mismatch')
    out.extend(ret_true)
    out.extend(stock_body)
    body = bytes(out)
    opcodes.decode(body, 0, len(body))
    return body


def assert_pinned_feature_gates(file: HBCFile, label: str) -> None:
    """Verify buildPinnedGate pins every locally enabled feature gate to true."""

    strs = hbc_strings(file)
    eh = effective_header(file, BUILD_PINNED_GATE_FUNCTION)
    if strs[eh.function_name].text != 'buildPinnedGate':
        raise AssertionError(
            f'{label}: fn#{BUILD_PINNED_GATE_FUNCTION} is not buildPinnedGate'
        )
    body = file.data[eh.offset:eh.offset + eh.bytecode_size]
    insns = file.opcodes.decode(body, 0, len(body))
    by_offset = {ins.offset: ins for ins in insns}
    if not insns or insns[0].name != 'LoadParam' or insns[0].operands != (2, 1):
        raise AssertionError(
            f'{label}: buildPinnedGate does not load gate name into r2'
        )
    matched: set[str] = set()
    for idx_i in range(len(insns) - 1):
        cur, nxt = insns[idx_i], insns[idx_i + 1]
        if (
            cur.name in ('LoadConstString', 'LoadConstStringLongIndex')
            and cur.operands[0] == 3
            and nxt.name == 'JStrictEqualLong'
            and nxt.operands[1:] == (2, 3)
        ):
            target_off = nxt.offset + nxt.operands[0]
            ret_load = by_offset.get(target_off)
            ret_ins = by_offset.get(target_off + 2)
            if (
                ret_load is not None
                and ret_load.name == 'LoadConstTrue'
                and ret_load.operands == (0,)
                and ret_ins is not None
                and ret_ins.name == 'Ret'
                and ret_ins.operands == (0,)
            ):
                matched.add(strs[cur.operands[1]].text)
    missing = sorted(set(PINNED_ENABLED_FEATURE_GATES) - matched)
    if missing:
        raise AssertionError(
            f'{label}: buildPinnedGate missing pinned feature gates: {missing}'
        )


def _assert_build_live_env_slot(stock: HBCFile, strs) -> None:
    """Confirm buildLive still loads DevGatewayOverride from parent env slot 60."""

    eh = effective_header(stock, BUILD_LIVE_FUNCTION)
    if strs[eh.function_name].text != 'buildLive':
        raise ValueError(f'Function {BUILD_LIVE_FUNCTION} is not buildLive')
    insns = stock.opcodes.decode(
        stock.data[eh.offset:eh.offset + eh.bytecode_size], 0, eh.bytecode_size
    )
    dev_gw_id = _unique_str_idx(strs, 'DevGatewayOverride')
    for idx_i in range(len(insns) - 1):
        cur, nxt = insns[idx_i], insns[idx_i + 1]
        if (
            cur.name == 'LoadFromEnvironment'
            and cur.operands[2] == STAMP_SENDER_DEV_GATEWAY_ENV_SLOT
            and nxt.name in ('GetById', 'GetByIdLong')
            and nxt.operands[-1] == dev_gw_id
        ):
            return
    raise ValueError(
        f'buildLive fn#{BUILD_LIVE_FUNCTION} no longer loads DevGatewayOverride '
        f'from env slot {STAMP_SENDER_DEV_GATEWAY_ENV_SLOT}'
    )


def build_gateway(
    stock: HBCFile,
    gateway_126: HBCFile,
) -> tuple[bytes, dict[str, object]]:
    """Build the full 1.27.0 gateway-template.hbc from stock 1.27.0 + gateway 1.26.0."""

    opcodes = stock.opcodes
    strs = hbc_strings(stock)
    strs_126 = hbc_strings(gateway_126)
    target_by_text: dict[str, int] = {}
    for entry in strs:
        target_by_text.setdefault(entry.text, entry.index)

    replacements: dict[int, FunctionEdit] = {}

    # 1. Equal-length return covers (unpaired + gateway-only telemetry/voice/auth hooks).
    for idx, stub in {**UNPAIRED_COVERS, **GATEWAY_EXTRA_COVERS}.items():
        body, _ = equal_length_cover_body(stock, idx, stub)
        replacements[idx] = FunctionEdit(body=body)

    # 2. Telemetry sinks -> Promise.resolve(true).
    for idx, (expected_name, expected_size) in UNPAIRED_PROMISE_TRUE.items():
        eh = effective_header(stock, idx)
        body = promise_true_equal_length_body(stock, idx, expected_name, expected_size)
        meta = replace(
            FunctionMetadata.from_header(eh),
            read_cache_size=max(eh.read_cache_size, 2),
        )
        require_metadata(body_requirements(opcodes, body), meta, label=f'promise-true fn#{idx}')
        replacements[idx] = FunctionEdit(body=body, metadata=meta)

    # 3. ChatAvatar default motion -> 'live'.
    avatar_h = effective_header(stock, CHAT_AVATAR_FUNCTION)
    avatar_orig = stock.data[avatar_h.offset:avatar_h.offset + avatar_h.bytecode_size]
    replacements[CHAT_AVATAR_FUNCTION] = FunctionEdit(
        body=enable_chat_avatar_motion(stock, avatar_orig)
    )

    # 4. useNativePluginEntries -> return [] (hide built-in official native entries).
    h_native = effective_header(stock, NATIVE_PLUGIN_ENTRIES_FUNCTION)
    if strs[h_native.function_name].text != 'useNativePluginEntries':
        raise ValueError(
            f'Function {NATIVE_PLUGIN_ENTRIES_FUNCTION} is '
            f'{strs[h_native.function_name].text!r}, expected useNativePluginEntries'
        )
    body_native, boundary_native = equal_length_cover_body(
        stock, NATIVE_PLUGIN_ENTRIES_FUNCTION, EMPTY_ARRAY_STUB
    )
    if boundary_native != 7:
        raise ValueError(f'useNativePluginEntries boundary is {boundary_native}, expected 7')
    replacements[NATIVE_PLUGIN_ENTRIES_FUNCTION] = FunctionEdit(body=body_native)

    # 5. Gateway shell (DevGatewayOverride.read): 24600-byte full-header capacity.
    sh_gw = effective_header(stock, GATEWAY_SHELL_FUNCTION)
    if strs[sh_gw.function_name].text != 'read' or sh_gw.bytecode_size != 4:
        raise ValueError(f'Gateway shell fn#{GATEWAY_SHELL_FUNCTION} anchor moved')
    shell_stub = bytes.fromhex('93007600')  # LoadConstUndefined 0; Ret 0
    shell_body = shell_stub + b'\x00' * (GATEWAY_BODY_CAPACITY - len(shell_stub))
    opcodes.decode(shell_body, 0, len(shell_body))
    shell_meta = replace(
        FunctionMetadata.from_header(sh_gw),
        frame_size=max(sh_gw.frame_size, 3),
        read_cache_size=0,
        write_cache_size=max(sh_gw.write_cache_size, 2),
    )
    replacements[GATEWAY_SHELL_FUNCTION] = FunctionEdit(
        body=shell_body, metadata=shell_meta
    )

    # 6. TranscriptionService timeout 90000 -> 125000 (fn#3171 offset 510).
    h3171 = effective_header(stock, 3171)
    b3171 = bytearray(stock.data[h3171.offset:h3171.offset + h3171.bytecode_size])
    if b3171[510:516] != _encode_ins(opcodes, 'LoadConstInt', 0, 90000):
        raise ValueError('TranscriptionService fn#3171 LoadConstInt 90000 anchor moved')
    b3171[510:516] = _encode_ins(opcodes, 'LoadConstInt', 0, 125000)
    opcodes.decode(bytes(b3171), 0, len(b3171))
    replacements[3171] = FunctionEdit(body=bytes(b3171))

    # 7. stampSender (fn#31207): if (DevGatewayOverride.read() !== undefined) return undefined;
    _assert_build_live_env_slot(stock, strs)
    sh_stamp = effective_header(stock, STAMP_SENDER_FUNCTION)
    if strs[sh_stamp.function_name].text != 'stampSender':
        raise ValueError(f'Function {STAMP_SENDER_FUNCTION} is not stampSender')
    sorig = stock.data[sh_stamp.offset:sh_stamp.offset + sh_stamp.bytecode_size]
    ret_undef = _encode_ins(opcodes, 'Ret', 1)
    j_skip = _encode_ins(opcodes, 'JStrictEqual', 4 + len(ret_undef), 0, 1)
    prefix_stamp = (
        _encode_ins(opcodes, 'GetParentEnvironment', 0, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 0, 0, STAMP_SENDER_DEV_GATEWAY_ENV_SLOT)
        + _encode_get_by_id(opcodes, 1, 0, 0, _unique_str_idx(strs, 'DevGatewayOverride'))
        + _encode_get_by_id(opcodes, 0, 1, 1, _unique_str_idx(strs, 'read'))
        + _encode_ins(opcodes, 'Call1', 0, 0, 1)
        + _encode_ins(opcodes, 'LoadConstUndefined', 1)
        + j_skip
        + ret_undef
    )
    body_stamp = prefix_stamp + sorig
    opcodes.decode(body_stamp, 0, len(body_stamp))
    req_stamp = body_requirements(opcodes, body_stamp)
    meta_stamp = replace(
        FunctionMetadata.from_header(sh_stamp),
        frame_size=max(sh_stamp.frame_size, req_stamp.frame_size, 14),
        read_cache_size=max(sh_stamp.read_cache_size, req_stamp.read_cache_entries, 2),
    )
    require_metadata(req_stamp, meta_stamp, label='stampSender fn#31207')
    replacements[STAMP_SENDER_FUNCTION] = FunctionEdit(body=body_stamp, metadata=meta_stamp)

    # 8. ownerRoute (fn#31096): route devGateway sessions to { kind: 'current' }.
    oh = effective_header(stock, 31096)
    if strs[oh.function_name].text != 'ownerRoute':
        raise ValueError('Function 31096 is not ownerRoute')
    oorig = stock.data[oh.offset:oh.offset + oh.bytecode_size]
    tail_ret_current = (
        _encode_ins(opcodes, 'NewObject', 0)
        + _encode_load_const_string(opcodes, 1, _unique_str_idx(strs, 'current'))
        + _encode_define_own_by_id(opcodes, 0, 1, 0, _unique_str_idx(strs, 'kind'))
        + _encode_ins(opcodes, 'Ret', 0)
    )
    j2 = _encode_ins(opcodes, 'JStrictNotEqual', 4 + len(tail_ret_current), 1, 2)
    check_dev_gw = (
        _encode_get_by_id(opcodes, 1, 0, 4, _unique_str_idx(strs, 'session'))
        + _encode_load_const_string(opcodes, 2, _unique_str_idx(strs, 'devGateway'))
        + j2
        + tail_ret_current
    )
    j1 = _encode_ins(opcodes, 'JStrictNotEqual', 4 + len(check_dev_gw), 1, 2)
    prefix_owner = (
        _encode_ins(opcodes, 'LoadParam', 0, 0)
        + _encode_get_by_id(opcodes, 0, 0, 0, _unique_str_idx(strs, 'auth'))
        + _encode_get_by_id(opcodes, 0, 0, 1, _unique_str_idx(strs, 'state'))
        + _encode_get_by_id(opcodes, 0, 0, 2, _unique_str_idx(strs, 'current'))
        + _encode_get_by_id(opcodes, 1, 0, 3, _unique_str_idx(strs, 'phase'))
        + _encode_load_const_string(opcodes, 2, _unique_str_idx(strs, 'loggedIn'))
        + j1
        + check_dev_gw
    )
    body_owner = prefix_owner + oorig
    opcodes.decode(body_owner, 0, len(body_owner))
    req_owner = body_requirements(opcodes, body_owner)
    meta_owner = replace(
        FunctionMetadata.from_header(oh),
        frame_size=max(oh.frame_size, req_owner.frame_size),
        read_cache_size=max(oh.read_cache_size, req_owner.read_cache_entries),
        write_cache_size=max(oh.write_cache_size, req_owner.write_cache_entries, 1),
    )
    require_metadata(req_owner, meta_owner, label='ownerRoute fn#31096')
    replacements[31096] = FunctionEdit(body=body_owner, metadata=meta_owner)

    # 9. routedLane (fn#35351): 4-byte in-place jump patch preserving stock StringSwitchImm.
    rh = effective_header(stock, 35351)
    if strs[rh.function_name].text != 'routedLane':
        raise ValueError('Function 35351 is not routedLane')
    rorig = bytearray(stock.data[rh.offset:rh.offset + rh.bytecode_size])
    rinsns = opcodes.decode(bytes(rorig), 0, len(rorig))
    if not (rinsns[5].offset == 26 and rinsns[5].name == 'JStrictEqualLong' and rinsns[5].operands == (130, 2, 1)):
        raise ValueError('routedLane fn#35351 anchor moved')
    if not (rinsns[9].offset == 44 and rinsns[9].name == 'LoadConstString' and rinsns[9].operands == (1, _unique_str_idx(strs, 'gateway'))):
        raise ValueError('routedLane fn#35351 gateway branch moved')
    rorig[26:33] = _encode_ins(opcodes, 'JStrictEqualLong', 18, 2, 1)
    opcodes.decode(bytes(rorig), 0, len(rorig))
    replacements[35351] = FunctionEdit(body=bytes(rorig))

    # 10. gatewayPorts (fn#35345): 1-byte in-place env slot fix (CreateClosureLongIndex env 1 -> 2).
    gh = effective_header(stock, 35345)
    if strs[gh.function_name].text != 'gatewayPorts':
        raise ValueError('Function 35345 is not gatewayPorts')
    gorig = bytearray(stock.data[gh.offset:gh.offset + gh.bytecode_size])
    ginsns = opcodes.decode(bytes(gorig), 0, len(gorig))
    ins_res = next(item for item in ginsns if item.offset == 133)
    if not (ins_res.name == 'CreateClosureLongIndex' and ins_res.operands == (3, 1, 67866)):
        raise ValueError('gatewayPorts fn#35345 CreateClosureLongIndex anchor moved')
    gorig[133:140] = _encode_ins(opcodes, 'CreateClosureLongIndex', 3, 2, 67866)
    opcodes.decode(bytes(gorig), 0, len(gorig))
    replacements[35345] = FunctionEdit(body=bytes(gorig))

    # 11. StorageService initializer (fn#13553): expose globalThis['grokbot.voice.storage'] = this.
    sth = effective_header(stock, 13553)
    if strs[sth.function_name].text != '<instance_members_initializer:StorageService>':
        raise ValueError('Function 13553 is not StorageService initializer')
    storig = stock.data[sth.offset:sth.offset + sth.bytecode_size]
    if storig[-4:] != _encode_ins(opcodes, 'LoadConstUndefined', 0) + _encode_ins(opcodes, 'Ret', 0):
        raise ValueError('StorageService fn#13553 epilogue moved')
    suffix_storage = (
        _encode_ins(opcodes, 'GetGlobalObject', 0)
        + _encode_load_const_string(opcodes, 1, _unique_str_idx(strs, 'grokbot'))
        + _encode_load_const_string(opcodes, 3, _unique_str_idx(strs, '.'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_load_const_string(opcodes, 3, _unique_str_idx(strs, 'voice'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_load_const_string(opcodes, 3, _unique_str_idx(strs, '.'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_load_const_string(opcodes, 3, _unique_str_idx(strs, 'storage'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_ins(opcodes, 'PutByValStrict', 0, 1, 2)
    )
    body_storage = storig[:-4] + suffix_storage + storig[-4:]
    opcodes.decode(body_storage, 0, len(body_storage))
    req_storage = body_requirements(opcodes, body_storage)
    meta_storage = replace(
        FunctionMetadata.from_header(sth),
        frame_size=max(sth.frame_size, req_storage.frame_size),
    )
    require_metadata(req_storage, meta_storage, label='StorageService fn#13553')
    replacements[13553] = FunctionEdit(body=body_storage, metadata=meta_storage)

    # 12. Group/identity gateway writes (fn#83670, fn#83673, fn#83674).
    # Stock fn#83670 has frame_size=21 and ends with ``CallBuiltin 0, 44, 2`` using
    # r12 == frame_size - 9, so frame_size MUST remain 21. Move r11 -> r7 (r7 is
    # dead after reading .gateway and overwritten by Call3's dst) so every Call3
    # source operand stays strictly below 21 - (7 + 3) == 11.
    h_grp = effective_header(stock, 83670)
    if strs[h_grp.function_name].text != '?anon_0_setGroupMembers':
        raise ValueError('Function 83670 is not ?anon_0_setGroupMembers')
    b_grp = bytearray(stock.data[h_grp.offset:h_grp.offset + h_grp.bytecode_size])
    patch_grp = (
        _encode_get_by_id(opcodes, 9, 7, 1, _unique_str_idx(strs, 'gateway'))
        + _encode_get_by_id(opcodes, 8, 9, 2, _unique_str_idx(strs, 'setGroupMembers'))
        + _encode_ins(opcodes, 'Mov', 7, 11)
        + _encode_ins(opcodes, 'Call3', 7, 8, 9, 7, 10)
        + _encode_ins(opcodes, 'LoadConstUndefined', 12) * 7
    )
    if len(patch_grp) != 268 - 233:
        raise AssertionError('Unexpected setGroupMembers patch length')
    b_grp[233:268] = patch_grp
    opcodes.decode(bytes(b_grp), 0, len(b_grp))
    replacements[83670] = FunctionEdit(body=bytes(b_grp))

    h_rid = effective_header(stock, 83674)
    if strs[h_rid.function_name].text != '?anon_0_readServerIdentity':
        raise ValueError('Function 83674 is not ?anon_0_readServerIdentity')
    b_rid = bytearray(stock.data[h_rid.offset:h_rid.offset + h_rid.bytecode_size])
    p1_rid = _encode_ins(opcodes, 'Mov', 7, 0) + _encode_ins(opcodes, 'Mov', 8, 8)
    p2_rid = (
        _encode_ins(opcodes, 'LoadConstUndefined', 9) * 3
        + _encode_get_by_id(opcodes, 8, 7, 10, _unique_str_idx(strs, 'gateway'))
        + _encode_get_by_id(opcodes, 7, 8, 11, _unique_str_idx(strs, 'listAgents'))
        + _encode_ins(opcodes, 'Call2', 7, 7, 8, 9)
    )
    if len(p1_rid) != 82 - 76 or len(p2_rid) != 397 - 374:
        raise AssertionError('Unexpected readServerIdentity patch length')
    b_rid[76:82] = p1_rid
    b_rid[374:397] = p2_rid
    opcodes.decode(bytes(b_rid), 0, len(b_rid))
    replacements[83674] = FunctionEdit(body=bytes(b_rid))

    h_aid = effective_header(stock, 83673)
    if strs[h_aid.function_name].text != '?anon_0_applyIdentityWrite':
        raise ValueError('Function 83673 is not ?anon_0_applyIdentityWrite')
    b_aid = bytearray(stock.data[h_aid.offset:h_aid.offset + h_aid.bytecode_size])
    p1_aid = _encode_ins(opcodes, 'LoadConstUndefined', 7) + _encode_ins(opcodes, 'Mov', 8, 8)
    p2_core = (
        _encode_ins(opcodes, 'LoadFromEnvironment', 9, 1, 7)
        + _encode_get_by_id(opcodes, 9, 9, 10, _unique_str_idx(strs, 'gateway'))
        + _encode_load_const_string(opcodes, 13, _unique_str_idx(strs, 'updateAgent'))
        + _encode_ins(opcodes, 'GetByVal', 8, 9, 13)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 7, 10, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 12, 10, 5)
        + _encode_ins(opcodes, 'Call3', 8, 8, 9, 7, 12)
    )
    rem = (728 - 621) - len(p2_core)
    if len(p1_aid) != 239 - 234 or rem < 3 or rem % 2 != 1:
        raise AssertionError('Unexpected applyIdentityWrite patch length')
    p2_aid = p2_core + _encode_ins(opcodes, 'Mov', 13, 13) + _encode_ins(opcodes, 'LoadConstUndefined', 13) * ((rem - 3) // 2)
    b_aid[234:239] = p1_aid
    b_aid[621:728] = p2_aid
    opcodes.decode(bytes(b_aid), 0, len(b_aid))
    replacements[83673] = FunctionEdit(body=bytes(b_aid))

    # 13. Voice call mint context & toolbar/session in-place patches.
    h_sc = effective_header(stock, 81654)
    if strs[h_sc.function_name].text != '?anon_2_startCall':
        raise ValueError('Function 81654 is not ?anon_2_startCall')
    b_sc = bytearray(stock.data[h_sc.offset:h_sc.offset + h_sc.bytecode_size])
    if b_sc[2031:2033] != _encode_ins(opcodes, 'NewObject', 24):
        raise ValueError('startCall fn#81654 NewObject 24 anchor moved')
    b_sc[2031:2033] = _encode_ins(opcodes, 'LoadConstUndefined', 37)
    opcodes.decode(bytes(b_sc), 0, len(b_sc))
    replacements[81654] = FunctionEdit(body=bytes(b_sc))

    h_rd = effective_header(stock, 81660)
    if strs[h_rd.function_name].text != '?anon_0_redialTheSameCall':
        raise ValueError('Function 81660 is not ?anon_0_redialTheSameCall')
    b_rd = bytearray(stock.data[h_rd.offset:h_rd.offset + h_rd.bytecode_size])
    if b_rd[1110:1112] != _encode_ins(opcodes, 'NewObject', 16):
        raise ValueError('redialTheSameCall fn#81660 NewObject 16 anchor moved')
    b_rd[1110:1112] = _encode_ins(opcodes, 'LoadConstUndefined', 8)
    opcodes.decode(bytes(b_rd), 0, len(b_rd))
    replacements[81660] = FunctionEdit(body=bytes(b_rd))

    h_ct = effective_header(stock, 44878)
    if strs[h_ct.function_name].text != 'CallToolbar':
        raise ValueError('Function 44878 is not CallToolbar')
    b_ct = bytearray(stock.data[h_ct.offset:h_ct.offset + h_ct.bytecode_size])
    if b_ct[48:54] != _encode_get_by_id(opcodes, 18, 2, 5, _unique_str_idx(strs, 'onToggleSettings')):
        raise ValueError('CallToolbar fn#44878 anchor moved')
    b_ct[48:54] = _encode_ins(opcodes, 'LoadConstUndefined', 18) * 3
    opcodes.decode(bytes(b_ct), 0, len(b_ct))
    replacements[44878] = FunctionEdit(body=bytes(b_ct))

    h_ic = effective_header(stock, 39397)
    if strs[h_ic.function_name].text != 'IslandControls':
        raise ValueError('Function 39397 is not IslandControls')
    b_ic = bytearray(stock.data[h_ic.offset:h_ic.offset + h_ic.bytecode_size])
    if b_ic[42:48] != _encode_get_by_id(opcodes, 17, 3, 4, _unique_str_idx(strs, 'onOpenSettings')):
        raise ValueError('IslandControls fn#39397 anchor moved')
    b_ic[42:48] = _encode_ins(opcodes, 'LoadConstUndefined', 17) * 3
    opcodes.decode(bytes(b_ic), 0, len(b_ic))
    replacements[39397] = FunctionEdit(body=bytes(b_ic))

    h_xai = effective_header(stock, 26708)
    if strs[h_xai.function_name].text != 'XaiRealtimeSession':
        raise ValueError('Function 26708 is not XaiRealtimeSession')
    b_xai = bytearray(stock.data[h_xai.offset:h_xai.offset + h_xai.bytecode_size])
    if b_xai[577:582] != _encode_ins(opcodes, 'Call2', 9, 11, 12, 9):
        raise ValueError('XaiRealtimeSession fn#26708 anchor moved')
    b_xai[577:582] = _encode_ins(opcodes, 'LoadConstTrue', 9) + _encode_ins(opcodes, 'Mov', 9, 9)
    opcodes.decode(bytes(b_xai), 0, len(b_xai))
    replacements[26708] = FunctionEdit(body=bytes(b_xai))

    # 14. SkillDetail module (fn#6697) -> wrap SkillDetail with added fn#91316.
    h_skm = effective_header(stock, SKILL_DETAIL_MODULE_FUNCTION)
    b_skm = stock.data[h_skm.offset:h_skm.offset + h_skm.bytecode_size]
    if b_skm[12:17] != _encode_ins(opcodes, 'CreateClosure', 4, 2, SKILL_DETAIL_ORIGINAL_FUNCTION):
        raise ValueError('SkillDetail module fn#6697 CreateClosure anchor moved')
    body_skm = (
        b_skm[:12]
        + _encode_ins(opcodes, 'CreateClosureLongIndex', 4, 2, NEW_FUNCTION_START)
        + b_skm[17:]
    )
    opcodes.decode(body_skm, 0, len(body_skm))
    replacements[SKILL_DETAIL_MODULE_FUNCTION] = FunctionEdit(body=body_skm)

    # 14b. buildPinnedGate (fn#19464): pin inline Canvas/Pages preview gates to true.
    h_pin = effective_header(stock, BUILD_PINNED_GATE_FUNCTION)
    body_pin = build_pinned_feature_gates_body(
        stock, BUILD_PINNED_GATE_FUNCTION, strs, target_by_text
    )
    req_pin = body_requirements(opcodes, body_pin)
    meta_pin = FunctionMetadata.from_header(h_pin)
    require_metadata(req_pin, meta_pin, label=f'buildPinnedGate fn#{BUILD_PINNED_GATE_FUNCTION}')
    replacements[BUILD_PINNED_GATE_FUNCTION] = FunctionEdit(body=body_pin, metadata=meta_pin)

    # 15. Semantically port the 22 complex functions from verified gateway 1.26.0.
    ported_records: list[dict[str, object]] = []
    for src_idx, dst_idx in PORTED_FUNCTIONS.items():
        dst_h = effective_header(stock, dst_idx)
        dst_name = strs[dst_h.function_name].text
        if dst_name != EXPECTED_PORTED_NAMES[dst_idx]:
            raise ValueError(
                f'Target fn#{dst_idx} is {dst_name!r}, expected {EXPECTED_PORTED_NAMES[dst_idx]!r}'
            )
        src_h = effective_header(gateway_126, src_idx)
        if dst_idx in (BACKEND_CALL_FUNCTION, BACKEND_CALL_PUBLIC_FUNCTION):
            body = build_backend_call_bypass_body(stock, dst_idx, strs, target_by_text)
        else:
            body = port_function_body(
                gateway_126,
                stock,
                src_idx,
                closure_map=CLOSURE_TARGET_MAP,
                source_strings=strs_126,
                target_strings=strs,
                target_by_text=target_by_text,
            )
        req = body_requirements(opcodes, body)
        meta = replace(
            FunctionMetadata.from_header(dst_h),
            frame_size=max(dst_h.frame_size, src_h.frame_size, req.frame_size),
            read_cache_size=max(dst_h.read_cache_size, src_h.read_cache_size, req.read_cache_entries),
            write_cache_size=max(dst_h.write_cache_size, src_h.write_cache_size, req.write_cache_entries),
            private_name_cache_size=max(
                dst_h.private_name_cache_size,
                src_h.private_name_cache_size,
                req.private_name_cache_entries,
            ),
            num_cache_new_object=max(
                dst_h.num_cache_new_object,
                src_h.num_cache_new_object,
                req.num_cache_new_object,
            ),
        )
        require_metadata(req, meta, label=f'ported fn#{src_idx}->{dst_idx}')
        replacements[dst_idx] = FunctionEdit(
            body=body,
            metadata=meta,
            exception_handlers=(),
            debug_offset=None,
            replace_exception_handlers=True,
            replace_debug_offset=True,
        )
        ported_records.append(
            {
                'from126': src_idx,
                'to127': dst_idx,
                'name': dst_name,
                'sourceBytes': dst_h.bytecode_size,
                'targetBytes': len(body),
                'bodySha256': sha256(body),
            }
        )

    # 16. Semantically port the 6 added SkillDetail publication functions (91316..91321).
    global_name_id = _unique_str_idx(strs, 'global')
    additions: list[NewFunction] = []
    for offset in range(NEW_FUNCTION_COUNT):
        src_idx = OLD_NEW_FUNCTION_START + offset
        dst_idx = NEW_FUNCTION_START + offset
        src_h = effective_header(gateway_126, src_idx)
        # fn#6697 (SkillDetail module in 1.27.0) shifted InsetGroup* from slot 6 -> 12
        # and jsx/jsxs/Fragment from slot 9 -> 18; React is module ID 50.
        env_remap = {(1, 6): 12, (1, 9): 18} if offset == 0 else None
        body = port_function_body(
            gateway_126,
            stock,
            src_idx,
            closure_map=CLOSURE_TARGET_MAP,
            source_strings=strs_126,
            target_strings=strs,
            target_by_text=target_by_text,
            env_slot_remap=env_remap,
            react_require_fix=(offset == 0),
        )
        req = body_requirements(opcodes, body)
        meta = replace(
            FunctionMetadata.from_header(src_h),
            function_name=global_name_id,
            frame_size=max(src_h.frame_size, req.frame_size),
            read_cache_size=max(src_h.read_cache_size, req.read_cache_entries),
            write_cache_size=max(src_h.write_cache_size, req.write_cache_entries),
        )
        require_metadata(req, meta, label=f'added fn#{dst_idx}')
        additions.append(NewFunction(body=body, metadata=meta))

    output = stock.write(replacements=replacements, additions=additions)
    target = HBCFile.parse(output, strict=True)
    if len(target.function_headers) != STOCK_127_FUNCTION_COUNT + NEW_FUNCTION_COUNT:
        raise AssertionError('Generated 1.27.0 function count is incorrect')
    require_clean(target, 'Generated 1.27.0 gateway template')
    assert_chat_avatar_motion(target, 'Generated 1.27.0 gateway template')
    assert_native_plugin_entries_hidden(target, 'Generated 1.27.0 gateway template')
    assert_backend_local_bypass(target, 'Generated 1.27.0 gateway template')
    assert_pinned_feature_gates(target, 'Generated 1.27.0 gateway template')
    structural_audit = audit_hbc(target)
    structural_audit.require_ok('Generated 1.27.0 gateway template')

    summary = {
        'bytes': len(output),
        'sha256': sha256(output),
        'functions': len(target.function_headers),
        'functionInfos': len(target.function_infos),
        'existingEdits': len(replacements),
        'addedFunctions': len(additions),
        'chatAvatarMotion': 'live',
        'nativePluginEntriesHidden': NATIVE_PLUGIN_ENTRIES_FUNCTION,
        'mobileSessionConvergenceBypass': MOBILE_SESSION_CONVERGENCE_FUNCTION,
        'pinnedEnabledFeatureGates': list(PINNED_ENABLED_FEATURE_GATES),
        'portedFunctions': ported_records,
        'structuralAudit': structural_audit.as_dict(),
    }
    return output, summary


def build_gateway_metadata(
    stock: HBCFile,
    gateway: HBCFile,
    gateway_bytes: bytes,
) -> tuple[dict[str, object], bytes]:
    """Build the metadata consumed by ``GBHermes.m`` for URL/token injection."""

    if len(gateway.function_headers) != STOCK_127_FUNCTION_COUNT + NEW_FUNCTION_COUNT:
        raise ValueError('Gateway function count does not match the 1.27.0 recipe')

    small = gateway.function_headers[GATEWAY_SHELL_FUNCTION]
    if not small.overflowed or small.full_header_offset is None:
        raise ValueError(
            f'Gateway shell function {GATEWAY_SHELL_FUNCTION} must use a full header'
        )
    shell = effective_header(gateway, GATEWAY_SHELL_FUNCTION)
    if shell.bytecode_size != GATEWAY_BODY_CAPACITY:
        raise ValueError(
            f'Gateway shell capacity is {shell.bytecode_size}, expected {GATEWAY_BODY_CAPACITY}'
        )

    strings = ascii_string_map(gateway)
    expected_ascii = {chr(code) for code in range(33, 127)}
    if set(strings) != expected_ascii:
        raise ValueError('Gateway ASCII string map is incomplete')

    empty = unique_string(gateway, '')
    url = unique_string(gateway, 'url')
    token = unique_string(gateway, 'token')
    opcodes = {name: gateway.opcodes.ids[name] for name in GATEWAY_OPCODE_NAMES}
    body_length_offset = small.full_header_offset + 12
    if shell.offset + GATEWAY_BODY_CAPACITY > len(gateway_bytes) - 20:
        raise ValueError('Gateway shell body extends into the footer')
    if body_length_offset + 4 >= len(gateway_bytes) - 20:
        raise ValueError('Gateway shell length field extends into the footer')

    metadata: dict[str, object] = {
        'schema': 'grokbot-native-hermes/v1',
        'originalSha256': sha256(stock.data),
        'templateSha256': sha256(gateway_bytes),
        'bodyOffset': shell.offset,
        'bodyCapacity': GATEWAY_BODY_CAPACITY,
        'bodyLengthOffset': body_length_offset,
        'strings': {str(ord(ch)): index for ch, index in strings.items()},
        'emptyString': empty.index,
        'urlKey': url.index,
        'tokenKey': token.index,
        'opcodes': opcodes,
        'maxUrlLength': 2048,
        'maxTokenLength': 1024,
    }
    metadata_bytes = (json.dumps(metadata, indent=2) + '\n').encode('utf-8')
    return metadata, metadata_bytes


def validate_injected_gateway(
    template: bytes,
    metadata: dict[str, object],
) -> dict[str, object]:
    injected, body = inject_gateway(
        template,
        metadata,
        'https://host.example',
        'pair-0123456789-ABCDEFG',
    )
    parsed = HBCFile.parse(injected, strict=True)
    require_clean(parsed, 'Injected 1.27.0 gateway bundle')
    shell = parsed.function_headers[GATEWAY_SHELL_FUNCTION]
    if not shell.overflowed or shell.full_header_offset is None:
        raise AssertionError('Injected shell function lost its full header')
    header = effective_header(parsed, GATEWAY_SHELL_FUNCTION)
    offset = int(metadata['bodyOffset'])
    capacity = int(metadata['bodyCapacity'])
    length_offset = int(metadata['bodyLengthOffset'])
    if injected[offset:offset + len(body)] != body:
        raise AssertionError('Injected gateway body does not match the simulator')
    if header.bytecode_size != len(body):
        raise AssertionError(
            f'Injected gateway header length is {header.bytecode_size}, expected {len(body)}'
        )
    if struct.unpack_from('<I', injected, length_offset)[0] != len(body):
        raise AssertionError('Injected gateway length field does not match the body')
    if any(injected[offset + len(body):offset + capacity]):
        raise AssertionError('Injected gateway capacity was not zero-filled')
    if hashlib.sha1(injected[:-20]).digest() != injected[-20:]:
        raise AssertionError('Injected gateway footer SHA-1 is incorrect')
    audit = audit_hbc(parsed)
    audit.require_ok('Injected 1.27.0 gateway bundle')
    return {
        'url': 'https://host.example',
        'token': 'pair-0123456789-ABCDEFG',
        'bodyBytes': len(body),
        'headerBytes': header.bytecode_size,
        'bodyOffset': offset,
        'bodyLengthOffset': length_offset,
        'footerSha1': injected[-20:].hex(),
        'metadataAuditMismatches': 0,
        'structuralAudit': audit.as_dict(),
    }


def _default_recipe_126() -> Path:
    archived = REPO_ROOT / 'ios/recipes/ios/1.26.0/gateway-template.hbc.gbp.gz'
    if archived.is_file():
        return archived
    return REPO_ROOT / 'ios/recipes/ios/gateway-template.hbc.gbp.gz'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock-127', required=True, type=Path)
    parser.add_argument('--stock-126', required=True, type=Path)
    parser.add_argument('--recipe-126', type=Path, default=_default_recipe_126())
    parser.add_argument('--output-unpaired', type=Path)
    parser.add_argument('--output-gateway', type=Path)
    parser.add_argument('--output-metadata', type=Path)
    parser.add_argument('--recipes-dir', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()

    if not any((args.output_unpaired, args.output_gateway, args.output_metadata, args.recipes_dir)):
        parser.error('Choose at least one output artifact')

    stock_127 = HBCFile.from_path(args.stock_127, strict=True)
    if sha256(stock_127.data) != EXPECTED_STOCK_127_SHA256:
        raise ValueError('Stock 1.27.0 HBC SHA-256 does not match the pinned 1.27.0 (29519) bundle')
    if len(stock_127.function_headers) != STOCK_127_FUNCTION_COUNT:
        raise ValueError(
            f'Expected 1.27.0 stock function count {STOCK_127_FUNCTION_COUNT}, '
            f'found {len(stock_127.function_headers)}'
        )

    stock_126_bytes = args.stock_126.read_bytes()
    if sha256(stock_126_bytes) != EXPECTED_STOCK_126_SHA256:
        raise ValueError('Stock 1.26.0 HBC SHA-256 does not match the pinned 1.26.0 (29388) bundle')
    gateway_126_bytes = bytepatch.apply(stock_126_bytes, bytepatch.load(args.recipe_126))
    gateway_126 = HBCFile.parse(gateway_126_bytes, strict=True)

    unpaired, unpaired_summary = build_unpaired(stock_127)
    if sha256(unpaired) != EXPECTED_UNPAIRED_127_SHA256:
        raise ValueError(
            'Unpaired 1.27.0 bundle SHA-256 does not match the verified pin: '
            f'got {sha256(unpaired)}, expected {EXPECTED_UNPAIRED_127_SHA256}'
        )
    gateway, gateway_summary = build_gateway(stock_127, gateway_126)
    if sha256(gateway) != EXPECTED_GATEWAY_127_SHA256:
        raise ValueError(
            'Gateway template 1.27.0 SHA-256 does not match the verified pin: '
            f'got {sha256(gateway)}, expected {EXPECTED_GATEWAY_127_SHA256}'
        )
    gateway_file = HBCFile.parse(gateway, strict=True)
    metadata, metadata_bytes = build_gateway_metadata(stock_127, gateway_file, gateway)
    injection = validate_injected_gateway(gateway, metadata)

    if args.output_unpaired:
        write_artifact(args.output_unpaired, unpaired, overwrite=args.overwrite)
    if args.output_gateway:
        write_artifact(args.output_gateway, gateway, overwrite=args.overwrite)
    if args.output_metadata:
        write_artifact(args.output_metadata, metadata_bytes, overwrite=args.overwrite)

    recipes = {}
    if args.recipes_dir:
        recipes = build_recipes(
            stock_127.data,
            {
                'unpaired': unpaired,
                'gateway': gateway,
                'metadata': metadata_bytes,
            },
            args.recipes_dir,
            overwrite=args.overwrite,
        )

    summary = {
        'stock': {
            'bytes': len(stock_127.data),
            'sha256': sha256(stock_127.data),
            'functions': len(stock_127.function_headers),
        },
        'unpaired': unpaired_summary,
        'gateway': gateway_summary,
        'metadata': {
            'bytes': len(metadata_bytes),
            'sha256': sha256(metadata_bytes),
            'templateSha256': metadata['templateSha256'],
            'bodyOffset': metadata['bodyOffset'],
            'bodyCapacity': metadata['bodyCapacity'],
            'bodyLengthOffset': metadata['bodyLengthOffset'],
            'stringCount': len(metadata['strings']),
        },
        'injection': injection,
        'recipes': recipes,
    }
    if args.report:
        write_artifact(
            args.report,
            (json.dumps(summary, indent=2) + '\n').encode('utf-8'),
            overwrite=args.overwrite,
        )
    compact = {
        'stockSha256': summary['stock']['sha256'],
        'unpairedSha256': unpaired_summary['sha256'],
        'gatewaySha256': gateway_summary['sha256'],
        'metadataSha256': summary['metadata']['sha256'],
        'injectionBodyBytes': injection['bodyBytes'],
        'recipes': recipes,
    }
    print(json.dumps(compact, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
