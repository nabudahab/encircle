import contextlib
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

import strava_sync as sync


class Clock(datetime):
    current = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls.current.astimezone(tz)


START = Clock.current - timedelta(days=1)
GPS = {"latlng": {"data": [[40.0, -86.0], [40.001, -86.001]]},
       "time": {"data": [0, 10]}}


def activity(activity_id, started_at=START, **properties):
    return {"id": activity_id, "start_date": started_at.isoformat(), "sport_type": "Ride", **properties}


@contextlib.contextmanager
def serve(dispatch):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            status, headers, payload = dispatch(urlsplit(self.path), self.headers, body)
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()


class SyncTests(unittest.TestCase):
    def test_track_segments_break_at_time_distance_and_missing_coordinates(self):
        streams = {
            "latlng": {"data": [[40, -86], [40.001, -86], [40.001, -86],
                                [40.002, -86], [40.003, -86], [40.5, -86],
                                [40.501, -86], None, [40.502, -86]]},
            "time": {"data": [0, 2, 3, 64, 66, 68, 70, 72, 74]},
        }
        self.assertEqual(sync.track_segments(streams), [
            [[-86, 40], [-86, 40.001]], [[-86, 40.002], [-86, 40.003]],
            [[-86, 40.5], [-86, 40.501]],
        ])
        self.assertEqual(sync.track_segments({"latlng": GPS["latlng"]}), [[[-86, 40], [-86.001, 40.001]]])
        self.assertEqual(sync.track_segments({}), [])
        with self.assertRaises(sync.SyncError):
            sync.track_segments({**GPS, "time": {"data": [0]}})

    def test_loopback_authorization_checks_state_and_does_not_log_code(self):
        results = []
        worker = None

        def authorize_in_browser(message, flush):
            nonlocal worker
            options = parse_qs(urlsplit(message.splitlines()[1]).query)
            self.assertEqual(options["scope"], ["activity:read"])
            callback = options["redirect_uri"][0]
            self.assertEqual(urlsplit(callback).hostname, "127.0.0.1")

            def callback_requests():
                for state in ("incorrect-state", options["state"][0]):
                    query = urlencode({"state": state, "code": "fake-code", "scope": "read,activity:read"})
                    try:
                        with urlopen(f"{callback}?{query}", timeout=5) as response:
                            results.append((response.status, response.headers.get("Cache-Control")))
                    except HTTPError as error:
                        results.append((error.code, error.headers.get("Cache-Control")))
                        error.close()

            worker = threading.Thread(target=callback_requests)
            self.addCleanup(worker.join)
            worker.start()

        errors = io.StringIO()
        with patch.object(sync, "print", side_effect=authorize_in_browser, create=True), contextlib.redirect_stderr(errors):
            self.assertEqual(sync.authorization_code("123"), "fake-code")
        worker.join()
        self.assertEqual(results, [(400, "no-store"), (200, "no-store")])
        self.assertEqual(errors.getvalue(), "")
        self.assertFalse(sync.valid_scope("activity:read_all"))
        self.assertFalse(sync.valid_scope("activity:read,activity:write"))

    def test_authorize_exchanges_code_using_private_config(self):
        exchanges = []

        def dispatch(url, headers, body):
            exchanges.append((url.path, parse_qs(body.decode())))
            return 200, {}, {"access_token": "access", "refresh_token": "refresh", "expires_at": 4_000_000_000,
                             "athlete": {"id": 91}, "scope": "activity:read"}

        with tempfile.TemporaryDirectory() as temp, serve(dispatch) as base, contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"XDG_STATE_HOME": temp}, clear=True))
            stack.enter_context(patch.object(sync, "STRAVA_OAUTH", f"{base}/oauth"))
            callback = stack.enter_context(patch.object(sync, "authorization_code", return_value="fake-code"))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with sync.locked_state() as directory:
                config = directory / "client.json"
                sync.write_state(config, {"client_id": "123", "client_secret": "fake-secret"})
            config.chmod(0o644)
            with self.assertRaisesRegex(sync.SyncError, "Restrict client.json"):
                sync.Strava(directory)
            config.chmod(0o600)
            self.assertEqual(sync.main(["authorize"]), 0)
            callback.assert_called_once_with("123")
            self.assertEqual(exchanges, [("/oauth/token", {"client_id": ["123"], "client_secret": ["fake-secret"],
                                                           "grant_type": ["authorization_code"], "code": ["fake-code"]})])
            self.assertEqual(sync.Strava(directory).athlete_id(), 91)
            saved = sync.read_state(directory / "tokens.json")
            self.assertEqual(saved["refresh_token"], "refresh")
            self.assertNotIn("client_secret", saved)
            self.assertNotIn("fake-code", output.getvalue())

    def test_full_import_retries_same_body_and_resumes_after_partial_failure(self):
        list_queries, posted_bodies, refreshes = [], [], []
        at_cutoff = Clock.current
        rejected = True
        late_upload = False

        def dispatch(url, headers, body):
            query = parse_qs(url.query)
            if url.path == "/oauth/token":
                refreshes.append(parse_qs(body.decode()))
                return 200, {}, {"access_token": "fresh", "refresh_token": "rotated", "expires_at": 4_000_000_000}
            if url.path == "/api/v3/athlete/activities":
                self.assertEqual(headers["Authorization"], "Bearer fresh")
                list_queries.append(query)
                page = int(query["page"][0])
                if page == 1:
                    return 200, {}, [activity(2), activity(3, sport_type="Run"),
                                     activity(4, sport_type="VirtualRide"), activity(5, trainer=True),
                                     activity(6, START - timedelta(microseconds=1)),
                                     activity(7, at_cutoff), activity(8, manual=True)]
                if page == 2:
                    results = [activity(1, sport_type="GravelRide"), activity(9, START + timedelta(seconds=2))]
                    if late_upload:
                        results.append(activity(10, START + timedelta(seconds=1)))
                    return 200, {}, results
                return 200, {}, []
            if url.path.startswith("/api/v3/activities/"):
                self.assertEqual(query, {"keys": ["latlng,time"], "key_by_type": ["true"]})
                activity_id = int(url.path.split("/")[-2])
                if activity_id == 9:
                    return 404, {}, {}
                points = [[40, -86], [40 + activity_id / 10000, -86.001]]
                return 200, {}, {**GPS, "latlng": {"data": points}}
            self.assertEqual(url.path, "/api/rides")
            self.assertIsNone(headers.get("Authorization"))
            self.assertEqual(headers["Content-Type"], "application/json")
            posted_bodies.append(body)
            is_second_ride = json.loads(body)["segments"][0][-1][1] == 40.0002
            if is_second_ride and rejected:
                return 503, {}, {"error": "ignored"}
            passed = 0 if json.loads(body)["startedAt"] == at_cutoff.isoformat() else 7
            return 200, {}, {"id": 42, "playerId": "2026", "passed": passed, "enclosed": 0,
                             "duplicate": is_second_ride}

        with tempfile.TemporaryDirectory() as temp, serve(dispatch) as base, contextlib.ExitStack() as stack:
            stack.enter_context(patch.multiple(sync, STRAVA_API=f"{base}/api/v3", STRAVA_OAUTH=f"{base}/oauth",
                                               ENCIRCLE_RIDES=f"{base}/api/rides", datetime=Clock))
            stack.enter_context(patch.dict(os.environ, {"XDG_STATE_HOME": temp, "STRAVA_CLIENT_ID": "123",
                                                        "STRAVA_CLIENT_SECRET": "fake-secret"}))
            stack.enter_context(patch.object(sync.time, "sleep"))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            errors = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            with sync.locked_state() as directory:
                sync.write_state(directory / "tokens.json", {"client_id": "123", "athlete_id": 907,
                                 "access_token": "expired", "refresh_token": "original", "expires_at": 1})
            first = ["import", "--local-only", "--since", START.isoformat()]
            resume = ["import", "--local-only"]
            self.assertEqual(sync.main(first), 1)
            checkpoint = directory / "checkpoint-907.json"
            pending = sync.read_state(checkpoint)
            self.assertEqual(pending["handled"], {"1": START.isoformat()})
            self.assertEqual(pending["pending"], [START.isoformat(), Clock.current.isoformat()])
            self.assertEqual(posted_bodies[1:4], [posted_bodies[1]] * 3)
            self.assertEqual(json.loads(posted_bodies[0]), {"startedAt": START.isoformat(),
                             "segments": [[[-86, 40], [-86.001, 40.0001]]]})
            self.assertEqual(refreshes[0]["client_secret"], ["fake-secret"])
            self.assertEqual(refreshes[0]["refresh_token"], ["original"])
            tokens = directory / "tokens.json"
            self.assertEqual(sync.read_state(tokens)["refresh_token"], "rotated")
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(tokens.stat().st_mode & 0o777, 0o600)
            self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)

            rejected = False
            self.assertEqual(sync.main(resume), 0)
            self.assertEqual(posted_bodies[4], posted_bodies[1])
            completed = sync.read_state(checkpoint)
            self.assertIsNone(completed["pending"])
            self.assertEqual(completed["through"], Clock.current.isoformat())
            self.assertNotIn("segments", checkpoint.read_text())
            self.assertEqual(list_queries[0]["after"], [str(int(START.timestamp()) - 1)])
            self.assertEqual(list_queries[0]["before"], [str(int(Clock.current.timestamp()))])
            self.assertEqual([query["page"][0] for query in list_queries], ["1", "2", "3"] * 2)
            self.assertIn("duplicates 1, no score 0, skipped 1", output.getvalue())
            self.assertIn("Strava ride 2: Encircle API returned HTTP 503", errors.getvalue())
            self.assertNotIn("fake-secret", output.getvalue() + errors.getvalue())

            late_upload = True
            stack.enter_context(patch.object(Clock, "current", Clock.current + timedelta(seconds=3)))
            self.assertEqual(sync.main(resume), 0)
            self.assertEqual(len(posted_bodies), 7)
            self.assertEqual(json.loads(posted_bodies[5])["startedAt"], (START + timedelta(seconds=1)).isoformat())
            self.assertEqual(json.loads(posted_bodies[6])["startedAt"], at_cutoff.isoformat())
            self.assertIn("Strava ride 7: no score", output.getvalue())
            self.assertEqual(len(refreshes), 1)

    def test_historical_backfill_advances_only_completed_windows(self):
        since = Clock.current - timedelta(days=2)
        initial_end = since + timedelta(days=1)

        class Strava:
            def athlete_id(self):
                return 17

        with tempfile.TemporaryDirectory() as temp, patch.multiple(sync, datetime=Clock, WINDOW=timedelta(days=1)):
            directory = Path(temp)
            path = directory / "checkpoint-17.json"
            with patch.object(sync, "list_rides", side_effect=[[], sync.StatusError("Strava API", 429)]) as list_rides:
                with self.assertRaisesRegex(sync.StatusError, "429"):
                    sync.import_rides(Strava(), directory, since)
                self.assertEqual(list_rides.call_args.args[1:], (initial_end, Clock.current))
            saved = sync.read_state(path)
            self.assertEqual(saved["through"], initial_end.isoformat())
            self.assertEqual(saved["backfill_next"], initial_end.isoformat())
            with patch.object(sync, "list_rides", return_value=[]) as list_rides, contextlib.redirect_stdout(io.StringIO()):
                sync.import_rides(Strava(), directory, None)
                self.assertEqual(list_rides.call_count, 1)
                self.assertEqual(list_rides.call_args.args[1:], (initial_end, Clock.current))
            self.assertIsNone(sync.read_state(path)["backfill_next"])

    def test_import_refuses_redirects_and_unbounded_rate_limit_wait(self):
        requests = []

        def dispatch(url, headers, body):
            requests.append((url.path, body))
            if url.path == "/api/rides":
                return 307, {"Location": "/other"}, {}
            return 429, {"Retry-After": "900"}, {}

        with serve(dispatch) as base, patch.object(sync.time, "sleep") as sleep:
            with self.assertRaisesRegex(sync.StatusError, "307"):
                sync.request_json("Encircle API", sync.Request(f"{base}/api/rides", data=b"fake-track"))
            with self.assertRaisesRegex(sync.StatusError, "429"):
                sync.request_json("Strava API", sync.Request(f"{base}/rate-limit"))
            sleep.assert_not_called()
        self.assertEqual(requests, [("/api/rides", b"fake-track"), ("/rate-limit", b"")])


if __name__ == "__main__":
    unittest.main()
