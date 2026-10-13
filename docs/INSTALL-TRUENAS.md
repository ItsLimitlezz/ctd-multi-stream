# Install on TrueNAS

This guide installs CTD Multi-Stream as a custom app on **TrueNAS 24.10 (Electric Eel) or newer**, the releases where apps run on Docker. It covers TrueNAS SCALE and Community Edition (25.x, 26). The image runs on amd64 and arm64.

What you end up with:

- The web UI at `https://<your-public-ip>` from anywhere, and at `https://<NAS-IP>:30443` on your LAN.
- OBS on your LAN sending to `rtmp://<NAS-IP>:1935/live`. RTMP is **not** exposed to the internet.
- All data in one dataset that you can snapshot and back up.

## Before you start

- **A public IPv4 address.** Let's Encrypt needs to reach your router on port 80. If your ISP puts you behind CGNAT (the WAN address in your router starts with `100.64`–`100.127`, or differs from what [whatismyip.com](https://www.whatismyip.com) shows), automatic certificates can't work. You can still use the app on your LAN or over a VPN with a self-signed certificate (see [HTTPS options](#https-options)).
- **A router you can configure** for port forwarding, and a fixed LAN IP for the NAS (a DHCP reservation is enough).
- **Upload bandwidth** for every destination at once. The app relays without re-encoding, so you need roughly the sum of all outgoing bitrates. Example: landscape at 6 Mbps to 4 platforms plus vertical at 4 Mbps to 3 platforms is about 36 Mbps.
- **Resources.** Relaying uses almost no CPU. Plan about 1 GB of RAM for the app, plus a few hundred MB for each platform that uses the built-in browser (Instagram, TikTok, X, Facebook profile).

## 1. Create a dataset

1. **Datasets** → select your pool → **Add Dataset**.
2. Create `apps` first if it doesn't exist, then create `ctd-multi-stream` inside it. If TrueNAS offers a **Dataset Preset**, choose **Apps**.
3. Make sure the built-in **apps** user (uid 568) can write to it: select the dataset → **Permissions** → **Edit**, and give user `apps` (or group `apps`) **Modify** access. The **Apps** preset does this for you.

The full path will be `/mnt/<pool>/apps/ctd-multi-stream`.

## 2. Install the app

1. Open [`deploy/truenas/ctd-multi-stream.yaml`](../deploy/truenas/ctd-multi-stream.yaml) and copy it into a text editor.
2. Replace `<pool>` with your pool name. (The image is `ghcr.io/itslimitlezz/ctd-multi-stream`; nothing to change there.)
3. In TrueNAS: **Apps** → **Discover Apps** → the **⋮** menu → **Install via YAML**.
4. **Name:** `ctd-multi-stream`. Paste the edited YAML into the editor and click **Save**.

TrueNAS pulls the image (about 1 GB) and starts the container. Wait until the app shows **Running**.

Image tags: `latest` is the newest release, `X.Y.Z` is a specific release, `main` is the development build. Pin a version if you want to decide when to upgrade.

## 3. Forward ports on your router

| Public (WAN) port | Forward to | Why |
|---|---|---|
| TCP **443** | NAS LAN IP, port **30443** | Web UI over HTTPS |
| TCP **80** | NAS LAN IP, port **30080** | Let's Encrypt validation (HTTP-01), and a redirect to HTTPS |
| 1935 | **nothing** | RTMP ingest stays on your LAN. Never forward it. |

> [!WARNING]
> Forward to **30443** and **30080**, never to the NAS's own 443 or 80. Those are the TrueNAS admin UI, which must never be exposed to the internet.

If you can't use public port 443 (for example, your ISP blocks it), forward another port (say 8443 → 30443) and set `PUBLIC_PORT: "8443"` in the app's YAML. Port 80 must still reach 30080 for Let's Encrypt. Without it the app stays on a self-signed certificate.

## 4. First login

The first admin account is protected by a one-time **setup code** printed in the app's log, so a stranger who finds the port first can't claim your instance.

1. **Apps** → **Installed** → **ctd-multi-stream** → **Workloads** → **View Logs**.
2. Find the line that contains `"setupCode"`, for example `"setupCode":"K7QM-2XRP-9WDH"`.
3. Open `https://<NAS-IP>:30443`. In the first minutes the certificate is self-signed, so the browser shows a warning. Continue to the site.
4. Enter the setup code, choose an admin username and a **long, unique password** (at least 10 characters; a passphrase is best).

A new code is generated on every restart until setup is done. Afterwards the code is gone and only the login page is shown.

Then continue with:

- [OBS setup](OBS-SETUP.md): point OBS and the Aitum Vertical plugin at the app.
- [Platforms](PLATFORMS.md): connect your accounts and create destinations.
- **Settings → Users**: add `operator` accounts for people who should only go live, change the title and read chat.
- **Profile**: optionally turn on two-factor authentication (TOTP).

## HTTPS

With the default `TLS_MODE: auto`:

1. **First minutes: self-signed.** On first start the app creates a self-signed certificate. Browsers warn about it; continue anyway on your own network.
2. **Then: a Let's Encrypt certificate for your public IP.** The app discovers your public IP and requests an IP address certificate over port 80. These certificates are short-lived (about 6 days). The app renews them automatically well before they expire, and requests a new one when your public IP changes. No domain name needed.
3. If issuance fails (port 80 not forwarded, CGNAT, rate limits), the app keeps serving the self-signed certificate and retries with increasing delays. **Settings → HTTPS** shows which certificate is active, when it expires, and the last error.

On your LAN, `https://<NAS-IP>:30443` shows a name mismatch warning once the Let's Encrypt certificate is active, because the certificate names your public IP, not the NAS's LAN IP. Either accept the warning on the LAN, or browse to `https://<public-ip>` if your router supports NAT loopback (hairpinning).

### HTTPS options

Change settings in **Apps** → **Installed** → **ctd-multi-stream** → **Edit**, under `environment:` in the YAML, then **Save**. The app restarts.

| Setup | Environment |
|---|---|
| Default: Let's Encrypt for your public IP | `TLS_MODE: auto` |
| Your own domain (DNS or dynamic DNS pointing at your public IP). Gets a normal 90-day certificate. Port 80 still needed. | `PUBLIC_HOST: stream.example.com` |
| Contact e-mail for Let's Encrypt notices | `ACME_EMAIL: you@example.com` |
| LAN or VPN only (no port forwarding) | `TLS_MODE: self-signed` |
| Your own reverse proxy (Nginx Proxy Manager, Caddy, Traefik) terminates HTTPS | `TLS_MODE: "off"` and `TRUST_PROXY: "true"` |
| Your own certificate files (put them in the dataset) | `TLS_MODE: manual`, `TLS_CERT_FILE: /data/tls/my.crt`, `TLS_KEY_FILE: /data/tls/my.key` |

Reverse proxy notes:

- With `TLS_MODE: "off"` the app serves plain HTTP on container port 8443, so point the proxy at `http://<NAS-IP>:30443`. The proxy must pass WebSockets (`/api/ws`, `/api/browser/…/ws`, `/overlay/ws`) and the `Host` header unchanged.
- Forward your router only to the proxy, never straight to 30443. Without HTTPS in the app, session cookies are not marked `Secure`.
- Set **Settings → General → Public base URL** to the proxy's `https://` address so links (OAuth redirects, the chat overlay) use it.
- Quote `"off"` and `"true"` in YAML, otherwise they are parsed as booleans.

## Backups

Everything lives in the dataset:

| Path | Contents |
|---|---|
| `app.db` (+ `-wal`, `-shm`) | SQLite database: users, settings, accounts, destinations, audit log, encrypted secrets |
| `master.key` | The key that decrypts stream keys, OAuth tokens and browser sessions |
| `tls/` | Certificates and the Let's Encrypt account key (re-created if lost) |
| `mediamtx/` | Generated MediaMTX config (re-created on start) |

- Back up the whole dataset: periodic **snapshots** plus replication or Cloud Sync. ZFS snapshots are crash-consistent, which SQLite recovers from. For a guaranteed clean copy, stop the app first.
- **Keep `master.key` with the database.** Without it, every stored key and token is unreadable and you have to reconnect all accounts and re-enter stream keys. Anyone who has both `app.db` and `master.key` can read your stream keys and tokens, so protect your backups like passwords.
- If you set `MASTER_KEY` in the environment instead, the file is not used. Store that value somewhere safe.

To restore: stop the app, roll back the snapshot or copy the files back into the dataset (owned by uid 568), and start the app.

## Updating

Update when you're not streaming: the container restarts, which ends any running session.

- **On `latest`:** if TrueNAS shows **Update** for the app, use it. Otherwise pull the new image under **Apps** → **Configuration** → **Manage Container Images** → **Pull Image** (`ghcr.io/itslimitlezz/ctd-multi-stream`, tag `latest`), then stop and start the app.
- **On a pinned version:** **Edit** the app, change the tag in `image:`, and **Save**.

The database schema migrates automatically on start. Downgrades are not supported, so snapshot the dataset before upgrading.

## Account recovery

Five wrong passwords from one address lock the account for that address for 15 minutes; the lockout clears on its own. For a forgotten password or a lost authenticator app:

- **Another admin can still sign in:** they can set a new password or turn off 2FA for that user in **Settings → Users**.
- **Nobody can sign in:** use the recovery command inside the container. Open **Apps** → **Installed** → **ctd-multi-stream** → **Workloads** → **Shell** (the shell starts in `/app`) and run:

  ```sh
  node dist/server/src/cli.js list-users                  # usernames, roles, and who has 2FA on
  node dist/server/src/cli.js reset-password <username>
  ```

`reset-password` prints a new random password once, turns off 2FA, clears any lockout and signs the user out everywhere. Sign in with it, change the password under **Profile**, and turn 2FA back on there if you use it. The app can keep running while you do this.

Anyone with shell access to the container (or to the TrueNAS host) can do this for any user, so treat that access like an admin password.

## Troubleshooting

| Symptom | Check |
|---|---|
| App doesn't start; log mentions `EACCES` / permission denied | The `apps` user (568) needs Modify permission on the dataset (step 1). |
| Port 1935 is already used by another app | Change the mapping and `RTMP_PORT` to the same new number, e.g. `"1936:1936"` and `RTMP_PORT: "1936"`. **Settings → OBS setup** then shows the new port. |
| Not reachable from the internet | Port forwarding goes to the NAS's LAN IP on 30443; CGNAT (see [Before you start](#before-you-start)); the NAS's IP changed (use a DHCP reservation). |
| Still self-signed after 15 minutes | Port 80 → 30080 forwarding, and the TLS status and last error in **Settings → HTTPS**. |
| OBS can't connect | OBS and the NAS are on the same network; server `rtmp://<NAS-IP>:1935/live`; the stream key copied exactly from **Settings → OBS setup**. |
| Lost the setup code | Restart the app: a new code is printed while no admin account exists. |
| Forgot a password or lost the 2FA authenticator | If another admin can still sign in, they can set a new password or turn off 2FA in **Settings → Users**. Otherwise open **Apps** → **Installed** → **ctd-multi-stream** → **Workloads** → **Shell** and run `node dist/server/src/cli.js list-users` to see the usernames, then `node dist/server/src/cli.js reset-password <username>`. See [Account recovery](#account-recovery). |
| `http://<NAS-IP>:30080` opens the TrueNAS login | Port 30080 redirects to the public HTTPS port (443), which on the LAN is TrueNAS itself. Use `https://<NAS-IP>:30443` on the LAN. |
