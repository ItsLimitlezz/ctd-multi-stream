# TrueNAS

[`ctd-multi-stream.yaml`](ctd-multi-stream.yaml) is a Docker Compose file for **Apps → Discover Apps → ⋮ → Install via YAML** on TrueNAS 24.10 or newer.

Before pasting it, replace `<pool>` with your pool name and `<owner>` with the GitHub user or organization that publishes the image (lowercase), and create the dataset `/mnt/<pool>/apps/ctd-multi-stream` with Modify permission for the `apps` user (568).

Ports on the NAS: **30443** (web UI, HTTPS), **30080** (Let's Encrypt HTTP-01), **1935** (RTMP from OBS, LAN only). On your router, forward public 443 → 30443 and 80 → 30080, and nothing else.

The full guide, including the first login, HTTPS options, backups and updates, is [docs/INSTALL-TRUENAS.md](../../docs/INSTALL-TRUENAS.md).
