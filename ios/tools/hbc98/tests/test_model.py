from __future__ import annotations

import hashlib
import struct
import unittest
from dataclasses import replace

from ios.tools.hbc98.model import (
    ExceptionHandler,
    FunctionEdit,
    FunctionHeader,
    FunctionMetadata,
    HBCFormatError,
    HBCFile,
    HAS_EXCEPTION_HANDLER,
    HAS_DEBUG_INFO,
    MAGIC,
    NewFunction,
    OVERFLOWED,
    VERSION,
    _FunctionState,
    _needs_function_info,
    align4,
    remap_exception_handlers,
)
from ios.tools.hbc98.opcodes import OpcodeSet
from ios.tools.hbc98.audit import audit_hbc
from ios.tools.hbc98.requirements import (
    BodyRequirements,
    body_requirements,
    hbc_metadata_issues,
    merge_replacement_metadata,
    metadata_mismatches,
    require_metadata,
)


OPCODES = OpcodeSet.load_default()


def _instruction(name: str, *values: int) -> bytes:
    operands = OPCODES.operands(name)
    if len(operands) != len(values):
        raise AssertionError('Operand count mismatch for %s' % name)
    result = bytearray([OPCODES.ids[name]])
    for operand, value in zip(operands, values):
        if operand == 'Reg8' or operand == 'UInt8' or operand == 'Addr8':
            result.extend(struct.pack('<B', value))
        elif operand == 'UInt16' or operand == 'Addr32':
            result.extend(struct.pack('<I' if operand == 'Addr32' else '<H', value))
        else:
            result.extend(struct.pack('<I', value))
    return bytes(result)


def _small_header(
    *,
    offset: int,
    size: int,
    pointer: int | None = None,
    flags: int = 0,
) -> bytes:
    if pointer is not None:
        w0 = pointer & 0xFFFFFF
        w1 = ((pointer >> 24) & 0xFF) << 14
        flags |= OVERFLOWED
    else:
        w0 = offset
        w1 = size | (0 << 14)
    return struct.pack('<2I4B', w0, w1, 0, 0, 0, flags)


def _full_header(
    *,
    offset: int,
    size: int,
    flags: int = 0,
    read_cache: int = 0,
    write_cache: int = 0,
    num_cache_new_object: int = 0,
    private_name_cache: int = 0,
) -> bytes:
    return struct.pack('<8I', offset, 1, 0, size, 0, 2, 0, 4) + bytes(
        [read_cache, write_cache, num_cache_new_object, private_name_cache, flags]
    )


def _debug_header() -> bytes:
    return b'\0' * 16


def _finish(prefix: bytes, debug: bytes = None) -> bytes:
    debug = _debug_header() if debug is None else debug
    body = bytearray(prefix)
    body.extend(debug)
    file_length = len(body) + 20
    struct.pack_into('<I', body, 32, file_length)
    return bytes(body) + hashlib.sha1(body).digest()


def _header(
    *,
    function_count: int,
    string_switch_count: int = 0,
    debug_info_offset: int = 0,
) -> bytes:
    return struct.pack(
        '<QI20s20IB15s',
        MAGIC,
        VERSION,
        b'\0' * 20,
        0,
        0,
        function_count,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        string_switch_count,
        0,
        0,
        0,
        debug_info_offset,
        0,
        b'\0' * 15,
    )


def _small_fixture(body: bytes, switches: int = 0) -> bytes:
    return _small_alias_fixture(body, function_count=1, switches=switches)


def _small_alias_fixture(body: bytes, *, function_count: int, switches: int = 0) -> bytes:
    body_offset = 128 + 12 * function_count
    info_offset = align4(body_offset + len(body))
    prefix = (
        _header(function_count=1, string_switch_count=switches, debug_info_offset=info_offset)
    )
    prefix = bytearray(prefix)
    struct.pack_into('<I', prefix, 40, function_count)
    prefix = bytes(prefix) + b''.join(
        _small_header(offset=body_offset, size=len(body)) for _ in range(function_count)
    )
    prefix += body
    prefix += b'\0' * (info_offset - body_offset - len(body))
    return _finish(prefix)


def _small_metadata(header=None) -> FunctionMetadata:
    if header is None:
        return FunctionMetadata(
            param_count=0,
            loop_depth=0,
            function_name=0,
            number_reg_count=1,
            non_pointer_reg_count=0,
            frame_size=2,
            read_cache_size=0,
            write_cache_size=0,
            num_cache_new_object=0,
            private_name_cache_size=0,
            flags=0,
        )
    return FunctionMetadata(
        param_count=header.param_count,
        loop_depth=header.loop_depth,
        function_name=header.function_name,
        number_reg_count=header.number_reg_count,
        non_pointer_reg_count=header.non_pointer_reg_count,
        frame_size=header.frame_size,
        read_cache_size=header.read_cache_size,
        write_cache_size=header.write_cache_size,
        num_cache_new_object=header.num_cache_new_object,
        private_name_cache_size=header.private_name_cache_size,
        flags=header.flags,
    )


def _overflow_info_fixture(
    body: bytes,
    *,
    flags: int,
    debug_data_offset: int = 7,
) -> bytes:
    body_offset = 140
    pointer = align4(body_offset + len(body))
    info = bytearray(_full_header(offset=body_offset, size=len(body), flags=flags))
    if flags & HAS_EXCEPTION_HANDLER:
        info.extend(b'\0' * (align4(len(info)) - len(info)))
        info.extend(struct.pack('<I3I', 1, 0, len(body), 0))
    if flags & HAS_DEBUG_INFO:
        info.extend(b'\0' * (align4(len(info)) - len(info)))
        info.extend(struct.pack('<I', debug_data_offset))
    debug_offset = align4(pointer + len(info))
    prefix = (
        _header(function_count=1, debug_info_offset=debug_offset)
        + _small_header(offset=0, size=0, pointer=pointer)
        + body
        + b'\0' * (pointer - body_offset - len(body))
        + info
        + b'\0' * (debug_offset - pointer - len(info))
    )
    return _finish(prefix)


def _overflow_fixture(body: bytes, *, flags: int = 0) -> tuple[bytes, int]:
    body_offset = 140
    pointer = align4(body_offset + len(body))
    info = _full_header(offset=body_offset, size=len(body), flags=flags)
    if flags & HAS_EXCEPTION_HANDLER:
        info += b'\0' * (align4(len(info)) - len(info))
        info += struct.pack('<I3I', 1, 0, len(body), 0)
    debug_offset = align4(pointer + len(info))
    prefix = (
        _header(function_count=1, debug_info_offset=debug_offset)
        + _small_header(offset=0, size=0, pointer=pointer)
        + body
        + b'\0' * (pointer - body_offset - len(body))
        + info
        + b'\0' * (debug_offset - pointer - len(info))
    )
    return _finish(prefix), body_offset


class HBC98ModelTests(unittest.TestCase):
    def test_body_cache_operand_indices_and_no_cache_sentinel(self) -> None:
        body = (
            _instruction('GetByIdWithReceiverLong', 1, 2, 9, 3, 0)
            + _instruction('GetById', 1, 2, 255, 0)
            + _instruction('CreateThisForSuper', 1, 2, 3, 4)
            + _instruction('Ret', 0)
        )
        requirements = body_requirements(OPCODES, body)
        self.assertEqual(requirements.read_cache_entries, 10)

    def test_body_write_private_and_new_object_requirements(self) -> None:
        body = (
            _instruction('PutByIdStrictLong', 1, 2, 7, 0)
            + _instruction('DefineOwnById', 1, 2, 10, 0)
            + _instruction('PrivateIsIn', 1, 2, 3, 12)
            + _instruction('GetOwnPrivateBySym', 1, 2, 14, 3)
            + _instruction('CacheNewObject', 1, 2, 0, 4)
            + _instruction('Ret', 0)
        )
        requirements = body_requirements(OPCODES, body)
        self.assertEqual(requirements.write_cache_entries, 11)
        self.assertEqual(requirements.private_name_cache_entries, 15)
        self.assertEqual(requirements.num_cache_new_object, 5)

    def test_cache_new_object_no_cache_is_ignored(self) -> None:
        body = (
            _instruction('CacheNewObject', 1, 2, 0, 255)
            + _instruction('Ret', 0)
        )
        requirements = body_requirements(OPCODES, body)
        self.assertEqual(requirements.num_cache_new_object, 0)

    def test_load_param_is_reported_without_constraining_param_count(self) -> None:
        body = (
            _instruction('LoadParam', 0, 0)
            + _instruction('LoadParamLong', 0, 200)
            + _instruction('Ret', 0)
        )
        requirements = body_requirements(OPCODES, body)
        self.assertEqual(requirements.max_load_param, 200)
        metadata = _small_metadata()
        metadata = replace(metadata, param_count=0, frame_size=1)
        require_metadata(requirements, metadata, label='test')

    def test_metadata_requirements_reject_short_frames_and_caches(self) -> None:
        requirements = BodyRequirements(
            max_register=5,
            read_cache_entries=4,
            write_cache_entries=3,
            private_name_cache_entries=2,
            num_cache_new_object=1,
        )
        metadata = replace(
            _small_metadata(),
            frame_size=5,
            read_cache_size=3,
            write_cache_size=2,
            private_name_cache_size=1,
            num_cache_new_object=0,
        )
        self.assertEqual(len(metadata_mismatches(requirements, metadata)), 5)
        with self.assertRaisesRegex(ValueError, 'metadata is too small'):
            require_metadata(requirements, metadata, label='test')

    def test_replacement_metadata_uses_legacy_layout_and_safe_maxima(self) -> None:
        legacy = replace(
            _small_metadata(),
            param_count=3,
            loop_depth=2,
            function_name=1,
            number_reg_count=4,
            non_pointer_reg_count=2,
            frame_size=32,
            read_cache_size=12,
            write_cache_size=2,
            private_name_cache_size=0,
            flags=HAS_EXCEPTION_HANDLER | HAS_DEBUG_INFO | OVERFLOWED | 0x01,
        )
        stock = replace(
            _small_metadata(),
            function_name=77,
            frame_size=12,
            read_cache_size=2,
            write_cache_size=0,
            private_name_cache_size=1,
            num_cache_new_object=1,
            flags=0x02,
        )
        requirements = BodyRequirements(
            max_register=29,
            read_cache_entries=8,
            write_cache_entries=3,
            private_name_cache_entries=2,
            num_cache_new_object=2,
        )
        metadata = merge_replacement_metadata(
            legacy=legacy,
            stock=stock,
            requirements=requirements,
            has_exception_section=False,
            has_debug_info=True,
        )
        self.assertEqual(metadata.param_count, 3)
        self.assertEqual(metadata.loop_depth, 2)
        self.assertEqual(metadata.function_name, 77)
        self.assertEqual(metadata.number_reg_count, 4)
        self.assertEqual(metadata.non_pointer_reg_count, 2)
        self.assertEqual(metadata.frame_size, 32)
        self.assertEqual(metadata.read_cache_size, 12)
        self.assertEqual(metadata.write_cache_size, 3)
        self.assertEqual(metadata.private_name_cache_size, 2)
        self.assertEqual(metadata.num_cache_new_object, 2)
        self.assertEqual(
            metadata.flags,
            0x01 | HAS_DEBUG_INFO,
        )
        self.assertFalse(
            metadata.fits_small(offset=0, bytecode_size=1),
            'private cache and cache-new-object counts above one require a full header',
        )

    def test_replacement_metadata_rejects_frame_above_one_byte(self) -> None:
        with self.assertRaisesRegex(ValueError, 'frame_size 256'):
            merge_replacement_metadata(
                legacy=_small_metadata(),
                stock=_small_metadata(),
                requirements=BodyRequirements(max_register=255),
                has_exception_section=False,
                has_debug_info=False,
            )

    def test_private_cache_above_one_writes_a_full_header(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        body = (
            _instruction('PrivateIsIn', 0, 1, 2, 2)
            + _instruction('Ret', 0)
        )
        metadata = replace(
            _small_metadata(file.function_headers[0]),
            frame_size=3,
            private_name_cache_size=3,
        )
        target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=body, metadata=metadata)}
            )
        )
        small = target.function_headers[0]
        self.assertTrue(small.overflowed)
        self.assertEqual(small.effective.private_name_cache_size, 3)
        self.assertEqual(hbc_metadata_issues(target), ())

    def test_full_metadata_audit_reports_underallocated_body(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        body = (
            _instruction('GetById', 0, 1, 3, 0)
            + _instruction('Ret', 0)
        )
        metadata = _small_metadata(file.function_headers[0])
        target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=body, metadata=metadata)}
            )
        )
        issues = hbc_metadata_issues(target)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]['function'], 0)
        self.assertIn(
            'read_cache_size 0 < required 4',
            issues[0]['mismatches'],
        )

    def test_unified_audit_reports_structural_body_error(self) -> None:
        body = _instruction('Jmp', 1) + _instruction('Ret', 0)
        audit = audit_hbc(HBCFile.parse(_small_fixture(body)))
        self.assertFalse(audit.ok)
        self.assertTrue(
            any(issue['kind'] == 'branch-target' for issue in audit.issues)
        )
        with self.assertRaisesRegex(ValueError, 'audit issues'):
            audit.require_ok('test')

    def test_unified_audit_reports_unknown_opcode(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\xff'), strict=True, allow_legacy=True)
        audit = audit_hbc(file)
        self.assertEqual(audit.invalid_opcodes, 1)
        self.assertTrue(
            any(issue['kind'] == 'invalid-opcode' for issue in audit.issues)
        )

    def test_unified_audit_reports_metadata_mismatch(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        body = (
            _instruction('GetById', 0, 1, 3, 0)
            + _instruction('Ret', 0)
        )
        target = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=body,
                        metadata=_small_metadata(file.function_headers[0]),
                    )
                }
            )
        )
        audit = audit_hbc(target)
        self.assertEqual(audit.metadata_mismatches, 1)
        self.assertTrue(
            any(issue['kind'] == 'metadata-mismatch' for issue in audit.issues)
        )

    def test_unified_audit_reports_prohibit_call_closure_target(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        caller_body = (
            _instruction('LoadConstUndefined', 0)
            + _instruction('CreateClosure', 1, 0, 1)
            + _instruction('Ret', 1)
        )
        callee_body = _instruction('LoadConstUndefined', 0) + _instruction('Ret', 0)
        caller_meta = replace(_small_metadata(), frame_size=2, flags=0x06)
        prohibit_call_meta = replace(_small_metadata(), frame_size=1, flags=0x00)
        bad_target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=caller_body, metadata=caller_meta)},
                additions=(NewFunction(body=callee_body, metadata=prohibit_call_meta),),
            )
        )
        bad_audit = audit_hbc(bad_target)
        self.assertFalse(bad_audit.ok)
        self.assertTrue(
            any(issue['kind'] == 'closure-prohibit-call' for issue in bad_audit.issues)
        )

        callable_meta = replace(prohibit_call_meta, flags=0x05)
        good_target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=caller_body, metadata=caller_meta)},
                additions=(NewFunction(body=callee_body, metadata=callable_meta),),
            )
        )
        good_audit = audit_hbc(good_target)
        self.assertFalse(
            any(issue['kind'] == 'closure-prohibit-call' for issue in good_audit.issues)
        )

    def test_unified_audit_allows_create_base_class_on_prohibit_call_constructor(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        caller_body = (
            _instruction('LoadConstUndefined', 0)
            + _instruction('CreateBaseClass', 1, 2, 0, 1)
            + _instruction('Ret', 1)
        )
        callee_body = _instruction('LoadConstUndefined', 0) + _instruction('Ret', 0)
        caller_meta = replace(_small_metadata(), frame_size=3, flags=0x06)
        prohibit_call_meta = replace(_small_metadata(), frame_size=1, flags=0x00)
        target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=caller_body, metadata=caller_meta)},
                additions=(NewFunction(body=callee_body, metadata=prohibit_call_meta),),
            )
        )
        audit = audit_hbc(target)
        self.assertFalse(
            any(issue['kind'] == 'closure-prohibit-call' for issue in audit.issues)
        )
        self.assertEqual(
            {issue['kind'] for issue in audit.issues},
            {'function-name-index'},
        )

    def test_unified_audit_skips_missing_overflow_info_and_short_header_table(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        caller_body = (
            _instruction('LoadConstUndefined', 0)
            + _instruction('CreateClosure', 1, 0, 1)
            + _instruction('Ret', 1)
        )
        callee_body = _instruction('LoadConstUndefined', 0) + _instruction('Ret', 0)
        caller_meta = replace(_small_metadata(), frame_size=2, flags=0x06)
        callable_meta = replace(_small_metadata(), frame_size=1, flags=0x05)
        base_target = HBCFile.parse(
            file.write(
                replacements={0: FunctionEdit(body=caller_body, metadata=caller_meta)},
                additions=(NewFunction(body=callee_body, metadata=callable_meta),),
            )
        )

        # Missing overflow FunctionInfo leaves flags=OVERFLOWED (0x20), whose low bits are 0.
        # audit_hbc must not false-positive closure-prohibit-call on it.
        missing_info_header = replace(
            base_target.function_headers[1],
            flags=OVERFLOWED,
            full_header=None,
            full_header_offset=base_target.body_start,
        )
        missing_info_file = replace(
            base_target,
            function_headers=(base_target.function_headers[0], missing_info_header),
        )
        missing_info_audit = audit_hbc(missing_info_file)
        self.assertFalse(
            any(issue['kind'] == 'closure-prohibit-call' for issue in missing_info_audit.issues)
        )
        self.assertTrue(
            any(issue['kind'] == 'function-info-missing' for issue in missing_info_audit.issues)
        )

        # Declared function_count > len(function_headers) must not raise IndexError.
        caller_to_missing = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=(
                            _instruction('LoadConstUndefined', 0)
                            + _instruction('CreateClosure', 1, 0, 2)
                            + _instruction('Ret', 1)
                        ),
                        metadata=caller_meta,
                    )
                },
                additions=(NewFunction(body=callee_body, metadata=callable_meta),),
            )
        )
        short_headers_file = replace(
            caller_to_missing,
            header=replace(caller_to_missing.header, function_count=3),
        )
        short_audit = audit_hbc(short_headers_file)
        self.assertTrue(any(issue['kind'] == 'function-count' for issue in short_audit.issues))
        self.assertFalse(
            any(issue['kind'] == 'closure-prohibit-call' for issue in short_audit.issues)
        )

    def test_unified_audit_reports_call_frame_overlap(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))

        # Repro of fn#13806 crash: Call1(5, 6, 5) in frame_size=14 leaves limit=6,
        # so callee register r6 overlaps ThisArg (frame_size - 8 == 6).
        bad_call1_body = (
            _instruction('LoadConstUndefined', 5)
            + _instruction('Call1', 5, 6, 5)
            + _instruction('Ret', 5)
        )
        meta14 = replace(_small_metadata(), frame_size=14, flags=0x06)
        bad_call1 = HBCFile.parse(
            file.write(replacements={0: FunctionEdit(body=bad_call1_body, metadata=meta14)})
        )
        bad_audit = audit_hbc(bad_call1)
        overlap_issues = [
            issue for issue in bad_audit.issues if issue['kind'] == 'call-frame-overlap'
        ]
        self.assertEqual(len(overlap_issues), 1)
        self.assertEqual(overlap_issues[0]['opcode'], 'Call1')
        self.assertEqual(overlap_issues[0]['limit'], 6)
        self.assertEqual(overlap_issues[0]['maxSourceRegister'], 6)

        # Sources strictly below limit (r3, r4 < 6) pass even when dst (r6) == limit.
        good_call1_body = (
            _instruction('LoadConstUndefined', 3)
            + _instruction('Call1', 6, 4, 3)
            + _instruction('Ret', 6)
        )
        good_call1 = HBCFile.parse(
            file.write(replacements={0: FunctionEdit(body=good_call1_body, metadata=meta14)})
        )
        self.assertFalse(
            any(issue['kind'] == 'call-frame-overlap' for issue in audit_hbc(good_call1).issues)
        )

        # Call3(5, 7, 4, 6, 0) fails in frame_size=16 (limit=6) and passes in frame_size=24 (limit=14).
        call3_body = (
            _instruction('Call3', 5, 7, 4, 6, 0)
            + _instruction('Ret', 5)
        )
        bad_call3 = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=call3_body,
                        metadata=replace(_small_metadata(), frame_size=16, flags=0x05),
                    )
                }
            )
        )
        self.assertTrue(
            any(issue['kind'] == 'call-frame-overlap' for issue in audit_hbc(bad_call3).issues)
        )
        good_call3 = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=call3_body,
                        metadata=replace(_small_metadata(), frame_size=24, flags=0x05),
                    )
                }
            )
        )
        self.assertFalse(
            any(issue['kind'] == 'call-frame-overlap' for issue in audit_hbc(good_call3).issues)
        )

        # Vararg Call(dst, callee, argCount): frame_size=23, argCount=5 => limit=11.
        good_varcall = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=_instruction('Call', 14, 10, 5) + _instruction('Ret', 14),
                        metadata=replace(_small_metadata(), frame_size=23, flags=0x06),
                    )
                }
            )
        )
        self.assertFalse(
            any(issue['kind'] == 'call-frame-overlap' for issue in audit_hbc(good_varcall).issues)
        )
        bad_varcall = HBCFile.parse(
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=_instruction('Call', 14, 11, 5) + _instruction('Ret', 14),
                        metadata=replace(_small_metadata(), frame_size=23, flags=0x06),
                    )
                }
            )
        )
        self.assertTrue(
            any(issue['kind'] == 'call-frame-overlap' for issue in audit_hbc(bad_varcall).issues)
        )

        # Missing overflow FunctionInfo must not false-positive call-frame-overlap.
        missing_info_header = replace(
            good_call1.function_headers[0],
            flags=OVERFLOWED,
            full_header=None,
            full_header_offset=good_call1.body_start,
        )
        missing_info_file = replace(good_call1, function_headers=(missing_info_header,))
        self.assertFalse(
            any(
                issue['kind'] == 'call-frame-overlap'
                for issue in audit_hbc(missing_info_file).issues
            )
        )

        # A zero-byte aliased function sharing a BodyGroup offset (like stock Hermes
        # empty headers) must not false-positive against instructions of the non-empty
        # sibling function at the same offset.
        zero_alias_header = replace(
            good_call1.function_headers[0],
            index=1,
            bytecode_size=0,
            frame_size=0,
            flags=0x02,
            full_header=None,
            full_header_offset=None,
        )
        aliased_group = replace(good_call1.body_groups[0], function_indexes=(0, 1))
        aliased_file = replace(
            good_call1,
            header=replace(good_call1.header, function_count=2),
            function_headers=(good_call1.function_headers[0], zero_alias_header),
            body_groups=(aliased_group,),
        )
        self.assertFalse(
            any(
                issue['kind'] == 'call-frame-overlap'
                for issue in audit_hbc(aliased_file).issues
            )
        )

    def test_metadata_audit_reports_decode_error(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\xff'), strict=True, allow_legacy=True)
        issues = hbc_metadata_issues(file)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]['kind'], 'decode-error')
        self.assertIn('Unknown opcode 255', issues[0]['error'])

    def test_full_header_cache_fields_round_trip(self) -> None:
        raw = _full_header(
            offset=0x1234,
            size=0x5678,
            flags=HAS_DEBUG_INFO,
            read_cache=0x12,
            write_cache=0x34,
            num_cache_new_object=0x56,
            private_name_cache=0x78,
        )
        header = FunctionHeader.parse(raw, 0)
        self.assertEqual(header.read_cache_size, 0x12)
        self.assertEqual(header.write_cache_size, 0x34)
        self.assertEqual(header.num_cache_new_object, 0x56)
        self.assertEqual(header.private_name_cache_size, 0x78)
        self.assertEqual(header.encode(), raw)

        metadata = FunctionMetadata.from_header(header)
        self.assertEqual(
            metadata.to_header(offset=0x1234, bytecode_size=0x5678).encode(),
            raw,
        )

    def test_small_function_round_trip(self) -> None:
        fixture = _small_fixture(b'\x00')
        file = HBCFile.parse(fixture)
        self.assertEqual(len(file.body_groups), 1)
        self.assertEqual(file.body_groups[0].instructions[0].name, 'Unreachable')
        self.assertEqual(file.rebuild(), fixture)

    def test_full_header_and_exception_round_trip(self) -> None:
        fixture, body_offset = _overflow_fixture(b'\x00', flags=HAS_EXCEPTION_HANDLER)
        file = HBCFile.parse(fixture)
        info = file.function_infos[next(iter(file.function_infos))]
        self.assertEqual(info.header.offset, body_offset)
        self.assertEqual(info.exception_handlers[0].end, 1)
        self.assertEqual(file.rebuild(), fixture)

    def test_same_size_body_replacement_stays_in_place(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        original_offset = file.function_headers[0].offset
        target = HBCFile.parse(file.write(replacements={0: b'\x7d'}))
        self.assertEqual(target.function_headers[0].offset, original_offset)
        self.assertEqual(target.body_for_function(0), b'\x7d')

    def test_size_change_relocates_body(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        original_offset = file.function_headers[0].offset
        target = HBCFile.parse(file.write(replacements={0: b'\x7d\x00'}))
        self.assertGreater(target.function_headers[0].offset, original_offset)
        self.assertEqual(target.body_for_function(0), b'\x7d\x00')

    def test_shared_alias_body_change_preserves_alias(self) -> None:
        file = HBCFile.parse(_small_alias_fixture(b'\x00', function_count=2))
        target = HBCFile.parse(
            file.write(replacements={0: FunctionEdit(body=b'\x7d\x00'), 1: FunctionEdit(body=b'\x7d\x00')})
        )
        self.assertEqual(target.function_headers[0].offset, target.function_headers[1].offset)
        self.assertEqual(len(target.body_groups), 1)
        self.assertEqual(target.body_for_function(0), b'\x7d\x00')
        self.assertEqual(target.body_for_function(1), b'\x7d\x00')

    def test_relocated_body_preserves_exception_and_debug_info(self) -> None:
        flags = HAS_EXCEPTION_HANDLER | HAS_DEBUG_INFO
        fixture = _overflow_info_fixture(b'\x00', flags=flags, debug_data_offset=7)
        file = HBCFile.parse(fixture)
        original_pointer = file.function_headers[0].full_header_offset
        target = HBCFile.parse(file.write(replacements={0: b'\x7d\x00'}))
        small = target.function_headers[0]
        self.assertTrue(small.overflowed)
        self.assertGreater(small.full_header_offset, original_pointer)
        info = target.function_infos[small.full_header_offset]
        self.assertEqual(info.exception_handlers, (ExceptionHandler(0, 1, 0),))
        self.assertEqual(info.debug_offset, 7)

    def test_exception_handler_boundaries_follow_widened_instructions(self) -> None:
        short = (
            bytes([OPCODES.ids['Unreachable']])
            + bytes([OPCODES.ids['LoadConstString']])
            + b'\0'
            + struct.pack('<H', 1)
            + bytes([OPCODES.ids['Ret'], 0])
        )
        long = (
            bytes([OPCODES.ids['Unreachable']])
            + bytes([OPCODES.ids['LoadConstStringLongIndex']])
            + b'\0'
            + struct.pack('<I', 70000)
            + bytes([OPCODES.ids['Ret'], 0])
        )
        handlers = remap_exception_handlers(
            (ExceptionHandler(1, 5, 0),),
            source_body=short,
            target_body=long,
            opcodes=OPCODES,
        )
        self.assertEqual(handlers, (ExceptionHandler(1, 7, 0),))

    def test_exception_handler_must_start_on_instruction_boundary(self) -> None:
        body = (
            bytes([OPCODES.ids['Unreachable']])
            + bytes([OPCODES.ids['LoadConstString']])
            + b'\0'
            + struct.pack('<H', 1)
            + bytes([OPCODES.ids['Ret'], 0])
        )
        fixture = _overflow_info_fixture(body, flags=HAS_EXCEPTION_HANDLER)
        file = HBCFile.parse(fixture)
        with self.assertRaisesRegex(ValueError, 'start 2 is not an instruction boundary'):
            file.write(
                replacements={
                    0: FunctionEdit(
                        body=body,
                        exception_handlers=(ExceptionHandler(2, len(body), 0),),
                        replace_exception_handlers=True,
                    )
                }
            )

    def test_new_function_is_appended_and_serialized(self) -> None:
        file = HBCFile.parse(_small_fixture(b'\x00'))
        metadata = _small_metadata(file.function_headers[0])
        target = HBCFile.parse(
            file.write(additions=(NewFunction(body=b'\x7d\x00', metadata=metadata),))
        )
        self.assertEqual(len(target.function_headers), 2)
        self.assertEqual(target.body_for_function(1), b'\x7d\x00')

    def test_offset_above_25_bits_requires_function_info(self) -> None:
        state = _FunctionState(
            metadata=_small_metadata(),
            body=b'\x00',
            bytecode_size=1,
            body_offset=0x02000000,
            exception_handlers=(),
            debug_offset=None,
            force_full=False,
        )
        self.assertTrue(_needs_function_info(state))
        state.body_offset = 0x01FFFFFF
        self.assertFalse(_needs_function_info(state))

    def test_removing_string_switch_updates_header_count(self) -> None:
        opcode = OPCODES.ids['StringSwitchImm']
        size = OPCODES.instruction_size('StringSwitchImm')
        body_offset = 140
        table_offset = align4(body_offset + size)
        relative = table_offset - body_offset
        body = bytes([opcode]) + struct.pack('<BIIII', 0, 0, relative, 0, 1)
        body += b'\0' * (table_offset - body_offset - len(body))
        body += struct.pack('<Ii', 0, 0)
        file = HBCFile.parse(_small_fixture(body, switches=1))
        target = HBCFile.parse(file.write(replacements={0: b'\x00'}))
        self.assertEqual(target.header.num_string_switch_imms, 0)

    def test_uint_switch_table(self) -> None:
        opcode = OPCODES.ids['UIntSwitchImm']
        size = OPCODES.instruction_size('UIntSwitchImm')
        body_offset = 140
        table_offset = align4(body_offset + size)
        relative = table_offset - body_offset
        body = bytes([opcode]) + struct.pack('<BIII', 0, relative, 0, 0)
        body += b'\0' * (table_offset - body_offset - len(body))
        body += struct.pack('<I', 0)
        fixture = _small_fixture(body)
        file = HBCFile.parse(fixture)
        table = file.body_groups[0].switch_tables[0]
        self.assertEqual(table.kind, 'UIntSwitchImm')
        self.assertEqual(table.count, 1)
        self.assertEqual(file.rebuild(), fixture)

    def test_string_switch_table(self) -> None:
        opcode = OPCODES.ids['StringSwitchImm']
        size = OPCODES.instruction_size('StringSwitchImm')
        body_offset = 140
        table_offset = align4(body_offset + size)
        relative = table_offset - body_offset
        body = bytes([opcode]) + struct.pack('<BIIII', 0, 0, relative, 0, 1)
        body += b'\0' * (table_offset - body_offset - len(body))
        body += struct.pack('<Ii', 0, 0)
        fixture = _small_fixture(body, switches=1)
        file = HBCFile.parse(fixture)
        table = file.body_groups[0].switch_tables[0]
        self.assertEqual(table.kind, 'StringSwitchImm')
        self.assertEqual(table.count, 1)
        self.assertEqual(file.rebuild(), fixture)

    def test_footer_hash_rejects_tampering(self) -> None:
        fixture = bytearray(_small_fixture(b'\x00'))
        fixture[140] ^= 1
        with self.assertRaisesRegex(HBCFormatError, 'Footer SHA-1'):
            HBCFile.parse(bytes(fixture))

    def test_unknown_opcode_is_rejected_in_strict_mode(self) -> None:
        fixture = _small_fixture(b'\xff')
        with self.assertRaisesRegex(HBCFormatError, 'unknown opcode 255'):
            HBCFile.parse(fixture)

    def test_legacy_unknown_opcode_can_be_inspected(self) -> None:
        fixture = _small_fixture(b'\xff')
        file = HBCFile.parse(fixture, strict=True, allow_legacy=True)
        self.assertEqual(file.validation.invalid_opcodes, [(140, 255)])
        self.assertEqual(file.rebuild(), fixture)

    def test_truncated_section_is_rejected(self) -> None:
        fixture = bytearray(_small_fixture(b'\x00'))
        struct.pack_into('<I', fixture, 40, 2)
        fixture[32:36] = struct.pack('<I', len(fixture))
        fixture[-20:] = hashlib.sha1(fixture[:-20]).digest()
        with self.assertRaises(HBCFormatError):
            HBCFile.parse(bytes(fixture))


if __name__ == '__main__':
    unittest.main()
