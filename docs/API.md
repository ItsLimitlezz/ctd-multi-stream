# External API (v1)

Read-only API for other apps: **CTD Overlay** (merged chat, stream status), the **CTD OBS plugin**
(bitrates, which streams are down, chat), bots and scripts. It is separate from the web UI's own
session-cookie API.

- Base path: `/api/v1`. Breaking changes ship as `/api/v2`.
- JSON, UTF-8, `camelCase`. Times: ISO 8601 UTC in resources, epoch milliseconds in live envelopes.
- Machine-readable description: `GET /api/v1/openapi.json` (no auth).
- Everything here is `GET` (read-only). Nothing in v1 changes the stream.

## 1. Where to connect

| From | URL | Notes |
|---|---|---|
| Same LAN / same NAS (CTD Overlay, OBS) | `http://<NAS-IP>:<HTTP_PORT>/api/v1` — TrueNAS: `http://<NAS-IP>:30080/api/v1` | Plain HTTP, served **only to private-network clients** (10/8, 172.16/12, 192.168/16, 100.64/10, loopback, fc00::/7, link-local). Internet clients on this port are redirected to HTTPS. Simplest for LAN apps: no certificate to trust. |
| Anywhere | `https://<public IP or host>/api/v1`, or on the LAN `https://<NAS-IP>:30443/api/v1` | The certificate is Let's Encrypt for the public IP/host, or self-signed. Self-signed: pin the SHA-256 fingerprint shown in **Settings → API** (`tlsFingerprint256`). |

`/dock` and `/overlay/*` follow the same rule (LAN HTTP or HTTPS).

"Private-network client" means the TCP peer address (never `X-Forwarded-For`). Where a NAT or proxy
hop replaces the client's address with a private one, internet clients look private too: Docker
Desktop (Windows/macOS), rootless Docker/Podman, IPv6 published into an IPv4-only Docker network,
or ports forwarded from a VPS through a tunnel. On such installs set `LAN_HTTP=off` (this port only
answers ACME challenges and redirects to HTTPS) or `LAN_HTTP_CIDRS=192.168.1.0/24,…` (only peers in
those ranges count as LAN; it replaces the built-in private ranges).

**Settings → API** shows both URLs. The LAN URL uses `LAN_HTTP_HOST` when set, else the address you
opened the web UI with when it is a LAN IP or a LAN-only name (`nas.local`, `truenas.lan`, a
single-label name). Inside a container nothing else is guessed (the container's own address is not
the NAS address), so the LAN URL is empty until you open the web UI by its LAN address or set
`LAN_HTTP_HOST`. It assumes `HTTP_PORT` is mapped like the HTTPS port (Docker `443 → 80`, TrueNAS
`30443 → 30080`). If your port mapping differs, set the `LAN_HTTP_PORT` environment variable to
the HTTP port as seen from the LAN. With `LAN_HTTP=off` the LAN URL is the HTTPS one.

## 2. Authentication

Create a token in the web UI: **Settings → API → New token** (admin). The secret is shown once:

```
ctd_pat_3fK9wQ1v…        (ctd_pat_ + 43 base64url characters)
```

Send it on every request:

```http
Authorization: Bearer ctd_pat_3fK9wQ1v…
```

| Scope | Grants |
|---|---|
| `chat:read` | `GET /chat`, `chat.*` and `alert.*` events |
| `status:read` | `GET /status`, `stream.*`, `feed.*`, `destination.*`, `system.notice` events |

`/`, `/events` and `/events/poll` return whatever the token's scopes allow. Browser-only
fallback: `GET /events` also accepts `?access_token=` (prefer the header; query strings can end up
in proxy logs). Tokens are stored hashed; revoking one in Settings → API takes effect immediately
(open streams are closed within 30 s).

Limits: 600 requests/minute per token (`429` + `Retry-After`), 5 concurrent event streams per token
(a 6th gets `429` with `Retry-After: 30`).

Responses carry `Access-Control-Allow-Origin: *` and the API never uses or sets cookies, so a
browser app on another origin can call it with the `Authorization` header.

### Errors

[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/ItsLimitlezz/ctd-multi-stream/blob/main/docs/API.md#errors",
  "title": "Missing scope",
  "status": 403,
  "detail": "This token needs the chat:read scope. Edit it in Settings → API.",
  "code": "missing_scope"
}
```

| Status | `code` | When |
|---|---|---|
| 401 | `unauthenticated` | No/unknown/revoked token |
| 403 | `missing_scope` | Token lacks the scope |
| 400 | `invalid` | Bad query parameter |
| 404 | `not_found` | Unknown `/api/v1` path |
| 429 | `rate_limited` | Over the limit (`Retry-After` seconds) |

## 3. Envelope

Every live item (event stream, poll, chat backfill) is an envelope, compatible with the CTD Overlay
(SKP) envelope:

```json
{
  "id": "01JA7Q8M9X2V4C6B8N0P2R4T6W",
  "type": "chat.message",
  "ts": 1791830000123,
  "src": { "connector": "ctd-multi-stream", "connection": "5b1c…destination id…", "platform": "twitch" },
  "data": { }
}
```

| Field | Meaning |
|---|---|
| `id` | ULID: unique and sortable by time. Doubles as the stream/poll cursor. |
| `type` | Event type (§5). |
| `ts` | Server epoch ms when the event happened. |
| `src.connection` | Destination id the event belongs to, or `core` for session-wide events. |
| `src.platform` | `twitch`, `youtube`, `kick`, `facebook`, `x`, `instagram`, `tiktok`, `custom`, or `core`. (CTD Overlay maps the ones its standard doesn't list to `custom`.) |

## 4. Routes

### `GET /api/v1/`
Who am I. Any valid token.
```json
{ "name": "ctd-multi-stream", "version": "0.2.0", "apiVersion": 1, "token": { "name": "CTD Overlay", "scopes": ["chat:read", "status:read"] } }
```

### `GET /api/v1/status` — `status:read`
Everything a dashboard or the OBS plugin needs in one call. Poll it (every 2 s is fine) or use the
event stream.

```json
{
  "session": {
    "status": "live",
    "startedAt": "2026-10-17T03:00:04Z",
    "title": "DPRTMNT Saturday",
    "testMode": false,
    "autoGoLive": true
  },
  "feeds": [
    { "feed": "landscape", "online": true, "since": "2026-10-17T02:59:58Z",
      "video": { "codec": "H264", "width": 1920, "height": 1080 },
      "audio": { "codec": "MPEG-4 Audio", "sampleRate": 48000, "channels": 2 },
      "bitrateKbps": 6012 },
    { "feed": "vertical", "online": true, "since": "2026-10-17T02:59:59Z",
      "video": { "codec": "H264", "width": 1080, "height": 1920 },
      "audio": { "codec": "MPEG-4 Audio", "sampleRate": 48000, "channels": 2 },
      "bitrateKbps": 4010 }
  ],
  "destinations": [
    { "id": "5b1c…", "name": "Twitch", "platform": "twitch", "feed": "landscape", "enabled": true,
      "phase": "live", "live": true, "down": false, "message": null,
      "stats": { "bitrateKbps": 6010, "fps": 60, "speed": 1, "uptimeSec": 3605 },
      "viewers": 214, "watchUrl": "https://www.twitch.tv/dprtmnttoronto",
      "recoveries": 0, "lastRecovery": null, "since": "2026-10-17T03:00:09Z" },
    { "id": "9e2f…", "name": "Instagram", "platform": "instagram", "feed": "vertical", "enabled": true,
      "phase": "recovering", "live": false, "down": true,
      "message": "Instagram ended the live (copyright). Starting a new one…",
      "stats": null, "viewers": null, "watchUrl": null,
      "recoveries": 1, "lastRecovery": { "at": "2026-10-17T04:12:40Z", "reason": "copyright" },
      "since": "2026-10-17T04:12:40Z" }
  ],
  "platforms": [
    { "platform": "twitch", "destinations": ["5b1c…"], "live": true, "title": "DPRTMNT Saturday",
      "startedAt": 1791831609000, "viewers": 214, "error": null },
    { "platform": "instagram", "destinations": ["9e2f…"], "live": false, "title": "DPRTMNT Saturday",
      "startedAt": null, "viewers": null, "error": "Instagram ended the live (copyright). Starting a new one…" }
  ]
}
```

- `phase`: `idle`, `disabled`, `waiting-for-feed`, `preparing`, `connecting`, `confirming`, `live`,
  `retrying`, `recovering`, `ending`, `error`. `live` = phase is `live`.
- `down` = the session is running, the destination is enabled (and not skipped by test mode), and
  it isn't reaching the platform right now (`error`, `retrying`, `recovering`, or `waiting-for-feed`).
  This is the field to light up red.
- `session.testMode`: the session streams in **test mode** (the dashboard switch; it can only change
  while no session runs). Every destination uses its platform's private/test setting: Twitch
  bandwidth test, YouTube private broadcast, Instagram Practice, Facebook Page "only me".
  Destinations whose platform (or account) has none are not started at all: `phase: "disabled"`,
  `message: "Skipped — Kick has no test mode"`, never `down`. Test mode never changes a channel
  title (Twitch, Kick), which is public even during a bandwidth test; `session.title` is applied
  when the stream goes live outside test mode.
- `viewers`: current viewers while live, as the platform reports them: Twitch, Kick and Facebook Page
  (polled every 30 s), YouTube (every 60 s), Instagram and TikTok (read from the live page). `null`
  when unknown: not live, not reported yet, hidden by the platform, or never reported (X, custom
  RTMP). Never `0` for "unknown".
- `platforms[]`: per-platform rollup. `live` if any of its destinations is live; `viewers` is the sum
  of known counts (null if none known); `error` is the message of the first down destination that
  has one (`null` if none does; check `destinations[].down` for the down state itself).

### `GET /api/v1/chat?limit=200&after=<id>` — `chat:read`
Recent chat still visible after moderation, **oldest first**, as `chat.message` envelopes.
`limit` 1–500 (default 200). With `after`, only messages newer than that envelope id (incremental
polling). Session-scoped: the buffer holds the last 500 messages.

```json
{ "items": [ { "id": "01JA…", "type": "chat.message", "ts": 1791830000123, "src": { … }, "data": { … } } ],
  "next": "01JA7Q8M9X2V4C6B8N0P2R4T6W" }
```
`next` is the id of the last item (pass it as `after` next time), or the `after` you sent when there
was nothing new.

### `GET /api/v1/events?types=chat.*,destination.*` — Server-Sent Events
`Content-Type: text/event-stream`. Every frame:

```
id: 01JA7Q8M9X2V4C6B8N0P2R4T6W
event: chat.message
data: {"id":"01JA7Q8M9X2V4C6B8N0P2R4T6W","type":"chat.message","ts":1791830000123,"src":{…},"data":{…}}

```

- `types`: comma-separated globs (`chat.*`, `destination.down`, …); default = everything the
  token's scopes allow.
- **Resume:** send `Last-Event-ID: <id>` (or `?cursor=<id>`). The server replays buffered events
  after it (buffer: last 2000 events or 15 minutes). If an event you would receive (by `types` and
  scopes) after that id has already left the buffer, or the id is from before a server restart, the
  server first sends `event: system.reset` — refetch `/chat` and `/status`, then continue. Events
  your filter skips never cause a reset.
- On connect without a cursor, the stream starts with one `stream.status` and one
  `destination.status` per destination (current state), then live events. Chat backfill is not
  replayed — call `GET /chat` for that.
- Heartbeat comment `: ping` every 15 s. `retry: 3000` is sent once.
- A client that stops reading (more than about 1 MB of live events queued for it) is disconnected;
  it resumes with `Last-Event-ID` like after any disconnect.

### `GET /api/v1/events/poll?after=<id>&types=…` — polling alternative
For clients that can't hold a stream open (e.g. a C plugin). Same envelopes and buffer as `/events`.
```json
{ "items": [ … ], "next": "01JA…", "reset": false }
```
`reset: true` means an event you would receive after `after` has left the buffer, or `after` is from
before a server restart (refetch `/status` and `/chat`).
Without `after`: returns nothing but the current cursor (`next`), so you can start polling from now.
`next` is the id of the last item; with `types` it also moves past events the filter skipped.

## 5. Event types

### `chat.message` — `chat:read`
```json
{
  "id": "twitch:9d0a7c1e-…",
  "platform": "twitch",
  "channel": "Twitch",
  "destinationId": "5b1c…",
  "platformMessageId": "9d0a7c1e-…",
  "user": {
    "id": "twitch:144552210",
    "login": "djfan",
    "name": "DJFan",
    "color": "#1E90FF",
    "avatar": null,
    "badges": [ { "id": "subscriber/12", "label": "subscriber" } ],
    "roles": ["subscriber"]
  },
  "text": "this set is fire Kappa https://kick.com/dprtmnttoronto",
  "fragments": [
    { "type": "text", "text": "this set is fire " },
    { "type": "emote", "text": "Kappa", "image": "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" },
    { "type": "text", "text": " " },
    { "type": "link", "text": "https://kick.com/dprtmnttoronto", "url": "https://kick.com/dprtmnttoronto" }
  ],
  "reply": null,
  "highlighted": false,
  "action": false,
  "kind": "message",
  "ts": 1791830000123
}
```
- `id` is stable for the message (prefixed with the platform) — use it to apply deletions.
- `user.id` is `<platform>:<id>` when the chat source gives the platform's user id (Twitch,
  YouTube, Kick; Facebook Page when Facebook shares the commenter), otherwise
  `<platform>:name:<display name>` (browser-read chat on Instagram, TikTok, X and Facebook profile).
  Treat it as opaque: compare it, don't parse it.
- `roles` ⊆ `broadcaster`, `moderator`, `vip`, `subscriber`, `member`, `verified`, `founder`,
  `artist`, `bot`; the raw platform badges stay in `badges`.
- `fragments`: joining every fragment's `text` always equals `text`: `text` fragments, `link`
  fragments for URLs, and `emote` fragments (with an `https` `image`) where the chat source
  resolves emotes: Twitch emotes and Kick emote codes (an emote fragment's `text` is how the emote
  reads in `text`, e.g. its name). Twitch cheers (Bits) also get `cheermote` fragments: `text` as
  written (e.g. `Cheer100`) and an integer `amount` of bits, no `image`. `mention` is reserved: no
  chat source sends it yet. Treat a fragment type you don't know as text.
- `action` is `true` for `/me` messages (Twitch, Kick); `highlighted` for highlighted or paid
  messages.
- `kind: "event"` = a platform notice shown in chat (sub, raid, Super Chat…), `text` is its
  human-readable line. When the notice is a structured alert, an `alert.<kind>` event (below)
  follows it.
- `color` is `#RRGGBB` or `null`; `avatar` is an `https` URL or `null`. `channel` is the
  destination name.
- `platformMessageId` and `user.login` are `null` when the chat source doesn't provide them
  (browser-read chat). `reply`
  is `null` or `{ "messageId", "userName", "text" }` (`messageId` in the same prefixed form as
  `id`; any of them may be `null`).

### `chat.message.deleted` — `chat:read`
```json
{ "messageId": "twitch:9d0a7c1e-…", "platformMessageId": "9d0a7c1e-…", "platform": "twitch", "destinationId": "5b1c…" }
```
`messageId` is the deleted message's `id` (for a message the server never saw: `<platform>:<platformMessageId>`).
### `chat.user.cleared` — `chat:read` (ban / timeout: remove that user's messages)
```json
{ "userId": "twitch:144552210", "userName": "DJFan", "platform": "twitch", "destinationId": "5b1c…" }
```
`userId` has the `user.id` form (`<platform>:name:<name>` when the platform only names the user);
either field may be `null`.
### `chat.cleared` — `chat:read` (whole chat cleared on one platform)
```json
{ "platform": "twitch", "destinationId": "5b1c…" }
```
Moderation is reported where the platform exposes it: Twitch (deleted messages, bans and
timeouts, `/clear`), YouTube (deleted messages, bans and timeouts) and Kick (deleted messages,
bans and timeouts, cleared chat). Browser-read chat (Instagram, TikTok, X, Facebook profile) has no
deletion events. `GET /chat` already leaves removed messages out.

### `alert.<kind>` — `chat:read`
Structured platform alerts, in the CTD Overlay alert shape. Each one is also a `chat.message`
(`kind: "event"`, a readable `text`), sent right before it; `messageId` is that message's `id`.
Alerts are live events only: `GET /chat` returns the chat line, not the alert. Subscribe with
`types=alert.*` (note that `chat.*` does not include them).

| Type | From | `amount` |
|---|---|---|
| `alert.subscription` | Twitch sub / resub, Kick subscription | `months` (cumulative), `tier` = `1000` / `2000` / `3000` / `Prime` on Twitch |
| `alert.gift` | Twitch gifted subs (single and mystery), Kick gifted subscriptions, YouTube gifted memberships | `count` (subs gifted), `gift.recipients` when known |
| `alert.cheer` | Twitch Bits | `bits` |
| `alert.raid` | Twitch raid, Kick host | `viewers` |
| `alert.membership` | YouTube new member (`months: 1`), member milestone | `months` |
| `alert.superchat` | YouTube Super Chat and Super Sticker | `currency` |
| `alert.follow`, `alert.kicks`, `alert.tip` | Reserved for the CTD Overlay kinds; no chat source sends them yet | — |

Kick Kicks and YouTube paid gifts (Jewels) are `chat.message` event lines only
(`kind: "event"`), with no alert.

```json
{
  "kind": "subscription",
  "user": { "id": "twitch:144552210", "name": "DJFan" },
  "amount": { "unit": "months", "value": 12 },
  "tier": "1000",
  "message": { "text": "a year of DPRTMNT!" },
  "platform": "twitch",
  "destinationId": "5b1c…",
  "messageId": "twitch:3f1d7c2a-…",
  "ts": 1791830000123
}
```
```json
{
  "kind": "superchat",
  "user": { "id": "youtube:UCx9…", "name": "Night Owl", "avatar": "https://yt3.ggpht.com/…" },
  "amount": { "unit": "currency", "value": "5.00", "currency": "USD" },
  "message": { "text": "play the remix!" },
  "platform": "youtube",
  "destinationId": "7c4e…",
  "messageId": "youtube:LCC.Cg8KDQ…",
  "ts": 1791830012456
}
```
```json
{
  "kind": "gift",
  "user": { "name": "Anonymous", "anonymous": true },
  "amount": { "unit": "count", "value": 5 },
  "gift": { "total": 5 },
  "platform": "twitch",
  "destinationId": "5b1c…",
  "messageId": "twitch:9a0b…",
  "ts": 1791830020789
}
```
- Fields that don't apply are left out (not `null`): `amount`, `tier`, `message`, `gift`,
  `user.id` (anonymous users), `user.avatar`, `user.anonymous`.
- `user.id` has the `chat.message` `user.id` form, so it can be matched with chat authors.
- `amount.value` is an integer for `months`, `count`, `bits`, `kicks` and `viewers`. Money
  (`unit: "currency"`) is a **decimal string** with an ISO 4217 `currency` (`"5.00"` `USD`,
  `"1000"` `JPY`) — never a float; format it with the currency's own rules.
- `gift`: `{ "recipients"?: [names], "total"?: integer }` (for a gift bomb `total` is the number of
  subs; recipients may be missing or partial).

### `stream.status` — `status:read`
`data` = the `session` object from `/status`. Sent when status, title, test mode or auto go-live change.

### `feed.status` — `status:read`
`data` = one `feeds[]` item. Sent on online/offline/codec changes and at most every 2 s for bitrate.

### `destination.status` — `status:read`
`data` = one `destinations[]` item. Sent on every phase change, and at most every 2 s for stats/viewers.

### `destination.down` / `destination.up` — `status:read`
Edge-triggered, once per transition of the `down` flag (§4 `/status`):
```json
{ "destinationId": "9e2f…", "name": "Instagram", "platform": "instagram", "phase": "recovering",
  "reason": "Instagram ended the live (copyright). Starting a new one…" }
```
```json
{ "destinationId": "9e2f…", "name": "Instagram", "platform": "instagram", "downForSec": 41, "recoveries": 1 }
```
`reason` is the destination's `message` (may be `null`). Stopping the session also clears `down`
(you get `destination.up`), and so does deleting a down destination (its last event is that
`destination.up`; refetch `/status` for the current list).

### `system.notice` — `status:read`
Messages the web UI shows as toasts (takedown detected, live again, session stopped…):
```json
{ "level": "warn", "message": "Instagram ended the live (copyright). Starting a new one…" }
```

### `system.reset`
`data: {}` — events you would have received after your cursor are no longer buffered (or the
cursor is from before a restart); refetch `/status` and `/chat`.

## 6. Not in v1 (yet)

- Writing (sending chat, changing the title, going live, test mode). The web UI does that; v1 is
  read-only.
- Follows, Kick KICKs and tips as alerts (`alert.follow`, `alert.kicks` and `alert.tip` are
  reserved: no chat source sends them yet).
- Viewer counts for X (not exposed by X) and custom RTMP servers.

## 7. Example clients

```bash
curl -H "Authorization: Bearer $CTD_TOKEN" http://192.168.1.20:30080/api/v1/status
```

```bash
curl -N -H "Authorization: Bearer $CTD_TOKEN" "http://192.168.1.20:30080/api/v1/events?types=chat.*"
```

Node (no dependencies, resumes after disconnects):

```js
let cursor = null;
async function run() {
  for (;;) {
    try {
      const res = await fetch('http://192.168.1.20:30080/api/v1/events', {
        headers: { authorization: `Bearer ${process.env.CTD_TOKEN}`, ...(cursor ? { 'last-event-id': cursor } : {}) },
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue; // heartbeat
          const env = JSON.parse(data);
          cursor = env.id ?? cursor;
          console.log(env.type, env.data);
        }
      }
    } catch (err) { console.error(err.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
run();
```

## 8. OBS dock

**Settings → API → OBS dock** creates a token (`status:read` + `chat:read`) and gives a URL like
`http://192.168.1.20:30080/dock#token=ctd_pat_…`. In OBS: **Docks → Custom Browser Docks**, paste
it. The dock shows live status (with a TEST badge in test mode), feed bitrates, every destination
(red when down, with the reason), viewers, and the merged chat. The token stays in the URL
fragment, so it is never sent to the server in the URL — the page sends it as a header.

## Changelog

`apiVersion` stays `1`: every change below is additive, so clients written for an earlier v1
keep working (ignore event types and fields you don't know). `GET /api/v1/openapi.json` reports
the revision in `info.version`.

### v1.1

- **Alerts:** `alert.<kind>` events (`subscription`, `gift`, `cheer`, `raid`, `membership`,
  `superchat`; `follow`, `kicks`, `tip` reserved) under the `chat:read` scope, sent after the
  `chat.message` event line that carries them (§5). Money is a decimal string + ISO 4217 currency.
- **Viewers:** `destinations[].viewers` (and the `platforms[].viewers` sum of known counts) are now
  filled for Twitch, Kick, YouTube, Facebook Page, Instagram and TikTok.
- **Test mode:** `session.testMode` is live: the dashboard switch streams privately where the
  platform allows it and skips the rest (`phase: "disabled"`, "Skipped — … has no test mode").
- **Chat details** for Twitch, YouTube, Kick and Facebook Page: real platform user ids
  (`user.id` = `<platform>:<id>`), `user.login`, `platformMessageId`; Twitch emote and Kick
  emote-code `emote` fragments, Twitch `cheermote` fragments (with `amount`); `action` for `/me`;
  `chat.message.deleted`, `chat.user.cleared` and `chat.cleared` from Twitch, YouTube and Kick.

### v1.0

First release: tokens and scopes, `/status`, `/chat`, `/events` (SSE) and `/events/poll`, `chat.*`,
`stream.status`, `feed.status`, `destination.*` and `system.*` events, the OBS dock.
