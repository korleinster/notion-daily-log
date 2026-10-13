# External Mac Mini uptime monitor (Revision 3 local implementation)

Corrective Revision 3 (`SLACK-R3-CORRECTIVE-20261012`) was approved for full
direct local execution on 2026-10-12. Its exact workflow-path correction and
regression tests passed independent QA: 29 uptime tests on Python 3.12 and 10
notification tests on Node 22.23.3. Notion's R3 scope passed; overall R3 local
acceptance is **BLOCKED** by a separate Discord sanitizer finding. Approved
Revision 4 has not yet been implemented. This is local implementation,
**not an activated production monitor**.
The real GitHub Ubuntu workflow and Slack
receipt are unverified. Deploying the workflow, installing the producer and
observer, changing the notification backend, and enabling automatic recovery
each require separate owner-approved operational gates. Do not test against
the production Gist or send real alerts from a development run.

## Signals and state

The host publishes `heartbeat.json` to a Gist every five minutes:

```json
{
  "version": 1,
  "host": "macmini",
  "sentAt": "2026-09-29T12:00:00Z",
  "monitor": {
    "lastCheckAt": "2026-09-29T11:59:45Z",
    "mode": "observe",
    "status": "healthy"
  }
}
```

`lastCheckAt` can be `null`; `mode` is `observe`, `auto`, or `disabled`; `status` is `healthy`, `degraded`, or `unknown`. A valid host `sentAt` is the only liveness source. Gist metadata such as `updated_at`, the consumer's fetch time, and a newly written state file cannot make a stale host appear healthy. Until JSON publishing is installed, the consumer accepts only the confirmed legacy `heartbeat.txt` format: `YYYY-MM-DDTHH:MM:SSZ | alive` with an optional trailing newline. It reports the local observer as uninstalled/unknown for this legacy signal.

The consumer runs every ten minutes. A host signal older than 900 seconds is stale. The observer is unavailable when its check is absent, disabled, degraded/unknown, or more than 90 seconds behind the host publisher's `sentAt`. Observer failure alone never sends Wake-on-LAN. Malformed, future-dated, missing, truncated, unauthenticated, or unfetchable signals are a **monitoring-path error**, not a proven host outage. They do not send WOL. Their claimed alert is attempted once only after its state claim is durably stored in the independent GitHub artifact described below. If the artifact itself cannot be persisted, no alert/WOL side effect is attempted and the failed GitHub Actions run is the only escalation signal. A failed monitor run cannot establish host health or downtime.

The consumer PATCHes only `uptime-state.json` in the Gist for host and observer transitions, incident number, and effect claims. Separately, GitHub Actions artifacts preserve durable once-only claims. The first artifact must be created by an explicit manual `workflow_dispatch` with `bootstrap=true`; a missing artifact does not trigger automatic bootstrap. Normal runs use only the latest state from this repository's trusted `main` workflow and retain it for seven days. Missing, expired, unreadable, malformed, invalid, or untrusted-provenance state fails closed as unknown. The workflow is serialized. Each run stores its claims and uploads the checkpoint, then verifies a non-empty artifact ID, before attempting any notification or WOL. Claims survive a later failed run, so uncertain effects are not automatically replayed. Recovery is notified once only after a valid fresh host signal and successful claim persistence. Preserve both Gist state and artifact history when rotating credentials or upgrading the producer.

The prior Revision 2 independent-QA finding is preserved as historical: it
reproduced rejection of the valid bare `.github/workflows/macmini-uptime.yml`
path, an unexpected error rather than an expected failure. R3 now accepts only
the exact bare path and its `@main` and `@refs/heads/main` forms. Other
repositories, branches, workflow names, arbitrary suffixes, or partial matches
remain rejected; repository/head repository, event, run/attempt, artifact URL,
digest, size, and archive checks remain in force. The target repository's live
workflow metadata remains unverified, so local tests do not establish live
acceptance.

Wake-on-LAN uses the existing configured WAN IPv4 destination and UDP port 9002. A send attempt is not proof the host woke up. The host publisher and local observer are separate: the latter remains observe-only on first installation, and this external workflow does not activate local restarts.

## Configuration and rollout checks

The workflow uses these GitHub Actions settings, with no local credentials needed for tests:

| Setting | Location | Purpose |
| --- | --- | --- |
| `MACMINI_GIST_ID`, `MACMINI_GIST_TOKEN` | Secrets | Existing Gist ID and a token able to read/PATCH that Gist |
| `MACMINI_WAN_IP` | Secret | Existing Wake-on-LAN WAN IPv4 destination |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Secrets | Required only for `telegram` or `dual` |
| `SLACK_BOT_TOKEN` | Secret | Required only for `slack` or `dual`; bot must have `chat:write` |
| `SLACK_ALERTS_CHANNEL_ID` | Variable | Required only for `slack` or `dual`; bot must be in this alerts channel |
| `OPS_NOTIFICATION_BACKEND` | Variable | `telegram` (default), `slack`, or `dual`; any other value fails closed |
| Workflow permissions | `actions: read` | Read artifact state; checkout retains `contents: read` |

The legacy hardware MAC address is already fixed in the workflow. Keep it and UDP port 9002 unchanged during this revision. The Slack alerts channel is the external host down/recovery destination. `dual` is a temporary test/cutover mode, not the final state. Slack-only mode does not require Telegram credentials. Message API calls use bounded timeouts, bounded 429 retry, no automatic mentions/unfurls, and no credential or Gist-body logging.

Before the later deployment gate, verify the producer writes both signal formats exactly, that the observer check is fresh relative to `sentAt`, that the existing Gist and WOL route are correct, and that credentials/Slack channel permissions are configured without exposing their values. Run the isolated tests below, review workflow syntax and the changed-file diff, and obtain separate approval before enabling this workflow on the live branch. Start with an observe-only local observer and staged read-only/live notification checks; do not infer host health merely from a green workflow. For rollback, disable the external workflow or restore the previously approved revision through a separate operational decision; preserve `uptime-state.json` and never erase incident history as a shortcut.

```bash
python3 -m unittest discover -s tests/uptime -v
python3 -c "import ast,pathlib; ast.parse(pathlib.Path('scripts/uptime/monitor.py').read_text())"
```
