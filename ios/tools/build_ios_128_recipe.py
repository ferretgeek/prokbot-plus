"""Rebuild the iOS 1.28.0 (29649) bytecode resources from the stock bundle.

This is an offline release-engineering helper. It consumes artifacts extracted
from user-supplied app bundles and never embeds those artifacts in the repo. It
replays the pinned 1.27.0 gateway recipe in memory to obtain the verified 1.27.0
patch bodies, ports them semantically onto stock 1.28.0 (remapping strings,
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
from ios.tools.build_ios_127_recipe import (  # noqa: E402
    BACKEND_LOCAL_BYPASS_RPCS,
    PINNED_ENABLED_FEATURE_GATES,
    _closure_variant_for_width,
    _encode_define_own_by_id,
    _encode_get_by_id,
    _encode_ins,
    _encode_load_const_string,
    _string_variant_for_width,
    _unique_str_idx,
    build_promise_true_prefix,
    promise_true_equal_length_body,
)
from ios.tools.hbc98.audit import (  # noqa: E402
    CALLER_EXTRA_REGISTERS_AT_END,
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


EXPECTED_STOCK_127_SHA256 = (
    '6a8a877981bbaa3fc05040f5b5e01781b8f6e07dd1e110d8cca07904d6483498'
)
EXPECTED_STOCK_128_SHA256 = (
    'd5e2377bd8e6d072b1d006f785f32d1c2b8f990b8fcdc155361dbc90dff05d9f'
)
EXPECTED_UNPAIRED_128_SHA256 = (
    'd6728b6ae7be0170b6d856c5c5a7586d90f7c0dac51f24f5d27d75a22cfc79ea'
)
EXPECTED_GATEWAY_128_SHA256 = (
    '8780a5983fbaaadc73006776a7274d381e34f7eac22e15f67678720d9d0219c9'
)
NATIVE_PLUGIN_ENTRIES_OFFSET = 35475316

# Hermes FunctionHeaderFlag: ProhibitInvoke=ProhibitConstruct(0x01) | StrictMode(0x04).
# ProhibitInvoke=0x00 is ProhibitCall (class constructor) and throws TypeError on Call*.
CALLABLE_ARROW_FLAGS = 0x05
# Minimum frame_size for synthesized Realtime Voice helper closures so all
# Call1..Call4 instructions keep their source registers strictly below
# frame_size - (CallerExtraRegistersAtEnd + argCount).
VOICE_HELPER_MIN_FRAME_SIZE = 24

BACKEND_CALL_FUNCTION = 32902
BACKEND_CALL_PUBLIC_FUNCTION = 32904
BACKEND_LOCAL_BYPASS_RPCS_128 = BACKEND_LOCAL_BYPASS_RPCS

BUILD_PINNED_GATE_FUNCTION = 27266

STOCK_128_FUNCTION_COUNT = 94838
NEW_FUNCTION_START = STOCK_128_FUNCTION_COUNT
SKILL_DETAIL_ADDED_COUNT = 6
SKILL_DETAIL_JSON_HELPER_FUNCTION = NEW_FUNCTION_START + 3
VOICE_TOGGLE_GROUP_FUNCTION = NEW_FUNCTION_START + SKILL_DETAIL_ADDED_COUNT
VOICE_SNAPSHOT_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 1
VOICE_STORAGE_SPEC_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 2
VOICE_DISPOSE_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 3
VOICE_TOGGLE_CHANGE_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 4
VOICE_SUBSCRIBE_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 5
VOICE_SCHEMA_PARSE_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 6
VOICE_CALL_SUB_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 7
VOICE_APPLY_STATUS_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 8
VOICE_CATCH_STATUS_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 9
VOICE_SYNC_STATUS_FUNCTION = VOICE_TOGGLE_GROUP_FUNCTION + 10
VOICE_ADDED_COUNT = 11
NEW_FUNCTION_COUNT = SKILL_DETAIL_ADDED_COUNT + VOICE_ADDED_COUNT
OLD_NEW_FUNCTION_START = 91316

SETTINGS_SHEET_MODULE_FUNCTION = 6665
SETTINGS_TRY_ON_SELFIE_ENV_SLOT = 39
VOICE_TOGGLE_127_SOURCE_FUNCTION = 44896
VOICE_STORAGE_SPEC_127_SOURCE_FUNCTION = 72315
VOICE_SCHEMA_PARSE_127_SOURCE_FUNCTION = 76444

GATEWAY_SHELL_FUNCTION = 26756
CHAT_AVATAR_FUNCTION = 43388
CHAT_AVATAR_DEFAULT_STATIC_INDEX = 13623
CHAT_AVATAR_LIVE_INDEX = 12891
CHAT_AVATAR_LOAD_OFFSET = 52
NATIVE_PLUGIN_ENTRIES_FUNCTION = 56807
MOBILE_SESSION_CONVERGENCE_FUNCTION = 18148

SKILL_DETAIL_MODULE_FUNCTION = 6901
SKILL_DETAIL_ORIGINAL_FUNCTION = 57638
SKILL_DETAIL_127_FUNCTION = 56088
REACT_128_MODULE_ID = 50

BUILD_LIVE_FUNCTION = 31104
STAMP_SENDER_FUNCTION = 31111
STAMP_SENDER_DEV_GATEWAY_ENV_SLOT = 62

UNPAIRED_COVERS = {
    17359: bytes.fromhex('96007600'),  # canRecord -> false
    17649: bytes.fromhex('93007600'),  # record -> undefined
    17742: RET_THIS_STUB,              # AppsFlyerService.start -> return this
    27041: bytes.fromhex('93007600'),  # log -> undefined
    27281: bytes.fromhex('95007600'),  # isStatsigDisabled -> true
    27300: bytes.fromhex('96007600'),  # shouldFetch -> false
    27374: bytes.fromhex('96007600'),  # sandStatsigNetworkUrlAllowed -> false
    28560: RET_THIS_STUB,              # BrazeService.start -> return this
    23768: bytes.fromhex('93007600'),  # SandSentry.init -> undefined
}

# BackendAnalyticsSink.send (32 bytes) and BackendLogSink.submit (34 bytes).
UNPAIRED_PROMISE_TRUE = {
    17600: ('send', 32),
    36371: ('submit', 34),
}
UNPAIRED_CACHE_FIXES = frozenset(UNPAIRED_PROMISE_TRUE)
UNPAIRED_ALL_TARGETS = frozenset(UNPAIRED_COVERS) | UNPAIRED_CACHE_FIXES

GATEWAY_EXTRA_COVERS = {
    MOBILE_SESSION_CONVERGENCE_FUNCTION: bytes.fromhex('96007600'),  # false
    29405: bytes.fromhex('93007600'),  # ingestInboundNudge -> undefined
    29453: bytes.fromhex('93007600'),  # tellHost -> undefined
    29458: bytes.fromhex('93007600'),  # startUsageBeat -> undefined
    29460: bytes.fromhex('93007600'),  # startSpokenDrain -> undefined
    45620: bytes.fromhex('94007600'),  # VoiceSettingsGroup -> null
    65106: bytes.fromhex('96007600'),  # isResumptionEnabled -> false
}

# 1.27.0 -> 1.28.0 mapping for the ported complex functions.
# Note: 1.27.0 fn#44896 (Realtime voice toggle row) is ported as added
# VOICE_TOGGLE_GROUP_FUNCTION (mounted in SettingsSheet's module fn#6665) rather
# than overwriting VoiceSettingsSelect (fn#45621), which is unused in 1.28.0.
PORTED_FUNCTIONS = {
    24995: 29407,  # harnessFor
    25026: 29439,  # finish
    25036: 29451,  # settleTheRecord
    26597: 30716,  # session
    26598: 30717,  # callTool
    26719: 30877,  # settleAgentSpeech
    26748: 30906,  # openAfterUserFirstGrace
    28069: 32793,  # mintSandVoiceCallSecret
    28177: 32902,  # call
    28179: 32904,  # callPublic
    39401: 40201,  # useResolvedFeatureGate
    61963: 65105,  # isEnabled
    62728: 65721,  # (voice tool drain helper)
    64660: 65908,  # isVoiceCallEnabled
    67866: 64181,  # resolveLocalTool
}

# Complete closure-target remapping from gateway 1.27.0 -> gateway 1.28.0.
# All Realtime Voice closures are appended as NewFunction entries rather than
# overwriting stock 1.28.0 closures (75297 is AgentPickerRow._t3 and 78752 is
# ConnectorGrantCard.t20 in stock 1.28.0).
CLOSURE_TARGET_MAP = {
    **PORTED_FUNCTIONS,
    72314: VOICE_SNAPSHOT_FUNCTION,
    VOICE_STORAGE_SPEC_127_SOURCE_FUNCTION: VOICE_STORAGE_SPEC_FUNCTION,
    72317: VOICE_DISPOSE_FUNCTION,
    72318: VOICE_TOGGLE_CHANGE_FUNCTION,
    73416: VOICE_SUBSCRIBE_FUNCTION,
    VOICE_SCHEMA_PARSE_127_SOURCE_FUNCTION: VOICE_SCHEMA_PARSE_FUNCTION,
    62015: 65170,  # ?anon_0_finish
    62727: 65720,  # settleAgentSpeech sibling closure
    63513: 68304,  # ?anon_0_call
    63515: 68306,  # ?anon_0_callPublic
    69906: 71603,  # useResolvedFeatureGate t0
    69907: 71604,  # useResolvedFeatureGate t1
    SKILL_DETAIL_127_FUNCTION: SKILL_DETAIL_ORIGINAL_FUNCTION,
    **{
        OLD_NEW_FUNCTION_START + offset: NEW_FUNCTION_START + offset
        for offset in range(SKILL_DETAIL_ADDED_COUNT)
    },
}

# Expected function names for ported targets so mismatches fail fast.
EXPECTED_PORTED_NAMES = {
    29407: 'harnessFor',
    29439: 'finish',
    29451: 'settleTheRecord',
    30716: 'session',
    30717: 'callTool',
    30877: 'settleAgentSpeech',
    30906: 'openAfterUserFirstGrace',
    32793: 'mintSandVoiceCallSecret',
    32902: 'call',
    32904: 'callPublic',
    40201: 'useResolvedFeatureGate',
    65105: 'isEnabled',
    65721: '',
    65908: 'isVoiceCallEnabled',
    64181: 'resolveLocalTool',
}

_VOICE_STORAGE_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'storage')
_VOICE_SERVICE_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'service')
_VOICE_HOST_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'host')
_VOICE_SUBS_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'subs')
_VOICE_SEQ_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'seq')
_VOICE_PENDING_KEY_PARTS = ('grokbot', '.', 'voice', '.', 'pending')
_VOICE_LOCAL_PREF_KEY_PARTS = ('grokbot', '.', 'local', '.', 'voice', '.', 'enabled')
_VOICE_STATUS_URL_PARTS = (
    'https://', 'local', '.', 'voice', '/', 'local', '/', 'voice', '/', 'status'
)
_SETTINGS_VOICE_ENV_REMAP = {
    (0, 13): 14,  # useStoredValue
    (0, 2): 1,    # useLingui
    (0, 19): 20,  # InsetGroup / InsetGroupToggleRow
    (0, 37): 44,  # jsx
}


def _encode_concat_strings(
    opcodes: OpcodeSet,
    strs,
    dst_reg: int,
    tmp_reg: int,
    parts: tuple[str, ...],
) -> bytes:
    if not parts:
        raise ValueError('parts must not be empty')
    out = bytearray(
        _encode_load_const_string(opcodes, dst_reg, _unique_str_idx(strs, parts[0]))
    )
    for part in parts[1:]:
        out.extend(
            _encode_load_const_string(opcodes, tmp_reg, _unique_str_idx(strs, part))
        )
        out.extend(_encode_ins(opcodes, 'Add', dst_reg, dst_reg, tmp_reg))
    return bytes(out)


def _jmp_over(
    opcodes: OpcodeSet,
    jmp_name: str,
    skipped_block: bytes,
    *reg_operands: int,
) -> bytes:
    disp = opcodes.instruction_size(jmp_name) + len(skipped_block)
    return _encode_ins(opcodes, jmp_name, disp, *reg_operands) + skipped_block


def build_realtime_voice_bodies(
    opcodes: OpcodeSet,
    strs,
) -> tuple[dict[int, bytes], dict[int, tuple[int, bytes]]]:
    """Build 1.28.0 Host-synced realtime voice gate bodies and added helpers.

    Returns ``(replaced_bodies, added_specs)`` where ``added_specs`` maps new
    function index -> ``(param_count, body)``.
    """

    object_sid = _unique_str_idx(strs, 'Object')
    if object_sid > 0xFFFF:
        raise ValueError(f'Object string ID {object_sid} exceeds UInt16 TryGetById')

    # 94851: callVoiceSub(cb) -> if (cb) cb();
    invoke_cb = (
        _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Call1', 0, 1, 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )
    body_call_sub = (
        _encode_ins(opcodes, 'LoadParam', 1, 1)
        + _jmp_over(opcodes, 'JmpFalseLong', invoke_cb, 1)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # 94852: applyHostVoiceStatus(data) -> updates globalThis['grokbot.voice.host']
    # and notifies subscribers via Object.values(subs).forEach(callVoiceSub).
    read_enabled = (
        _encode_get_by_id(opcodes, 7, 6, 0, _unique_str_idx(strs, 'enabled'))
        + _encode_ins(opcodes, 'LoadConstTrue', 8)
        + _encode_ins(opcodes, 'StrictEq', 5, 7, 8)
    )
    notify_subs_call = (
        _encode_ins(opcodes, 'TryGetById', 7, 1, 1, object_sid)
        + _encode_get_by_id(opcodes, 8, 7, 2, _unique_str_idx(strs, 'values'))
        + _encode_ins(opcodes, 'Call2', 6, 8, 7, 6)
        + _encode_get_by_id(opcodes, 8, 6, 3, _unique_str_idx(strs, 'forEach'))
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'CreateClosureLongIndex', 9, 0, VOICE_CALL_SUB_FUNCTION)
        + _encode_ins(opcodes, 'Call2', 6, 8, 6, 9)
    )
    notify_if_changed = (
        _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_SUBS_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 6, 1, 2)
        + _jmp_over(opcodes, 'JmpFalseLong', notify_subs_call, 6)
    )
    body_apply_status = (
        _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_PENDING_KEY_PARTS)
        + _encode_ins(opcodes, 'LoadConstFalse', 4)
        + _encode_ins(opcodes, 'PutByValStrict', 1, 2, 4)
        + _encode_ins(opcodes, 'LoadConstFalse', 5)
        + _encode_ins(opcodes, 'LoadParam', 6, 1)
        + _jmp_over(opcodes, 'JmpFalseLong', read_enabled, 6)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_HOST_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 6, 1, 2)
        + _encode_ins(opcodes, 'PutByValStrict', 1, 2, 5)
        + _jmp_over(opcodes, 'JStrictEqualLong', notify_if_changed, 6, 5)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # 94853: catchHostVoiceStatus() -> applyHostVoiceStatus(undefined)
    body_catch_status = (
        _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'CreateClosureLongIndex', 1, 0, VOICE_APPLY_STATUS_FUNCTION)
        + _encode_ins(opcodes, 'Call2', 0, 1, 0, 0)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # 94854: syncHostVoiceStatus() -> coalesced fetch('https://local.voice/local/voice/status')
    do_fetch = (
        _encode_ins(opcodes, 'PutByValStrict', 1, 2, 5)
        + _encode_concat_strings(opcodes, strs, 6, 3, _VOICE_STATUS_URL_PARTS)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Call2', 6, 4, 0, 6)
        + _encode_get_by_id(opcodes, 7, 6, 1, _unique_str_idx(strs, 'then'))
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 8, 0, SKILL_DETAIL_JSON_HELPER_FUNCTION
        )
        + _encode_ins(opcodes, 'Call2', 6, 7, 6, 8)
        + _encode_get_by_id(opcodes, 7, 6, 2, _unique_str_idx(strs, 'then'))
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 8, 0, VOICE_APPLY_STATUS_FUNCTION
        )
        + _encode_ins(opcodes, 'Call2', 6, 7, 6, 8)
        + _encode_get_by_id(opcodes, 7, 6, 3, _unique_str_idx(strs, 'catch'))
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 8, 0, VOICE_CATCH_STATUS_FUNCTION
        )
        + _encode_ins(opcodes, 'Call2', 6, 7, 6, 8)
    )
    check_fetch_and_run = (
        _encode_get_by_id(opcodes, 4, 1, 0, _unique_str_idx(strs, 'fetch'))
        + _jmp_over(opcodes, 'JmpFalseLong', do_fetch, 4)
    )
    body_sync_status = (
        _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_PENDING_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _encode_ins(opcodes, 'LoadConstTrue', 5)
        + _jmp_over(opcodes, 'JStrictEqualLong', check_fetch_and_run, 4, 5)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # getSnapshot() -> hostEnabled === true && localPref === 'true'
    read_store_value = (
        _encode_get_by_id(
            opcodes, 6, 5, 1, _unique_str_idx(strs, 'getString')
        )
        + _encode_concat_strings(
            opcodes, strs, 2, 3, _VOICE_LOCAL_PREF_KEY_PARTS
        )
        + _encode_ins(opcodes, 'Call2', 4, 6, 5, 2)
        + _encode_load_const_string(opcodes, 5, _unique_str_idx(strs, 'true'))
        + _encode_ins(opcodes, 'StrictEq', 0, 4, 5)
        + _encode_ins(opcodes, 'Ret', 0)
    )
    read_local_pref = (
        _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_STORAGE_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _jmp_over(
            opcodes,
            'JmpFalseLong',
            (
                _encode_get_by_id(opcodes, 5, 4, 0, _unique_str_idx(strs, 'store'))
                + _jmp_over(opcodes, 'JmpFalseLong', read_store_value, 5)
            ),
            4,
        )
    )
    body_snapshot = (
        _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_HOST_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _encode_ins(opcodes, 'LoadConstTrue', 5)
        + _jmp_over(opcodes, 'JStrictNotEqualLong', read_local_pref, 4, 5)
        + _encode_ins(opcodes, 'LoadConstFalse', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # 94849: subscribe(cb) -> subscribes storage + host status map, refreshes status
    sub_storage_block = (
        _encode_get_by_id(opcodes, 7, 4, 0, _unique_str_idx(strs, 'subscribe'))
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_LOCAL_PREF_KEY_PARTS)
        + _encode_ins(opcodes, 'Call3', 5, 7, 4, 2, 6)
    )
    init_subs_block = (
        _encode_ins(opcodes, 'NewObject', 7)
        + _encode_ins(opcodes, 'PutByValStrict', 1, 2, 7)
    )
    init_seq_block = _encode_ins(opcodes, 'LoadConstZero', 8)
    body_subscribe = (
        _encode_ins(opcodes, 'CreateFunctionEnvironment', 0, 2)
        + _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_STORAGE_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _encode_ins(opcodes, 'LoadConstUndefined', 5)
        + _encode_ins(opcodes, 'LoadParam', 6, 1)
        + _jmp_over(opcodes, 'JmpFalseLong', sub_storage_block, 4)
        + _encode_ins(opcodes, 'StoreToEnvironment', 0, 0, 5)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_SUBS_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 7, 1, 2)
        + _jmp_over(opcodes, 'JmpTrueLong', init_subs_block, 7)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_SEQ_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 8, 1, 2)
        + _jmp_over(opcodes, 'JmpTrueLong', init_seq_block, 8)
        + _encode_ins(opcodes, 'LoadConstUInt8', 9, 1)
        + _encode_ins(opcodes, 'Add', 8, 8, 9)
        + _encode_ins(opcodes, 'PutByValStrict', 1, 2, 8)
        + _encode_ins(opcodes, 'PutByValStrict', 7, 8, 6)
        + _encode_ins(opcodes, 'StoreToEnvironment', 0, 1, 8)
        + _encode_ins(opcodes, 'LoadConstUndefined', 9)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 10, 9, VOICE_SYNC_STATUS_FUNCTION
        )
        + _encode_ins(opcodes, 'Call1', 9, 10, 9)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 10, 0, VOICE_DISPOSE_FUNCTION
        )
        + _encode_ins(opcodes, 'Ret', 10)
    )

    # 94847: dispose() -> disposes storage sub + deletes host status sub
    dispose_storage_sub = (
        _encode_get_by_id(opcodes, 2, 1, 0, _unique_str_idx(strs, 'dispose'))
        + _encode_ins(opcodes, 'Call1', 3, 2, 1)
    )
    delete_host_sub = (
        _encode_ins(opcodes, 'LoadFromEnvironment', 5, 0, 1)
        + _encode_ins(opcodes, 'DelByVal', 5, 4, 5, 0)
    )
    body_dispose = (
        _encode_ins(opcodes, 'GetParentEnvironment', 0, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 1, 0, 0)
        + _jmp_over(opcodes, 'JmpFalseLong', dispose_storage_sub, 1)
        + _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_SUBS_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _jmp_over(opcodes, 'JmpFalseLong', delete_host_sub, 4)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    # 94848: onValueChange(val) -> writes preference; syncs status on true, hangs up on false
    sync_when_true = (
        _encode_ins(opcodes, 'LoadConstUndefined', 5)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 6, 5, VOICE_SYNC_STATUS_FUNCTION
        )
        + _encode_ins(opcodes, 'Call1', 5, 6, 5)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )
    hangup_call = (
        _encode_get_by_id(opcodes, 5, 4, 1, _unique_str_idx(strs, 'hangUp'))
        + _encode_ins(opcodes, 'Call1', 5, 5, 4)
    )
    write_storage_block = (
        _encode_ins(opcodes, 'LoadConstUndefined', 5)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 6, 5, VOICE_STORAGE_SPEC_FUNCTION
        )
        + _encode_ins(opcodes, 'Call1', 6, 6, 5)
        + _encode_get_by_id(opcodes, 7, 4, 0, _unique_str_idx(strs, 'write'))
        + _encode_ins(opcodes, 'Call3', 5, 7, 4, 6, 0)
    )
    body_toggle_change = (
        _encode_ins(opcodes, 'LoadParam', 0, 1)
        + _encode_ins(opcodes, 'GetGlobalObject', 1)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_STORAGE_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _jmp_over(opcodes, 'JmpFalseLong', write_storage_block, 4)
        + _jmp_over(opcodes, 'JmpFalseLong', sync_when_true, 0)
        + _encode_concat_strings(opcodes, strs, 2, 3, _VOICE_SERVICE_KEY_PARTS)
        + _encode_ins(opcodes, 'GetByVal', 4, 1, 2)
        + _jmp_over(opcodes, 'JmpFalseLong', hangup_call, 4)
        + _encode_ins(opcodes, 'LoadConstUndefined', 0)
        + _encode_ins(opcodes, 'Ret', 0)
    )

    replaced: dict[int, bytes] = {}
    added = {
        VOICE_SNAPSHOT_FUNCTION: (1, body_snapshot),
        VOICE_DISPOSE_FUNCTION: (2, body_dispose),
        VOICE_TOGGLE_CHANGE_FUNCTION: (2, body_toggle_change),
        VOICE_SUBSCRIBE_FUNCTION: (2, body_subscribe),
        VOICE_CALL_SUB_FUNCTION: (2, body_call_sub),
        VOICE_APPLY_STATUS_FUNCTION: (2, body_apply_status),
        VOICE_CATCH_STATUS_FUNCTION: (1, body_catch_status),
        VOICE_SYNC_STATUS_FUNCTION: (1, body_sync_status),
    }
    for body in (*replaced.values(), *(spec[1] for spec in added.values())):
        opcodes.decode(body, 0, len(body))
    return replaced, added


def assert_realtime_voice_wired(file: HBCFile, label: str) -> None:
    """Verify SettingsSheet mounts the Realtime Voice toggle and gates calls on Host status."""

    strs = hbc_strings(file)
    try_on_sid = _unique_str_idx(strs, 'TryOnSelfieGroup')
    host_sid = _unique_str_idx(strs, 'host')
    status_sid = _unique_str_idx(strs, 'status')

    h_mod = effective_header(file, SETTINGS_SHEET_MODULE_FUNCTION)
    mod_insns = file.opcodes.decode(
        file.data[h_mod.offset:h_mod.offset + h_mod.bytecode_size],
        0,
        h_mod.bytecode_size,
    )
    has_closure = any(
        ins.name in ('CreateClosure', 'CreateClosureLongIndex')
        and ins.operands[2] == VOICE_TOGGLE_GROUP_FUNCTION
        for ins in mod_insns
    )
    has_define = any(
        ins.name in ('DefineOwnById', 'DefineOwnByIdLong')
        and ins.operands[-1] == try_on_sid
        for ins in mod_insns
    )
    has_store = any(
        ins.name == 'StoreToEnvironment'
        and ins.operands[:2] == (2, SETTINGS_TRY_ON_SELFIE_ENV_SLOT)
        for ins in mod_insns
    )
    if not (has_closure and has_define and has_store):
        raise AssertionError(
            f'{label}: SettingsSheet module fn#{SETTINGS_SHEET_MODULE_FUNCTION} '
            'does not mount VoiceRealtimeToggleGroup into TryOnSelfieGroup'
        )

    h_snap = effective_header(file, VOICE_SNAPSHOT_FUNCTION)
    snap_insns = file.opcodes.decode(
        file.data[h_snap.offset:h_snap.offset + h_snap.bytecode_size],
        0,
        h_snap.bytecode_size,
    )
    if not any(
        ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and ins.operands[1] == host_sid
        for ins in snap_insns
    ):
        raise AssertionError(
            f'{label}: voice snapshot fn#{VOICE_SNAPSHOT_FUNCTION} does not check Host status'
        )

    h_sync = effective_header(file, VOICE_SYNC_STATUS_FUNCTION)
    sync_insns = file.opcodes.decode(
        file.data[h_sync.offset:h_sync.offset + h_sync.bytecode_size],
        0,
        h_sync.bytecode_size,
    )
    if not any(
        ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and ins.operands[1] == status_sid
        for ins in sync_insns
    ):
        raise AssertionError(
            f'{label}: voice status sync fn#{VOICE_SYNC_STATUS_FUNCTION} does not fetch /local/voice/status'
        )

    for added_idx in range(NEW_FUNCTION_START, NEW_FUNCTION_START + NEW_FUNCTION_COUNT):
        eh_added = effective_header(file, added_idx)
        if (eh_added.flags & 0x03) == 0:
            raise AssertionError(
                f'{label}: added fn#{added_idx} has ProhibitCall flags={eh_added.flags}'
            )


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
    verify_react_module_id: int | None = None,
) -> bytes:
    """Semantically port a patched HBC-98 body from 1.27.0 to 1.28.0.

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
                        f'fn#{source_index} offset {ins.offset}: string {text!r} missing in 1.28.0'
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

    if verify_react_module_id is not None:
        found_react = False
        for idx_i in range(len(instructions) - 2):
            if (
                names[idx_i] in ('GetById', 'GetByIdShort', 'GetByIdLong')
                and target_strings[operands[idx_i][-1]].text == '__r'
                and names[idx_i + 1] == 'LoadConstUInt8'
                and operands[idx_i + 1][1] == verify_react_module_id
                and names[idx_i + 2] == 'Call2'
            ):
                found_react = True
        if not found_react:
            raise ValueError(
                f'fn#{source_index}: expected __r({verify_react_module_id}) React require call not found'
            )

    reencoded = _reencode_with_promotions(instructions, names, operands, opcodes)
    opcodes.decode(reencoded, 0, len(reencoded))
    return reencoded


def assert_chat_avatar_static(file: HBCFile, label: str) -> None:
    """Verify ChatAvatar keeps the stock ``static`` default motion.

    1.26.0 and 1.27.0 recipes switch ChatAvatar's default to ``live``. In 1.28.0
    ``live`` renders the new GrokBotFace (blink clock, gaze smoothing, eye morphs)
    as SVG redrawn by JavaScript every frame, so forcing it onto every Bot list
    row costs 64 React Native commits per second while idle and 25-49 ms frames
    while scrolling. 1.28.0 therefore keeps the stock default, which leaves
    avatars static as in the official client.
    """

    header = effective_header(file, CHAT_AVATAR_FUNCTION)
    strings = hbc_strings(file)
    if strings[header.function_name].text != 'ChatAvatar':
        raise AssertionError(f'{label} changed the ChatAvatar function identity')
    if strings[CHAT_AVATAR_DEFAULT_STATIC_INDEX].text != 'static':
        raise AssertionError(f'{label} moved the ChatAvatar static string')
    instructions = file.opcodes.decode(
        file.data[header.offset:header.offset + header.bytecode_size],
        0,
        header.bytecode_size,
    )
    defaults = [
        ins for ins in instructions
        if ins.name == 'LoadConstString' and ins.offset == CHAT_AVATAR_LOAD_OFFSET
    ]
    if len(defaults) != 1 or defaults[0].operands[-1] != CHAT_AVATAR_DEFAULT_STATIC_INDEX:
        raise AssertionError(f'{label} does not keep ChatAvatar static by default')
    if any(
        ins.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and ins.operands[-1] == CHAT_AVATAR_LIVE_INDEX
        for ins in instructions
    ):
        raise AssertionError(f'{label} forces ChatAvatar to live motion')


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

    if len(stock.function_headers) != STOCK_128_FUNCTION_COUNT:
        raise ValueError(
            f'Expected stock function count {STOCK_128_FUNCTION_COUNT}, '
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

    # ChatAvatar keeps the stock static default in 1.28.0; see assert_chat_avatar_static.

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
    require_clean(target, 'Generated 1.28.0 unpaired bundle')
    assert_chat_avatar_static(target, 'Generated 1.28.0 unpaired bundle')

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
    expected_changed = set(UNPAIRED_ALL_TARGETS)
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
        'chatAvatarMotion': 'static',
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
    """Build BackendClient.call / callPublic with local-intercepted RPC bypasses."""

    opcodes = stock.opcodes
    eh = effective_header(stock, fn_idx)
    stock_body = stock.data[eh.offset:eh.offset + eh.bytecode_size]
    if len(stock_body) != 34:
        raise ValueError(
            f'BackendClient fn#{fn_idx} stock body is {len(stock_body)} bytes, expected 34'
        )
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
    for rpc_path in BACKEND_LOCAL_BYPASS_RPCS_128:
        sid = target_by_text.get(rpc_path)
        if sid is None:
            raise ValueError(f'Missing RPC path string in 1.28.0 HBC: {rpc_path!r}')
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
    expected = set(BACKEND_LOCAL_BYPASS_RPCS_128)
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
    """Prepend locally pinned feature gates to ``buildPinnedGate``."""

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
            raise ValueError(f'Missing feature gate string in 1.28.0 HBC: {gate_name!r}')
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
    """Confirm buildLive still loads DevGatewayOverride from parent env slot 62."""

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
    gateway_127: HBCFile,
) -> tuple[bytes, dict[str, object]]:
    """Build the full 1.28.0 gateway-template.hbc from stock 1.28.0 + gateway 1.27.0."""

    opcodes = stock.opcodes
    strs = hbc_strings(stock)
    strs_127 = hbc_strings(gateway_127)
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

    # 3. ChatAvatar keeps the stock static default; see assert_chat_avatar_static.
    if CHAT_AVATAR_FUNCTION in replacements:
        raise AssertionError('ChatAvatar must not be replaced in the 1.28.0 gateway')

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
        number_reg_count=0,
        non_pointer_reg_count=0,
        frame_size=max(sh_gw.frame_size, 3),
        read_cache_size=0,
        write_cache_size=max(sh_gw.write_cache_size, 2),
    )
    replacements[GATEWAY_SHELL_FUNCTION] = FunctionEdit(
        body=shell_body, metadata=shell_meta
    )

    # 6. TranscriptionService timeout 90000 -> 125000 (fn#3117 offset 510).
    h_tr = effective_header(stock, 3117)
    b_tr = bytearray(stock.data[h_tr.offset:h_tr.offset + h_tr.bytecode_size])
    if b_tr[510:516] != _encode_ins(opcodes, 'LoadConstInt', 0, 90000):
        raise ValueError('TranscriptionService fn#3117 LoadConstInt 90000 anchor moved')
    b_tr[510:516] = _encode_ins(opcodes, 'LoadConstInt', 0, 125000)
    opcodes.decode(bytes(b_tr), 0, len(b_tr))
    replacements[3117] = FunctionEdit(body=bytes(b_tr))

    # 7. stampSender (fn#31111): if (DevGatewayOverride.read() !== undefined) return undefined;
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
        number_reg_count=0,
        non_pointer_reg_count=0,
        frame_size=max(sh_stamp.frame_size, req_stamp.frame_size, 14),
        read_cache_size=max(sh_stamp.read_cache_size, req_stamp.read_cache_entries, 2),
    )
    require_metadata(req_stamp, meta_stamp, label='stampSender fn#31111')
    replacements[STAMP_SENDER_FUNCTION] = FunctionEdit(body=body_stamp, metadata=meta_stamp)

    # 8. ownerRoute (fn#40095): route devGateway sessions to { kind: 'current' }.
    oh = effective_header(stock, 40095)
    if strs[oh.function_name].text != 'ownerRoute':
        raise ValueError('Function 40095 is not ownerRoute')
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
        number_reg_count=0,
        non_pointer_reg_count=0,
        frame_size=max(oh.frame_size, req_owner.frame_size),
        read_cache_size=max(oh.read_cache_size, req_owner.read_cache_entries),
        write_cache_size=max(oh.write_cache_size, req_owner.write_cache_entries, 1),
    )
    require_metadata(req_owner, meta_owner, label='ownerRoute fn#40095')
    replacements[40095] = FunctionEdit(body=body_owner, metadata=meta_owner)

    # 9. routedLane (fn#26781): 4-byte in-place jump patch preserving stock StringSwitchImm.
    rh = effective_header(stock, 26781)
    if strs[rh.function_name].text != 'routedLane':
        raise ValueError('Function 26781 is not routedLane')
    rorig = bytearray(stock.data[rh.offset:rh.offset + rh.bytecode_size])
    rinsns = opcodes.decode(bytes(rorig), 0, len(rorig))
    if not (rinsns[5].offset == 26 and rinsns[5].name == 'JStrictEqualLong' and rinsns[5].operands == (130, 2, 1)):
        raise ValueError('routedLane fn#26781 anchor moved')
    if not (rinsns[9].offset == 44 and rinsns[9].name == 'LoadConstString' and rinsns[9].operands == (1, _unique_str_idx(strs, 'gateway'))):
        raise ValueError('routedLane fn#26781 gateway branch moved')
    rorig[26:33] = _encode_ins(opcodes, 'JStrictEqualLong', 18, 2, 1)
    opcodes.decode(bytes(rorig), 0, len(rorig))
    replacements[26781] = FunctionEdit(body=bytes(rorig))

    # 10. gatewayPorts (fn#26775): 1-byte in-place env slot fix (CreateClosure env 1 -> 2).
    gh = effective_header(stock, 26775)
    if strs[gh.function_name].text != 'gatewayPorts':
        raise ValueError('Function 26775 is not gatewayPorts')
    gorig = bytearray(stock.data[gh.offset:gh.offset + gh.bytecode_size])
    ginsns = opcodes.decode(bytes(gorig), 0, len(gorig))
    ins_res = next(item for item in ginsns if item.offset == 113)
    if not (ins_res.name == 'CreateClosure' and ins_res.operands == (3, 1, 64181)):
        raise ValueError('gatewayPorts fn#26775 CreateClosure anchor moved')
    gorig[113:118] = _encode_ins(opcodes, 'CreateClosure', 3, 2, 64181)
    opcodes.decode(bytes(gorig), 0, len(gorig))
    replacements[26775] = FunctionEdit(body=bytes(gorig))

    # 11. StorageService initializer (fn#13806): expose globalThis['grokbot.voice.storage'] = this
    # and trigger initial Host /local/voice/status sync.
    # Stock fn#13806 has frame_size=14 and hardcodes ``Mov 6, 4; Construct 1, 1, 1``
    # (r6 == frame_size - 8 is the outgoing ThisArg slot), so frame_size MUST remain 14
    # and Call1 source operands MUST stay < 6 (r3/r4, never r6).
    sth = effective_header(stock, 13806)
    if strs[sth.function_name].text != '<instance_members_initializer:StorageService>':
        raise ValueError('Function 13806 is not StorageService initializer')
    if sth.non_pointer_reg_count > 1 or sth.frame_size != 14:
        raise ValueError('StorageService fn#13806 register layout changed')
    storig = stock.data[sth.offset:sth.offset + sth.bytecode_size]
    if storig[-4:] != _encode_ins(opcodes, 'LoadConstUndefined', 0) + _encode_ins(opcodes, 'Ret', 0):
        raise ValueError('StorageService fn#13806 epilogue moved')
    suffix_storage = (
        _encode_ins(opcodes, 'GetGlobalObject', 4)
        + _encode_concat_strings(opcodes, strs, 1, 3, _VOICE_STORAGE_KEY_PARTS)
        + _encode_ins(opcodes, 'PutByValStrict', 4, 1, 2)
        + _encode_ins(opcodes, 'LoadConstUndefined', 3)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 4, 3, VOICE_SYNC_STATUS_FUNCTION
        )
        + _encode_ins(opcodes, 'Call1', 5, 4, 3)
    )
    body_storage = storig[:-4] + suffix_storage + storig[-4:]
    opcodes.decode(body_storage, 0, len(body_storage))
    req_storage = body_requirements(opcodes, body_storage)
    meta_storage = FunctionMetadata.from_header(sth)
    require_metadata(req_storage, meta_storage, label='StorageService fn#13806')
    replacements[13806] = FunctionEdit(body=body_storage, metadata=meta_storage)

    # 11b. SettingsSheet module (fn#6665): mount VoiceRealtimeToggleGroup into
    # TryOnSelfieGroup (env slot 39) so SettingsSheet renders the experimental
    # Realtime Voice toggle without modifying SettingsSheet's own body.
    h_set_mod = effective_header(stock, SETTINGS_SHEET_MODULE_FUNCTION)
    if h_set_mod.non_pointer_reg_count != 1:
        raise ValueError('SettingsSheet module fn#6665 register layout changed')
    b_set_mod = stock.data[h_set_mod.offset:h_set_mod.offset + h_set_mod.bytecode_size]
    if b_set_mod[-2:] != _encode_ins(opcodes, 'Ret', 0):
        raise ValueError('SettingsSheet module fn#6665 epilogue moved')
    set_mod_insns = opcodes.decode(b_set_mod, 0, len(b_set_mod))
    if not any(
        ins.name == 'StoreToEnvironment'
        and ins.operands[:2] == (2, SETTINGS_TRY_ON_SELFIE_ENV_SLOT)
        for ins in set_mod_insns
    ):
        raise ValueError('SettingsSheet module fn#6665 slot 39 anchor moved')
    suffix_set_mod = (
        _encode_ins(opcodes, 'NewObject', 4)
        + _encode_ins(
            opcodes, 'CreateClosureLongIndex', 6, 2, VOICE_TOGGLE_GROUP_FUNCTION
        )
        + _encode_define_own_by_id(
            opcodes, 4, 6, 1, _unique_str_idx(strs, 'TryOnSelfieGroup')
        )
        + _encode_ins(
            opcodes, 'StoreToEnvironment', 2, SETTINGS_TRY_ON_SELFIE_ENV_SLOT, 4
        )
    )
    body_set_mod = b_set_mod[:-2] + suffix_set_mod + b_set_mod[-2:]
    opcodes.decode(body_set_mod, 0, len(body_set_mod))
    req_set_mod = body_requirements(opcodes, body_set_mod)
    meta_set_mod = replace(
        FunctionMetadata.from_header(h_set_mod),
        frame_size=max(h_set_mod.frame_size, req_set_mod.frame_size),
        write_cache_size=max(h_set_mod.write_cache_size, req_set_mod.write_cache_entries),
    )
    require_metadata(req_set_mod, meta_set_mod, label='SettingsSheet module fn#6665')
    replacements[SETTINGS_SHEET_MODULE_FUNCTION] = FunctionEdit(
        body=body_set_mod, metadata=meta_set_mod
    )

    # 12. Group/identity gateway writes (fn#83406, fn#83409, fn#83410).
    # Stock fn#83406 has frame_size=21 and ends with ``CallBuiltin 0, 44, 2`` using
    # r12 == frame_size - 9, so frame_size MUST remain 21. Move r11 -> r7 (r7 is
    # dead after reading .gateway and overwritten by Call3's dst) so every Call3
    # source operand stays strictly below 21 - (7 + 3) == 11.
    h_grp = effective_header(stock, 83406)
    if strs[h_grp.function_name].text != '?anon_0_setGroupMembers':
        raise ValueError('Function 83406 is not ?anon_0_setGroupMembers')
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
    replacements[83406] = FunctionEdit(body=bytes(b_grp))

    h_rid = effective_header(stock, 83410)
    if strs[h_rid.function_name].text != '?anon_0_readServerIdentity':
        raise ValueError('Function 83410 is not ?anon_0_readServerIdentity')
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
    replacements[83410] = FunctionEdit(body=bytes(b_rid))

    h_aid = effective_header(stock, 83409)
    if strs[h_aid.function_name].text != '?anon_0_applyIdentityWrite':
        raise ValueError('Function 83409 is not ?anon_0_applyIdentityWrite')
    b_aid = bytearray(stock.data[h_aid.offset:h_aid.offset + h_aid.bytecode_size])
    if b_aid[234:239] != _encode_ins(opcodes, 'GetByIdShort', 7, 7, 1, _unique_str_idx(strs, 'agent')):
        raise ValueError('applyIdentityWrite fn#83409 p1 anchor moved')
    if b_aid[646:650] != _encode_ins(opcodes, 'LoadFromEnvironment', 11, 1, 6):
        raise ValueError('applyIdentityWrite fn#83409 p2 start anchor moved')
    if b_aid[759:764] != _encode_ins(opcodes, 'Call2', 8, 8, 9, 7):
        raise ValueError('applyIdentityWrite fn#83409 p2 end anchor moved')
    p1_aid = _encode_ins(opcodes, 'LoadConstUndefined', 7) + _encode_ins(opcodes, 'Mov', 8, 8)
    p2_core = (
        _encode_ins(opcodes, 'LoadFromEnvironment', 9, 1, 7)
        + _encode_get_by_id(opcodes, 9, 9, 11, _unique_str_idx(strs, 'gateway'))
        + _encode_load_const_string(opcodes, 13, _unique_str_idx(strs, 'updateAgent'))
        + _encode_ins(opcodes, 'GetByVal', 8, 9, 13)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 7, 10, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 12, 10, 5)
        + _encode_ins(opcodes, 'Call3', 8, 8, 9, 7, 12)
    )
    rem = (764 - 646) - len(p2_core)
    if len(p1_aid) != 239 - 234 or rem < 0:
        raise AssertionError('Unexpected applyIdentityWrite patch length')
    if rem % 2 == 1:
        if rem < 3:
            raise AssertionError('Cannot pad odd remainder < 3 in applyIdentityWrite')
        p2_aid = p2_core + _encode_ins(opcodes, 'Mov', 13, 13) + _encode_ins(opcodes, 'LoadConstUndefined', 13) * ((rem - 3) // 2)
    else:
        p2_aid = p2_core + _encode_ins(opcodes, 'LoadConstUndefined', 13) * (rem // 2)
    b_aid[234:239] = p1_aid
    b_aid[646:764] = p2_aid
    opcodes.decode(bytes(b_aid), 0, len(b_aid))
    replacements[83409] = FunctionEdit(body=bytes(b_aid))

    # 13. Voice call mint context & toolbar/session in-place patches.
    h_sc = effective_header(stock, 84680)
    if strs[h_sc.function_name].text != '?anon_2_startCall':
        raise ValueError('Function 84680 is not ?anon_2_startCall')
    b_sc = bytearray(stock.data[h_sc.offset:h_sc.offset + h_sc.bytecode_size])
    if b_sc[2003:2005] != _encode_ins(opcodes, 'NewObject', 24):
        raise ValueError('startCall fn#84680 NewObject 24 anchor moved')
    b_sc[2003:2005] = _encode_ins(opcodes, 'LoadConstUndefined', 37)
    opcodes.decode(bytes(b_sc), 0, len(b_sc))
    replacements[84680] = FunctionEdit(body=bytes(b_sc))

    h_rd = effective_header(stock, 84689)
    if strs[h_rd.function_name].text != '?anon_0_redialTheSameCall':
        raise ValueError('Function 84689 is not ?anon_0_redialTheSameCall')
    b_rd = bytearray(stock.data[h_rd.offset:h_rd.offset + h_rd.bytecode_size])
    if b_rd[1110:1112] != _encode_ins(opcodes, 'NewObject', 16):
        raise ValueError('redialTheSameCall fn#84689 NewObject 16 anchor moved')
    b_rd[1110:1112] = _encode_ins(opcodes, 'LoadConstUndefined', 8)
    opcodes.decode(bytes(b_rd), 0, len(b_rd))
    replacements[84689] = FunctionEdit(body=bytes(b_rd))

    h_ct = effective_header(stock, 45603)
    if strs[h_ct.function_name].text != 'CallToolbar':
        raise ValueError('Function 45603 is not CallToolbar')
    b_ct = bytearray(stock.data[h_ct.offset:h_ct.offset + h_ct.bytecode_size])
    if b_ct[48:54] != _encode_get_by_id(opcodes, 18, 2, 5, _unique_str_idx(strs, 'onToggleSettings')):
        raise ValueError('CallToolbar fn#45603 anchor moved')
    b_ct[48:54] = _encode_ins(opcodes, 'LoadConstUndefined', 18) * 3
    opcodes.decode(bytes(b_ct), 0, len(b_ct))
    replacements[45603] = FunctionEdit(body=bytes(b_ct))

    h_ic = effective_header(stock, 40197)
    if strs[h_ic.function_name].text != 'IslandControls':
        raise ValueError('Function 40197 is not IslandControls')
    b_ic = bytearray(stock.data[h_ic.offset:h_ic.offset + h_ic.bytecode_size])
    if b_ic[42:48] != _encode_get_by_id(opcodes, 17, 3, 4, _unique_str_idx(strs, 'onOpenSettings')):
        raise ValueError('IslandControls fn#40197 anchor moved')
    b_ic[42:48] = _encode_ins(opcodes, 'LoadConstUndefined', 17) * 3
    opcodes.decode(bytes(b_ic), 0, len(b_ic))
    replacements[40197] = FunctionEdit(body=bytes(b_ic))

    h_xai = effective_header(stock, 30866)
    if strs[h_xai.function_name].text != 'XaiRealtimeSession':
        raise ValueError('Function 30866 is not XaiRealtimeSession')
    b_xai = bytearray(stock.data[h_xai.offset:h_xai.offset + h_xai.bytecode_size])
    if b_xai[593:598] != _encode_ins(opcodes, 'Call2', 9, 11, 12, 9):
        raise ValueError('XaiRealtimeSession fn#30866 anchor moved')
    b_xai[593:598] = _encode_ins(opcodes, 'LoadConstTrue', 9) + _encode_ins(opcodes, 'Mov', 9, 9)
    opcodes.decode(bytes(b_xai), 0, len(b_xai))
    replacements[30866] = FunctionEdit(body=bytes(b_xai))

    # 14. SkillDetail module (fn#6901) -> wrap SkillDetail with added fn#94838.
    h_skm = effective_header(stock, SKILL_DETAIL_MODULE_FUNCTION)
    b_skm = stock.data[h_skm.offset:h_skm.offset + h_skm.bytecode_size]
    if b_skm[12:17] != _encode_ins(opcodes, 'CreateClosure', 4, 2, SKILL_DETAIL_ORIGINAL_FUNCTION):
        raise ValueError('SkillDetail module fn#6901 CreateClosure anchor moved')
    body_skm = (
        b_skm[:12]
        + _encode_ins(opcodes, 'CreateClosureLongIndex', 4, 2, NEW_FUNCTION_START)
        + b_skm[17:]
    )
    opcodes.decode(body_skm, 0, len(body_skm))
    replacements[SKILL_DETAIL_MODULE_FUNCTION] = FunctionEdit(body=body_skm)

    # 14b. buildPinnedGate (fn#27266): pin inline Canvas/Pages preview gates to true.
    h_pin = effective_header(stock, BUILD_PINNED_GATE_FUNCTION)
    body_pin = build_pinned_feature_gates_body(
        stock, BUILD_PINNED_GATE_FUNCTION, strs, target_by_text
    )
    req_pin = body_requirements(opcodes, body_pin)
    meta_pin = FunctionMetadata.from_header(h_pin)
    require_metadata(req_pin, meta_pin, label=f'buildPinnedGate fn#{BUILD_PINNED_GATE_FUNCTION}')
    replacements[BUILD_PINNED_GATE_FUNCTION] = FunctionEdit(body=body_pin, metadata=meta_pin)

    # 15. Semantically port the 15 complex functions from verified gateway 1.27.0.
    ported_records: list[dict[str, object]] = []
    for src_idx, dst_idx in PORTED_FUNCTIONS.items():
        dst_h = effective_header(stock, dst_idx)
        dst_name = strs[dst_h.function_name].text
        if dst_name != EXPECTED_PORTED_NAMES[dst_idx]:
            raise ValueError(
                f'Target fn#{dst_idx} is {dst_name!r}, expected {EXPECTED_PORTED_NAMES[dst_idx]!r}'
            )
        src_h = effective_header(gateway_127, src_idx)
        if dst_idx in (BACKEND_CALL_FUNCTION, BACKEND_CALL_PUBLIC_FUNCTION):
            body = build_backend_call_bypass_body(stock, dst_idx, strs, target_by_text)
        else:
            body = port_function_body(
                gateway_127,
                stock,
                src_idx,
                closure_map=CLOSURE_TARGET_MAP,
                source_strings=strs_127,
                target_strings=strs,
                target_by_text=target_by_text,
            )
        req = body_requirements(opcodes, body)
        meta = replace(
            FunctionMetadata.from_header(dst_h),
            number_reg_count=0,
            non_pointer_reg_count=0,
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
                'from127': src_idx,
                'to128': dst_idx,
                'name': dst_name,
                'sourceBytes': dst_h.bytecode_size,
                'targetBytes': len(body),
                'bodySha256': sha256(body),
            }
        )

    _, voice_added = build_realtime_voice_bodies(opcodes, strs)

    # 16. Semantically port the 6 added SkillDetail publication functions (94838..94843)
    # plus the 11 added Realtime Voice functions (94844..94854).
    # Appending all Realtime Voice closures avoids overwriting any stock 1.28.0
    # functions (such as AgentPickerRow._t3 at 75297 or ConnectorGrantCard.t20 at 78752),
    # and sets CALLABLE_ARROW_FLAGS (ProhibitConstruct | StrictMode = 0x05) so Hermes
    # never treats added closures as ProhibitCall (0x00) class constructors.
    # In 1.28.0 fn#6901 keeps InsetGroup* at slot 12, jsx/jsxs/Fragment at slot 18,
    # useLingui at slot 2, useLocalSearchParams at slot 3, and React at module ID 50.
    global_name_id = _unique_str_idx(strs, 'global')
    additions: list[NewFunction] = []
    for offset in range(SKILL_DETAIL_ADDED_COUNT):
        src_idx = OLD_NEW_FUNCTION_START + offset
        dst_idx = NEW_FUNCTION_START + offset
        src_h = effective_header(gateway_127, src_idx)
        body = port_function_body(
            gateway_127,
            stock,
            src_idx,
            closure_map=CLOSURE_TARGET_MAP,
            source_strings=strs_127,
            target_strings=strs,
            target_by_text=target_by_text,
            verify_react_module_id=(REACT_128_MODULE_ID if offset == 0 else None),
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

    def _make_ported_voice_addition(
        src_127_idx: int,
        dst_128_idx: int,
        *,
        env_slot_remap: Mapping[tuple[int, int], int] | None = None,
    ) -> NewFunction:
        src_vh = effective_header(gateway_127, src_127_idx)
        v_body = port_function_body(
            gateway_127,
            stock,
            src_127_idx,
            closure_map=CLOSURE_TARGET_MAP,
            source_strings=strs_127,
            target_strings=strs,
            target_by_text=target_by_text,
            env_slot_remap=env_slot_remap,
        )
        v_req = body_requirements(opcodes, v_body)
        v_flags = src_vh.flags if (src_vh.flags & 0x03) != 0 else CALLABLE_ARROW_FLAGS
        v_meta = replace(
            FunctionMetadata.from_header(src_vh),
            function_name=global_name_id,
            number_reg_count=0,
            non_pointer_reg_count=0,
            frame_size=max(src_vh.frame_size, v_req.frame_size),
            read_cache_size=max(src_vh.read_cache_size, v_req.read_cache_entries),
            write_cache_size=max(src_vh.write_cache_size, v_req.write_cache_entries),
            flags=v_flags,
        )
        require_metadata(v_req, v_meta, label=f'added fn#{dst_128_idx}')
        return NewFunction(body=v_body, metadata=v_meta)

    def _make_helper_voice_addition(helper_idx: int) -> NewFunction:
        param_count, helper_body = voice_added[helper_idx]
        req_helper = body_requirements(opcodes, helper_body)
        min_frame_size = max(
            VOICE_HELPER_MIN_FRAME_SIZE,
            req_helper.frame_size + CALLER_EXTRA_REGISTERS_AT_END + 4,
        )
        meta_helper = FunctionMetadata(
            param_count=param_count,
            loop_depth=0,
            function_name=global_name_id,
            number_reg_count=0,
            non_pointer_reg_count=0,
            frame_size=min_frame_size,
            read_cache_size=max(4, req_helper.read_cache_entries),
            write_cache_size=req_helper.write_cache_entries,
            num_cache_new_object=0,
            private_name_cache_size=0,
            flags=CALLABLE_ARROW_FLAGS,
        )
        require_metadata(req_helper, meta_helper, label=f'added fn#{helper_idx}')
        return NewFunction(body=helper_body, metadata=meta_helper)

    voice_addition_plan = (
        (
            VOICE_TOGGLE_GROUP_FUNCTION,
            lambda: _make_ported_voice_addition(
                VOICE_TOGGLE_127_SOURCE_FUNCTION,
                VOICE_TOGGLE_GROUP_FUNCTION,
                env_slot_remap=_SETTINGS_VOICE_ENV_REMAP,
            ),
        ),
        (VOICE_SNAPSHOT_FUNCTION, lambda: _make_helper_voice_addition(VOICE_SNAPSHOT_FUNCTION)),
        (
            VOICE_STORAGE_SPEC_FUNCTION,
            lambda: _make_ported_voice_addition(
                VOICE_STORAGE_SPEC_127_SOURCE_FUNCTION,
                VOICE_STORAGE_SPEC_FUNCTION,
            ),
        ),
        (VOICE_DISPOSE_FUNCTION, lambda: _make_helper_voice_addition(VOICE_DISPOSE_FUNCTION)),
        (
            VOICE_TOGGLE_CHANGE_FUNCTION,
            lambda: _make_helper_voice_addition(VOICE_TOGGLE_CHANGE_FUNCTION),
        ),
        (VOICE_SUBSCRIBE_FUNCTION, lambda: _make_helper_voice_addition(VOICE_SUBSCRIBE_FUNCTION)),
        (
            VOICE_SCHEMA_PARSE_FUNCTION,
            lambda: _make_ported_voice_addition(
                VOICE_SCHEMA_PARSE_127_SOURCE_FUNCTION,
                VOICE_SCHEMA_PARSE_FUNCTION,
            ),
        ),
        (VOICE_CALL_SUB_FUNCTION, lambda: _make_helper_voice_addition(VOICE_CALL_SUB_FUNCTION)),
        (
            VOICE_APPLY_STATUS_FUNCTION,
            lambda: _make_helper_voice_addition(VOICE_APPLY_STATUS_FUNCTION),
        ),
        (
            VOICE_CATCH_STATUS_FUNCTION,
            lambda: _make_helper_voice_addition(VOICE_CATCH_STATUS_FUNCTION),
        ),
        (
            VOICE_SYNC_STATUS_FUNCTION,
            lambda: _make_helper_voice_addition(VOICE_SYNC_STATUS_FUNCTION),
        ),
    )
    for expected_idx, builder in voice_addition_plan:
        actual_idx = STOCK_128_FUNCTION_COUNT + len(additions)
        if actual_idx != expected_idx:
            raise AssertionError(
                f'Voice addition index drift: expected {expected_idx}, got {actual_idx}'
            )
        additions.append(builder())

    output = stock.write(replacements=replacements, additions=additions)
    target = HBCFile.parse(output, strict=True)
    if len(target.function_headers) != STOCK_128_FUNCTION_COUNT + NEW_FUNCTION_COUNT:
        raise AssertionError('Generated 1.28.0 function count is incorrect')
    require_clean(target, 'Generated 1.28.0 gateway template')
    assert_chat_avatar_static(target, 'Generated 1.28.0 gateway template')
    assert_native_plugin_entries_hidden(target, 'Generated 1.28.0 gateway template')
    assert_backend_local_bypass(target, 'Generated 1.28.0 gateway template')
    assert_pinned_feature_gates(target, 'Generated 1.28.0 gateway template')
    assert_realtime_voice_wired(target, 'Generated 1.28.0 gateway template')
    structural_audit = audit_hbc(target)
    structural_audit.require_ok('Generated 1.28.0 gateway template')

    summary = {
        'bytes': len(output),
        'sha256': sha256(output),
        'functions': len(target.function_headers),
        'functionInfos': len(target.function_infos),
        'existingEdits': len(replacements),
        'addedFunctions': len(additions),
        'chatAvatarMotion': 'static',
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

    if len(gateway.function_headers) != STOCK_128_FUNCTION_COUNT + NEW_FUNCTION_COUNT:
        raise ValueError('Gateway function count does not match the 1.28.0 recipe')

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
    require_clean(parsed, 'Injected 1.28.0 gateway bundle')
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
    audit.require_ok('Injected 1.28.0 gateway bundle')
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


def _default_recipe_127() -> Path:
    archived = REPO_ROOT / 'ios/recipes/ios/1.27.0/gateway-template.hbc.gbp.gz'
    if archived.is_file():
        return archived
    return REPO_ROOT / 'ios/recipes/ios/gateway-template.hbc.gbp.gz'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock-128', required=True, type=Path)
    parser.add_argument('--stock-127', required=True, type=Path)
    parser.add_argument('--recipe-127', type=Path, default=_default_recipe_127())
    parser.add_argument('--output-unpaired', type=Path)
    parser.add_argument('--output-gateway', type=Path)
    parser.add_argument('--output-metadata', type=Path)
    parser.add_argument('--recipes-dir', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()

    if not any((args.output_unpaired, args.output_gateway, args.output_metadata, args.recipes_dir)):
        parser.error('Choose at least one output artifact')

    stock_128 = HBCFile.from_path(args.stock_128, strict=True)
    if sha256(stock_128.data) != EXPECTED_STOCK_128_SHA256:
        raise ValueError('Stock 1.28.0 HBC SHA-256 does not match the pinned 1.28.0 (29649) bundle')
    if len(stock_128.function_headers) != STOCK_128_FUNCTION_COUNT:
        raise ValueError(
            f'Expected 1.28.0 stock function count {STOCK_128_FUNCTION_COUNT}, '
            f'found {len(stock_128.function_headers)}'
        )

    stock_127_bytes = args.stock_127.read_bytes()
    if sha256(stock_127_bytes) != EXPECTED_STOCK_127_SHA256:
        raise ValueError('Stock 1.27.0 HBC SHA-256 does not match the pinned 1.27.0 (29519) bundle')
    gateway_127_bytes = bytepatch.apply(stock_127_bytes, bytepatch.load(args.recipe_127))
    gateway_127 = HBCFile.parse(gateway_127_bytes, strict=True)

    unpaired, unpaired_summary = build_unpaired(stock_128)
    if EXPECTED_UNPAIRED_128_SHA256 and sha256(unpaired) != EXPECTED_UNPAIRED_128_SHA256:
        raise ValueError(
            'Unpaired 1.28.0 bundle SHA-256 does not match the verified pin: '
            f'got {sha256(unpaired)}, expected {EXPECTED_UNPAIRED_128_SHA256}'
        )
    gateway, gateway_summary = build_gateway(stock_128, gateway_127)
    if EXPECTED_GATEWAY_128_SHA256 and sha256(gateway) != EXPECTED_GATEWAY_128_SHA256:
        raise ValueError(
            'Gateway template 1.28.0 SHA-256 does not match the verified pin: '
            f'got {sha256(gateway)}, expected {EXPECTED_GATEWAY_128_SHA256}'
        )
    gateway_file = HBCFile.parse(gateway, strict=True)
    metadata, metadata_bytes = build_gateway_metadata(stock_128, gateway_file, gateway)
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
            stock_128.data,
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
            'bytes': len(stock_128.data),
            'sha256': sha256(stock_128.data),
            'functions': len(stock_128.function_headers),
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
