# Security

CTD Multi-Stream is meant to be reachable from the internet through a port forward, and it holds the keys to your streaming accounts. This page explains what is exposed, how it is protected, and what to do if something goes wrong.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Include the version (shown in **Settings → About**), what you found, and steps to reproduce. You'll get an acknowledgement as soon as possible, and a fix will be released before the details are made public. Only the latest release receives security fixes.

## What is exposed

| Port (container → typical host) | Exposure | What it serves |
|---|---|---|
| 8443 → 443 / 30443 | **Internet** (port-forwarded) | Web UI, REST API and WebSockets, over HTTPS |
| 8080 → 80 / 30080 | Internet (port-forwarded) | Only Let's Encrypt HTTP-01 challenge responses and a redirect to HTTPS |
| 1935 → 1935 | **LAN only** (never forward it) | RTMP ingest from OBS |
| MediaMTX API, auth hook | Loopback inside the container | Internal only |

Public paths that work without logging in:

- The login and first-run setup pages, and `GET /healthz`.
- The OBS chat overlay `/overlay/chat?token=…`. It needs a long random token and only shows chat. Rotate the token if the URL leaks.
- `/oauth/callback/<platform>`, which completes an OAuth connection only for a logged-in admin.

RTMP publishing requires a random per-feed key. Reading a feed is only possible from inside the container with an internal password, so nobody on your LAN can pull your stream from the server.

## Protections

- **HTTPS by default.** A Let's Encrypt certificate for your public IP (or domain), renewed automatically, with a self-signed fallback. HSTS is sent when HTTPS is on. See [HTTPS](INSTALL-TRUENAS.md#https).
- **First-run claim.** Creating the first admin requires a one-time setup code that is only printed in the container log, so whoever finds the port first can't claim your instance.
- **Passwords** are hashed with Argon2id and must be at least 10 characters.
- **Brute-force protection.** Five wrong passwords from one address lock the account for that address for 15 minutes, so a stranger can't lock you out from elsewhere. 50 failures across all addresses lock the account for 15 minutes for any address that hasn't logged in to it recently. Repeated failures from one IP address are rate-limited. Unknown usernames are locked the same way, so errors never reveal whether a username exists.
- **Sessions** use random tokens stored only as hashes, in `HttpOnly`, `SameSite=Strict` cookies marked `Secure` under HTTPS. Sessions expire after 30 days of inactivity (90 days at most). Changing your password logs out your other sessions.
- **CSRF protection.** Every state-changing API request must carry a per-session token, and WebSocket connections must come from the app's own origin.
- **Strict Content-Security-Policy** (same-origin scripts only, no framing) and the usual security headers.
- **Optional two-factor authentication** (TOTP, off by default): **Profile → Two-factor authentication**. Recommended for admins. An admin can turn it off for another user in **Settings → Users**.
- **Recovery needs container access.** A locked-out user (forgotten password, lost authenticator) is recovered with `node dist/server/src/cli.js reset-password <username>` run inside the container (`docker compose exec ctd-multi-stream …`, or the TrueNAS app **Shell**; see [Account recovery](INSTALL-TRUENAS.md#account-recovery)). It prints a new password once, turns off 2FA and signs the user out everywhere. This means shell access to the container or host is equivalent to admin access.
- **Roles.** `admin` manages users, developer apps, accounts, destinations, settings and the browser login view. `operator` can only go live, end the stream, change the title, toggle destinations and read chat.
- **Secrets encrypted at rest** with AES-256-GCM: platform stream keys, OAuth tokens, developer-app secrets, browser sessions and TOTP secrets. The master key is `master.key` in the data folder (created on first run, readable only by the app's user) or the `MASTER_KEY` environment variable.
- **Secrets stay on the server.** Platform stream keys and developer-app secrets are write-only in the UI. Logs never contain stream keys, tokens, passwords, cookies or full RTMP URLs.
- **Audit log** (**Settings → Audit log**): logins and failed logins, user changes, account and destination changes, going live and stopping, title changes, key rotations, settings changes and use of the browser login view.
- **Manual browser login.** For Instagram, TikTok, X and Facebook profile you log in yourself in a live view of the app's browser. Passwords are never stored or typed by the app.
- **Container hardening.** The app runs as an unprivileged user (uid 568) with all Linux capabilities dropped and `no-new-privileges` (as in the provided compose files). The built-in Chromium runs without its own sandbox inside the container, so the container is the isolation boundary for the browser. It only visits the platforms you connect.

## If someone gets in

Be clear about what an account on your instance is worth:

- An **admin** can stream anything to every connected platform, read and change all settings, point destinations at their own server (which hands them the video and the platform's stream key), and use the **browser login view**: that is a logged-in browser on your Instagram, TikTok, X or Facebook account, so they could act as you there.
- An **operator** can start and stop streams, change the title on every platform, turn destinations on and off, and read chat.
- Someone with a copy of your **data folder** (`app.db` plus `master.key`) can decrypt every stored token, key and browser session.

So:

- Use a **long, unique password** (a passphrase from a password manager) for every user, and turn on **2FA** for admins.
- Give people who only run streams the **operator** role.
- Keep the image **up to date**.
- Forward only the web port (and port 80 for Let's Encrypt). Never forward 1935, and never expose the TrueNAS admin UI.
- Protect backups of the data folder like passwords.

### If you suspect a compromise

1. Change every user's password (this ends their other sessions) and review the users list.
2. Check **Settings → Audit log** for logins and changes you don't recognize.
3. Revoke the app's access on each platform (Twitch: Connections; Google account: third-party access; Kick, Facebook: app settings), then reconnect the accounts.
4. Reset your stream keys on every platform that has one, and rotate the OBS ingest keys and the chat overlay token in the app.
5. Log out of all sessions on Instagram, TikTok, X and Facebook from their security settings, then log in again through the app.
6. If the data folder may have leaked, also regenerate your developer-app secrets (Twitch, Google, Kick, Meta).
