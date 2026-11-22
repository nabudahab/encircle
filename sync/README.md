# Local Strava import

This Python 3.10+ script imports your own outdoor cycling activities into Encircle. It runs once per command on Linux or macOS and uses only the Python standard library. Run it against your laptop's private Encircle instance at `http://127.0.0.1:3001`. Encircle handles scoring, database writes, and duplicate detection.

## Connect your Strava account

1. Create or open your personal API app and set its **Authorization Callback Domain** to `127.0.0.1`. [Strava API settings](https://www.strava.com/settings/api)
2. From the Encircle project directory, run the following in Bash. Enter the client ID and client secret from your Strava app settings at the prompts. The secret prompt hides what you type.

   ```bash
   read -rp 'Strava client ID: ' STRAVA_CLIENT_ID
   read -rsp 'Strava client secret: ' STRAVA_CLIENT_SECRET
   printf '\n'
   export STRAVA_CLIENT_ID STRAVA_CLIENT_SECRET
   python3 sync/strava_sync.py authorize
   ```

3. Open the printed authorization URL in your laptop browser, sign in to your own Strava account, and grant `activity:read`. Strava redirects the browser to a temporary listener on `127.0.0.1` and the script saves the tokens. This scope covers activities visible to Everyone and Followers, with Strava privacy-zone data excluded. [Strava OAuth documentation](https://developers.strava.com/docs/authentication/)

Use the same environment variables in later shells. For persistent client credentials, put the following JSON in `~/.local/state/encircle-strava/client.json` instead. Create the directory with `mkdir -p -m 700 ~/.local/state/encircle-strava` if needed, open the file in a local editor with `umask 077`, and set file permissions with `chmod 600 ~/.local/state/encircle-strava/client.json`. If your laptop sets `XDG_STATE_HOME`, use its `encircle-strava` subdirectory. The environment variables take precedence when set.

```json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

## Import rides

Start the local Encircle API on port `3001` and choose an inclusive start date for the first import. A date means midnight UTC. You can also pass a timestamp with an explicit timezone, such as `2026-11-01T08:00:00-05:00`. [Local API setup](../server/README.md)

```bash
python3 sync/strava_sync.py import --local-only --since 2026-11-01
```

For subsequent imports, or to resume an interrupted import, run the same command without `--since`.

```bash
python3 sync/strava_sync.py import --local-only
```

The importer paginates through Strava activities in 30-day windows, processes rides oldest first, and checkpoints each completed ride. Routine imports also check the seven days preceding the last completed cutoff for late uploads. Once an import finishes, pass `--since` to replay rides from that date, including history before your original start date. Encircle identifies repeats by track and start time and replaces the saved awards if the scoring rules have changed. Ride edits, removals, and visibility changes require separate reconciliation.

The importer includes outdoor road, mountain bike, gravel, e-bike, e-mountain bike, handcycle, and velomobile rides. It skips indoor trainer rides, virtual rides, manual entries, and rides without usable GPS. It sends longitude and latitude in that order, splitting at invalid samples, backwards time, gaps over 60 seconds, or jumps over 500 meters. Missing time streams still allow splitting by distance. Segments need at least two distinct consecutive points. [Strava API reference](https://developers.strava.com/docs/reference/)

Tokens and checkpoint metadata are stored in `~/.local/state/encircle-strava` or `$XDG_STATE_HOME/encircle-strava`. The directory is private and generated files are owner-only. The importer saves rotated tokens as Strava refreshes them. GPS samples are held in memory for the import and sent only to the local Encircle API. Each run prints activity IDs and outcomes, followed by totals. Rides that earn zero Indiana awards are reported as `no score`.

Strava activity requests and Encircle posts get up to three attempts on network failures and temporary server failures. A rate limit with a `Retry-After` of at most 10 seconds gets retried, while a longer or unspecified wait exits so you can resume later. For an expired or revoked OAuth grant that Strava cannot refresh, run `authorize` again and then resume. [Strava rate limits](https://developers.strava.com/docs/rate-limits/)

## Offline tests

```bash
python3 -B -m unittest discover -s sync -v
```

The tests use fake credentials and loopback mock endpoints for OAuth, Strava, and Encircle.
