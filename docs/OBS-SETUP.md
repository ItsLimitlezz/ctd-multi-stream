# OBS setup

CTD Multi-Stream takes two feeds from OBS on your LAN:

| Feed | Sent by | Goes to (defaults) |
|---|---|---|
| **landscape** | OBS main output | Twitch, YouTube, Kick, Facebook, X, custom RTMP |
| **vertical** | [Aitum Vertical](https://aitum.tv/) plugin | Instagram, TikTok, YouTube (Shorts), Twitch Dual Format |

Each destination is bound to one feed, and you can change the routing per destination. You don't need both feeds: with only the main output, everything bound to `landscape` still works.

## Get the server and stream keys

In CTD Multi-Stream, open **Settings → OBS setup** (admins only). It shows:

- **Server:** `rtmp://<NAS-IP>:1935/live`. The host is the address you used to open the web UI. If you opened it through your public address, set **Settings → General → Ingest host** to the NAS's LAN IP so OBS uses the LAN address.
- **Stream key (landscape):** `landscape?key=…`
- **Stream key (vertical):** `vertical?key=…`

Copy them with the copy buttons rather than typing them. Each feed has its own random key, and only the right key can publish. Treat the keys like passwords. If one leaks, **rotate** it on the same page and paste the new key into OBS.

RTMP is LAN-only by design: never port-forward 1935. OBS must run on the same network as the server (or reach it over a VPN).

## Main output (landscape)

**Settings → Stream**

| Field | Value |
|---|---|
| Service | **Custom…** |
| Server | `rtmp://<NAS-IP>:1935/live` |
| Stream Key | `landscape?key=…` |
| Use authentication | off |

**Settings → Output** (Output Mode: **Advanced**) **→ Streaming**

| Setting | Recommended |
|---|---|
| Encoder | H.264: NVIDIA NVENC H.264, QuickSync H.264, AMD HW H.264 or x264. Not HEVC or AV1. |
| Rate control | **CBR** |
| Bitrate | **6000 Kbps or less** (4500 is a safe choice for 720p60) |
| Keyframe interval | **2 s** |
| Profile | high |

**Settings → Video:** output resolution **1920×1080** or **1280×720**, **60** or **30** fps.

**Settings → Audio:** sample rate **48 kHz**. **Settings → Output → Audio:** track bitrate **160** kbps (AAC).

## Vertical output (Aitum Vertical)

1. Install the free [Aitum Vertical](https://obsproject.com/forum/resources/aitum-vertical.1715/) plugin and restart OBS. It adds a second, vertical canvas with its own docks.
2. Open the plugin's settings (the gear icon in the **Vertical** dock) and its stream settings.
3. Add a stream output with server `rtmp://<NAS-IP>:1935/live` and stream key `vertical?key=…`.
4. Use these settings:

| Setting | Recommended |
|---|---|
| Canvas / output | **1080×1920** or **720×1280** |
| FPS | **30** |
| Encoder | H.264, **CBR**, about **4000 Kbps** |
| Keyframe interval | **2 s** |
| Audio | AAC **160** kbps, **48 kHz** |

Start the vertical stream from the Vertical dock's stream button. Aitum Vertical can also start it together with the main output; see its settings.

## Why these settings

The app **does not re-encode**: it copies video and audio to every platform as-is (`-c copy`). That keeps CPU use near zero, but each OBS output must suit the strictest platform bound to that feed:

- H.264 video with AAC audio is accepted everywhere. Other codecs are rejected by some platforms.
- A **2-second keyframe interval** is required or recommended by Twitch, YouTube, Kick, Facebook and the vertical platforms.
- **CBR at 6 Mbps or less** is within what Twitch recommends for most channels and is fine for the other landscape platforms.
- Upload bandwidth: the server sends one copy per destination. 6 Mbps to four landscape destinations plus 4 Mbps to three vertical ones is about 36 Mbps of upload from the server.

| Feed | Resolution | FPS | Video | Keyframe | Audio |
|---|---|---|---|---|---|
| Landscape | 1920×1080 or 1280×720 | 60 or 30 | H.264 CBR ≤ 6 Mbps | 2 s | AAC 160 kbps, 48 kHz |
| Vertical | 1080×1920 or 720×1280 | 30 | H.264 CBR ~4 Mbps | 2 s | AAC 160 kbps, 48 kHz |

## Going live

By default the app **goes live automatically when OBS starts streaming** (the **Auto go-live** switch on the dashboard). When a feed arrives, every enabled destination bound to it starts with the title currently set on the dashboard.

- Turn **Auto go-live** off to start and stop the session yourself with **Go live** / **End stream**.
- The dashboard shows each feed's state (resolution, fps, codec, bitrate) and each destination's phase: waiting for feed, preparing, connecting, confirming, live, retrying or error.
- If OBS drops for a moment, the app waits before ending anything (**Settings → General → Disconnect grace**, 15 s by default) and resumes the same lives when the feed returns.
- Platforms driven by the built-in browser (Instagram, TikTok) create a new live with a new key every time, wait for the preview to arrive and then click "Go live". That takes a little longer than API platforms.
- A failing destination retries on its own and never blocks the others.

## Twitch Dual Format

Twitch can show viewers a landscape and a vertical version of the same stream ("Dual Format"). It uses Enhanced Broadcasting: several video tracks in one connection. Check your Twitch dashboard's stream settings to see whether Dual Format is available for your channel. Each Twitch destination has a **Dual Format** option with three modes. If you want Dual Format, use **OBS sends Dual Format directly**.

### Relay one feed (default)

The app relays this destination's feed (normally landscape) to Twitch as a regular stream. Nothing special to set up in OBS.

### OBS sends Dual Format directly (recommended for Dual Format)

OBS sends Dual Format straight to Twitch. CTD Multi-Stream sends **no video** to Twitch: it only keeps the Twitch title in sync and reads Twitch chat, and relays your feeds to every other platform.

1. In OBS **Settings → Stream**, set **Service: Twitch**, connect your account, turn on **Enhanced Broadcasting**, and pick the Aitum Vertical canvas as the additional canvas. Follow Twitch's and Aitum's current Dual Format instructions for your OBS version.
2. Your main output now goes to Twitch, so the app needs the landscape feed from an extra output. Add one with a multistream plugin, for example the free Aitum Multistream: Custom server `rtmp://<NAS-IP>:1935/live`, key `landscape?key=…`.
3. Point the Aitum Vertical canvas's stream output at the app as described above (`vertical?key=…`).
4. In the Twitch destination, set **Dual Format** to "OBS sends Dual Format directly".

Your PC uploads the Twitch stream itself. The extra outputs to the app stay on your LAN.

### Relay both feeds as Dual Format (experimental)

The app combines the landscape and vertical feeds into one Enhanced RTMP multitrack connection to Twitch, so OBS only sends to the app. Both feeds must be online, and the destination's **Landscape feed format** and **Vertical feed format** fields must match exactly what OBS sends (for example `1920x1080@60` and `1080x1920@60`).

> [!WARNING]
> As of October 2026, Twitch currently refuses this mode. Twitch's Enhanced Broadcasting config check asks for the encoding GPU, and a relay has none, so Twitch answers with errors such as "did not send GPU Information" or "Your GPU is not supported". Twitch may also drop the stream because the relay can't re-encode or add OBS's performance metrics. Use this mode only to experiment, and use **OBS sends Dual Format directly** for real streams.

## Troubleshooting

| Problem | Check |
|---|---|
| OBS: "Failed to connect to server" | The server URL uses the NAS's LAN IP, port 1935 is mapped in the container, and no firewall blocks it. |
| OBS connects, then disconnects immediately | The stream key is wrong, was rotated, or was pasted into the wrong output (`landscape` vs `vertical`). |
| Feed shows offline on the dashboard | That OBS output isn't streaming. The vertical stream is started separately in the Vertical dock. |
| A platform rejects the stream | Video must be H.264 with a 2-second keyframe interval and AAC audio at 48 kHz. Lower the bitrate if the platform has a limit. |
| Destination stuck in "waiting for feed" | It is bound to a feed that isn't streaming. Change its feed or start that output. |
