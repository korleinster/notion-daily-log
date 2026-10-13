"""External heartbeat monitor. Importing this module has no side effects."""

import datetime as dt
import hashlib
import io
import ipaddress
import json
import os
import pathlib
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile


HOST_STALE = 900
OBSERVER_LAG = 90
STATE_FILE = "uptime-state.json"
GIST_API = "https://api.github.com/gists/"
SLACK_API = "https://slack.com/api/chat.postMessage"
ARTIFACT_PREFIX = "macmini-monitor-state-v1-"
ARTIFACT_FILE = "monitor-state.json"
WORKFLOW_FILE = ".github/workflows/macmini-uptime.yml"
MAX_ARCHIVE_BYTES = 65536
MAX_ARTIFACTS = 2000


class MonitorError(Exception):
    """Safe diagnostic; never include URLs, credentials, or response bodies."""


def parse_time(value, field):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value
    ):
        raise MonitorError(f"invalid {field} timestamp")
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MonitorError(f"invalid {field} timestamp") from exc


def age(then, now, field):
    seconds = (now - then).total_seconds()
    if seconds < 0:
        raise MonitorError(f"future {field} timestamp")
    return seconds


def content(files, name):
    item = files.get(name)
    if not isinstance(item, dict) or item.get("truncated") or not isinstance(item.get("content"), str):
        raise MonitorError(f"missing or truncated {name}")
    return item["content"]


def heartbeat(files, now):
    if "heartbeat.json" not in files:
        # The existing producer writes exactly this format.
        match = re.fullmatch(
            r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| alive\n?",
            content(files, "heartbeat.txt"),
        )
        if not match:
            raise MonitorError("invalid legacy heartbeat")
        sent = parse_time(match.group(1), "host")
        age(sent, now, "host")
        return sent, "unknown", "observer uninstalled or not reported", "legacy"
    try:
        data = json.loads(content(files, "heartbeat.json"))
    except ValueError as exc:
        raise MonitorError("invalid heartbeat.json") from exc
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1 or data.get("host") != "macmini":
        raise MonitorError("invalid heartbeat.json schema")
    sent = parse_time(data.get("sentAt"), "host")
    age(sent, now, "host")
    monitor = data.get("monitor")
    if not isinstance(monitor, dict) or monitor.get("mode") not in ("observe", "auto", "disabled") or monitor.get("status") not in ("healthy", "degraded", "unknown"):
        raise MonitorError("invalid observer schema")
    checked_raw = monitor.get("lastCheckAt")
    if checked_raw is None:
        observer = "unhealthy"
        detail = "observer disabled" if monitor["mode"] == "disabled" else "observer check absent"
    else:
        checked = parse_time(checked_raw, "observer")
        lag = age(checked, sent, "observer")
        if lag > OBSERVER_LAG:
            observer, detail = "unhealthy", "observer check lags host publisher"
        elif monitor["mode"] == "disabled":
            observer, detail = "unhealthy", "observer disabled"
        elif monitor["status"] != "healthy":
            observer, detail = "unhealthy", "observer status " + monitor["status"]
        else:
            observer, detail = "healthy", "observer healthy"
    return sent, observer, detail, "json"


def state_from(files):
    if STATE_FILE not in files:
        return {"version": 1, "hostPhase": "up", "incident": 0, "observerPhase": "healthy"}
    try:
        state = json.loads(content(files, STATE_FILE))
    except ValueError as exc:
        raise MonitorError("invalid uptime state") from exc
    if (not isinstance(state, dict) or type(state.get("version")) is not int or state["version"] != 1
            or state.get("hostPhase") not in ("up", "down")
            or state.get("observerPhase") not in ("healthy", "unhealthy", "unknown")
            or type(state.get("incident")) is not int or state["incident"] < 0):
        raise MonitorError("invalid uptime state schema")
    return state


def backend_from(env):
    backend = env.get("OPS_NOTIFICATION_BACKEND", "telegram") or "telegram"
    if backend not in ("telegram", "slack", "dual"):
        raise MonitorError("unsupported notification backend")
    if not re.fullmatch(r"[0-9a-fA-F]{16,64}", env.get("GIST_ID", "")) or not env.get("GIST_TOKEN"):
        raise MonitorError("missing or invalid Gist configuration")
    if backend in ("telegram", "dual") and (not env.get("TELEGRAM_BOT_TOKEN") or not env.get("TELEGRAM_CHAT_ID")):
        raise MonitorError("missing Telegram configuration")
    if backend in ("slack", "dual") and (not env.get("SLACK_BOT_TOKEN") or not re.fullmatch(r"[CGD][A-Z0-9]+", env.get("SLACK_ALERTS_CHANNEL_ID", ""))):
        raise MonitorError("missing or invalid Slack alerts configuration")
    return backend


class Http:
    def __init__(self, opener=urllib.request.urlopen, sleep=time.sleep):
        self.opener, self.sleep = opener, sleep

    def json(self, request):
        for attempt in range(2):
            try:
                with self.opener(request, timeout=10) as response:
                    raw = response.read(1024 * 1024 + 1)
                    if len(raw) > 1024 * 1024:
                        raise MonitorError("HTTP response too large")
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise MonitorError("invalid HTTP response")
                    return result
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt == 0:
                    try:
                        delay = float(exc.headers.get("Retry-After", "0"))
                    except (ValueError, TypeError):
                        delay = -1
                    if 0 <= delay <= 3:
                        self.sleep(delay)
                        continue
                raise MonitorError(f"HTTP {exc.code}") from None
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                raise MonitorError("HTTP request failed or invalid response") from exc
        raise MonitorError("HTTP rate limit")


class Gist:
    def __init__(self, env, http):
        self.url = GIST_API + env["GIST_ID"]
        self.token, self.http = env["GIST_TOKEN"], http

    def headers(self):
        return {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json", "Content-Type": "application/json"}

    def read(self):
        data = self.http.json(urllib.request.Request(self.url, headers=self.headers()))
        if not isinstance(data.get("files"), dict):
            raise MonitorError("invalid Gist response")
        return data["files"]

    def write(self, state):
        # PATCH only the separate state file; never replace heartbeat data.
        body = json.dumps({"files": {STATE_FILE: {"content": json.dumps(state, sort_keys=True)}}}).encode()
        self.http.json(urllib.request.Request(self.url, data=body, headers=self.headers(), method="PATCH"))
        # A successful HTTP response is not enough to claim an external effect.
        # Confirm that the state visible through the read path matches exactly.
        if state_from(self.read()) != state:
            raise MonitorError("state persistence unconfirmed")


class Notifier:
    def __init__(self, env, backend, http):
        self.env, self.backend, self.http = env, backend, http

    def send(self, message):
        message = message[:3000]
        failures = []
        if self.backend in ("slack", "dual"):
            body = json.dumps({"channel": self.env["SLACK_ALERTS_CHANNEL_ID"], "text": message,
                               "unfurl_links": False, "unfurl_media": False, "link_names": False}).encode()
            req = urllib.request.Request(SLACK_API, data=body, headers={
                "Authorization": "Bearer " + self.env["SLACK_BOT_TOKEN"],
                "Content-Type": "application/json; charset=utf-8"})
            try:
                if self.http.json(req).get("ok") is not True:
                    raise MonitorError("Slack API rejected message")
            except MonitorError:
                failures.append("Slack notification failed")
        if self.backend in ("telegram", "dual"):
            url = "https://api.telegram.org/bot" + self.env["TELEGRAM_BOT_TOKEN"] + "/sendMessage"
            body = urllib.parse.urlencode({"chat_id": self.env["TELEGRAM_CHAT_ID"], "text": message,
                                           "disable_web_page_preview": "true"}).encode()
            try:
                if self.http.json(urllib.request.Request(url, data=body)).get("ok") is not True:
                    raise MonitorError("Telegram API rejected message")
            except MonitorError:
                failures.append("Telegram notification failed")
        if failures:
            raise MonitorError("; ".join(failures))


def wol(env):
    try:
        destination = str(ipaddress.IPv4Address(env["MACMINI_WAN_IP"]))
        mac = env["MACMINI_MAC"].replace(":", "")
        if not re.fullmatch(r"[0-9a-fA-F]{12}", mac):
            raise ValueError("invalid MAC")
        packet = bytes.fromhex("ff" * 6 + mac * 16)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(5)
            sock.sendto(packet, (destination, 9002))
    except (KeyError, ValueError, OSError) as exc:
        raise MonitorError("WOL send attempt failed") from exc


def run(store, notifier, send_wol, now):
    files = store.read()
    sent, observer, detail, source = heartbeat(files, now)
    state = state_from(files)
    host_age = age(sent, now, "host")
    if host_age > HOST_STALE:
        if state["hostPhase"] == "down":
            return "host still stale; incident already claimed"
        state.update(hostPhase="down", incident=state["incident"] + 1,
                     observerPhase=observer, downAt=now.isoformat().replace("+00:00", "Z"),
                     wolClaimed=True, downAlertClaimed=True)
        store.write(state)  # Claim before either external effect.
        outcome = "WOL packet attempted"
        try:
            send_wol()
        except MonitorError:
            outcome = "WOL send attempt failed"
        notifier.send(f"🚨 Mac Mini host heartbeat is stale ({int(host_age)} seconds). {outcome}. Incident {state['incident']}. Local observer: {detail}.")
        return "host stale; first incident effects claimed"
    if state["hostPhase"] == "down":
        state.update(hostPhase="up", observerPhase=observer, recoveryAlertClaimed=True)
        store.write(state)
        notifier.send(f"✅ Mac Mini host heartbeat recovered. Incident {state['incident']}. Local observer: {detail}.")
        return "host recovery claimed"
    if observer != state["observerPhase"]:
        state.update(observerPhase=observer, observerAlertClaimed=True)
        store.write(state)
        if observer == "healthy":
            notifier.send("✅ Mac Mini local observer recovered.")
        else:
            notifier.send("⚠️ Mac Mini local observer is unavailable: " + detail + ". Host heartbeat remains fresh.")
        return "observer transition claimed"
    return f"host fresh; observer {observer}; source {source}"


def path_error_code(exc):
    value = str(exc)
    if value == "HTTP 401" or value == "HTTP 403":
        return "gist_auth"
    if value.startswith("HTTP ") or value.startswith("HTTP request"):
        return "gist_transport"
    if "timestamp" in value:
        return "gist_time"
    if "persistence" in value or "write" in value:
        return "gist_write"
    return "gist_data"


def prepare_host_effects(store, now):
    files = store.read()
    sent, observer, detail, _source = heartbeat(files, now)
    state = state_from(files)
    host_age = age(sent, now, "host")
    if host_age > HOST_STALE:
        if state["hostPhase"] == "down":
            return []
        state.update(hostPhase="down", incident=state["incident"] + 1,
                     observerPhase=observer, downAt=now.isoformat().replace("+00:00", "Z"),
                     wolClaimed=True, downAlertClaimed=True)
        store.write(state)
        return [{"kind": "wol"}, {"kind": "alert", "message":
                f"🚨 Mac Mini host heartbeat is stale ({int(host_age)} seconds). WOL packet attempted. Incident {state['incident']}. Local observer: {detail}."}]
    if state["hostPhase"] == "down":
        state.update(hostPhase="up", observerPhase=observer, recoveryAlertClaimed=True)
        store.write(state)
        return [{"kind": "alert", "message":
                f"✅ Mac Mini host heartbeat recovered. Incident {state['incident']}. Local observer: {detail}."}]
    if observer != state["observerPhase"]:
        state.update(observerPhase=observer, observerAlertClaimed=True)
        store.write(state)
        if observer == "healthy":
            return [{"kind": "alert", "message": "✅ Mac Mini local observer recovered."}]
        return [{"kind": "alert", "message": "⚠️ Mac Mini local observer is unavailable: " + detail + ". Host heartbeat remains fresh."}]
    return []


def prepare_artifact_run(store, artifact, now, bootstrap=False):
    """Prepare claims and effects; the caller MUST upload the artifact before effects."""
    previous = artifact.read(now)
    timestamp = now.isoformat().replace("+00:00", "Z")
    if previous is None:
        if not bootstrap:
            raise MonitorError("artifact state missing; explicit bootstrap required")
        # Bootstrap only against a readable, valid Gist; never infer a down event.
        files = store.read()
        heartbeat(files, now)
        state_from(files)
        artifact.write({"version": 1, "pathPhase": "healthy", "errorCode": "none",
                        "incident": 0, "claim": "bootstrap", "claimedAt": timestamp,
                        "checkedAt": timestamp})
        return []
    if bootstrap:
        raise MonitorError("artifact state already exists")
    try:
        effects = prepare_host_effects(store, now)
    except MonitorError as exc:
        code = path_error_code(exc)
        effects = []
        if previous["pathPhase"] == "healthy":
            previous["incident"] += 1
            previous["claim"] = "error"
            previous["claimedAt"] = timestamp
            effects.append({"kind": "alert", "message":
                            f"⚠️ Mac Mini monitoring path error ({code}). Incident {previous['incident']}. Host state unknown; WOL not attempted."})
        previous["pathPhase"] = "error"
        previous["errorCode"] = code
    else:
        if previous["pathPhase"] == "error":
            previous["claim"] = "recovered"
            previous["claimedAt"] = timestamp
            effects.append({"kind": "alert", "message":
                            f"✅ Mac Mini monitoring path recovered. Incident {previous['incident']}."})
        previous["pathPhase"] = "healthy"
        previous["errorCode"] = "none"
        if previous["claim"] == "bootstrap":
            previous["claim"] = "checkpoint"
    previous["checkedAt"] = timestamp
    artifact.write(previous)
    return effects


def validate_artifact_state(state, now):
    if (not isinstance(state, dict) or set(state) != {"version", "pathPhase", "errorCode", "incident", "claim", "claimedAt", "checkedAt"}
            or type(state["version"]) is not int or state["version"] != 1
            or state["pathPhase"] not in ("healthy", "error")
            or state["errorCode"] not in ("none", "gist_auth", "gist_transport", "gist_time", "gist_write", "gist_data")
            or type(state["incident"]) is not int or state["incident"] < 0
            or state["claim"] not in ("bootstrap", "checkpoint", "error", "recovered")):
        raise MonitorError("invalid artifact state")
    if ((state["pathPhase"] == "error") != (state["errorCode"] != "none")
            or (state["pathPhase"] == "error" and (state["claim"] != "error" or state["incident"] == 0))
            or (state["pathPhase"] == "healthy" and state["claim"] == "error")):
        raise MonitorError("inconsistent artifact state")
    claimed = parse_time(state["claimedAt"], "claim")
    checked = parse_time(state["checkedAt"], "checkpoint")
    age(claimed, now, "claim")
    if age(checked, now, "checkpoint") > 7 * 86400:
        raise MonitorError("artifact state expired")
    if claimed > checked:
        raise MonitorError("invalid artifact state chronology")
    return state


def validate_workflow_context(env):
    if (env.get("GITHUB_REPOSITORY") != "korleinster/notion-daily-log"
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_EVENT_NAME") not in ("schedule", "workflow_dispatch")
            or not re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_REPOSITORY_ID", ""))
            or not re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", ""))
            or not re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ATTEMPT", ""))
            or env.get("GITHUB_WORKFLOW_REF") !=
                "korleinster/notion-daily-log/" + WORKFLOW_FILE + "@refs/heads/main"
            or not env.get("GITHUB_TOKEN")):
        raise MonitorError("untrusted workflow context")


class GithubArtifact:
    def __init__(self, env, now, opener=None):
        validate_workflow_context(env)
        self.env, self.now = env, now
        self.opener = opener or urllib.request.build_opener(ArtifactRedirect).open
        self.base = "https://api.github.com/repos/korleinster/notion-daily-log/actions"
        self.path = pathlib.Path(env["RUNNER_TEMP"]) / ARTIFACT_FILE

    def request(self, url):
        return urllib.request.Request(url, headers={"Authorization": "Bearer " + self.env["GITHUB_TOKEN"],
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"})

    def get(self, url, limit):
        try:
            with self.opener(self.request(url), timeout=10) as response:
                raw = response.read(limit + 1)
            if len(raw) > limit:
                raise MonitorError("artifact response too large")
            return raw
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise MonitorError("artifact API unavailable") from exc

    def get_json(self, url):
        try:
            value = json.loads(self.get(url, 1024 * 1024))
        except ValueError as exc:
            raise MonitorError("invalid artifact API response") from exc
        if not isinstance(value, dict):
            raise MonitorError("invalid artifact API response")
        return value

    def read(self, now):
        found = []
        for page in range(1, 21):
            result = self.get_json(self.base + f"/artifacts?per_page=100&page={page}")
            count, items = result.get("total_count"), result.get("artifacts")
            if type(count) is not int or not (0 <= count <= MAX_ARTIFACTS) or not isinstance(items, list):
                raise MonitorError("invalid artifact listing")
            found.extend(item for item in items if isinstance(item, dict) and
                         isinstance(item.get("name"), str) and item["name"].startswith(ARTIFACT_PREFIX))
            if page * 100 >= count:
                break
        if not found:
            return None
        try:
            latest = max(found, key=lambda item: (parse_time(item.get("created_at"), "artifact"), item.get("id")))
        except (MonitorError, TypeError):
            raise MonitorError("invalid artifact listing") from None
        if (type(latest.get("id")) is not int or latest["id"] <= 0
                or not re.fullmatch(ARTIFACT_PREFIX + r"([1-9][0-9]*)-([1-9][0-9]*)", latest["name"])):
            raise MonitorError("invalid artifact listing")
        name_run_id, name_attempt = latest["name"][len(ARTIFACT_PREFIX):].split("-")
        if (latest.get("expired") is not False or type(latest.get("size_in_bytes")) is not int
                or not (0 < latest["size_in_bytes"] <= MAX_ARCHIVE_BYTES)):
            raise MonitorError("artifact unavailable or expired")
        workflow_run = latest.get("workflow_run")
        repo_id = int(self.env["GITHUB_REPOSITORY_ID"])
        if (not isinstance(workflow_run, dict) or workflow_run.get("repository_id") != repo_id
                or workflow_run.get("head_repository_id") != repo_id
                or workflow_run.get("head_branch") != "main"):
            raise MonitorError("untrusted artifact provenance")
        run_id = workflow_run.get("id")
        if name_run_id != str(run_id):
            raise MonitorError("untrusted artifact provenance")
        run = self.get_json(self.base + f"/runs/{run_id}")
        if (run.get("id") != run_id or run.get("head_branch") != "main"
                or run.get("path") not in (WORKFLOW_FILE, WORKFLOW_FILE + "@main",
                                           WORKFLOW_FILE + "@refs/heads/main")
                or run.get("event") not in ("schedule", "workflow_dispatch")
                or type(run.get("run_attempt")) is not int
                or not (1 <= int(name_attempt) <= run["run_attempt"])
                or not isinstance(run.get("repository"), dict)
                or run["repository"].get("id") != repo_id
                or not isinstance(run.get("head_repository"), dict)
                or run["head_repository"].get("id") != repo_id):
            raise MonitorError("untrusted artifact provenance")
        archive_url = self.base + f"/artifacts/{latest['id']}/zip"
        if latest.get("archive_download_url") != archive_url:
            raise MonitorError("invalid artifact archive URL")
        raw = self.get(archive_url, MAX_ARCHIVE_BYTES)
        digest = latest.get("digest")
        if (len(raw) != latest["size_in_bytes"] or not isinstance(digest, str)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
                or digest != "sha256:" + hashlib.sha256(raw).hexdigest()):
            raise MonitorError("artifact digest mismatch")
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                if (len(entries) != 1 or entries[0].filename != ARTIFACT_FILE
                        or entries[0].file_size > 4096 or entries[0].is_dir()
                        or (entries[0].external_attr >> 16) & 0o170000 == 0o120000):
                    raise MonitorError("invalid artifact archive")
                payload = archive.read(entries[0])
            state = json.loads(payload)
        except Exception as exc:
            raise MonitorError("invalid artifact archive") from exc
        return validate_artifact_state(state, now)

    def write(self, state):
        validate_artifact_state(state, self.now)
        self.path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")


class ArtifactRedirect(urllib.request.HTTPRedirectHandler):
    """Allow signed artifact redirects but never forward the GitHub bearer token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not re.fullmatch(
            r"https://api\.github\.com/repos/korleinster/notion-daily-log/actions/artifacts/[1-9][0-9]*/zip",
            req.full_url,
        ):
            raise MonitorError("untrusted artifact redirect")
        parsed = urllib.parse.urlsplit(newurl)
        host = parsed.hostname or ""
        if (parsed.scheme != "https" or parsed.username or parsed.password
                or parsed.port not in (None, 443) or not (host == "githubusercontent.com"
                or host.endswith(".githubusercontent.com")
                or host.endswith(".blob.core.windows.net"))):
            raise MonitorError("untrusted artifact redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            raise MonitorError("invalid artifact redirect")
        redirected.remove_header("Authorization")
        redirected.unredirected_hdrs.pop("Authorization", None)
        return redirected


def execute_effects(effects, notifier, send_wol):
    outcome = "WOL packet attempted"
    for effect in effects:
        if effect.get("kind") == "wol":
            try:
                send_wol()
            except MonitorError:
                outcome = "WOL send attempt failed"
        elif effect.get("kind") == "alert":
            notifier.send(effect["message"].replace("WOL packet attempted", outcome))
        else:
            raise MonitorError("invalid effect")


def main():
    env = dict(os.environ)
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("prepare", "effects"):
            raise MonitorError("explicit prepare or effects phase required")
        backend = backend_from(env)
        validate_workflow_context(env)
        http = Http()
        temp = pathlib.Path(env["RUNNER_TEMP"])
        if sys.argv[1] == "prepare":
            now = dt.datetime.now(dt.timezone.utc)
            artifact = GithubArtifact(env, now)
            effects = prepare_artifact_run(Gist(env, http), artifact, now,
                                           bootstrap=env.get("UPTIME_BOOTSTRAP") == "true")
            (temp / "monitor-effects.json").write_text(json.dumps(effects), encoding="utf-8")
            print("monitor claims prepared; artifact upload required before effects")
        else:
            if not re.fullmatch(r"[1-9][0-9]*", env.get("UPTIME_ARTIFACT_ID", "")):
                raise MonitorError("artifact upload not confirmed")
            state = json.loads((temp / ARTIFACT_FILE).read_text(encoding="utf-8"))
            validate_artifact_state(state, dt.datetime.now(dt.timezone.utc))
            effects = json.loads((temp / "monitor-effects.json").read_text(encoding="utf-8"))
            if not isinstance(effects, list) or len(effects) > 3:
                raise MonitorError("invalid effects manifest")
            execute_effects(effects, Notifier(env, backend, http), lambda: wol(env))
            print("monitor effects attempted")
        return 0
    except MonitorError as exc:
        print(f"::error::Mac Mini monitoring path error: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print("::error::Mac Mini monitoring path error: local state unavailable", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
