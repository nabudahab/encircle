#!/usr/bin/env python3
"""Import one athlete's outdoor Strava rides into the local Encircle API."""

import argparse
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import fcntl
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_OAUTH = "https://www.strava.com/oauth"
ENCIRCLE_RIDES = "http://127.0.0.1:3001/api/rides"
SCOPE = "activity:read"
BIKE_SPORTS = {"Ride", "MountainBikeRide", "GravelRide", "EBikeRide",
               "EMountainBikeRide", "Handcycle", "Velomobile"}
LOOKBACK = timedelta(days=7)
WINDOW = timedelta(days=30)
PAGE_SIZE = 200
MAX_PAGES = 200
MAX_TIME_GAP = 60
MAX_DISTANCE_GAP = 500
GAP_ARC = math.sin(MAX_DISTANCE_GAP / (2 * 6_371_000)) ** 2


class SyncError(Exception):
    pass


class StatusError(SyncError):
    def __init__(self, service, status):
        super().__init__(f"{service} returned HTTP {status}.")
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Explicit endpoints only. A proxy or redirect must never receive the local ride POST.
HTTP = build_opener(ProxyHandler({}), NoRedirect())


def retry_delay(status, retry_after, attempt):
    if status == 429 and not retry_after:
        return None
    if not retry_after:
        return 2 ** attempt
    try:
        delay = int(retry_after)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(retry_after)
            delay = (retry_at - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    return max(0, delay) if delay <= 10 else None


def request_json(service, request, attempts=3):
    for attempt in range(attempts):
        try:
            with HTTP.open(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            status = error.code
            retry_after = error.headers.get("Retry-After")
            error.close()
            delay = retry_delay(status, retry_after, attempt)
            if (status not in {429, 500, 502, 503, 504}
                    or delay is None or attempt + 1 == attempts):
                raise StatusError(service, status) from None
        except (OSError, HTTPException):
            if attempt + 1 == attempts:
                raise SyncError(f"Could not complete a request to {service}.") from None
            delay = 2 ** attempt
        except ValueError:
            raise SyncError(f"{service} returned invalid JSON.") from None
        time.sleep(delay)


def check_private(info, name):
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SyncError(f"Restrict {name} to your user before continuing.")


@contextmanager
def private_file(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SyncError(f"{path.name} must be a regular file.")
        check_private(info, path.name)
        yield fd
    finally:
        os.close(fd)


def read_state(path):
    try:
        with private_file(path, os.O_RDONLY) as fd:
            with open(fd, encoding="utf-8", closefd=False) as source:
                data = json.load(source)
    except FileNotFoundError:
        return None
    except ValueError:
        raise SyncError(f"{path.name} contains invalid JSON.") from None
    if not isinstance(data, dict):
        raise SyncError(f"{path.name} must contain a JSON object.")
    return data


def write_state(path, data):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     delete=False) as output:
        temporary = Path(output.name)
        try:
            json.dump(data, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            output.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def locked_state():
    base = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    directory = base / "encircle-strava"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise SyncError("The state directory must be a directory owned by your user.")
    check_private(info, "the state directory")
    with private_file(directory / "sync.lock", os.O_RDWR | os.O_CREAT) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError("Another Strava sync or authorization is running.") from None
        yield directory


def client_credentials(directory):
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if client_id is None and secret is None:
        config = read_state(directory / "client.json") or {}
        client_id, secret = config.get("client_id"), config.get("client_secret")
    if (not isinstance(client_id, str) or not client_id.isascii() or not client_id.isdecimal()
            or not isinstance(secret, str) or not secret.strip()):
        raise SyncError("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET or configure client.json.")
    return client_id, secret


def valid_scope(value):
    if not isinstance(value, str):
        return False
    scopes = set(value.replace(",", " ").split())
    return SCOPE in scopes and scopes <= {SCOPE, "read"}


def authorization_code(client_id):
    state = secrets.token_urlsafe(32)
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(3)
            super().setup()

        def log_message(self, format, *args):
            pass

        def do_GET(self):
            path, _, query = self.path.partition("?")
            params = parse_qs(query, keep_blank_values=True)
            received_states = params.get("state", [])
            if (path != "/callback" or len(received_states) != 1
                    or not secrets.compare_digest(received_states[0].encode(), state.encode())):
                self.reply(400, "Invalid authorization callback.")
                return
            codes = params.get("code", [])
            scopes = params.get("scope", [])
            if ("error" in params or len(codes) != 1 or not codes[0] or len(scopes) != 1
                    or not valid_scope(scopes[0])):
                result["error"] = True
                self.reply(400, "Grant Strava activity:read and retry authorization in the terminal.")
                return
            result["code"] = codes[0]
            self.reply(200, "Authorization received. Return to your terminal.")

        def reply(self, status, message):
            body = message.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 0.5
        query = urlencode({"client_id": client_id, "response_type": "code",
                           "redirect_uri": f"http://127.0.0.1:{server.server_port}/callback",
                           "scope": SCOPE, "approval_prompt": "force", "state": state})
        print(f"Open this URL in your laptop browser within five minutes:\n{STRAVA_OAUTH}/authorize?{query}",
              flush=True)
        deadline = time.monotonic() + 300
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if "error" in result:
        raise SyncError("Strava did not grant the requested activity:read scope.")
    if "code" not in result:
        raise SyncError("Timed out waiting for Strava authorization.")
    return result["code"]


def positive_id(value):
    return type(value) is int and value > 0


class Strava:
    def __init__(self, directory):
        self.client_id, self.client_secret = client_credentials(directory)
        self.path = directory / "tokens.json"
        self.tokens = read_state(self.path)

    def authorize(self):
        code = authorization_code(self.client_id)
        self.exchange("authorization_code", code=code)
        print("Strava authorization saved. Run the import command when ready.")

    def exchange(self, grant_type, **params):
        form = urlencode({"client_id": self.client_id, "client_secret": self.client_secret,
                          "grant_type": grant_type, **params}).encode()
        request = Request(f"{STRAVA_OAUTH}/token", data=form)
        try:
            # Code use and refresh-token rotation may succeed even if the response is lost.
            payload = request_json("Strava token endpoint", request, attempts=1)
        except StatusError as error:
            if error.status not in {400, 401}:
                raise
            raise SyncError(f"{error} Check your client settings and run authorize again.") from None
        if not isinstance(payload, dict):
            raise SyncError("Strava returned an invalid token response.")
        if "scope" in payload and not valid_scope(payload["scope"]):
            raise SyncError("Strava returned a token with unexpected permissions.")
        if grant_type == "authorization_code":
            athlete = payload.get("athlete")
            athlete_id = athlete.get("id") if isinstance(athlete, dict) else None
        else:
            athlete_id = self.tokens["athlete_id"]
        tokens = {"client_id": self.client_id, "athlete_id": athlete_id,
                  "access_token": payload.get("access_token"), "refresh_token": payload.get("refresh_token"),
                  "expires_at": payload.get("expires_at")}
        if not valid_tokens(tokens):
            raise SyncError("Strava returned an incomplete token response.")
        write_state(self.path, tokens)
        self.tokens = tokens

    def athlete_id(self):
        if not valid_tokens(self.tokens) or self.tokens.get("client_id") != self.client_id:
            raise SyncError("Run authorize with the current Strava client credentials before importing.")
        return self.tokens["athlete_id"]

    def refresh(self):
        self.exchange("refresh_token", refresh_token=self.tokens["refresh_token"])

    def get(self, path, **query):
        if self.tokens["expires_at"] <= time.time() + 60:
            self.refresh()
        url = f"{STRAVA_API}{path}?{urlencode(query)}"
        for attempt in range(2):
            request = Request(url, headers={"Authorization": f"Bearer {self.tokens['access_token']}"})
            try:
                return request_json("Strava API", request)
            except StatusError as error:
                if error.status != 401 or attempt:
                    raise
                self.refresh()


def valid_tokens(tokens):
    return (isinstance(tokens, dict) and positive_id(tokens.get("athlete_id"))
            and positive_id(tokens.get("expires_at"))
            and all(isinstance(tokens.get(key), str) and tokens[key]
                    for key in ("access_token", "refresh_token")))


def parse_date(value, *, allow_date=False):
    if allow_date and len(value) == 10:
        return datetime.combine(date.fromisoformat(value), datetime.min.time(), timezone.utc)
    parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    if parsed.tzinfo is None:
        raise ValueError("timestamp needs a timezone")
    return parsed.astimezone(timezone.utc)


@dataclass
class Checkpoint:
    floor: datetime
    through: datetime
    backfill_next: datetime | None = None
    pending: tuple[datetime, datetime] | None = None
    handled: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path, since):
        data = read_state(path)
        if data is None:
            if since is None:
                raise SyncError("The first import requires --since.")
            return cls(since, since, since)
        try:
            floor = parse_date(data["floor"])
            through = parse_date(data["through"])
            backfill = parse_date(data["backfill_next"]) if data["backfill_next"] else None
            pending = None
            if data["pending"] is not None:
                start, end = data["pending"]
                pending = (parse_date(start), parse_date(end))
                if not pending[0] < pending[1]:
                    raise ValueError
            handled = data["handled"]
            if floor > through or not isinstance(handled, dict):
                raise ValueError
            for timestamp in handled.values():
                parse_date(timestamp)
        except (KeyError, AttributeError, TypeError, ValueError, OverflowError):
            raise SyncError("The local ride checkpoint is invalid.") from None
        return cls(floor, through, backfill, pending, handled)

    def save(self, path):
        write_state(path, {"floor": self.floor.isoformat(), "through": self.through.isoformat(),
                           "backfill_next": self.backfill_next.isoformat() if self.backfill_next else None,
                           "pending": [bound.isoformat() for bound in self.pending] if self.pending else None,
                           "handled": self.handled})


def list_rides(strava, since, before):
    rides = {}
    for page in range(1, MAX_PAGES + 1):
        activities = strava.get("/athlete/activities", after=math.floor(since.timestamp()) - 1,
                                before=math.ceil(before.timestamp()), page=page, per_page=PAGE_SIZE)
        if not isinstance(activities, list):
            raise SyncError("Strava returned an invalid activity list.")
        if not activities:
            return sorted((started_at, activity_id) for activity_id, started_at in rides.items())
        for activity in activities:
            if not isinstance(activity, dict):
                raise SyncError("Strava returned an invalid activity.")
            sport = activity.get("sport_type") or activity.get("type")
            if not isinstance(sport, str):
                raise SyncError("Strava returned an activity without a valid sport type.")
            if sport not in BIKE_SPORTS or activity.get("manual") or activity.get("trainer"):
                continue
            activity_id = activity.get("id")
            try:
                started_at = parse_date(activity["start_date"])
                if not positive_id(activity_id):
                    raise ValueError
            except (KeyError, AttributeError, TypeError, ValueError, OverflowError):
                raise SyncError("Strava returned a ride without a valid ID or start date.") from None
            if since <= started_at < before:
                rides[activity_id] = started_at
    raise SyncError("Strava's activity list did not finish within the page limit.")


def stream_data(streams, name):
    stream = streams.get(name)
    if stream is None:
        return None
    if not isinstance(stream, dict) or not isinstance(stream.get("data"), list):
        raise SyncError(f"Strava returned an invalid {name} stream.")
    return stream["data"]


def valid_coordinate(pair):
    if not isinstance(pair, list) or len(pair) != 2:
        return False
    lat, lon = pair
    return (type(lat) in (int, float) and -90 <= lat <= 90
            and type(lon) in (int, float) and -180 <= lon <= 180
            and pair != [0, 0])


def distance_gap(previous, current):
    previous_lon, previous_lat = map(math.radians, previous)
    lon, lat = map(math.radians, current)
    arc = math.sin((lat - previous_lat) / 2) ** 2
    arc += math.cos(lat) * math.cos(previous_lat) * math.sin((lon - previous_lon) / 2) ** 2
    return arc > GAP_ARC


def track_segments(streams):
    if not isinstance(streams, dict):
        raise SyncError("Strava returned an invalid stream set.")
    coordinates = stream_data(streams, "latlng")
    if not coordinates:
        return []
    times = stream_data(streams, "time")
    if times is not None and len(times) != len(coordinates):
        raise SyncError("Strava's GPS and time streams have different lengths.")
    segments, segment = [], []
    previous_time = None
    for index, pair in enumerate(coordinates):
        elapsed = times[index] if times is not None else 0
        valid = valid_coordinate(pair) and type(elapsed) is int and elapsed >= 0
        gap = (valid and segment and (not 0 <= elapsed - previous_time <= MAX_TIME_GAP
                                    or distance_gap(segment[-1], pair[::-1])))
        if not valid or gap:
            if len(segment) >= 2:
                segments.append(segment)
            segment = []
        if valid:
            point = pair[::-1]
            if not segment or point != segment[-1]:
                segment.append(point)
            previous_time = elapsed
    if len(segment) >= 2:
        segments.append(segment)
    return segments


def import_ride(strava, started_at, activity_id):
    try:
        streams = strava.get(f"/activities/{activity_id}/streams", keys="latlng,time", key_by_type="true")
    except StatusError as error:
        if error.status == 404:
            return "unavailable"
        raise
    segments = track_segments(streams)
    if not segments:
        return "no usable GPS"
    body = json.dumps({"startedAt": started_at.isoformat(), "segments": segments},
                      allow_nan=False, separators=(",", ":")).encode()
    request = Request(ENCIRCLE_RIDES, data=body, headers={"Content-Type": "application/json"})
    response = request_json("Encircle API", request)
    if (not isinstance(response, dict) or type(response.get("duplicate")) is not bool
            or not all(key in response for key in ("id", "playerId"))
            or any(type(response.get(key)) is not int or response[key] < 0 for key in ("passed", "enclosed"))):
        raise SyncError("Encircle returned an invalid ride import response.")
    if response["duplicate"]:
        return "duplicate"
    return "imported" if response["passed"] or response["enclosed"] else "no score"


def import_rides(strava, directory, since):
    path = directory / f"checkpoint-{strava.athlete_id()}.json"
    checkpoint = Checkpoint.load(path, since)
    cutoff = datetime.now(timezone.utc).replace(microsecond=0)
    if since is not None:
        if since >= cutoff or since > checkpoint.through:
            raise SyncError("--since must precede the current time and cannot skip past the checkpoint.")
        if checkpoint.pending or checkpoint.backfill_next is not None:
            if since != checkpoint.backfill_next:
                raise SyncError("An import is in progress. Resume without --since before starting another backfill.")
        else:
            checkpoint.floor = min(checkpoint.floor, since)
            checkpoint.backfill_next = since
    if cutoff < checkpoint.through:
        raise SyncError("The laptop clock is behind the last import checkpoint.")

    # A backfill may deliberately go behind the rolling lookback. Its own cursor is
    # advanced separately so an interruption cannot skip the rest of that history.
    start = checkpoint.backfill_next or max(checkpoint.floor, checkpoint.through - LOOKBACK)
    if checkpoint.pending:
        start = checkpoint.pending[0]
        cutoff = max(cutoff, checkpoint.pending[1])
    counts = Counter()
    while start < cutoff:
        if checkpoint.pending is None:
            checkpoint.pending = (start, min(start + WINDOW, cutoff))
            checkpoint.save(path)
        start, end = checkpoint.pending
        for started_at, activity_id in list_rides(strava, start, end):
            key, timestamp = str(activity_id), started_at.isoformat()
            if checkpoint.handled.get(key) == timestamp:
                continue
            try:
                outcome = import_ride(strava, started_at, activity_id)
            except SyncError as error:
                raise SyncError(f"Strava ride {activity_id}: {error} Import resumes on the next run.") from None
            checkpoint.handled[key] = timestamp
            checkpoint.save(path)
            counts[outcome] += 1
            print(f"Strava ride {activity_id}: {outcome}", flush=True)
        checkpoint.through = max(checkpoint.through, end)
        checkpoint.pending = None
        if checkpoint.backfill_next is not None:
            checkpoint.backfill_next = end if end < cutoff else None
        keep_from = min(end, max(checkpoint.floor, checkpoint.through - LOOKBACK)).isoformat()
        checkpoint.handled = {key: timestamp for key, timestamp in checkpoint.handled.items()
                              if timestamp >= keep_from}
        checkpoint.save(path)
        start = end
    print(f"Imported {counts['imported']}, duplicates {counts['duplicate']}, no score {counts['no score']}, skipped "
          f"{counts['unavailable'] + counts['no usable GPS']}.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("authorize", help="Connect your own Strava account on this laptop")
    run = subcommands.add_parser("import", help="Fetch your rides once and import them into Encircle")
    run.add_argument("--local-only", action="store_true", required=True,
                     help=f"Opt in to sending GPS streams to {ENCIRCLE_RIDES}")
    run.add_argument("--since", metavar="DATE", help="Inclusive UTC date or ISO timestamp with timezone")
    args = parser.parse_args(argv)
    since = None
    if args.command == "import" and args.since is not None:
        try:
            since = parse_date(args.since, allow_date=True)
        except (ValueError, OverflowError):
            run.error("--since must be YYYY-MM-DD (UTC) or an ISO timestamp with a timezone")
    try:
        with locked_state() as directory:
            strava = Strava(directory)
            if args.command == "authorize":
                strava.authorize()
            else:
                import_rides(strava, directory, since)
    except SyncError as error:
        print(error, file=sys.stderr)
        return 1
    except OSError as error:
        print(f"Local file or socket error ({error.strerror or type(error).__name__}).", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Stopped. Run the import command again to resume.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
