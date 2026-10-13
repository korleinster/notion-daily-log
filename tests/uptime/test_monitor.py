"""Offline acceptance tests for the external heartbeat consumer."""

import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from unittest import mock


MODULE = pathlib.Path(__file__).resolve().parents[2] / "scripts/uptime/monitor.py"
SPEC = importlib.util.spec_from_file_location("uptime_monitor", MODULE)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)
UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 29, 12, 0, tzinfo=UTC)


def stamp(seconds_before=0):
    return (NOW - dt.timedelta(seconds=seconds_before)).isoformat().replace("+00:00", "Z")


def fixture(host_age=0, check_lag=0, mode="observe", status="healthy"):
    return {"heartbeat.json": {"content": json.dumps({
        "version": 1, "host": "macmini", "sentAt": stamp(host_age),
        "monitor": {"lastCheckAt": None if check_lag is None else stamp(host_age + check_lag),
                    "mode": mode, "status": status},
    })}}


class Store:
    def __init__(self, files, fail_write=False):
        self.files = copy.deepcopy(files)
        self.fail_write = fail_write
        self.writes = []

    def read(self):
        return copy.deepcopy(self.files)

    def write(self, state):
        if self.fail_write:
            raise monitor.MonitorError("state persistence failed")
        self.writes.append(copy.deepcopy(state))
        self.files[monitor.STATE_FILE] = {"content": json.dumps(state)}


class Notifier:
    def __init__(self, fail=False):
        self.messages = []
        self.fail = fail

    def send(self, message):
        self.messages.append(message)
        if self.fail:
            raise monitor.MonitorError("notification failed")


class Artifact:
    def __init__(self, state=None, fail_read=False, fail_write=False):
        self.state = copy.deepcopy(state)
        self.fail_read = fail_read
        self.fail_write = fail_write
        self.writes = []

    def read(self, now):
        if self.fail_read:
            raise monitor.MonitorError("artifact unavailable")
        return copy.deepcopy(self.state)

    def write(self, state):
        if self.fail_write:
            raise monitor.MonitorError("artifact unavailable")
        self.state = copy.deepcopy(state)
        self.writes.append(copy.deepcopy(state))


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.payload


class MonitorTests(unittest.TestCase):
    def test_artifact_requires_explicit_bootstrap_and_claim_before_effects(self):
        gist, artifact = Store(fixture(host_age=901)), Artifact()
        with self.assertRaises(monitor.MonitorError):
            monitor.prepare_artifact_run(gist, artifact, NOW)
        self.assertFalse(gist.writes)
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW, bootstrap=True), [])
        effects = monitor.prepare_artifact_run(gist, artifact, NOW)
        self.assertEqual([item['kind'] for item in effects], ['wol', 'alert'])
        self.assertEqual(artifact.state['pathPhase'], 'healthy')
        self.assertEqual(artifact.state['claim'], 'checkpoint')
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])

    def test_path_error_and_recovery_claim_once_without_wol(self):
        gist, artifact = Store(fixture()), Artifact()
        monitor.prepare_artifact_run(gist, artifact, NOW, bootstrap=True)
        gist.read = mock.Mock(side_effect=monitor.MonitorError('HTTP 401'))
        first = monitor.prepare_artifact_run(gist, artifact, NOW)
        self.assertEqual([item['kind'] for item in first], ['alert'])
        self.assertEqual(artifact.state['pathPhase'], 'error')
        self.assertEqual(artifact.state['errorCode'], 'gist_auth')
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])
        gist.read = lambda: copy.deepcopy(gist.files)
        recovered = monitor.prepare_artifact_run(gist, artifact, NOW)
        self.assertEqual([item['kind'] for item in recovered], ['alert'])
        self.assertIn('recovered', recovered[0]['message'])
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])

    def test_gist_data_time_and_write_failures_never_trigger_wol(self):
        for files, fail_write, code in (
            ({"heartbeat.json": {"content": "not-json"}}, False, "gist_data"),
            (fixture(host_age=-1), False, "gist_time"),
            (fixture(host_age=901), True, "gist_write"),
        ):
            with self.subTest(code=code):
                gist, artifact = Store(fixture()), Artifact()
                monitor.prepare_artifact_run(gist, artifact, NOW, bootstrap=True)
                gist.files, gist.fail_write = files, fail_write
                effects = monitor.prepare_artifact_run(gist, artifact, NOW)
                self.assertEqual([effect["kind"] for effect in effects], ["alert"])
                self.assertEqual(artifact.state["errorCode"], code)
                self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])

    def test_artifact_write_failure_blocks_effects_and_recovery_is_not_replayed(self):
        gist, artifact = Store(fixture(host_age=901)), Artifact()
        monitor.prepare_artifact_run(gist, artifact, NOW, bootstrap=True)
        artifact.fail_write = True
        with self.assertRaises(monitor.MonitorError):
            monitor.prepare_artifact_run(gist, artifact, NOW)
        artifact.fail_write = False
        # Gist claim may have reached the server before artifact upload failed.
        # Safety wins: do not infer a second WOL or an unclaimed alert.
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])
        gist.files["heartbeat.json"] = fixture()["heartbeat.json"]
        recovery = monitor.prepare_artifact_run(gist, artifact, NOW)
        self.assertEqual([effect["kind"] for effect in recovery], ["alert"])
        self.assertEqual(monitor.prepare_artifact_run(gist, artifact, NOW), [])

    def test_artifact_unavailable_blocks_gist_and_effects(self):
        gist = Store(fixture(host_age=901))
        with self.assertRaises(monitor.MonitorError):
            monitor.prepare_artifact_run(gist, Artifact(fail_read=True), NOW)
        self.assertFalse(gist.writes)

    def test_stale_boundary_and_first_down_once(self):
        store = Store(fixture(host_age=900))
        notify = Notifier()
        wol = mock.Mock()
        self.assertIn("fresh", monitor.run(store, notify, wol, NOW))
        self.assertEqual((len(store.writes), len(notify.messages), wol.call_count), (0, 0, 0))
        store.files = fixture(host_age=901) | {k: v for k, v in store.files.items() if k == monitor.STATE_FILE}
        self.assertIn("first incident", monitor.run(store, notify, wol, NOW))
        self.assertEqual((len(store.writes), len(notify.messages), wol.call_count), (1, 1, 1))
        self.assertEqual(store.writes[0]["incident"], 1)
        self.assertTrue(store.writes[0]["wolClaimed"])
        self.assertTrue(store.writes[0]["downAlertClaimed"])
        self.assertIn("already claimed", monitor.run(store, notify, wol, NOW))
        self.assertEqual((len(store.writes), len(notify.messages), wol.call_count), (1, 1, 1))

    def test_recovery_once_and_new_incident(self):
        store, notify, wol = Store(fixture(host_age=901)), Notifier(), mock.Mock()
        monitor.run(store, notify, wol, NOW)
        store.files["heartbeat.json"] = fixture(host_age=0)["heartbeat.json"]
        self.assertIn("recovery claimed", monitor.run(store, notify, wol, NOW))
        self.assertIn("recovered", notify.messages[-1])
        self.assertIn("fresh", monitor.run(store, notify, wol, NOW))
        self.assertEqual(len(notify.messages), 2)
        store.files["heartbeat.json"] = fixture(host_age=901)["heartbeat.json"]
        monitor.run(store, notify, wol, NOW)
        self.assertEqual((store.writes[-1]["incident"], wol.call_count), (2, 2))

    def test_persistence_failure_blocks_wol_and_alert(self):
        store, notify, wol = Store(fixture(host_age=901), fail_write=True), Notifier(), mock.Mock()
        with self.assertRaisesRegex(monitor.MonitorError, "persistence"):
            monitor.run(store, notify, wol, NOW)
        self.assertEqual((wol.call_count, len(notify.messages)), (0, 0))
        state = {"version": 1, "hostPhase": "down", "incident": 1, "observerPhase": "healthy"}
        store.files[monitor.STATE_FILE] = {"content": json.dumps(state)}
        store.files["heartbeat.json"] = fixture(host_age=0)["heartbeat.json"]
        with self.assertRaisesRegex(monitor.MonitorError, "persistence"):
            monitor.run(store, notify, wol, NOW)
        self.assertEqual(len(notify.messages), 0)

    def test_unknown_wol_outcome_is_not_replayed(self):
        store, notify = Store(fixture(host_age=901)), Notifier()
        wol = mock.Mock(side_effect=monitor.MonitorError("WOL send attempt failed"))
        monitor.run(store, notify, wol, NOW)
        self.assertIn("WOL send attempt failed", notify.messages[0])
        monitor.run(store, notify, wol, NOW)
        self.assertEqual((wol.call_count, len(notify.messages)), (1, 1))

    def test_unknown_notification_outcome_is_not_replayed(self):
        store, notify, wol = Store(fixture(host_age=901)), Notifier(fail=True), mock.Mock()
        with self.assertRaisesRegex(monitor.MonitorError, "notification failed"):
            monitor.run(store, notify, wol, NOW)
        self.assertEqual(store.writes[0]["hostPhase"], "down")
        monitor.run(store, notify, wol, NOW)
        self.assertEqual((wol.call_count, len(notify.messages)), (1, 1))

    def test_observer_lag_at_boundary_and_transition(self):
        store, notify, wol = Store(fixture(check_lag=90)), Notifier(), mock.Mock()
        self.assertIn("observer healthy", monitor.run(store, notify, wol, NOW))
        store.files["heartbeat.json"] = fixture(check_lag=91)["heartbeat.json"]
        self.assertIn("observer transition", monitor.run(store, notify, wol, NOW))
        self.assertEqual((len(notify.messages), wol.call_count), (1, 0))
        self.assertIn("lags host publisher", notify.messages[0])
        monitor.run(store, notify, wol, NOW)
        self.assertEqual(len(notify.messages), 1)
        store.files["heartbeat.json"] = fixture(check_lag=0)["heartbeat.json"]
        monitor.run(store, notify, wol, NOW)
        self.assertEqual(len(notify.messages), 2)
        self.assertIn("observer recovered", notify.messages[1])

    def test_null_disabled_and_degraded_observer_never_wol(self):
        for data, reason in ((fixture(check_lag=None), "check absent"),
                             (fixture(check_lag=None, mode="disabled"), "disabled"),
                             (fixture(status="degraded"), "degraded")):
            with self.subTest(reason=reason):
                notify, wol = Notifier(), mock.Mock()
                monitor.run(Store(data), notify, wol, NOW)
                self.assertIn(reason, notify.messages[0])
                wol.assert_not_called()

    def test_recovery_includes_unhealthy_observer(self):
        store, notify = Store(fixture(host_age=901)), Notifier()
        monitor.run(store, notify, mock.Mock(), NOW)
        store.files["heartbeat.json"] = fixture(check_lag=None)["heartbeat.json"]
        monitor.run(store, notify, mock.Mock(), NOW)
        self.assertIn("observer check absent", notify.messages[-1])

    def test_legacy_exact_format_only(self):
        good = {"heartbeat.txt": {"content": stamp(0) + " | alive\n"}}
        self.assertEqual(monitor.heartbeat(good, NOW)[3], "legacy")
        for value in (stamp(0) + " alive", stamp(0) + " | dead\n", stamp(0) + " | alive\nextra"):
            with self.subTest(value=value), self.assertRaises(monitor.MonitorError):
                monitor.heartbeat({"heartbeat.txt": {"content": value}}, NOW)
        self.assertEqual(monitor.heartbeat(good | fixture(host_age=0), NOW)[3], "json")

    def test_invalid_host_and_state_are_monitoring_errors_without_effects(self):
        cases = [fixture(host_age=-1), fixture(check_lag=-1), fixture(status="wrong"),
                 {"heartbeat.json": {"content": "not-json"}},
                 {"heartbeat.json": {"content": "{}", "truncated": True}},
                 {"heartbeat.txt": {"content": "garbage"}},
                 fixture(host_age=901) | {monitor.STATE_FILE: {"content": "not-json"}}]
        for files in cases:
            with self.subTest(files=files):
                store, notify, wol = Store(files), Notifier(), mock.Mock()
                with self.assertRaises(monitor.MonitorError):
                    monitor.run(store, notify, wol, NOW)
                self.assertFalse(store.writes)
                self.assertFalse(notify.messages)
                wol.assert_not_called()

    def test_gist_fetch_failure_is_monitoring_path_error(self):
        store, notify, wol = Store(fixture(host_age=901)), Notifier(), mock.Mock()
        store.read = mock.Mock(side_effect=monitor.MonitorError("HTTP 401"))
        with self.assertRaisesRegex(monitor.MonitorError, "HTTP 401"):
            monitor.run(store, notify, wol, NOW)
        self.assertFalse(store.writes)
        self.assertFalse(notify.messages)
        wol.assert_not_called()

    def test_backend_default_explicit_and_fail_closed(self):
        base = {"GIST_ID": "a" * 32, "GIST_TOKEN": "gist", "TELEGRAM_BOT_TOKEN": "tg", "TELEGRAM_CHAT_ID": "123"}
        self.assertEqual(monitor.backend_from(base), "telegram")
        slack = base | {"OPS_NOTIFICATION_BACKEND": "slack", "SLACK_BOT_TOKEN": "slack", "SLACK_ALERTS_CHANNEL_ID": "C123ABC"}
        self.assertEqual(monitor.backend_from(slack), "slack")
        self.assertEqual(monitor.backend_from(slack | {"OPS_NOTIFICATION_BACKEND": "dual"}), "dual")
        for env in (base | {"OPS_NOTIFICATION_BACKEND": "typo"},
                    slack | {"SLACK_ALERTS_CHANNEL_ID": "bad"},
                    {k: v for k, v in base.items() if k != "GIST_TOKEN"},
                    base | {"OPS_NOTIFICATION_BACKEND": "slack"}):
            with self.subTest(env=env), self.assertRaises(monitor.MonitorError):
                monitor.backend_from(env)

    def test_wol_packet_destination_and_failure(self):
        env = {"MACMINI_WAN_IP": "192.0.2.10", "MACMINI_MAC": "68:5b:35:b3:48:94"}
        sock = mock.MagicMock()
        sock.__enter__.return_value = sock
        with mock.patch.object(monitor.socket, "socket", return_value=sock):
            monitor.wol(env)
        packet, destination = sock.sendto.call_args.args
        self.assertEqual((len(packet), destination), (102, ("192.0.2.10", 9002)))
        self.assertEqual(packet[:6], b"\xff" * 6)
        with self.assertRaises(monitor.MonitorError):
            monitor.wol(env | {"MACMINI_MAC": "invalid"})


class TransportTests(unittest.TestCase):
    def test_artifact_redirect_strips_auth_and_rejects_untrusted_host(self):
        handler = monitor.ArtifactRedirect()
        request = urllib.request.Request(
            'https://api.github.com/repos/korleinster/notion-daily-log/actions/artifacts/12/zip', headers={
            'Authorization': 'Bearer fixture-only', 'Accept': 'application/zip'})
        redirected = handler.redirect_request(request, None, 302, 'Found', {},
            'https://productionresults.blob.core.windows.net/signed?sig=fake')
        self.assertNotIn('Authorization', redirected.headers)
        self.assertNotIn('Authorization', redirected.unredirected_hdrs)
        with self.assertRaises(monitor.MonitorError):
            handler.redirect_request(request, None, 302, 'Found', {},
                'https://outside.example.test/steal')
        non_archive = urllib.request.Request('https://api.github.com/archive', headers={
            'Authorization': 'Bearer fixture-only'})
        with self.assertRaises(monitor.MonitorError):
            handler.redirect_request(non_archive, None, 302, 'Found', {},
                'https://productionresults.blob.core.windows.net/signed?sig=fake')

    def test_artifact_latest_corrupt_fails_closed_without_older_fallback(self):
        state = {'version': 1, 'pathPhase': 'healthy', 'errorCode': 'none', 'incident': 0,
                 'claim': 'checkpoint', 'claimedAt': stamp(), 'checkedAt': stamp()}
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('../outside.json', json.dumps(state))
        raw = archive.getvalue()
        def item(identifier, created):
            return {'id': identifier, 'name': f'macmini-monitor-state-v1-{identifier}-1',
                    'created_at': created, 'expired': False, 'size_in_bytes': len(raw),
                    'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                    'archive_download_url': f'https://api.github.com/repos/korleinster/notion-daily-log/actions/artifacts/{identifier}/zip',
                    'workflow_run': {'id': identifier, 'repository_id': 42,
                                     'head_repository_id': 42, 'head_branch': 'main'}}
        latest, older = item(12, stamp()), item(11, stamp(600))
        calls = []
        def opener(request, timeout):
            calls.append(request.full_url)
            if '/artifacts?' in request.full_url:
                return Response(json.dumps({'total_count': 2, 'artifacts': [older, latest]}).encode())
            if '/runs/12' in request.full_url:
                return Response(json.dumps({'id': 12, 'head_branch': 'main',
                    'path': monitor.WORKFLOW_FILE + '@main',
                    'event': 'schedule', 'run_attempt': 1,
                    'repository': {'id': 42}, 'head_repository': {'id': 42}}).encode())
            return Response(raw)
        env = {'GITHUB_REPOSITORY': 'korleinster/notion-daily-log', 'GITHUB_REF': 'refs/heads/main',
               'GITHUB_EVENT_NAME': 'schedule', 'GITHUB_REPOSITORY_ID': '42',
               'GITHUB_RUN_ID': '13', 'GITHUB_RUN_ATTEMPT': '1',
               'GITHUB_WORKFLOW_REF': 'korleinster/notion-daily-log/' + monitor.WORKFLOW_FILE + '@refs/heads/main',
               'GITHUB_TOKEN': 'fake-token', 'RUNNER_TEMP': '/private/tmp'}
        artifact = monitor.GithubArtifact(env, NOW, opener=opener)
        with self.assertRaisesRegex(monitor.MonitorError, 'invalid artifact archive'):
            artifact.read(NOW)
        self.assertNotIn('/runs/11', calls)

    def test_artifact_requires_digest_exact_size_and_trusted_event(self):
        state = {'version': 1, 'pathPhase': 'healthy', 'errorCode': 'none', 'incident': 0,
                 'claim': 'checkpoint', 'claimedAt': stamp(), 'checkedAt': stamp()}
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr(monitor.ARTIFACT_FILE, json.dumps(state))
        raw = archive.getvalue()
        item = {'id': 12, 'name': 'macmini-monitor-state-v1-12-1',
                'created_at': stamp(), 'expired': False, 'size_in_bytes': len(raw),
                'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                'archive_download_url': 'https://api.github.com/repos/korleinster/notion-daily-log/actions/artifacts/12/zip',
                'workflow_run': {'id': 12, 'repository_id': 42,
                                 'head_repository_id': 42, 'head_branch': 'main'}}
        run = {'id': 12, 'head_branch': 'main', 'path': monitor.WORKFLOW_FILE + '@main',
               'event': 'schedule', 'run_attempt': 1, 'conclusion': 'failure',
               'repository': {'id': 42}, 'head_repository': {'id': 42}}
        def opener(request, timeout):
            if '/artifacts?' in request.full_url:
                return Response(json.dumps({'total_count': 1, 'artifacts': [item]}).encode())
            if '/runs/12' in request.full_url:
                return Response(json.dumps(run).encode())
            return Response(raw)
        env = {'GITHUB_REPOSITORY': 'korleinster/notion-daily-log', 'GITHUB_REF': 'refs/heads/main',
               'GITHUB_EVENT_NAME': 'schedule', 'GITHUB_REPOSITORY_ID': '42',
               'GITHUB_RUN_ID': '13', 'GITHUB_RUN_ATTEMPT': '1',
               'GITHUB_WORKFLOW_REF': 'korleinster/notion-daily-log/' + monitor.WORKFLOW_FILE + '@refs/heads/main',
               'GITHUB_TOKEN': 'fake-token', 'RUNNER_TEMP': '/private/tmp'}
        artifact = monitor.GithubArtifact(env, NOW, opener=opener)
        # The workflow-run REST API can return a bare workflow file path.
        # Only these three exact forms are compatible with the trusted workflow.
        for path in (monitor.WORKFLOW_FILE, monitor.WORKFLOW_FILE + '@main',
                     monitor.WORKFLOW_FILE + '@refs/heads/main'):
            with self.subTest(valid_path=path):
                run['path'] = path
                self.assertEqual(artifact.read(NOW), state)
        for path in (monitor.WORKFLOW_FILE + '.bak', monitor.WORKFLOW_FILE + '@feature',
                     monitor.WORKFLOW_FILE + '@refs/heads/feature',
                     '.github/workflows/other-uptime.yml',
                     'other/repository/' + monitor.WORKFLOW_FILE):
            with self.subTest(invalid_path=path):
                run['path'] = path
                with self.assertRaisesRegex(monitor.MonitorError, 'untrusted artifact provenance'):
                    artifact.read(NOW)
        run['path'] = monitor.WORKFLOW_FILE
        # A bare path is not an exception to branch, repository, event, or run checks.
        for field, bad_value in (('head_branch', 'feature'), ('event', 'push'),
                                 ('repository', {'id': 43}), ('head_repository', {'id': 43}),
                                 ('id', 11), ('run_attempt', 0)):
            with self.subTest(bare_path_run_field=field):
                original = run[field]
                run[field] = bad_value
                try:
                    with self.assertRaisesRegex(monitor.MonitorError, 'untrusted artifact provenance'):
                        artifact.read(NOW)
                finally:
                    run[field] = original
        for field, bad_value in (('repository_id', 43), ('head_repository_id', 43),
                                 ('head_branch', 'feature')):
            with self.subTest(bare_path_artifact_field=field):
                original = item['workflow_run'][field]
                item['workflow_run'][field] = bad_value
                try:
                    with self.assertRaisesRegex(monitor.MonitorError, 'untrusted artifact provenance'):
                        artifact.read(NOW)
                finally:
                    item['workflow_run'][field] = original
        for bad_env in ({'GITHUB_REPOSITORY': 'other/repository'},
                        {'GITHUB_REF': 'refs/heads/feature'},
                        {'GITHUB_EVENT_NAME': 'push'},
                        {'GITHUB_WORKFLOW_REF': 'korleinster/notion-daily-log/' +
                         monitor.WORKFLOW_FILE + '@refs/heads/feature'}):
            with self.subTest(bare_path_context=bad_env):
                with self.assertRaisesRegex(monitor.MonitorError, 'untrusted workflow context'):
                    monitor.GithubArtifact(env | bad_env, NOW, opener=opener)
        for mutation in ({'digest': None}, {'size_in_bytes': len(raw) + 1},
                         {'name': 'macmini-monitor-state-v1-12-2'}):
            with self.subTest(mutation=mutation):
                item.update(mutation)
                with self.assertRaises(monitor.MonitorError):
                    artifact.read(NOW)
                item.update({'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                             'size_in_bytes': len(raw), 'name': 'macmini-monitor-state-v1-12-1'})

    def test_artifact_state_uses_checkpoint_freshness_during_long_incident(self):
        state = {'version': 1, 'pathPhase': 'error', 'errorCode': 'gist_transport', 'incident': 2,
                 'claim': 'error', 'claimedAt': stamp(8 * 86400), 'checkedAt': stamp()}
        self.assertEqual(monitor.validate_artifact_state(state, NOW), state)
        state['checkedAt'] = stamp(8 * 86400)
        with self.assertRaisesRegex(monitor.MonitorError, 'expired'):
            monitor.validate_artifact_state(state, NOW)

    def test_artifact_state_rejects_inconsistent_phase(self):
        state = {'version': 1, 'pathPhase': 'error', 'errorCode': 'none', 'incident': 0,
                 'claim': 'error', 'claimedAt': stamp(), 'checkedAt': stamp()}
        with self.assertRaises(monitor.MonitorError):
            monitor.validate_artifact_state(state, NOW)

    def test_workflow_is_serialized_with_checkout_read_permission(self):
        workflow = (MODULE.parents[2] / ".github/workflows/macmini-uptime.yml").read_text()
        self.assertIn("permissions:\n  contents: read\n  actions: read", workflow)
        self.assertIn("group: macmini-uptime-monitor", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("uses: actions/checkout@", workflow)
        self.assertIn("cron: '*/10 * * * *'", workflow)
        self.assertIn("python3 scripts/uptime/monitor.py prepare", workflow)
        self.assertIn("python3 scripts/uptime/monitor.py effects", workflow)
        self.assertIn("if-no-files-found: error", workflow)
        self.assertIn("retention-days: 7", workflow)
        self.assertIn("steps.upload-state.outputs.artifact-id", workflow)
        self.assertLess(workflow.index("python3 scripts/uptime/monitor.py prepare"),
                        workflow.index("uses: actions/upload-artifact@"))
        self.assertLess(workflow.index("uses: actions/upload-artifact@"),
                        workflow.index("python3 scripts/uptime/monitor.py effects"))

    def test_effects_phase_requires_uploaded_id_and_persisted_state(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {'GITHUB_REPOSITORY': 'korleinster/notion-daily-log', 'GITHUB_REF': 'refs/heads/main',
                   'GITHUB_EVENT_NAME': 'schedule', 'GITHUB_REPOSITORY_ID': '42',
                   'GITHUB_RUN_ID': '13', 'GITHUB_RUN_ATTEMPT': '1',
                   'GITHUB_WORKFLOW_REF': 'korleinster/notion-daily-log/' + monitor.WORKFLOW_FILE + '@refs/heads/main',
                   'GITHUB_TOKEN': 'fake-token', 'RUNNER_TEMP': directory,
                   'GIST_ID': 'a' * 32, 'GIST_TOKEN': 'fake-gist-token',
                   'TELEGRAM_BOT_TOKEN': 'fake-telegram-token', 'TELEGRAM_CHAT_ID': '123'}
            effects = [{'kind': 'wol'}, {'kind': 'alert', 'message': 'safe test alert'}]
            (pathlib.Path(directory) / 'monitor-effects.json').write_text(json.dumps(effects))
            notifier, wol = Notifier(), mock.Mock()
            with mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch.object(monitor.sys, 'argv', ['monitor.py', 'effects']), \
                 mock.patch.object(monitor, 'Notifier', return_value=notifier), \
                 mock.patch.object(monitor, 'wol', wol):
                self.assertEqual(monitor.main(), 1)
                wol.assert_not_called()
                os.environ['UPTIME_ARTIFACT_ID'] = '123'
                self.assertEqual(monitor.main(), 1)
                wol.assert_not_called()
                now = dt.datetime.now(UTC).isoformat().replace('+00:00', 'Z')
                state = {'version': 1, 'pathPhase': 'healthy', 'errorCode': 'none', 'incident': 0,
                         'claim': 'checkpoint', 'claimedAt': now, 'checkedAt': now}
                (pathlib.Path(directory) / monitor.ARTIFACT_FILE).write_text(json.dumps(state))
                self.assertEqual(monitor.main(), 0)
                self.assertEqual((wol.call_count, notifier.messages), (1, ['safe test alert']))

    def test_gist_state_patch_is_separate_from_heartbeat(self):
        calls = []
        state = {"version": 1, "hostPhase": "down", "incident": 1, "observerPhase": "healthy"}
        def opener(request, timeout):
            calls.append((request, timeout))
            if request.get_method() == "GET":
                return Response(json.dumps({"files": {monitor.STATE_FILE: {
                    "content": json.dumps(state)}}}).encode())
            return Response(b"{}")
        gist = monitor.Gist({"GIST_ID": "a" * 32, "GIST_TOKEN": "secret"}, monitor.Http(opener=opener))
        gist.write(state)
        request, timeout = calls[0]
        body = json.loads(request.data)
        self.assertEqual((request.get_method(), timeout), ("PATCH", 10))
        self.assertEqual(set(body["files"]), {monitor.STATE_FILE})
        self.assertNotIn("heartbeat.json", body["files"])
        self.assertEqual(calls[1][0].get_method(), "GET")
        mismatch = monitor.Http(opener=lambda *_args, **_kwargs: Response(b"{}"))
        with self.assertRaises(monitor.MonitorError):
            monitor.Gist({"GIST_ID": "a" * 32, "GIST_TOKEN": "secret"}, mismatch).write(
                state)

    def test_http_fetch_auth_error_and_invalid_json_are_safe(self):
        def http_error(_request, timeout):
            raise urllib.error.HTTPError("https://secret.invalid/token", 401, "sensitive", {}, io.BytesIO(b"secret"))
        with self.assertRaisesRegex(monitor.MonitorError, "HTTP 401") as caught:
            monitor.Http(opener=http_error).json(urllib.request.Request("https://example.invalid"))
        self.assertNotIn("secret", str(caught.exception))
        with self.assertRaises(monitor.MonitorError):
            monitor.Http(opener=lambda *_args, **_kwargs: Response(b"invalid")).json(
                urllib.request.Request("https://example.invalid"))
        with self.assertRaisesRegex(monitor.MonitorError, "too large"):
            monitor.Http(opener=lambda *_args, **_kwargs: Response(b"x" * (1024 * 1024 + 1))).json(
                urllib.request.Request("https://example.invalid"))

    def test_http_429_bounded_retry(self):
        calls, sleeps = [], []
        def opener(_request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise urllib.error.HTTPError("https://example.invalid", 429, "rate", {"Retry-After": "2"}, None)
            return Response(b"{\"ok\": true}")
        self.assertTrue(monitor.Http(opener=opener, sleep=sleeps.append).json(
            urllib.request.Request("https://example.invalid"))["ok"])
        self.assertEqual((calls, sleeps), ([10, 10], [2.0]))
        calls.clear()
        def too_long(_request, timeout):
            calls.append(1)
            raise urllib.error.HTTPError("https://example.invalid", 429, "rate", {"Retry-After": "30"}, None)
        with self.assertRaisesRegex(monitor.MonitorError, "HTTP 429"):
            monitor.Http(opener=too_long, sleep=sleeps.append).json(
                urllib.request.Request("https://example.invalid"))
        self.assertEqual(len(calls), 1)

    def test_slack_telegram_dual_payloads_and_api_failure(self):
        env = {"SLACK_BOT_TOKEN": "slack", "SLACK_ALERTS_CHANNEL_ID": "C123ABC",
               "TELEGRAM_BOT_TOKEN": "telegram", "TELEGRAM_CHAT_ID": "123"}
        requests = []
        def opener(request, timeout):
            requests.append(request)
            return Response(b"{\"ok\": true}")
        http = monitor.Http(opener=opener)
        monitor.Notifier(env, "dual", http).send("test")
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].full_url, monitor.SLACK_API)
        slack = json.loads(requests[0].data)
        self.assertEqual(slack["channel"], "C123ABC")
        self.assertFalse(slack["unfurl_links"])
        self.assertFalse(slack["unfurl_media"])
        self.assertFalse(slack["link_names"])
        self.assertIn("chat_id=123", requests[1].data.decode())
        requests.clear()
        monitor.Notifier(env, "slack", http).send("test")
        self.assertEqual(len(requests), 1)
        requests.clear()
        monitor.Notifier(env, "telegram", http).send("test")
        self.assertEqual(len(requests), 1)
        failing = monitor.Http(opener=lambda *_args, **_kwargs: Response(b"{\"ok\": false}"))
        with self.assertRaisesRegex(monitor.MonitorError, "Slack notification failed"):
            monitor.Notifier(env, "slack", failing).send("test")


if __name__ == "__main__":
    unittest.main()
