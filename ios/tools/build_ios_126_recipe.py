"""Rebuild the iOS 1.26 bytecode resources from the stock bundle.

This is an offline release-engineering helper. It consumes artifacts extracted
from user-supplied app bundles and never embeds those artifacts in the repo. It
builds the unpaired bundle, the dynamically-filled gateway template and its
metadata, validates an actual URL/token injection, and optionally writes the
three deterministic byte patches used by the release patcher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from dataclasses import replace
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ios.tools.hbc98.model import (  # noqa: E402
    ExceptionHandler,
    FunctionEdit,
    FunctionMetadata,
    HBCFile,
    NewFunction,
    remap_exception_handlers,
)
from ios.tools.hbc98.audit import audit_hbc  # noqa: E402
from ios.tools.hbc98.opcodes import OPERAND_WIDTHS  # noqa: E402
from ios.tools.hbc98.strings import (  # noqa: E402
    ascii_string_map,
    hbc_strings,
    matching_target_instruction_indexes,
    remap_untagged_string_operands,
    unique_string,
)
from ios.tools.hbc98.requirements import (  # noqa: E402
    body_requirements,
    effective_header,
    hbc_metadata_issues,
    merge_replacement_metadata,
    require_metadata,
)
from ios.release import bytepatch  # noqa: E402


EXPECTED_STOCK_SHA256 = (
    '619c8a542355f6ff64695f3c4f2ec7cb4835e8a284040fa423ccda655ffcb08f'
)
EXPECTED_GATEWAY_SHA256 = (
    '1fe92c5c37f401eaef0ea4c4eb574471c828e1f99b96826919f74f550d178bf2'
)
EXPECTED_GATEWAY_SHA256_WITH_AVATAR_MOTION = (
    'a0cf308a5b3d9ecdb5285373011d8be8e7a19924e8347b55f2d364cc96e4757f'
)
CHAT_AVATAR_FUNCTION = 40727
CHAT_AVATAR_DEFAULT_STATIC_INDEX = 16147
CHAT_AVATAR_LIVE_INDEX = 17658
CHAT_AVATAR_LOAD_OFFSET = 52
NATIVE_PLUGIN_ENTRIES_FUNCTION = 52198
EMPTY_ARRAY_STUB = bytes.fromhex('080000007600')  # NewArray r0, 0; Ret r0
RET_THIS_STUB = bytes.fromhex('8900007600')  # LoadParam r0, 0; Ret r0
STUB_NAMES = {
    bytes.fromhex('96007600'): 'false',
    bytes.fromhex('93007600'): 'undefined',
    bytes.fromhex('94007600'): 'null',
    bytes.fromhex('95007600'): 'true',
    RET_THIS_STUB: 'this',
}
# The stage-5 analysis called target function #42667 "true", but its legacy
# source function #30474 is the null-return body below. Preserve the actual
# legacy behavior explicitly.
REPORTED_STUB_LABEL_FIXES = {42667: ('true', 'null')}
EXPECTED_EDITS = 51
# These stage-5 rows are similarity-map false positives rather than valid
# version ports. Legacy #10149 was incorrectly mapped to stock #13169, which
# is already the complete StorageService member initializer in 1.26; replacing
# it leaves readCache undefined and breaks AppServicesProvider at startup.
# Legacy #19098 (``dial``) also belongs to the voice shell, which the
# private-server patch does not replace. Legacy #30493 (``stampSender``)
# similarly reads DevGatewayOverride, which 1.26 removed from the stock
# implementation, so carrying it across leaves AppServices.StorageService
# unavailable at startup.
DROPPED_REPORT_TARGETS = {13169, 16861, 23695, 29551, 33302}
NEW_FUNCTION_COUNT = 6
OLD_NEW_FUNCTION_START = 68583
NEW_FUNCTION_START = 85263
OLD_GLOBAL_STRING_INDEX = 30215
NEW_GLOBAL_STRING_INDEX = 23898

UNPAIRED_COVERS = {
    16822: bytes.fromhex('93007600'),  # undefined
    16861: RET_THIS_STUB,              # AppsFlyerService.start -> return this
    16590: bytes.fromhex('96007600'),  # false
    18535: bytes.fromhex('95007600'),  # true
    18554: bytes.fromhex('96007600'),  # false
    18628: bytes.fromhex('96007600'),  # false
    19942: RET_THIS_STUB,              # BrazeService.start -> return this
    20394: bytes.fromhex('93007600'),  # undefined
    18312: bytes.fromhex('93007600'),  # undefined
}
UNPAIRED_FULL32 = {
    16774: 13672,
    30595: 31169,
}
UNPAIRED_CACHE_FIXES = frozenset(UNPAIRED_FULL32)
UNPAIRED_ALL_TARGETS = frozenset(UNPAIRED_COVERS) | frozenset(UNPAIRED_FULL32)
PROMISE_TRUE_PREFIX = bytes.fromhex(
    '3d0148020100210044010201de95006e010102007601'
)

GATEWAY_SHELL_FUNCTION = 23387
MOBILE_SESSION_CONVERGENCE_FUNCTION = 17241
MOBILE_SESSION_FALSE_STUB = bytes.fromhex('96007600')
GATEWAY_BODY_CAPACITY = 24600
GATEWAY_OPCODE_NAMES = (
    'NewObject',
    'LoadConstString',
    'LoadConstStringLongIndex',
    'LoadConstUInt8',
    'Add',
    'DefineOwnById',
    'DefineOwnByIdLong',
    'Ret',
)
RECIPE_NAMES = {
    'unpaired': 'unpaired.hbc.gbp.gz',
    'gateway': 'gateway-template.hbc.gbp.gz',
    'metadata': 'gateway-template.json.gbp.gz',
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_hex_bodies(path: Path) -> dict[int, bytes]:
    raw = json.loads(path.read_text(encoding='utf-8'))
    return {int(index): bytes.fromhex(value) for index, value in raw.items()}


def load_bodies(work_dir: Path) -> dict[int, bytes]:
    bodies = read_hex_bodies(work_dir / 'bodies_full.json')
    bodies.update(read_hex_bodies(work_dir / 'bodies_plan.json'))
    bodies.update(read_hex_bodies(work_dir / 'bodies_fix_longidx.json'))
    for index, body in read_hex_bodies(work_dir / 'covers_extra.json').items():
        bodies.setdefault(index, body)
    return bodies


def parse_frame_pair(action: str) -> tuple[int, int] | None:
    match = re.search(r'frame (\d+)->(\d+)', action)
    return (int(match.group(1)), int(match.group(2))) if match else None


def metadata_record(metadata: FunctionMetadata) -> dict[str, object]:
    return {
        'paramCount': metadata.param_count,
        'loopDepth': metadata.loop_depth,
        'functionName': metadata.function_name,
        'numberRegCount': metadata.number_reg_count,
        'nonPointerRegCount': metadata.non_pointer_reg_count,
        'frameSize': metadata.frame_size,
        'readCacheSize': metadata.read_cache_size,
        'writeCacheSize': metadata.write_cache_size,
        'numCacheNewObject': metadata.num_cache_new_object,
        'privateNameCacheSize': metadata.private_name_cache_size,
        'flags': metadata.flags,
    }


def cover_body(file: HBCFile, index: int, stub: bytes) -> tuple[bytes, int]:
    header = effective_header(file, index)
    original = file.data[header.offset:header.offset + header.bytecode_size]
    group = next(
        group for group in file.body_groups if group.offset == header.offset
    )
    boundary = next(
        (
            instruction.offset - header.offset
            for instruction in group.instructions
            if instruction.offset - header.offset >= len(stub)
        ),
        len(original),
    )
    return stub + original[boundary:], boundary


def equal_length_cover_body(file: HBCFile, index: int, stub: bytes) -> tuple[bytes, int]:
    """Return a return-stub cover without changing the function's byte length."""

    header = effective_header(file, index)
    original = file.data[header.offset:header.offset + header.bytecode_size]
    group = next(
        group for group in file.body_groups if group.offset == header.offset
    )
    boundary = next(
        (
            instruction.offset - header.offset
            for instruction in group.instructions
            if instruction.offset - header.offset >= len(stub)
        ),
        len(original),
    )
    body = stub + b'\0' * (boundary - len(stub)) + original[boundary:]
    if len(body) != len(original):
        raise AssertionError(f'Function {index} cover changed the body length')
    file.opcodes.decode(body, 0, len(body))
    return body, boundary


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
        instruction for instruction in instructions
        if instruction.name == 'LoadConstString'
        and instruction.offset == CHAT_AVATAR_LOAD_OFFSET
        and instruction.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
    ]
    if len(matches) != 1:
        raise ValueError('ChatAvatar default static branch is not unique')
    if sum(
        instruction.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and instruction.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
        for instruction in instructions
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
    output[encoded:encoded + width] = CHAT_AVATAR_LIVE_INDEX.to_bytes(
        width, 'little'
    )
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
        instruction
        for instruction in instructions
        if instruction.name == 'LoadConstString'
        and instruction.offset == CHAT_AVATAR_LOAD_OFFSET
    ]
    if len(defaults) != 1 or defaults[0].operands[-1] != CHAT_AVATAR_LIVE_INDEX:
        raise AssertionError(f'{label} does not default ChatAvatar to live')
    if any(
        instruction.name in ('LoadConstString', 'LoadConstStringLongIndex')
        and instruction.operands[-1] == CHAT_AVATAR_DEFAULT_STATIC_INDEX
        for instruction in instructions
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


def require_clean(file: HBCFile, label: str) -> None:
    audit_hbc(file).require_ok(label)
    if file.validation.errors or file.validation.invalid_opcodes:
        file.validation.require_ok()
    metadata_issues = hbc_metadata_issues(file)
    if metadata_issues:
        raise ValueError(
            f'{label} has {len(metadata_issues)} metadata/body mismatches: '
            f'{metadata_issues[:5]}'
        )


def build_edits(
    stock: HBCFile, legacy: HBCFile, work_dir: Path
) -> tuple[dict[int, FunctionEdit], list[NewFunction], list[dict[str, object]]]:
    report = json.loads(
        (work_dir / 'assemble_report.stage5.json').read_text(encoding='utf-8')
    )
    if not isinstance(report, list):
        raise ValueError('Stage 5 report must be a JSON array')
    dropped = [row for row in report if int(row[2]) in DROPPED_REPORT_TARGETS]
    dropped_targets = {int(row[2]) for row in dropped}
    if dropped_targets != DROPPED_REPORT_TARGETS or len(dropped) != len(DROPPED_REPORT_TARGETS):
        raise ValueError(
            'Stage 5 report does not contain the expected dropped targets: '
            f'{sorted(DROPPED_REPORT_TARGETS)}'
        )
    valid = [row for row in report if row[2] and int(row[2]) not in DROPPED_REPORT_TARGETS]
    if len(valid) != EXPECTED_EDITS:
        raise ValueError(f'Expected {EXPECTED_EDITS} edits, found {len(valid)}')
    indexes = [int(row[2]) for row in valid]
    if len(indexes) != len(set(indexes)):
        raise ValueError('Stage 5 report contains duplicate target functions')

    bodies = load_bodies(work_dir)
    replacements: dict[int, FunctionEdit] = {}
    records: list[dict[str, object]] = []
    seen_legacy: set[int] = set()
    for old_index, action, target_index in valid:
        old_index = int(old_index)
        target_index = int(target_index)
        if old_index in seen_legacy:
            raise ValueError(f'Legacy function {old_index} is mapped more than once')
        seen_legacy.add(old_index)
        if old_index not in bodies:
            raise ValueError(f'Missing body for legacy function {old_index}')
        body = bodies[old_index]
        legacy_small = legacy.function_headers[old_index]
        legacy_header = effective_header(legacy, old_index)
        legacy_info = (
            legacy.function_infos.get(legacy_small.full_header_offset)
            if legacy_small.overflowed
            else None
        )
        stock_small = stock.function_headers[target_index]
        header = effective_header(stock, target_index)
        stock_info = (
            stock.function_infos.get(stock_small.full_header_offset)
            if stock_small.overflowed
            else None
        )
        original = stock.data[header.offset:header.offset + header.bytecode_size]

        cover_match = re.match(
            r'COVER-(false|undefined|null|true)\+reloc\(k=(\d+)\)', action
        )
        if cover_match:
            expected_name = cover_match.group(1)
            if target_index in REPORTED_STUB_LABEL_FIXES:
                reported, corrected = REPORTED_STUB_LABEL_FIXES[target_index]
                if expected_name != reported:
                    raise ValueError(
                        f'Function {target_index} report no longer uses the expected '
                        f'{reported!r} label'
                    )
                expected_name = corrected
            expected_boundary = int(cover_match.group(2))
            if STUB_NAMES.get(body) != expected_name:
                raise ValueError(
                    f'Function {target_index} does not contain the reported {expected_name} stub'
                )
            body, boundary = cover_body(stock, target_index, body)
            if boundary != expected_boundary:
                raise ValueError(
                    f'Function {target_index} cover boundary is {boundary}, '
                    f'report says {expected_boundary}'
                )
            placement = f'cover-{expected_name}-reloc'
            handler_source_body = original
        elif action == 'INPLACE':
            if len(body) != header.bytecode_size:
                raise ValueError(
                    f'In-place function {target_index} is {len(body)} bytes, '
                    f'stock is {header.bytecode_size}'
                )
            placement = 'inplace'
            handler_source_body = legacy.data[
                legacy_header.offset:legacy_header.offset + legacy_header.bytecode_size
            ]
        elif action.startswith('APPEND'):
            placement = 'append'
            handler_source_body = legacy.data[
                legacy_header.offset:legacy_header.offset + legacy_header.bytecode_size
            ]
        else:
            raise ValueError(f'Unsupported stage 5 action for function {target_index}: {action}')

        if body == original:
            raise ValueError(
                f'Function {target_index} would be identical to the stock body'
            )

        body_info = stock_info if cover_match else legacy_info

        string_remaps = ()
        preserved_string_operands = ()
        target_origin_instruction_count = 0
        if not cover_match:
            # Replayed bodies can retain target instructions and insert only the
            # legacy patch hunks. Preserve target string indexes for every
            # instruction proven to come from the stock 1.26 body; remap only
            # the inserted legacy instructions.
            target_origin = matching_target_instruction_indexes(
                stock,
                original,
                body,
            )
            target_origin_instruction_count = len(target_origin)
            source_instruction_indexes = (
                set(range(len(stock.opcodes.decode(body, 0, len(body)))))
                - target_origin
            )
            string_result = remap_untagged_string_operands(
                legacy,
                stock,
                body,
                stock.opcodes,
                source_instruction_indexes=source_instruction_indexes,
            )
            body = string_result.body
            string_remaps = string_result.changes
            preserved_string_operands = string_result.preserved

        # Every replacement must be a complete instruction stream in the stock
        # opcode table, including the retained tail after a four-byte stub.
        stock.opcodes.decode(body, 0, len(body))
        requirements = body_requirements(stock.opcodes, body)
        if cover_match:
            metadata = FunctionMetadata.from_header(header)
            require_metadata(
                requirements,
                metadata,
                label=f'COVER target function {target_index}',
            )
        else:
            metadata = merge_replacement_metadata(
                legacy=FunctionMetadata.from_header(legacy_header),
                stock=FunctionMetadata.from_header(header),
                requirements=requirements,
                has_exception_section=bool(
                    body_info and body_info.header.has_exception_handler
                ),
                has_debug_info=bool(body_info and body_info.debug_offset is not None),
            )

        raw_exception_handlers = body_info.exception_handlers if body_info else ()
        try:
            exception_handlers = remap_exception_handlers(
                raw_exception_handlers,
                source_body=handler_source_body,
                target_body=body,
                opcodes=stock.opcodes,
            )
        except ValueError as error:
            raise ValueError(
                f'Function {target_index} exception handlers cannot be remapped: {error}'
            ) from error

        frame_pair = parse_frame_pair(action)
        replacements[target_index] = FunctionEdit(
            body=body,
            metadata=metadata,
            exception_handlers=exception_handlers,
            debug_offset=body_info.debug_offset if body_info else None,
            replace_exception_handlers=True,
            replace_debug_offset=True,
        )
        records.append(
            {
                'oldFunction': old_index,
                'newFunction': target_index,
                'placement': placement,
                'sourceBytes': header.bytecode_size,
                'targetBytes': len(body),
                'frameSize': metadata.frame_size,
                'reportedFrameSize': frame_pair[1] if frame_pair else None,
                'requirements': requirements.as_dict(),
                'metadata': metadata_record(metadata),
                'exceptionHandlers': [
                    {'start': item.start, 'end': item.end, 'target': item.target}
                    for item in exception_handlers
                ],
                'stringOperandRemaps': [
                    {
                        'offset': item.offset,
                        'opcode': item.opcode,
                        'sourceIndex': item.source_index,
                        'targetIndex': item.target_index,
                        'text': item.text,
                    }
                    for item in string_remaps
                ],
                'preservedStringOperands': list(preserved_string_operands),
                'targetOriginInstructionCount': target_origin_instruction_count,
                'bodySha256': sha256(body),
            }
        )

    new_bodies = read_hex_bodies(work_dir / 'new6.json')
    additions: list[NewFunction] = []
    for offset in range(NEW_FUNCTION_COUNT):
        old_index = OLD_NEW_FUNCTION_START + offset
        if old_index not in new_bodies:
            raise ValueError(f'Missing body for legacy function {old_index}')
        body = new_bodies[old_index]
        stock.opcodes.decode(body, 0, len(body))
        old_header = effective_header(legacy, old_index)
        metadata = FunctionMetadata.from_header(old_header)
        if metadata.function_name == OLD_GLOBAL_STRING_INDEX:
            metadata = replace(metadata, function_name=NEW_GLOBAL_STRING_INDEX)
        requirements = body_requirements(stock.opcodes, body)
        require_metadata(
            requirements,
            metadata,
            label=f'new target function {NEW_FUNCTION_START + offset}',
        )
        additions.append(NewFunction(body=body, metadata=metadata))
        records.append(
            {
                'oldFunction': old_index,
                'newFunction': NEW_FUNCTION_START + offset,
                'placement': 'addition',
                'sourceBytes': 0,
                'targetBytes': len(body),
                'frameSize': metadata.frame_size,
                'requirements': requirements.as_dict(),
                'metadata': metadata_record(metadata),
                'bodySha256': sha256(body),
            }
        )
    return replacements, additions, records


def build_unpaired(stock: HBCFile) -> tuple[bytes, dict[str, object]]:
    """Build the equal-size unpaired bundle used before Host pairing."""

    if len(stock.function_headers) != NEW_FUNCTION_START:
        raise ValueError(
            f'Expected stock function count {NEW_FUNCTION_START}, '
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

    for index, old_index in UNPAIRED_FULL32.items():
        header = effective_header(stock, index)
        original = stock.data[header.offset:header.offset + header.bytecode_size]
        if len(original) != 32:
            raise ValueError(f'Function {index} is {len(original)} bytes, expected 32')
        body = PROMISE_TRUE_PREFIX + original[len(PROMISE_TRUE_PREFIX):]
        if len(body) != len(original):
            raise AssertionError(f'Promise stub changed function {index} length')
        stock.opcodes.decode(body, 0, len(body))
        metadata = replace(
            FunctionMetadata.from_header(header),
            read_cache_size=2,
        )
        requirements = body_requirements(stock.opcodes, body)
        require_metadata(requirements, metadata, label=f'unpaired Promise stub {index}')
        replacements[index] = FunctionEdit(body=body, metadata=metadata)
        records.append(
            {
                'function': index,
                'oldFunction': old_index,
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
    require_clean(target, 'Generated unpaired bundle')
    assert_chat_avatar_motion(target, 'Generated unpaired bundle')

    for index, (before, after) in enumerate(
        zip(stock.function_headers, target.function_headers)
    ):
        before_header = effective_header(stock, index)
        after_header = effective_header(target, index)
        if (before_header.offset, before_header.bytecode_size) != (
            after_header.offset,
            after_header.bytecode_size,
        ):
            raise AssertionError(f'Function {index} body offset or size changed')

    before_metadata = {
        index: FunctionMetadata.from_header(effective_header(stock, index))
        for index in range(len(stock.function_headers))
    }
    after_metadata = {
        index: FunctionMetadata.from_header(effective_header(target, index))
        for index in range(len(stock.function_headers))
    }
    changed_metadata = {
        index for index in before_metadata
        if before_metadata[index] != after_metadata[index]
    }
    if changed_metadata != set(UNPAIRED_CACHE_FIXES):
        raise AssertionError(
            f'Unexpected metadata changes: {sorted(changed_metadata)}'
        )
    for index in UNPAIRED_CACHE_FIXES:
        differences = [
            name for name in before_metadata[index].__dataclass_fields__
            if getattr(before_metadata[index], name)
            != getattr(after_metadata[index], name)
        ]
        if differences != ['read_cache_size']:
            raise AssertionError(
                f'Function {index} metadata changes are {differences}'
            )

    target_groups = {group.offset: group for group in target.body_groups}
    if set(target_groups) != {group.offset for group in stock.body_groups}:
        raise AssertionError('Unpaired body layout changed')
    changed_bodies: set[int] = set()
    for group in stock.body_groups:
        other = target_groups[group.offset]
        if group.size != other.size:
            raise AssertionError(f'Body group 0x{group.offset:x} changed size')
        if group.bytes != other.bytes:
            changed_bodies.update(group.function_indexes)
    expected_changed = set(UNPAIRED_ALL_TARGETS) | {CHAT_AVATAR_FUNCTION}
    if changed_bodies != expected_changed:
        raise AssertionError(
            f'Unexpected function bodies changed: {sorted(changed_bodies)}'
        )

    if target.sections['string_storage'].data != stock.sections['string_storage'].data:
        raise AssertionError('Unpaired bundle unexpectedly changed the string storage')

    footer = len(target.data) - 20
    if hashlib.sha1(target.data[:footer]).digest() != target.data[footer:]:
        raise AssertionError('Unpaired footer SHA-1 is incorrect')

    allowed_differences: set[int] = set()
    for index in expected_changed:
        header = effective_header(stock, index)
        allowed_differences.update(
            range(header.offset, header.offset + header.bytecode_size)
        )
    for index in UNPAIRED_CACHE_FIXES:
        small = stock.function_headers[index]
        if small.full_header_offset is None:
            raise AssertionError(f'Function {index} has no full header')
        allowed_differences.add(small.full_header_offset + 32)
    allowed_differences.update(range(footer, len(target.data)))
    unexpected = [
        offset for offset, (before, after) in enumerate(zip(stock.data, target.data))
        if before != after and offset not in allowed_differences
    ]
    if unexpected:
        raise AssertionError(
            f'Unexpected byte differences outside body/string/header/footer: '
            f'{unexpected[:20]}'
        )

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


def build_gateway_metadata(
    stock: HBCFile,
    gateway: HBCFile,
    gateway_bytes: bytes,
) -> tuple[dict[str, object], bytes]:
    """Build the metadata consumed by ``GBHermes.m`` for URL/token injection."""

    if len(gateway.function_headers) != NEW_FUNCTION_START + NEW_FUNCTION_COUNT:
        raise ValueError('Gateway function count does not match the recipe')

    small = gateway.function_headers[GATEWAY_SHELL_FUNCTION]
    if not small.overflowed or small.full_header_offset is None:
        raise ValueError(
            f'Gateway shell function {GATEWAY_SHELL_FUNCTION} must use a full header'
        )
    shell = effective_header(gateway, GATEWAY_SHELL_FUNCTION)
    if shell.bytecode_size != GATEWAY_BODY_CAPACITY:
        raise ValueError(
            f'Gateway shell capacity is {shell.bytecode_size}, '
            f'expected {GATEWAY_BODY_CAPACITY}'
        )

    strings = ascii_string_map(gateway)
    expected_ascii = {chr(code) for code in range(33, 127)}
    if set(strings) != expected_ascii:
        missing = sorted(expected_ascii - set(strings))
        extra = sorted(set(strings) - expected_ascii)
        raise ValueError(
            f'Gateway ASCII map is incomplete: missing={missing}, extra={extra}'
        )

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
        'strings': {
            str(ord(character)): index
            for character, index in strings.items()
        },
        'emptyString': empty.index,
        'urlKey': url.index,
        'tokenKey': token.index,
        'opcodes': opcodes,
        'maxUrlLength': 2048,
        'maxTokenLength': 1024,
    }
    metadata_bytes = (json.dumps(metadata, indent=2) + '\n').encode('utf-8')
    return metadata, metadata_bytes


def _gateway_u8(output: bytearray, value: int) -> None:
    if not 0 <= value <= 0xFF:
        raise ValueError(f'Gateway byte does not fit in U8: {value}')
    output.append(value)


def _gateway_u16(output: bytearray, value: int) -> None:
    if not 0 <= value <= 0xFFFF:
        raise ValueError(f'Gateway short does not fit in U16: {value}')
    output.extend(struct.pack('<H', value))


def _gateway_u32(output: bytearray, value: int) -> None:
    if not 0 <= value <= 0xFFFFFFFF:
        raise ValueError(f'Gateway value does not fit in U32: {value}')
    output.extend(struct.pack('<I', value))


def _gateway_string(
    output: bytearray,
    metadata: dict[str, object],
    register: int,
    index: int,
) -> None:
    opcodes = metadata['opcodes']
    if not isinstance(opcodes, dict):
        raise TypeError('Gateway metadata opcodes must be an object')
    if index < 65536:
        _gateway_u8(output, int(opcodes['LoadConstString']))
        _gateway_u8(output, register)
        _gateway_u16(output, index)
    else:
        _gateway_u8(output, int(opcodes['LoadConstStringLongIndex']))
        _gateway_u8(output, register)
        _gateway_u32(output, index)


def build_gateway_body(
    metadata: dict[str, object],
    url: str,
    token: str,
) -> bytes:
    """Mirror ``GBHermes.m`` byte-for-byte for a fixed URL and token."""

    if not url or len(url) > 2048 or not token or len(token) > 1024:
        raise ValueError('Invalid URL or token length')
    opcodes = metadata['opcodes']
    strings = metadata['strings']
    if not isinstance(opcodes, dict) or not isinstance(strings, dict):
        raise TypeError('Gateway metadata is malformed')
    output = bytearray()
    _gateway_u8(output, int(opcodes['NewObject']))
    _gateway_u8(output, 0)

    for cache, value in enumerate((url, token)):
        _gateway_string(output, metadata, 1, int(metadata['emptyString']))
        for character in value:
            codepoint = ord(character)
            if not 33 <= codepoint <= 126:
                raise ValueError(
                    'The Host address and token must contain printable ASCII only'
                )
            index = strings.get(str(codepoint))
            if index is not None:
                _gateway_string(output, metadata, 2, int(index))
            elif '0' <= character <= '9':
                _gateway_u8(output, int(opcodes['LoadConstUInt8']))
                _gateway_u8(output, 2)
                _gateway_u8(output, codepoint - ord('0'))
            else:
                raise ValueError(f'Unsupported gateway character: {character!r}')
            _gateway_u8(output, int(opcodes['Add']))
            _gateway_u8(output, 1)
            _gateway_u8(output, 1)
            _gateway_u8(output, 2)

        key = int(metadata['urlKey'] if cache == 0 else metadata['tokenKey'])
        long_form = key >= 65536
        _gateway_u8(
            output,
            int(opcodes['DefineOwnByIdLong' if long_form else 'DefineOwnById']),
        )
        _gateway_u8(output, 0)
        _gateway_u8(output, 1)
        _gateway_u8(output, cache)
        if long_form:
            _gateway_u32(output, key)
        else:
            _gateway_u16(output, key)

    _gateway_u8(output, int(opcodes['Ret']))
    _gateway_u8(output, 0)
    return bytes(output)


def inject_gateway(
    template: bytes,
    metadata: dict[str, object],
    url: str,
    token: str,
) -> tuple[bytes, bytes]:
    """Apply the same body replacement and footer rewrite as ``GBHermes.m``."""

    body = build_gateway_body(metadata, url, token)
    offset = int(metadata['bodyOffset'])
    capacity = int(metadata['bodyCapacity'])
    length_offset = int(metadata['bodyLengthOffset'])
    footer_start = len(template) - 20
    if len(body) > capacity:
        raise ValueError(f'Injected body is {len(body)} bytes; capacity is {capacity}')
    if offset < 0 or offset + capacity > footer_start:
        raise ValueError('Gateway body range extends into the footer')
    if length_offset < 0 or length_offset + 4 >= footer_start:
        raise ValueError('Gateway body length field extends into the footer')

    output = bytearray(template)
    output[offset:offset + len(body)] = body
    output[offset + len(body):offset + capacity] = b'\0' * (capacity - len(body))
    struct.pack_into('<I', output, length_offset, len(body))
    output[footer_start:footer_start + 20] = hashlib.sha1(
        output[:footer_start]
    ).digest()
    return bytes(output), body


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
    require_clean(parsed, 'Injected gateway bundle')
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
            f'Injected gateway header length is {header.bytecode_size}, '
            f'expected {len(body)}'
        )
    if struct.unpack_from('<I', injected, length_offset)[0] != len(body):
        raise AssertionError('Injected gateway length field does not match the body')
    if any(injected[offset + len(body):offset + capacity]):
        raise AssertionError('Injected gateway capacity was not zero-filled')
    if hashlib.sha1(injected[:-20]).digest() != injected[-20:]:
        raise AssertionError('Injected gateway footer SHA-1 is incorrect')
    audit = audit_hbc(parsed)
    audit.require_ok('Injected gateway bundle')
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


def write_artifact(path: Path, data: bytes, *, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f'Output already exists: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def build_recipes(
    stock: bytes,
    targets: dict[str, bytes],
    recipes_dir: Path,
    *,
    overwrite: bool,
) -> dict[str, object]:
    recipes: dict[str, object] = {}
    for name, target in targets.items():
        path = recipes_dir / RECIPE_NAMES[name]
        if path.exists() and not overwrite:
            raise FileExistsError(f'Recipe already exists: {path}')
        recipe = bytepatch.create(stock, target)
        if bytepatch.apply(stock, recipe) != target:
            raise AssertionError(f'{name} recipe failed round-trip')
        path.parent.mkdir(parents=True, exist_ok=True)
        bytepatch.save(path, recipe)
        recipes[name] = {
            'path': str(path),
            'sourceSha256': recipe['sourceSha256'],
            'targetSha256': recipe['targetSha256'],
            'targetBytes': recipe['targetBytes'],
            'operations': len(recipe['ops']),
        }
    return recipes


def _encode_ins(opcodes, name: str, *operands: int) -> bytes:
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


def apply_clean_126_fixes(
    stock: HBCFile,
    legacy: HBCFile,
    replacements: dict[int, FunctionEdit],
    additions: list[NewFunction],
) -> None:
    """Replace stage-5 heuristic artifacts with verified native 1.26 patches."""

    opcodes = stock.opcodes
    strs = hbc_strings(stock)
    legacy_strs = hbc_strings(legacy)

    # 1. Restore fn#71298 (FileAttachmentCard helper wrongly overwritten with Onboarding t4).
    replacements.pop(71298, None)

    # 2. Equal-length return covers for telemetry/statsig/voice-shell hooks.
    #    AppsFlyerService.start (16861) and BrazeService.start (19942) are fluent
    #    methods whose callers chain `.start()` and dereference the returned `this`.
    clean_covers = {
        16590: bytes.fromhex('96007600'),  # canRecord -> false
        16822: bytes.fromhex('93007600'),  # record -> undefined
        16861: RET_THIS_STUB,              # AppsFlyerService.start -> return this
        18312: bytes.fromhex('93007600'),  # log -> undefined
        18535: bytes.fromhex('95007600'),  # isStatsigDisabled -> true
        18554: bytes.fromhex('96007600'),  # shouldFetch -> false
        18628: bytes.fromhex('96007600'),  # sandStatsigNetworkUrlAllowed -> false
        19942: RET_THIS_STUB,              # BrazeService.start -> return this
        20394: bytes.fromhex('93007600'),  # SandSentry.init -> undefined
        MOBILE_SESSION_CONVERGENCE_FUNCTION: MOBILE_SESSION_FALSE_STUB,
        23692: bytes.fromhex('93007600'),  # ingestInboundNudge -> undefined
        23736: bytes.fromhex('93007600'),  # tellHost -> undefined
        23741: bytes.fromhex('93007600'),  # startUsageBeat -> undefined
        23743: bytes.fromhex('93007600'),  # startSpokenDrain -> undefined
        42667: bytes.fromhex('94007600'),  # VoiceSettingsGroup -> null
        57959: bytes.fromhex('96007600'),  # isResumptionEnabled -> false
    }
    for idx, stub in clean_covers.items():
        body, _ = equal_length_cover_body(stock, idx, stub)
        replacements[idx] = FunctionEdit(body=body)

    # 3. Telemetry sinks (16774 BackendAnalyticsSink.send, 30595 BackendLogSink.submit) -> Promise.resolve(true).
    for idx in UNPAIRED_FULL32:
        h = effective_header(stock, idx)
        orig = stock.data[h.offset:h.offset + h.bytecode_size]
        if len(orig) != 32:
            raise ValueError(f'Telemetry sink fn#{idx} is {len(orig)} bytes, expected 32')
        body = PROMISE_TRUE_PREFIX + orig[len(PROMISE_TRUE_PREFIX):]
        opcodes.decode(body, 0, len(body))
        meta = replace(FunctionMetadata.from_header(h), read_cache_size=max(h.read_cache_size, 2))
        require_metadata(body_requirements(opcodes, body), meta, label=f'promise-true fn#{idx}')
        replacements[idx] = FunctionEdit(body=body, metadata=meta)

    # 4. ChatAvatar default motion -> 'live'.
    avatar_header = effective_header(stock, CHAT_AVATAR_FUNCTION)
    avatar_original = stock.data[avatar_header.offset:avatar_header.offset + avatar_header.bytecode_size]
    replacements[CHAT_AVATAR_FUNCTION] = FunctionEdit(
        body=enable_chat_avatar_motion(stock, avatar_original)
    )

    # 5. fn#29551 (stampSender): if (DevGatewayOverride.read() !== undefined) return undefined;
    #    Parent env slot 56 matches buildLive (fn#29545 offset 359) in stock 1.26.0.
    sh = effective_header(stock, 29551)
    sorig = stock.data[sh.offset:sh.offset + sh.bytecode_size]
    prefix_29551 = (
        _encode_ins(opcodes, 'GetParentEnvironment', 0, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 0, 0, 56)
        + _encode_ins(opcodes, 'GetById', 1, 0, 0, _unique_str_idx(strs, 'DevGatewayOverride'))
        + _encode_ins(opcodes, 'GetById', 0, 1, 1, _unique_str_idx(strs, 'read'))
        + _encode_ins(opcodes, 'Call1', 0, 0, 1)
        + _encode_ins(opcodes, 'LoadConstUndefined', 1)
        + _encode_ins(opcodes, 'JStrictEqual', 6, 0, 1)
        + _encode_ins(opcodes, 'Ret', 1)
    )
    if len(prefix_29551) != 31:
        raise AssertionError(f'Unexpected stampSender prefix length: {len(prefix_29551)}')
    body_29551 = prefix_29551 + sorig
    opcodes.decode(body_29551, 0, len(body_29551))
    req_29551 = body_requirements(opcodes, body_29551)
    meta_29551 = replace(
        FunctionMetadata.from_header(sh),
        frame_size=max(sh.frame_size, req_29551.frame_size, 14),
        read_cache_size=max(sh.read_cache_size, req_29551.read_cache_entries, 2),
    )
    require_metadata(req_29551, meta_29551, label='stampSender fn#29551')
    replacements[29551] = FunctionEdit(body=body_29551, metadata=meta_29551)

    # 6. fn#29444 (ownerRoute): route devGateway sessions to { kind: 'current' } on top of stock 1.26.
    oh = effective_header(stock, 29444)
    oorig = stock.data[oh.offset:oh.offset + oh.bytecode_size]
    prefix_29444 = (
        _encode_ins(opcodes, 'LoadParam', 0, 0)
        + _encode_ins(opcodes, 'GetById', 0, 0, 0, _unique_str_idx(strs, 'auth'))
        + _encode_ins(opcodes, 'GetById', 0, 0, 1, _unique_str_idx(strs, 'state'))
        + _encode_ins(opcodes, 'GetById', 0, 0, 2, _unique_str_idx(strs, 'current'))
        + _encode_ins(opcodes, 'GetById', 1, 0, 3, _unique_str_idx(strs, 'phase'))
        + _encode_ins(opcodes, 'LoadConstStringLongIndex', 2, _unique_str_idx(strs, 'loggedIn'))
        + _encode_ins(opcodes, 'JStrictNotEqual', 34, 1, 2)
        + _encode_ins(opcodes, 'GetById', 1, 0, 4, _unique_str_idx(strs, 'session'))
        + _encode_ins(opcodes, 'LoadConstStringLongIndex', 2, _unique_str_idx(strs, 'devGateway'))
        + _encode_ins(opcodes, 'JStrictNotEqual', 18, 1, 2)
        + _encode_ins(opcodes, 'NewObject', 0)
        + _encode_ins(opcodes, 'LoadConstString', 1, _unique_str_idx(strs, 'current'))
        + _encode_ins(opcodes, 'DefineOwnById', 0, 1, 0, _unique_str_idx(strs, 'kind'))
        + _encode_ins(opcodes, 'Ret', 0)
    )
    if len(prefix_29444) != 67:
        raise AssertionError(f'Unexpected ownerRoute prefix length: {len(prefix_29444)}')
    body_29444 = prefix_29444 + oorig
    opcodes.decode(body_29444, 0, len(body_29444))
    req_29444 = body_requirements(opcodes, body_29444)
    meta_29444 = replace(
        FunctionMetadata.from_header(oh),
        frame_size=max(oh.frame_size, req_29444.frame_size),
        read_cache_size=max(oh.read_cache_size, req_29444.read_cache_entries),
        write_cache_size=max(oh.write_cache_size, req_29444.write_cache_entries, 1),
    )
    require_metadata(req_29444, meta_29444, label='ownerRoute fn#29444')
    replacements[29444] = FunctionEdit(body=body_29444, metadata=meta_29444)

    # 7. fn#33308 (routedLane): 4-byte in-place jump patch preserving stock StringSwitchImm.
    rh = effective_header(stock, 33308)
    rorig = bytearray(stock.data[rh.offset:rh.offset + rh.bytecode_size])
    rinsns = opcodes.decode(bytes(rorig), 0, len(rorig))
    if not (rinsns[5].offset == 26 and rinsns[5].name == 'JStrictEqualLong' and rinsns[5].operands == (130, 2, 1)):
        raise ValueError('routedLane fn#33308 anchor moved')
    if not (rinsns[9].offset == 44 and rinsns[9].name == 'LoadConstString' and rinsns[9].operands == (1, _unique_str_idx(strs, 'gateway'))):
        raise ValueError('routedLane fn#33308 gateway branch moved')
    rorig[26:33] = _encode_ins(opcodes, 'JStrictEqualLong', 18, 2, 1)
    body_33308 = bytes(rorig)
    opcodes.decode(body_33308, 0, len(body_33308))
    replacements[33308] = FunctionEdit(body=body_33308)

    # 8. fn#33302 (gatewayPorts): 1-byte in-place env slot fix (1.26 stores gateway in env 2).
    gh = effective_header(stock, 33302)
    gorig = bytearray(stock.data[gh.offset:gh.offset + gh.bytecode_size])
    ginsns = opcodes.decode(bytes(gorig), 0, len(gorig))
    ins_res = next(item for item in ginsns if item.offset == 109)
    if not (ins_res.name == 'CreateClosure' and ins_res.operands == (3, 1, 63512)):
        raise ValueError('gatewayPorts fn#33302 CreateClosure anchor moved')
    gorig[109:114] = _encode_ins(opcodes, 'CreateClosure', 3, 2, 63512)
    body_33302 = bytes(gorig)
    opcodes.decode(body_33302, 0, len(body_33302))
    replacements[33302] = FunctionEdit(body=body_33302)

    # 9. fn#13169 (StorageService initializer): expose globalThis['grokbot.voice.storage'] = this.
    sth = effective_header(stock, 13169)
    storig = stock.data[sth.offset:sth.offset + sth.bytecode_size]
    if storig[-4:] != _encode_ins(opcodes, 'LoadConstUndefined', 0) + _encode_ins(opcodes, 'Ret', 0):
        raise ValueError('StorageService fn#13169 epilogue moved')
    suffix_13169 = (
        _encode_ins(opcodes, 'GetGlobalObject', 0)
        + _encode_ins(opcodes, 'LoadConstString', 1, _unique_str_idx(strs, 'grokbot'))
        + _encode_ins(opcodes, 'LoadConstString', 3, _unique_str_idx(strs, '.'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_ins(opcodes, 'LoadConstString', 3, _unique_str_idx(strs, 'voice'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_ins(opcodes, 'LoadConstString', 3, _unique_str_idx(strs, '.'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_ins(opcodes, 'LoadConstString', 3, _unique_str_idx(strs, 'storage'))
        + _encode_ins(opcodes, 'Add', 1, 1, 3)
        + _encode_ins(opcodes, 'PutByValStrict', 0, 1, 2)
    )
    body_13169 = storig[:-4] + suffix_13169 + storig[-4:]
    opcodes.decode(body_13169, 0, len(body_13169))
    req_13169 = body_requirements(opcodes, body_13169)
    meta_13169 = replace(
        FunctionMetadata.from_header(sth),
        frame_size=max(sth.frame_size, req_13169.frame_size),
    )
    require_metadata(req_13169, meta_13169, label='StorageService fn#13169')
    replacements[13169] = FunctionEdit(body=body_13169, metadata=meta_13169)

    # 10. fn#78160 (?anon_0_setGroupMembers): exact in-place patch on stock 1.26.
    # Stock fn#78160 has frame_size=21 and ends with ``CallBuiltin 0, 44, 2`` using
    # r12 == frame_size - 9, so frame_size MUST remain 21. Move r11 -> r7 (r7 is
    # dead after reading .gateway and overwritten by Call3's dst) so every Call3
    # source operand stays strictly below 21 - (7 + 3) == 11.
    h78160 = effective_header(stock, 78160)
    if strs[h78160.function_name].text != '?anon_0_setGroupMembers':
        raise ValueError('Function 78160 is not ?anon_0_setGroupMembers')
    b78160 = bytearray(stock.data[h78160.offset:h78160.offset + h78160.bytecode_size])
    patch_78160 = (
        _encode_ins(opcodes, 'GetById', 9, 7, 1, _unique_str_idx(strs, 'gateway'))
        + _encode_ins(opcodes, 'GetById', 8, 9, 2, _unique_str_idx(strs, 'setGroupMembers'))
        + _encode_ins(opcodes, 'Mov', 7, 11)
        + _encode_ins(opcodes, 'Call3', 7, 8, 9, 7, 10)
        + _encode_ins(opcodes, 'LoadConstUndefined', 12) * 7
    )
    if len(patch_78160) != 268 - 233:
        raise AssertionError('Unexpected setGroupMembers patch length')
    b78160[233:268] = patch_78160
    opcodes.decode(bytes(b78160), 0, len(b78160))
    replacements[78160] = FunctionEdit(body=bytes(b78160))

    # 11. fn#78164 (?anon_0_readServerIdentity): exact in-place patches on stock 1.26.
    h78164 = effective_header(stock, 78164)
    b78164 = bytearray(stock.data[h78164.offset:h78164.offset + h78164.bytecode_size])
    p1_78164 = _encode_ins(opcodes, 'Mov', 7, 0) + _encode_ins(opcodes, 'Mov', 8, 8)
    p2_78164 = (
        _encode_ins(opcodes, 'LoadConstUndefined', 9) * 3
        + _encode_ins(opcodes, 'GetById', 8, 7, 10, _unique_str_idx(strs, 'gateway'))
        + _encode_ins(opcodes, 'GetById', 7, 8, 11, _unique_str_idx(strs, 'listAgents'))
        + _encode_ins(opcodes, 'Call2', 7, 7, 8, 9)
    )
    if len(p1_78164) != 82 - 76 or len(p2_78164) != 397 - 374:
        raise AssertionError('Unexpected readServerIdentity patch length')
    b78164[76:82] = p1_78164
    b78164[374:397] = p2_78164
    opcodes.decode(bytes(b78164), 0, len(b78164))
    replacements[78164] = FunctionEdit(body=bytes(b78164))

    # 12. fn#78163 (?anon_0_applyIdentityWrite): exact in-place patches on stock 1.26.
    h78163 = effective_header(stock, 78163)
    b78163 = bytearray(stock.data[h78163.offset:h78163.offset + h78163.bytecode_size])
    p1_78163 = _encode_ins(opcodes, 'LoadConstUndefined', 7) + _encode_ins(opcodes, 'Mov', 8, 8)
    p2_core = (
        _encode_ins(opcodes, 'LoadFromEnvironment', 9, 1, 7)
        + _encode_ins(opcodes, 'GetById', 9, 9, 10, _unique_str_idx(strs, 'gateway'))
        + _encode_ins(opcodes, 'LoadConstString', 13, _unique_str_idx(strs, 'updateAgent'))
        + _encode_ins(opcodes, 'GetByVal', 8, 9, 13)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 7, 10, 0)
        + _encode_ins(opcodes, 'LoadFromEnvironment', 12, 10, 5)
        + _encode_ins(opcodes, 'Call3', 8, 8, 9, 7, 12)
    )
    rem = (728 - 621) - len(p2_core)
    if len(p1_78163) != 239 - 234 or rem < 3 or rem % 2 != 1:
        raise AssertionError('Unexpected applyIdentityWrite patch length')
    p2_78163 = p2_core + _encode_ins(opcodes, 'Mov', 13, 13) + _encode_ins(opcodes, 'LoadConstUndefined', 13) * ((rem - 3) // 2)
    b78163[234:239] = p1_78163
    b78163[621:728] = p2_78163
    opcodes.decode(bytes(b78163), 0, len(b78163))
    replacements[78163] = FunctionEdit(body=bytes(b78163))

    # 13. fn#76214 (?anon_2_startCall) & fn#76220 (?anon_0_redialTheSameCall): pass call context to mintSandVoiceCallSecret.
    h76214 = effective_header(stock, 76214)
    b76214 = bytearray(stock.data[h76214.offset:h76214.offset + h76214.bytecode_size])
    if b76214[2012:2014] != _encode_ins(opcodes, 'NewObject', 24):
        raise ValueError('startCall fn#76214 anchor moved')
    b76214[2012:2014] = _encode_ins(opcodes, 'LoadConstUndefined', 37)
    opcodes.decode(bytes(b76214), 0, len(b76214))
    replacements[76214] = FunctionEdit(body=bytes(b76214))

    h76220 = effective_header(stock, 76220)
    b76220 = bytearray(stock.data[h76220.offset:h76220.offset + h76220.bytecode_size])
    if b76220[1110:1112] != _encode_ins(opcodes, 'NewObject', 16):
        raise ValueError('redialTheSameCall fn#76220 anchor moved')
    b76220[1110:1112] = _encode_ins(opcodes, 'LoadConstUndefined', 8)
    opcodes.decode(bytes(b76220), 0, len(b76220))
    replacements[76220] = FunctionEdit(body=bytes(b76220))

    # 14. fn#42650 (CallToolbar), fn#37394 (IslandControls), fn#25252 (XaiRealtimeSession).
    h42650 = effective_header(stock, 42650)
    b42650 = bytearray(stock.data[h42650.offset:h42650.offset + h42650.bytecode_size])
    if b42650[48:54] != _encode_ins(opcodes, 'GetById', 18, 2, 5, _unique_str_idx(strs, 'onToggleSettings')):
        raise ValueError('CallToolbar fn#42650 anchor moved')
    b42650[48:54] = _encode_ins(opcodes, 'LoadConstUndefined', 18) * 3
    opcodes.decode(bytes(b42650), 0, len(b42650))
    replacements[42650] = FunctionEdit(body=bytes(b42650))

    h37394 = effective_header(stock, 37394)
    b37394 = bytearray(stock.data[h37394.offset:h37394.offset + h37394.bytecode_size])
    if b37394[42:48] != _encode_ins(opcodes, 'GetById', 17, 3, 4, _unique_str_idx(strs, 'onOpenSettings')):
        raise ValueError('IslandControls fn#37394 anchor moved')
    b37394[42:48] = _encode_ins(opcodes, 'LoadConstUndefined', 17) * 3
    opcodes.decode(bytes(b37394), 0, len(b37394))
    replacements[37394] = FunctionEdit(body=bytes(b37394))

    h25252 = effective_header(stock, 25252)
    b25252 = bytearray(stock.data[h25252.offset:h25252.offset + h25252.bytecode_size])
    if b25252[577:582] != _encode_ins(opcodes, 'Call2', 9, 11, 12, 9):
        raise ValueError('XaiRealtimeSession fn#25252 anchor moved')
    b25252[577:582] = _encode_ins(opcodes, 'LoadConstTrue', 9) + _encode_ins(opcodes, 'Mov', 9, 9)
    opcodes.decode(bytes(b25252), 0, len(b25252))
    replacements[25252] = FunctionEdit(body=bytes(b25252))

    # 15. fn#6370 (SkillDetail module) & added fn#85263 wrapper.
    h6370 = effective_header(stock, 6370)
    b6370 = stock.data[h6370.offset:h6370.offset + h6370.bytecode_size]
    if b6370[12:17] != _encode_ins(opcodes, 'CreateClosure', 4, 2, 52498):
        raise ValueError('SkillDetail module fn#6370 anchor moved')
    body_6370 = b6370[:12] + _encode_ins(opcodes, 'CreateClosureLongIndex', 4, 2, NEW_FUNCTION_START) + b6370[17:]
    opcodes.decode(body_6370, 0, len(body_6370))
    replacements[6370] = FunctionEdit(body=body_6370)

    add0 = additions[0]
    b85263 = bytearray(add0.body)
    fixed_skill = False
    for ins in opcodes.decode(bytes(b85263), 0, len(b85263)):
        if ins.name == 'CreateClosure' and ins.operands[-1] == 37500:
            b85263[ins.offset:ins.offset + 5] = _encode_ins(opcodes, 'CreateClosure', ins.operands[0], ins.operands[1], 52498)
            fixed_skill = True
    if not fixed_skill:
        raise ValueError('Did not find legacy CreateClosure 37500 in added fn#85263')
    opcodes.decode(bytes(b85263), 0, len(b85263))
    additions[0] = NewFunction(body=bytes(b85263), metadata=add0.metadata)

    # 16. fn#42668 (VoiceSettingsSelect): fix GetById 183 ('jsx') -> 'locale'.
    ed42668 = replacements[42668]
    b42668 = bytearray(ed42668.body)
    fixed_loc = False
    for ins in opcodes.decode(bytes(b42668), 0, len(b42668)):
        if ins.offset == 57 and ins.name == 'GetById' and ins.operands[-1] == 183:
            b42668[ins.offset:ins.offset + 6] = _encode_ins(
                opcodes, 'GetById', ins.operands[0], ins.operands[1], ins.operands[2], _unique_str_idx(strs, 'locale')
            )
            fixed_loc = True
    if not fixed_loc:
        raise ValueError('Did not find GetById 183 at offset 57 in fn#42668')
    opcodes.decode(bytes(b42668), 0, len(b42668))
    replacements[42668] = replace(ed42668, body=bytes(b42668))

    # 17. Fix mis-mapped single-char strings in voice functions against legacy 1.16.
    for old_i, new_i in ((21440, 26512), (46942, 67872), (46943, 67871), (46944, 68701), (46946, 67875)):
        lh = effective_header(legacy, old_i)
        linsns = opcodes.decode(legacy.data[lh.offset:lh.offset + lh.bytecode_size], 0, lh.bytecode_size)
        ed = replacements[new_i]
        b = bytearray(ed.body)
        ninsns = opcodes.decode(bytes(b), 0, len(b))
        l_lcs = [i for i in linsns if i.name in ('LoadConstString', 'LoadConstStringLongIndex')]
        n_lcs = [i for i in ninsns if i.name in ('LoadConstString', 'LoadConstStringLongIndex')]
        if len(l_lcs) != len(n_lcs):
            raise ValueError(f'LCS count mismatch for {old_i}->{new_i}')
        for li, ni in zip(l_lcs, n_lcs):
            want_text = legacy_strs[li.operands[-1]].text
            got_text = strs[ni.operands[-1]].text
            if want_text != got_text:
                want_id = _unique_str_idx(strs, want_text)
                if ni.name != 'LoadConstString' or want_id >= 65536:
                    raise ValueError(f'Cannot patch string {want_text!r} in fn#{new_i}')
                b[ni.offset:ni.offset + 4] = _encode_ins(opcodes, 'LoadConstString', ni.operands[0], want_id)
        opcodes.decode(bytes(b), 0, len(b))
        replacements[new_i] = replace(ed, body=bytes(b))

    # 18. fn#52198 (useNativePluginEntries): return [] so built-in official native
    #     plugin entries (such as official 1Password) do not appear in Connected Apps.
    h52198 = effective_header(stock, NATIVE_PLUGIN_ENTRIES_FUNCTION)
    if strs[h52198.function_name].text != 'useNativePluginEntries':
        raise ValueError(
            f'Function {NATIVE_PLUGIN_ENTRIES_FUNCTION} is '
            f'{strs[h52198.function_name].text!r}, expected useNativePluginEntries'
        )
    body_52198, boundary_52198 = equal_length_cover_body(
        stock, NATIVE_PLUGIN_ENTRIES_FUNCTION, EMPTY_ARRAY_STUB
    )
    if boundary_52198 != 7:
        raise ValueError(
            f'useNativePluginEntries fn#{NATIVE_PLUGIN_ENTRIES_FUNCTION} '
            f'cover boundary is {boundary_52198}, expected 7'
        )
    replacements[NATIVE_PLUGIN_ENTRIES_FUNCTION] = FunctionEdit(body=body_52198)


def build_gateway(
    stock: HBCFile,
    legacy: HBCFile,
    work_dir: Path,
) -> tuple[bytes, dict[str, object]]:
    replacements, additions, records = build_edits(stock, legacy, work_dir)
    apply_clean_126_fixes(stock, legacy, replacements, additions)
    output = stock.write(replacements=replacements, additions=additions)
    target = HBCFile.parse(output, strict=True)
    if len(target.function_headers) != NEW_FUNCTION_START + NEW_FUNCTION_COUNT:
        raise AssertionError('Generated function count is incorrect')
    require_clean(target, 'Generated gateway template')
    assert_chat_avatar_motion(target, 'Generated gateway template')
    assert_native_plugin_entries_hidden(target, 'Generated gateway template')
    structural_audit = audit_hbc(target)
    structural_audit.require_ok('Generated gateway template')
    summary = {
        'bytes': len(output),
        'sha256': sha256(output),
        'functions': len(target.function_headers),
        'functionInfos': len(target.function_infos),
        'bodyStart': target.body_start,
        'infoStart': target.info_start,
        'debugInfoOffset': target.header.debug_info_offset,
        'existingEdits': len(replacements),
        'chatAvatarMotion': 'live',
        'nativePluginEntriesHidden': NATIVE_PLUGIN_ENTRIES_FUNCTION,
        'mobileSessionConvergenceBypass': MOBILE_SESSION_CONVERGENCE_FUNCTION,
        'addedFunctions': len(additions),
        'metadataAudit': {
            'functionsChecked': len(target.function_headers),
            'mismatches': 0,
        },
        'structuralAudit': structural_audit.as_dict(),
        'records': records,
    }
    return output, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock', required=True, type=Path)
    parser.add_argument('--legacy-template', required=True, type=Path)
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--output-unpaired', type=Path)
    parser.add_argument('--output-gateway', type=Path)
    parser.add_argument('--output-metadata', type=Path)
    parser.add_argument('--recipes-dir', type=Path)
    parser.add_argument('--output', type=Path, help='Deprecated alias for --output-gateway')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()

    if args.output and args.output_gateway:
        parser.error('Use only one of --output and --output-gateway')
    output_gateway = args.output_gateway or args.output
    if not any((args.output_unpaired, output_gateway, args.output_metadata, args.recipes_dir)):
        parser.error('Choose at least one output artifact')

    stock = HBCFile.from_path(args.stock, strict=True)
    if sha256(stock.data) != EXPECTED_STOCK_SHA256:
        raise ValueError('Stock HBC SHA-256 does not match the pinned 1.26.0 bundle')
    if len(stock.function_headers) != NEW_FUNCTION_START:
        raise ValueError(
            f'Expected stock function count {NEW_FUNCTION_START}, '
            f'found {len(stock.function_headers)}'
        )

    legacy = HBCFile.from_path(args.legacy_template, strict=False, allow_legacy=True)
    if len(legacy.function_headers) != OLD_NEW_FUNCTION_START + NEW_FUNCTION_COUNT:
        raise ValueError('Legacy template function count does not match the recipe')
    if legacy.validation.errors:
        raise ValueError('Legacy template has structural errors: ' + '; '.join(legacy.validation.errors))

    unpaired, unpaired_summary = build_unpaired(stock)
    gateway, gateway_summary = build_gateway(stock, legacy, args.work_dir)
    gateway_file = HBCFile.parse(gateway, strict=True)
    metadata, metadata_bytes = build_gateway_metadata(stock, gateway_file, gateway)
    gateway_sha256 = sha256(gateway)
    expected = EXPECTED_GATEWAY_SHA256_WITH_AVATAR_MOTION
    if gateway_sha256 != expected:
        raise ValueError(
            'Gateway template SHA-256 does not match the verified 1.26.0 '
            f'candidate: got {gateway_sha256}, expected {expected}'
        )
    injection = validate_injected_gateway(gateway, metadata)

    if args.output_unpaired:
        write_artifact(args.output_unpaired, unpaired, overwrite=args.overwrite)
    if output_gateway:
        write_artifact(output_gateway, gateway, overwrite=args.overwrite)
    if args.output_metadata:
        write_artifact(args.output_metadata, metadata_bytes, overwrite=args.overwrite)

    recipes = {}
    if args.recipes_dir:
        recipes = build_recipes(
            stock.data,
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
            'bytes': len(stock.data),
            'sha256': sha256(stock.data),
            'functions': len(stock.function_headers),
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
            (json.dumps(summary, indent=2) + '\n').encode(),
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
