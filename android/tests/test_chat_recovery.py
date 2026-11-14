"""Offline Android chat acceptance checks. Run: python -I -S -B android/tests/test_chat_recovery.py

The native runner can import verify_chat_recovery and pass observations in memory.
This module does not collect data, connect to anything, or import a private driver.
"""
from copy import deepcopy
from hashlib import sha256
import json
import re
import unittest


class EvidenceError(ValueError):
    """A fixed diagnostic code, never a transcript, locator, or identifier."""


def _need(ok, code):
    if not ok:
        raise EvidenceError(code)


def _sha(text):
    return sha256(text.encode('utf-8')).hexdigest()


def _dialog(rows, stage):
    _need(isinstance(rows, list), stage + '-full-transcript-required')
    result, seen = [], set()
    for row in rows:
        _need(isinstance(row, dict), stage + '-invalid-row')
        msg = row.get('message')
        if row.get('role') == 'user':
            role, text = 'user', row.get('content')
        elif row.get('kind') == 'send-message' and isinstance(msg, dict) and msg.get('type') == 'text':
            role, text = 'assistant', msg.get('content')
        else:
            continue  # Acceptance, reasoning, tool and non-text entries are not delivered text.
        rid = row.get('id')
        _need(type(rid) is int or isinstance(rid, str) and rid.strip(), stage + '-missing-row-id')
        _need(str(rid) not in seen, stage + '-duplicate-row-id')
        _need(isinstance(text, str), stage + '-invalid-text')
        seen.add(str(rid))
        result.append((role, rid, text))
    return result


def _check_bubbles(snapshot, records, stage):
    _need(isinstance(snapshot, list), stage + '-bubble-read-required')
    _need(len(snapshot) == len(records), stage + '-bubble-count')
    for bubble, (role, _, text) in zip(snapshot, records):
        _need(isinstance(bubble, dict) and bubble.get('role') == role and
              isinstance(bubble.get('text'), str) and bubble['text'].strip() == text.strip(),
              stage + '-bubble-order-or-content')


def _digest(rows):
    ordered = [(role, _sha(str(rid)), _sha(text)) for role, rid, text in rows]
    return _sha(json.dumps(ordered, separators=(',', ':')) + '\n')


def _check_readback(evidence):
    _need(isinstance(evidence, dict), 'reconnect-observations-required')
    for field, reason in [('deviceTags', 'unbound-paired-device'), ('agentTags', 'unbound-agent')]:
        tags = evidence.get(field)
        _need(isinstance(tags, (list, tuple)) and len(tags) == 4 and isinstance(tags[0], str) and
              re.fullmatch(r'[0-9a-f]{64}', tags[0]) and all(t == tags[0] for t in tags), reason)
    fields = ('secondHistorySeq', 'transportDownSeq', 'transportUpSeq', 'freshHistoryRequestSeq',
              'freshHistoryReplySeq', 'freshUiSeq')
    seq = [evidence.get(f) for f in fields]
    _need(all(type(n) is int and n >= 0 for n in seq) and all(a < b for a, b in zip(seq, seq[1:])),
          'missing-or-out-of-order-reconnect-read')
    counts = evidence.get('submitCounts')
    _need(isinstance(counts, (list, tuple)) and tuple(counts) == (1, 1, 0) and all(type(n) is int for n in counts),
          'unexpected-native-submit-count')
    return {'samePairedDevice': True, 'sameAgent': True, 'submitCounts': list(counts), **dict(zip(fields, seq))}


def verify_chat_recovery(prompts, label, *, baseline, first, second, recovered, bubbles, evidence):
    """Verify complete chronological getAgentTranscript arrays for one clean text-only chat.

    bubbles[stage] is an independent, ordered native read of ALL text bubbles in that
    chat, including any baseline. Do not filter on the challenge, sort, or deduplicate.
    evidence.deviceTags and agentTags bind the four reads in the order above. Use one
    monotonic observation counter for the second read, an observed transport-down/up,
    a new complete history request and its matching reply, then the new native UI read.
    submitCounts counts native-origin sendPrompt requests in turn 1, turn 2 and recovery.
    The native collector establishes origin and model use; snapshots cannot prove those.
    """
    _need(isinstance(prompts, (tuple, list)) and len(prompts) == 2 and
          all(isinstance(p, str) and p.strip() for p in prompts) and prompts[0] != prompts[1] and
          isinstance(label, str) and label and label.strip() == label and label not in prompts[1],
          'invalid-context-challenge')
    _need(isinstance(bubbles, dict), 'native-bubble-reads-required')
    readback = _check_readback(evidence)
    previous = _dialog(baseline, 'baseline')
    _need(not any(label in text or text in prompts for _, _, text in previous), 'challenge-in-baseline')
    prior_raw, turns = baseline, []
    for stage, raw, prompt in (('first', first, prompts[0]), ('second', second, prompts[1])):
        current = _dialog(raw, stage)
        _need(current[:len(previous)] == previous, stage + '-prior-records-changed')
        added = current[len(previous):]
        _need(len(added) == 2, stage + '-new-text-row-count')
        (ur, uid, ut), (ar, aid, at) = added
        _need(ur == 'user' and ut == prompt and ar == 'assistant' and at.strip() == label,
              stage + '-turn-order-or-content')
        prior_ids = {str(r['id']) for r in prior_raw if r.get('id') is not None}
        _need(not {str(uid), str(aid)} & prior_ids, stage + '-reused-prior-id')
        _check_bubbles(bubbles.get(stage), current, stage)
        turns.append({'userRowTag': _sha(str(uid)), 'promptSha256': _sha(ut),
                      'replyRowTag': _sha(str(aid)), 'replySha256': _sha(at)})
        previous, prior_raw = current, raw

    restored = _dialog(recovered, 'recovered')
    _need(restored == previous, 'recovered-records-changed')  # Raw text and ID, not just the matching label.
    _check_bubbles(bubbles.get('recovered'), restored, 'recovered')
    return {'turns': turns, 'readback': readback, 'beforeReconnectDialogSha256': _digest(previous),
            'afterReconnectDialogSha256': _digest(restored), 'newTextRowsOnReconnect': len(restored) - len(previous),
            'uiTextRowCounts': {s: len(bubbles[s]) for s in ('first', 'second', 'recovered')}}


class ChatRecoveryTests(unittest.TestCase):
    def setUp(self):
        label = 'PB-7ab41c'
        p1, p2 = 'Join PB-, 7ab and 41c. Reply only with the label.', 'Recall the previous label. Ref R-02.'

        def user(rid, text):
            return {'role': 'user', 'id': rid, 'content': text}

        def reply(rid):
            return {'kind': 'send-message', 'id': rid, 'message': {'type': 'text', 'content': label}}

        base = [user('old-user', 'Earlier fixture.')]
        first = [*base, user('user-one', p1), {'id': 'trace-one', 'role': 'assistant', 'content': label}, reply('reply-one')]
        second = [*first, user('user-two', p2), reply('reply-two')]
        ui1 = [{'role': 'user', 'text': 'Earlier fixture.'}, {'role': 'user', 'text': p1},
               {'role': 'assistant', 'text': label}]
        ui2 = [*ui1, {'role': 'user', 'text': p2}, {'role': 'assistant', 'text': label}]
        self.args = dict(prompts=(p1, p2), label=label, baseline=deepcopy(base), first=deepcopy(first),
                         second=deepcopy(second), recovered=deepcopy(second),
                         bubbles={'first': deepcopy(ui1), 'second': deepcopy(ui2), 'recovered': deepcopy(ui2)},
                         evidence={'deviceTags': [_sha('fixture-device')] * 4, 'agentTags': [_sha('fixture-agent')] * 4,
                                   'submitCounts': [1, 1, 0], 'secondHistorySeq': 5, 'transportDownSeq': 8,
                                   'transportUpSeq': 9, 'freshHistoryRequestSeq': 12, 'freshHistoryReplySeq': 13,
                                   'freshUiSeq': 16})

    def rejects(self, code, **changes):
        with self.assertRaises(EvidenceError) as exc:
            verify_chat_recovery(**{**self.args, **changes})
        self.assertEqual(str(exc.exception), code)

    def test_same_reply_in_two_turns_survives_a_fresh_read(self):
        self.args['recovered'] = [r for r in self.args['recovered'] if r.get('id') != 'trace-one']
        self.args['recovered'][-1]['timestampMs'] = 123
        report = verify_chat_recovery(**self.args)
        one, two = report['turns']
        self.assertEqual(len({t[k] for t in (one, two) for k in ('userRowTag', 'replyRowTag')}), 4)
        self.assertEqual(one['replySha256'], two['replySha256'])
        self.assertEqual(report['beforeReconnectDialogSha256'], report['afterReconnectDialogSha256'])
        self.assertEqual(report['newTextRowsOnReconnect'], 0)
        self.assertEqual(report['uiTextRowCounts'], {'first': 3, 'second': 5, 'recovered': 5})
        for raw in (*self.args['prompts'], self.args['label'], 'old-user', 'reply-one'):
            self.assertNotIn(raw, json.dumps(report))

    def test_duplicate_or_extra_text_is_not_filtered_out(self):
        for stage, prompt in zip(('first', 'second'), self.args['prompts']):
            rows = self.args[stage]
            for name, extra, reason in (
                ('same-id', rows[-1], 'duplicate-row-id'),
                ('new-id', {**rows[-1], 'id': 'copy'}, 'new-text-row-count'),
                ('other-text', {**rows[-1], 'id': 'extra', 'message': {'type': 'text', 'content': 'Other text.'}}, 'new-text-row-count'),
                ('resend', {'role': 'user', 'id': 'resend', 'content': prompt}, 'new-text-row-count'),
            ):
                with self.subTest(stage=stage, name=name):
                    self.rejects(stage + '-' + reason, **{stage: [*rows, extra]})

    def test_two_matching_replies_in_the_first_turn_do_not_prove_the_second(self):
        rows = self.args['second']
        self.rejects('second-turn-order-or-content', second=[*rows[:-2], rows[-1], rows[-2]])
        self.rejects('second-new-text-row-count', second=[*rows[:-1], {'accepted': True},
                     {'id': 'trace-two', 'role': 'assistant', 'content': self.args['label']}])

    def test_new_rows_need_new_ids_and_previous_turn_must_still_exist(self):
        rows = deepcopy(self.args['second'])
        rows[-1]['id'] = 'trace-one'
        self.rejects('second-reused-prior-id', second=rows)
        rows[-1]['id'] = None
        self.rejects('second-missing-row-id', second=rows)
        rows = deepcopy(self.args['second'])
        rows[3]['id'] = 'replaced-first-reply'
        self.rejects('second-prior-records-changed', second=rows)

    def test_reconnect_rejects_loss_replacement_reordering_or_changed_text(self):
        rows = self.args['recovered']
        u2, a2 = rows[-2:]
        for name, bad in (
            ('missing', rows[:-1]), ('retagged', [*rows[:-1], {**a2, 'id': 'new-id'}]),
            ('reordered', [*rows[:-2], a2, u2]), ('extra', [*rows, {**a2, 'id': 'copy'}]),
            ('text-changed', [*rows[:-1], {**a2, 'message': {'type': 'text', 'content': self.args['label'] + ' '}}]),
            ('baseline-lost', rows[1:]),
        ):
            with self.subTest(name=name):
                self.rejects('recovered-records-changed', recovered=bad)

    def test_correct_records_do_not_excuse_missing_duplicate_or_misplaced_native_bubbles(self):
        ui = self.args['bubbles']
        for stage in ('second', 'recovered'):
            rows = ui[stage]
            for bad, reason in ((None, 'bubble-read-required'), (rows[:-1], 'bubble-count'),
                                ([*rows, rows[-1]], 'bubble-count'),
                                ([*rows[:-2], rows[-1], rows[-2]], 'bubble-order-or-content')):
                with self.subTest(stage=stage, reason=reason):
                    self.rejects(stage + '-' + reason, bubbles={**ui, stage: bad})

    def test_rejects_stale_challenge_or_incomplete_history_source(self):
        self.rejects('challenge-in-baseline', baseline=[{'role': 'user', 'id': 'old', 'content': self.args['label']}])
        self.rejects('invalid-context-challenge', prompts=(self.args['prompts'][0], 'Echo ' + self.args['label']))
        self.rejects('recovered-full-transcript-required', recovered={'entries': self.args['recovered']})

    def test_equal_snapshots_are_not_proof_of_a_reconnect_or_fresh_read(self):
        proof = self.args['evidence']
        self.rejects('reconnect-observations-required', evidence=None)
        for field, wrong in [('transportDownSeq', None), ('transportUpSeq', proof['transportDownSeq']),
                             ('freshHistoryRequestSeq', proof['secondHistorySeq']), ('freshUiSeq', proof['freshHistoryReplySeq'])]:
            with self.subTest(field=field):
                self.rejects('missing-or-out-of-order-reconnect-read', evidence={**proof, field: wrong})

    def test_same_text_from_another_device_agent_or_resubmit_cannot_pass(self):
        proof = self.args['evidence']
        for field, reason in [('deviceTags', 'unbound-paired-device'), ('agentTags', 'unbound-agent')]:
            self.rejects(reason, evidence={**proof, field: [*proof[field][:-1], _sha('other')]})
        for counts in ([1, 1, 1], [2, 1, 0], [1, 0, 0]):
            self.rejects('unexpected-native-submit-count', evidence={**proof, 'submitCounts': counts})


if __name__ == '__main__':
    unittest.main()
