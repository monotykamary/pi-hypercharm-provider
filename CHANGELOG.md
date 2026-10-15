# Changelog

## 1.3.42

- Pin Pi SDK development dependencies to 1.2.0 while retaining wildcard host peers; verify real manifest loading, lifecycle and native/bundled Pi hosts offline.

## 1.3.41

- `/login` while the session-start catalog revalidation is still in flight now fetches the new account's catalog right away: the forced refresh aborts the old-credential revalidation and waits for it to release the sync lock instead of skipping as "locked" until the next session start.

## 1.3.40

- Quiet startup sync: background `/v1/provider` revalidation runs only with credentials, only when the disk cache is older than 1 hour (`PI_PROVIDER_SYNC_TTL_MS`, `0` = always), missing, or fetched with different credentials, and only in one pi process at a time (lock file next to the cache). Failed refreshes back off for 5 minutes; sessions that skip adopt a cache refreshed by another process. A completed `/login` forces a revalidation.
- OAuth sessions are fingerprinted by the stored refresh token (not the rotating access token), so token refreshes don't trigger refetches. Only a salted sha256 fingerprint is stored (`cache/hypercharm-models.sync.json`); the cache file format is unchanged.
- The footer's session-start credits/team/devices prefetch now runs only in interactive sessions (not `pi -p` or child agents) and is shared across pi processes through `cache/hypercharm-account.json` (2-minute window). Turn-triggered balance polls are unchanged.
- Write the model cache atomically; `session_start` never awaits the network and swallows background failures.
- Add vitest coverage for the sync policy and the session_start integration (`npm test` runs it after the node:test suites).

## 1.3.36

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.
- Make deprecated-catalog integration fixtures time-independent and emit shutdown before disposing test sessions.

## 1.3.35

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
