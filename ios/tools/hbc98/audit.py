"""Whole-file structural audits for Hermes bytecode v98 edits."""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .model import HBCFile, STRING_SWITCH, UINT_SWITCH
from .requirements import hbc_metadata_issues


_STRING_INDEX_OPERANDS = {
    'DeclareGlobalVar': (0,),
    'GetByIdShort': (3,),
    'GetById': (3,),
    'GetByIdLong': (3,),
    'GetByIdWithReceiverLong': (4,),
    'TryGetById': (3,),
    'TryGetByIdLong': (3,),
    'PutByIdLoose': (3,),
    'PutByIdStrict': (3,),
    'PutByIdLooseLong': (3,),
    'PutByIdStrictLong': (3,),
    'TryPutByIdLoose': (3,),
    'TryPutByIdStrict': (3,),
    'TryPutByIdLooseLong': (3,),
    'TryPutByIdStrictLong': (3,),
    'DefineOwnById': (3,),
    'DefineOwnByIdLong': (3,),
    'LoadConstString': (1,),
    'LoadConstStringLongIndex': (1,),
    'CreatePrivateName': (1,),
    'CreateRegExp': (1,),
}

_FUNCTION_INDEX_OPERANDS = {
    'CreateBaseClass': (3,),
    'CreateBaseClassLongIndex': (3,),
    'CreateDerivedClass': (4,),
    'CreateDerivedClassLongIndex': (4,),
    'CreateClosure': (2,),
    'CreateClosureLongIndex': (2,),
    'CreateGenerator': (2,),
    'CreateGeneratorLongIndex': (2,),
    'CreateGeneratorClosure': (2,),
    'CreateGeneratorClosureLongIndex': (2,),
    'CreateAsyncClosure': (2,),
    'CreateAsyncClosureLongIndex': (2,),
}

# In Hermes FunctionHeaderFlag, bits [0..1] encode ProhibitInvoke:
# 0 = ProhibitCall (ES6 class constructor; throws TypeError if called without new),
# 1 = ProhibitConstruct, 2 = ProhibitNone. Callable closure opcodes must never
# target a function header whose ProhibitInvoke bits are 0 (ProhibitCall).
_CALLABLE_CLOSURE_OPCODES = frozenset(
    {
        'CreateClosure',
        'CreateClosureLongIndex',
        'CreateGenerator',
        'CreateGeneratorLongIndex',
        'CreateGeneratorClosure',
        'CreateGeneratorClosureLongIndex',
        'CreateAsyncClosure',
        'CreateAsyncClosureLongIndex',
    }
)

# Hermes StackFrameLayout::CallerExtraRegistersAtEnd reserves 7 frame header
# registers plus ``argCount`` outgoing argument registers at the top of the
# caller's register frame. Call source operands (callee, newTarget, arguments)
# must stay strictly below ``frame_size - (7 + argCount)`` or the VM overwrites
# them while writing the outgoing call frame (before invoking the callee).
CALLER_EXTRA_REGISTERS_AT_END = 7

_FIXED_CALL_ARG_COUNTS = {
    'Call1': 1,
    'Call2': 2,
    'Call3': 3,
    'Call4': 4,
}
_VAR_CALL_ARG_OPERANDS = {
    'Call': 2,
    'Construct': 2,
    'CallWithNewTarget': 3,
}
_BUILTIN_CALL_ARG_OPERANDS = {
    'CallBuiltin': 2,
    'CallBuiltinLong': 2,
}


def _signed(value: int, bits: int) -> int:
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


@dataclass(frozen=True)
class HBCAudit:
    body_groups: int
    instructions: int
    addr8: int
    addr32: int
    string_switches: int
    uint_switches: int
    switch_cases: int
    exception_handlers: int
    string_references: int
    function_references: int
    validation_errors: int
    invalid_opcodes: int
    metadata_mismatches: int
    issues: tuple[dict[str, object], ...]

    @property
    def ok(self) -> bool:
        return not self.issues

    def as_dict(self) -> dict[str, object]:
        return {
            'bodyGroups': self.body_groups,
            'instructions': self.instructions,
            'addr8': self.addr8,
            'addr32': self.addr32,
            'stringSwitches': self.string_switches,
            'uintSwitches': self.uint_switches,
            'switchCases': self.switch_cases,
            'exceptionHandlers': self.exception_handlers,
            'stringReferences': self.string_references,
            'functionReferences': self.function_references,
            'validationErrors': self.validation_errors,
            'invalidOpcodes': self.invalid_opcodes,
            'metadataMismatches': self.metadata_mismatches,
            'issues': len(self.issues),
        }

    def require_ok(self, label: str) -> None:
        if self.issues:
            first = self.issues[0]
            raise ValueError(f'{label}: {len(self.issues)} audit issues; first={first}')


def audit_hbc(file: HBCFile) -> HBCAudit:
    """Audit parser validation, body metadata, control flow, and index ranges."""

    issues: list[dict[str, object]] = []
    instruction_count = 0
    addr8_count = 0
    addr32_count = 0
    string_switch_count = 0
    uint_switch_count = 0
    switch_case_count = 0
    exception_handler_count = 0
    string_reference_count = 0
    function_reference_count = 0

    for message in file.validation.errors:
        issues.append(
            {
                'source': 'validation',
                'kind': 'validation-error',
                'message': message,
            }
        )
    for offset, opcode in file.validation.invalid_opcodes:
        issues.append(
            {
                'source': 'validation',
                'kind': 'invalid-opcode',
                'offset': offset,
                'opcode': opcode,
            }
        )
    metadata_issues = hbc_metadata_issues(file)
    issues.extend(
        {'source': 'metadata', **issue}
        for issue in metadata_issues
    )

    def add_issue(kind: str, group_offset: int, **details: object) -> None:
        issues.append({'kind': kind, 'bodyOffset': group_offset, **details})

    if file.header.function_count != len(file.function_headers):
        add_issue(
            'function-count',
            0,
            declared=file.header.function_count,
            parsed=len(file.function_headers),
        )

    for index, header in enumerate(file.function_headers):
        if header.effective is None:
            function_name = header.function_name
        else:
            function_name = header.effective.function_name
        string_reference_count += 1
        if not 0 <= function_name < file.header.string_count:
            add_issue(
                'function-name-index',
                header.effective_offset,
                function=index,
                value=function_name,
                limit=file.header.string_count,
            )

    for group in file.body_groups:
        starts = {instruction.offset for instruction in group.instructions}
        relative_starts = {offset - group.offset for offset in starts}
        end = group.offset + group.size
        boundaries = starts | {end}
        instruction_count += len(group.instructions)

        by_offset = {instruction.offset: instruction for instruction in group.instructions}
        group_frames: list[tuple[int, int, int]] = []
        for fn_index in group.function_indexes:
            if fn_index < len(file.function_headers):
                fn_header = file.function_headers[fn_index]
                if not (fn_header.overflowed and fn_header.effective is None):
                    if fn_header.effective is not None:
                        fn_frame_size = fn_header.effective.frame_size
                        fn_bytecode_size = fn_header.effective.bytecode_size
                    else:
                        fn_frame_size = fn_header.frame_size
                        fn_bytecode_size = fn_header.bytecode_size
                    if fn_bytecode_size > 0:
                        group_frames.append((fn_index, fn_frame_size, fn_bytecode_size))

        for instruction in group.instructions:
            operand_types = file.opcodes.operands(instruction.name)
            for operand_type, value in zip(operand_types, instruction.operands):
                if operand_type == 'Addr8':
                    addr8_count += 1
                elif operand_type == 'Addr32':
                    addr32_count += 1

            if instruction.name == STRING_SWITCH:
                string_switch_count += 1
            elif instruction.name == UINT_SWITCH:
                uint_switch_count += 1
            elif operand_types and operand_types[0] in ('Addr8', 'Addr32'):
                displacement = _signed(
                    instruction.operands[0],
                    8 if operand_types[0] == 'Addr8' else 32,
                )
                target = instruction.offset + displacement
                if target not in boundaries:
                    add_issue(
                        'branch-target',
                        group.offset,
                        instructions=group.function_indexes,
                        instructionOffset=instruction.offset,
                        opcode=instruction.name,
                        target=target,
                        bodyEnd=end,
                    )

            arg_count: int | None = None
            src_regs: tuple[int, ...] = ()
            if instruction.name in _FIXED_CALL_ARG_COUNTS:
                arg_count = _FIXED_CALL_ARG_COUNTS[instruction.name]
                src_regs = instruction.operands[1:]
            elif instruction.name in _VAR_CALL_ARG_OPERANDS:
                arg_pos = _VAR_CALL_ARG_OPERANDS[instruction.name]
                arg_count = instruction.operands[arg_pos]
                src_regs = instruction.operands[1:arg_pos]
            elif instruction.name in _BUILTIN_CALL_ARG_OPERANDS:
                arg_pos = _BUILTIN_CALL_ARG_OPERANDS[instruction.name]
                arg_count = instruction.operands[arg_pos]
                src_regs = ()
            elif instruction.name == 'CallRequire':
                arg_count = 1
                src_regs = (instruction.operands[1],)

            if arg_count is not None and group_frames:
                required_margin = CALLER_EXTRA_REGISTERS_AT_END + arg_count
                max_src = max(src_regs) if src_regs else -1
                rel_offset = instruction.offset - group.offset
                for fn_index, fn_frame_size, fn_bytecode_size in group_frames:
                    if rel_offset >= fn_bytecode_size:
                        continue
                    limit = fn_frame_size - required_margin
                    if limit < 0 or max_src >= limit:
                        add_issue(
                            'call-frame-overlap',
                            group.offset,
                            function=fn_index,
                            instructionOffset=instruction.offset,
                            opcode=instruction.name,
                            frameSize=fn_frame_size,
                            argCount=arg_count,
                            maxSourceRegister=max_src,
                            limit=limit,
                        )

            for operand in _STRING_INDEX_OPERANDS.get(instruction.name, ()):
                string_reference_count += 1
                value = instruction.operands[operand]
                if not 0 <= value < file.header.string_count:
                    add_issue(
                        'string-index',
                        group.offset,
                        instructionOffset=instruction.offset,
                        opcode=instruction.name,
                        operand=operand,
                        value=value,
                        limit=file.header.string_count,
                    )

            for operand in _FUNCTION_INDEX_OPERANDS.get(instruction.name, ()):
                function_reference_count += 1
                value = instruction.operands[operand]
                if not 0 <= value < file.header.function_count:
                    add_issue(
                        'function-index',
                        group.offset,
                        instructionOffset=instruction.offset,
                        opcode=instruction.name,
                        operand=operand,
                        value=value,
                        limit=file.header.function_count,
                    )
                elif (
                    instruction.name in _CALLABLE_CLOSURE_OPCODES
                    and value < len(file.function_headers)
                ):
                    target_header = file.function_headers[value]
                    if not (target_header.overflowed and target_header.effective is None):
                        target_flags = (
                            target_header.effective.flags
                            if target_header.effective is not None
                            else target_header.flags
                        )
                        if (target_flags & 0x03) == 0:
                            add_issue(
                                'closure-prohibit-call',
                                group.offset,
                                instructionOffset=instruction.offset,
                                opcode=instruction.name,
                                targetFunction=value,
                                targetFlags=target_flags,
                            )

        for table in group.switch_tables:
            instruction = by_offset.get(table.instruction_offset)
            if instruction is None:
                add_issue(
                    'switch-instruction',
                    group.offset,
                    instructionOffset=table.instruction_offset,
                )
                continue
            if table.kind == UINT_SWITCH:
                if len(table.raw) != table.count * 4:
                    add_issue(
                        'switch-size',
                        group.offset,
                        instructionOffset=table.instruction_offset,
                        kind=table.kind,
                        bytes=len(table.raw),
                        count=table.count,
                    )
                    continue
                targets = (
                    struct.unpack_from('<i', table.raw, offset)[0]
                    for offset in range(0, len(table.raw), 4)
                )
            elif table.kind == STRING_SWITCH:
                if len(table.raw) != table.count * 8:
                    add_issue(
                        'switch-size',
                        group.offset,
                        instructionOffset=table.instruction_offset,
                        kind=table.kind,
                        bytes=len(table.raw),
                        count=table.count,
                    )
                    continue
                string_ids: list[int] = []
                displacements: list[int] = []
                for offset in range(0, len(table.raw), 8):
                    string_id, displacement = struct.unpack_from('<Ii', table.raw, offset)
                    string_ids.append(string_id)
                    displacements.append(displacement)
                for case, string_id in enumerate(string_ids):
                    string_reference_count += 1
                    if not 0 <= string_id < file.header.string_count:
                        add_issue(
                            'switch-string-index',
                            group.offset,
                            instructionOffset=table.instruction_offset,
                            case=case,
                            value=string_id,
                            limit=file.header.string_count,
                        )
                targets = iter(displacements)
            else:
                add_issue(
                    'switch-kind',
                    group.offset,
                    instructionOffset=table.instruction_offset,
                    kind=table.kind,
                )
                continue

            for case, displacement in enumerate(targets):
                switch_case_count += 1
                target = table.instruction_offset + displacement
                if target not in starts:
                    add_issue(
                        'switch-target',
                        group.offset,
                        instructionOffset=table.instruction_offset,
                        case=case,
                        target=target,
                        bodyEnd=end,
                    )

        for function in group.function_indexes:
            small = file.function_headers[function]
            if small.full_header_offset is None:
                continue
            info = file.function_infos.get(small.full_header_offset)
            if info is None:
                add_issue(
                    'function-info-missing',
                    group.offset,
                    function=function,
                    pointer=small.full_header_offset,
                )
                continue
            for handler_index, handler in enumerate(info.exception_handlers):
                exception_handler_count += 1
                if not 0 <= handler.start <= handler.end <= group.size:
                    add_issue(
                        'exception-range',
                        group.offset,
                        function=function,
                        handler=handler_index,
                        start=handler.start,
                        end=handler.end,
                        bodySize=group.size,
                    )
                    continue
                if handler.start not in relative_starts:
                    add_issue(
                        'exception-start',
                        group.offset,
                        function=function,
                        handler=handler_index,
                        start=handler.start,
                    )
                if handler.end not in relative_starts | {group.size}:
                    add_issue(
                        'exception-end',
                        group.offset,
                        function=function,
                        handler=handler_index,
                        end=handler.end,
                    )
                if handler.target not in relative_starts:
                    add_issue(
                        'exception-target',
                        group.offset,
                        function=function,
                        handler=handler_index,
                        target=handler.target,
                    )

    return HBCAudit(
        body_groups=len(file.body_groups),
        instructions=instruction_count,
        addr8=addr8_count,
        addr32=addr32_count,
        string_switches=string_switch_count,
        uint_switches=uint_switch_count,
        switch_cases=switch_case_count,
        exception_handlers=exception_handler_count,
        string_references=string_reference_count,
        function_references=function_reference_count,
        validation_errors=len(file.validation.errors),
        invalid_opcodes=len(file.validation.invalid_opcodes),
        metadata_mismatches=len(metadata_issues),
        issues=tuple(issues),
    )
