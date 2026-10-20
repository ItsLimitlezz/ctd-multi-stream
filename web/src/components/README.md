# Web UI design system

React 19 components for the CTD Relay web UI. Import from the barrel (`import { Button, Card } from '../components'`) or from the individual files. Styling lives in `web/src/styles.css`: CSS variables, dark by default, light through `prefers-color-scheme`. There are no external fonts or CDNs, because the CSP is `'self'` only. Inline `style` attributes are allowed.

Rules for pages:

- Talk to the server only through `web/src/api.ts`.
- Render user-supplied text as plain React text nodes. Never use `dangerouslySetInnerHTML`.
- Run URLs from the server through `safeHttpUrl()` before putting them in an `href`.
- Report errors with `toast.error(errorMessage(err))` (`errorMessage` is in `state/errors.ts`).

## Components

### Button
`<Button variant size loading icon block {...buttonProps}>`

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'danger' \| 'ghost'` | `'secondary'` | |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | |
| `loading` | `boolean` | `false` | Shows a spinner and disables the button. |
| `icon` | `ReactNode` | | Shown before the label. |
| `block` | `boolean` | `false` | Full width. |

`type` defaults to `"button"`, so pass `type="submit"` in forms. `buttonClass(variant, size, block)` returns the class names, which lets other elements look like buttons, for example `<Link to="/x" className={buttonClass('primary')}>`.

### ConfirmButton
A two-step button. The first click arms it and shows `confirmLabel`. A second click within `timeoutMs` runs `onConfirm`. Escape disarms it.
Props: all `Button` props except `onClick`, plus `onConfirm: () => void | Promise<unknown>` (the spinner shows until the promise settles, and the function must handle its own errors), `confirmLabel` (default "Click again to confirm"), `confirmVariant` (default `'danger'`), `timeoutMs` (default 4000), and `loading`.

### Card
`<Card title subtitle actions flush className {...sectionProps}>{children}</Card>` renders a `<section>`. `actions` sits at the right of the header. `flush` removes the body padding, for lists and chat logs.

### Field
`<Field label help error id required inline hideLabel>{control}</Field>` wraps a label, help text and error around one control. It sets up `id`, `aria-describedby`, `aria-invalid` and `aria-required` for a `TextInput`, `Select` or `Toggle` placed inside it, through context (`useFieldControl()`). An `id` is generated when omitted. `inline` puts the label and control on one row, which suits toggles. `hideLabel` keeps the label for screen readers only.

### TextInput
`<TextInput invalid mono onValueChange {...inputProps} />` is a native `<input>`. `onValueChange(value: string)` is a convenience callback that runs alongside the native `onChange`. `mono` sets a monospace font. Accepts `ref`.

### Select
`<Select options={[{ value, label, disabled? }]} value onValueChange placeholder invalid {...selectProps} />`. `placeholder` adds a first option with the value `''`.

### Toggle
`<Toggle checked onChange={(next) => ...} label disabled busy size="sm|md" aria-label aria-labelledby aria-describedby />` is a switch (`role="switch"`). `busy` disables it and animates the thumb while a request is in flight. With `label`, the label text is clickable too, and the switch is named by it through `aria-labelledby` (a switch inside a `<label>` doesn't reliably get its name from it). `aria-describedby` defaults to the surrounding `Field`'s help/error.

### Badge / StatusDot
`<Badge tone dot pulse title>{text}</Badge>` and `<StatusDot tone pulse label />`.
Tones (`Tone`): `neutral`, `info`, `success`, `warn`, `danger`, `live`, `accent`. Without a `label`, `StatusDot` is decorative.

### PlatformBadge
`<PlatformBadge platform size="sm|md|lg" withName />` is a colored circle with the platform's initial (no logos). The colors are twitch #9146FF, youtube #FF0000, kick #53FC18, facebook #1877F2, x #000, instagram #E1306C, tiktok #00F2EA and custom #888.
Helpers: `PLATFORM_META`, `platformMeta(id)` (unknown ids fall back to custom styling) and `platformName(id)`.

### PhaseBadge
`<PhaseBadge phase={DestinationPhase} />` shows a label and tone for each destination phase. For example, `live` is a red pulsing "Live", `error` is a red "Error", `waiting-for-feed` is an amber "Waiting for feed" and `recovering` (the platform ended the live, e.g. a copyright takedown, and a fresh one is being created) is an amber pulsing "Recovering". Helpers: `PHASE_META` and `phaseMeta(phase)`.

On the dashboard, `recovering` counts as active but not live ("1 of 2 destinations live · 1 recovering"), has no Retry button, and a card with `recoveries > 0` shows "Recovered 2× · last: <reason> <time ago>" (`recoverySummary(state, now)` in `DashboardPage.tsx`).

Also on the dashboard (helpers in `pages/dashboard-helpers.ts`):

- **Test mode:** a labelled switch next to Go live (`PUT /api/session/test-mode`), locked while a session runs. While on, an orange banner lists every enabled destination with what happens there (`testModePlan` / `testModeSummary`, from `PlatformInfo.testMode`; Facebook depends on the account type, resolved from the account for admins; a Facebook destination without an account, or whose account was deleted, is skipped like the server does), skipped destinations show "Skipped in test mode", and supported ones "Private test".
- **Viewers:** live destination cards show `DestinationState.viewers` when the platform reports it, and the status card shows the sum of the known counts (`destinationViewers`, `totalViewers`, `formatViewers`); unknown counts are hidden, never shown as 0.

Settings → **API** (`pages/settings/ApiTab.tsx`, helpers in `state/hub.ts`):

- **App pairing:** pending requests ("CTD OBS plugin wants to connect", from WS `pairings` + `GET /api/pairings`) with the app's code, requested profile/scopes, IP and expiry. A single request (or the one named by `?pair=<id>`, the app's `approveUrl`) opens straight into the approve form: token name, **Profile** (each profile or "Every profile", starting from what the app asked for; a removed profile falls back to the default one) and the permissions (requested ones tagged; `ingest:read` shows a stream-key warning). Approve / Deny / Later. `PairingBanner` repeats it on every page for admins.
- **Tokens:** list (with the profile each is limited to, or "Every profile" for tokens from before profiles) and revoke; new tokens pick a **Profile** (default: the one on screen) and start with `chat:read` + `status:read` only (`DEFAULT_TOKEN_SCOPES`). The secret is shown once, masked, in a modal that only closes with Done and can't close while the token is being created (`tokenModalReducer`).
- **Connected apps:** every registered app (WS `apps` + `GET /api/apps`) with online/offline, kind, version, its token's profile, a safe "Open app" link and its resources grouped by profile ("DPRTMNT: 2 overlays (…)", `groupResources`); Remove unregisters it (revoking the token disconnects it for good).
- **OBS dock:** one link per profile (profile picker when there are several; the token is limited to that profile and named "OBS dock — <profile>"); `dockUrl(access, secret)`: LAN base when known, else the HTTPS base; token in the URL fragment.
- Connection details with Copy buttons, and how pairing works.

### Modal
`<Modal open onClose title footer size="sm|md|lg" dismissible>{children}</Modal>` uses the native `<dialog>` element, so the focus trap, Escape and top-layer stacking come from the browser. Children mount only while the modal is open, so forms inside start fresh each time. Clicking the backdrop closes it when `dismissible` is set (the default). With `dismissible={false}`, Escape is stopped at keydown; if the browser still forces a close (Android back, a repeated Escape), the dialog is shown again. A dismissible modal closed by the browser calls `onClose`, so React state and the DOM never disagree. Open modals are tracked in `state/modal-stack.ts`.

### Spinner
`<Spinner size="sm|md|lg" label />`. Pass `label={null}` when the parent already says it is busy, for example a button with `aria-busy`.

### EmptyState
`<EmptyState icon title description action />`

### Tabs / TabPanel
`<Tabs tabs={[{ id, label, badge?, disabled? }]} value onChange idPrefix aria-label />` is an accessible tab list. Arrow keys, Home and End move between tabs and select them. Render the panel yourself with `<TabPanel idPrefix id>...</TabPanel>`, which sets the ARIA wiring through `tabId()` and `panelId()`. Settings sub-tabs use `?tab=`: read it with `useQuery().get('tab')` and change it with `setQuery({ tab })`.

### CopyField
`<CopyField value label help secret mono id />` shows a read-only value with a Copy button. `secret` masks the value until "Show" is pressed, and Copy always copies the real value. Plain-HTTP (non-secure) origins fall back to `execCommand('copy')`.

### DynamicForm
`<DynamicForm fields={FieldSpec[]} values onChange secretsSet errors disabled idPrefix />` renders the driver-described fields from `shared/types` as a controlled form:

| `FieldSpec.type` | Control |
|---|---|
| `text` | text input |
| `url` | `type="url"` input, monospace |
| `number` | text input with a decimal keypad; the value becomes a `number`, and invalid text stays a string so validation can flag it |
| `select` | `Select` with `options` (plus an empty choice unless the field is required and has a default) |
| `boolean` | `Toggle` |
| `secret` | password input with Show/Hide. When `secretsSet[key]` is true it shows **"•••• set"** with a **Change** button, and Cancel returns to "set". |
| `links` | `LinksEditor`: an ordered list of Title + URL rows with Add link, Remove and Move up/down; value is `LinkItem[]` |

Value semantics: `onChange` receives the whole values object. A key that is absent (`undefined`) means unset. For secrets, an absent key means "keep the stored value", so send only the secrets the user typed. Secret inputs carry `autocomplete="new-password"` and password-manager ignore attributes. A `links` value is always an array (it may hold blank rows while editing); it is sent as an array, never stringified.

Pure helpers in `dynamic-form.ts`, all exported from the barrel:

- `initialValues(fields, existing?)` applies existing values first, then defaults. Booleans default to `false`, links to the stored array (`[]` when missing or not an array), and secrets are never prefilled.
- `validateValues(fields, values, secretsSet?)` returns `{ [key]: message }`. A stored secret counts as satisfying `required`. URLs must be http(s), rtmp(s) or srt. Links: at most `LINKS_MAX` (20) non-blank rows, title 1–`LINK_TITLE_MAX` (100) characters, URL absolute http(s) of at most `LINK_URL_MAX` (2048) characters; the message names the row ("Link 2: URL must start with http:// or https://").
- `cleanValues(fields, values)` trims strings and drops empty values. A links field always yields its list, trimmed with blank rows dropped (`[]` clears the stored list on update).
- Links helpers: `toLinkItems(value)` (defensive read of an option value), `cleanLinks`, `isBlankLink`, `isHttpUrl`, `linkRowErrors(row)`, `validateLinks(field, value)`, and the immutable row edits `addLinkRow`, `removeLinkRow`, `moveLinkRow(list, index, ±1)`, `updateLinkRow`.
- `coerceNumber(raw)` and `isValidUrl(raw)`.
- `destinationFormValues(fields, destination)` maps `Destination.options` and `ingestUrl` to form values, according to each field's `target`.
- `destinationSecretsSet(fields, destination | null)` returns `{ [streamKeyField]: destination.hasStreamKey }`.
- `splitDestinationValues(fields, values)` returns `{ options, ingestUrl?, streamKey? }` for `CreateDestinationRequest` / `UpdateDestinationRequest`. `streamKey` is present only when the user typed a new key.

### LinksEditor
`<LinksEditor id label help error required value={LinkItem[]} onChange disabled />` is the `links` control on its own (a `role="group"` labelled by `label`). Row inputs get ids `${id}-<n>-title` / `${id}-<n>-url` and labels "Link n title" / "Link n URL". Rows keep stable keys, so focus follows a row when it moves; adding focuses the new title and removing focuses the neighbouring row (or Add link). While `error` is set, rows with a problem get a red border and their own message. Add link is disabled at `LINKS_MAX` rows. Stacked inputs keep it usable at 375 px.

### AlertToggle
`<AlertToggle label help />` is the "Alert me" switch (on the dashboard status card; the Profile page has the full Alerts card with "Read alerts aloud", the notification permission state and Test alert). `useAlertToggle()` returns `{ enabled, prefs, busy, setEnabled }`. Enabling runs `enableAlerts()` inside the click: it unlocks audio, plays a short chime and asks for notification permission, then toasts what works (`alertsEnabledMessage(status)`).

### ChatLog
`<ChatLog messages={ChatMessage[]} compact emptyText />` is a scrolling chat list, oldest first. It sticks to the bottom while the user is there. Once the user scrolls up it shows a "N new / Jump to latest" button; the count stays right when moderation removes messages (`countNewMessages(messages, prevLast)`). Each row shows a timestamp, a `PlatformBadge`, the author and the text, all as plain text. Author colors are accepted only as hex. When the message set changes completely, for example a filter change, pass a new `key` to reset it.

- **Alerts:** a `kind: 'event'` line with an `alert` (sub, gift, cheer, Kicks, raid, membership, Super Chat, tip, follow) gets a tinted row (`is-alert alert-<kind>`) and a tag with an icon, the label, the amount and the tier ("Subscription · 12 months · Tier 1", "Super Chat · $5.00").
- **Emotes:** when `fragments` add up exactly to `text`, emotes render as `<img>` (https URLs only, `referrerpolicy="no-referrer"`, the emote name as `alt`) and mentions in bold; otherwise the plain text is shown.
- `/me` lines (`action`) are italic in the author's color; `highlighted` messages get an accent stripe.

### Chat formatting (`chat-format.ts`)
Pure helpers, all exported from the barrel: `messageAlert(m)` (the alert of an event line, or null), `alertParts(alert)` / `alertSummary(alert)`, `formatAlertAmount(alert)` ("12 months", "5 gifts", "1,500 bits", "100 Kicks", "42 viewers"), `formatMoney(value, currency, locale?)` (ISO 4217 code + decimal string, formatted with `Intl.NumberFormat` from the string itself, so no float rounding; invalid input comes back as "value CUR"), `formatTier(tier)` ("1000" → "Tier 1", "Prime"), `chatSegments(m)`, `safeImageUrl(url)` and `ALERT_KINDS` / `ALERT_LABEL`.

### Toasts
`toast(message, { tone, durationMs })`, `toast.success/info/warn/error(message)` and `dismissToast(id)` work anywhere, with no hook needed. `<ToastProvider>`, mounted once in `App.tsx`, renders them. A repeated identical message bumps a counter instead of stacking. At most 4 are visible. `durationMs: 0` keeps a toast until it is dismissed. The store lives in `state/toast.ts`. While a modal is open, the toasts render inside the topmost one (a modal dialog makes the rest of the page inert and covers it).

### Profiles (`ProfileSwitcher.tsx`, `ProfileBadge.tsx`, `PairingBanner.tsx`)
- `ProfileSwitcher` (top bar): "● DPRTMNT ▾" with the profile's colour; a red dot when another profile is live; the menu (`role="menu"`, `menuitemradio`, arrow keys) lists every profile with LIVE / Starting / test mode and "Manage profiles" for admins. `ProfileSwitcherView` is the prop-driven version (tests).
- `LiveProfilesIndicator`: "2 live: Miami or Bust · DPRTMNT" (just "2 live" below 1440 px, hidden below 560 px) whenever several profiles are live or the live one isn't on screen.
- `ProfileDot` (colour dot, hollow ring without a colour; only `#RRGGBB` reaches a style), `ProfileStatusBadge`, `ProfileTag` ("Profile: ● DPRTMNT", on every profile-scoped page and tab).
- The current profile's colour underlines the top bar (`--profile-color`).
- `PairingBanner`: admins see "<app> wants to connect (code …) · Review" on every page except Settings → API.

### Other
- `AppShell` is the top bar (brand, profile switcher, live indicators, nav, user menu) plus the main area. The nav collapses to a menu below 1100 px; the brand text and user name hide below 1360 px, the brand below 480 px.
- `LiveIndicator` is the session status pill and shows "Reconnecting…" while the socket is down.
- `TestModeIndicator` is the orange "TEST MODE" pill (just "TEST" below 480 px) shown in the top bar on every page while `session.testMode` is on.
- `AuthLayout` is the centered card used by the sign-in and setup pages.
- `ErrorBoundary` catches a crashing page without taking down the shell. `App.tsx` resets it on every route. Lazy admin pages that fail to load after an update (missing chunk) reload the page once (`state/chunk-reload.ts`); if that fails too, the boundary offers Reload instead of Try again.
- `icons.tsx` holds small inline SVG icons (`CloseIcon`, `MenuIcon`, `LandscapeIcon`, `VerticalIcon`, `BroadcastIcon`, `ChatIcon`, `ExternalIcon`, `RetryIcon`, `ArrowDownIcon`, `ShieldIcon`, `ChevronUpIcon`, `ChevronDownIcon`, `PlusIcon`, `TrashIcon`, `BellIcon`, `EyeIcon` (viewers), `FlaskIcon` (test mode), `KeyIcon` (API tokens), and for chat alerts `HeartIcon`, `StarIcon`, `GiftIcon`, `GemIcon`, `BoltIcon`, `UsersIcon`, `CrownIcon`, `CoinIcon`).
- `format.ts` has `formatDuration`, `elapsedSeconds`, `formatBitrate`, `formatFps`, `formatResolution`, `formatCodecs`, `formatAudio`, `formatClock`, `formatDateTime`, `formatAgo` ("just now", "3 min ago"; never in the future) and `plural`.
- `utils.ts` has `cx(...)`, `safeHttpUrl(url)`, `safeHexColor(color)` and `copyText(text)`.

## Router (`web/src/router.tsx`)

The router has no dependencies and is based on `pushState`.

- `navigate(to, { replace? })` navigates within the app.
- `<Link to replace {...anchorProps}>` behaves like a normal link: modifier clicks and `target="_blank"` still work.
- `useRoute()` returns `{ name, path, label, adminOnly, pathname, search }`.
- `useQuery()` returns a `URLSearchParams`.
- `setQuery({ key: value | null }, { replace = true })`.
- `buildSearch(record)` and `ROUTES`.
- `matchRoute(path)` sends unknown paths to the dashboard.

The routes are `/`, `/chat`, `/destinations`\*, `/accounts`\*, `/settings`\*, `/profiles`\* (streaming profiles; not in the main nav: reached from the switcher and Settings), `/profile` (the signed-in user's own page), `/login` and `/setup`. The ones marked \* are admin-only: `App.tsx` shows "Admins only" to operators, and `AppShell` hides them from the operator nav.

**Sticky parameters:** `?profile=` follows the user: `navigate()` and `<Link>` (including its `href`, for new tabs) keep the current value when the target doesn't set one (`withStickyParams`). `setQuery` merges into the current query, so it can remove it on purpose.

## Profiles (`state/profile.tsx`, logic in `state/profiles.ts`)

A profile is an independent streaming set-up (accounts, destinations, title, OBS keys, test mode, chat); several can be live at once. Developer apps, users, settings, HTTPS, API tokens and audit are shared.

- `ProfileProvider` (inside `AuthProvider`, around `LiveProvider`) loads `GET /api/profiles` at login (retrying with backoff) and then follows the live socket (`hello.profiles`, `profiles` messages).
- **Current profile:** `?profile=<id>` in the URL; without it, the last profile used in this browser (`localStorage` `ctd.profile`, every access in try/catch); unknown or deleted ids fall back to it, then to the default profile (`resolveProfileId`). Once the list is known the URL is kept in line (the parameter is left out on an install with only the default profile).
- Hooks: `useProfileContext()` → `{ profiles, profileId, current, ready, select(id, to?), refresh(), apply(list) }`, plus `useProfiles()`, `useProfileId()`, `useCurrentProfile()`. Outside a provider (static renders) it is the default profile (`STATIC_PROFILE_CONTEXT`).
- Every profile-scoped call passes the profile: `api.session/startSession/stopSession/setTitle/setAutoGoLive/setTestMode/destinations/accounts/ingest/rotateIngestKey/recentChat/overlay/rotateOverlay(…, profileId)` send `?profile=`; `createAccount` / `createDestination` send `profileId` in the body (the forms use `useProfileId()`). Routes on one id (`/api/destinations/:id`, …) need no profile.
- `App.tsx` keys each page by route **and profile**, so switching starts the page fresh, and waits for the list (`ready`) before rendering pages.
- `/profiles` (`pages/ProfilesPage.tsx`): every profile with colour, status, counts, OBS key prefix and set-up links; create (name + colour; then "next steps"), rename/recolour (the slug and OBS keys never change), delete (disabled with the reason for the default profile and while its session isn't offline).

## State (`web/src/state/`)

### Auth (`auth.tsx`)
`useAuth()` returns `{ status, user, isAdmin, error, refresh, logout, signedIn, retry }`.
`status` is one of `'loading' | 'setup' | 'anonymous' | 'authenticated' | 'error'`.

On boot the app calls `api.setupStatus()`. If setup is needed it goes to `/setup`; otherwise it calls `api.me()` and either signs in or goes to `/login`. Any 401 `unauthenticated` response clears the user and redirects to `/login`. The page the user was on is remembered and restored after login; use `rememberReturnTo` and `takeReturnTo` to control this. Call `refresh()` after anything that changes the current user, for example enabling 2FA. `MIN_PASSWORD` is 10.

### Live store (`live.tsx`, logic in `live-store.ts`)
While a user is logged in, the app keeps one WebSocket open to `/api/ws?profile=<current profile>`; switching profile closes it and opens one for the new profile (`store.startProfile(id)` clears session, chat and accounts but keeps pairings and connected apps, which are shared). Session, feed, destination and chat messages stamped with another profile are ignored, and REST results pushed through `useLiveActions()` are bound to the profile on screen when the hook ran, so an answer arriving after a switch is dropped. If it drops, it reconnects with backoff (1 s, 2 s, 4 s, 8 s, then 15 s). It reconnects immediately when the network comes back or the tab becomes visible again. If a connection fails before the server's `hello`, the client calls `api.me()` first (and re-checks the profile list, in case the profile was deleted) and stops if the session is gone. Admins reload pending pairings (`GET /api/pairings`) on every `hello`.

| Hook | Returns |
|---|---|
| `useSession()` | `SessionState \| null`, kept current from `hello`, `session`, `feed` and `destination` messages; `null` while the store still holds another profile (the first render after a switch), so REST fallbacks run |
| `useChat()` | `ChatMessage[]`, oldest first, the last 500, deduplicated by id, without messages removed by moderation; empty while the store still holds another profile |
| `useLiveStatus()` | `boolean`: socket connected |
| `useLiveSocketReady()` | `boolean`: the socket of the profile on screen is connected (use it to decide whether a REST fallback is needed) |
| `useLiveConnections()` | number of successful connections (0 means still connecting) |
| `useAccountUpdates()` | `Record<accountId, Account>`, the latest pushed `account` messages |
| `useAccountsVersion()` | number that changes on every `account` message and after a reconnect; use it as a refetch dependency |
| `useDestinationsVersion()` | number that changes on `destinations-changed` and after a reconnect |
| `usePairings()` | pending app pairings (every profile), `null` until loaded |
| `useConnectedApps()` | connected apps (every profile), `null` until loaded |
| `useLiveEvent(type, handler)` | runs the handler for each server message of that `type` |
| `useLiveActions()` | `{ applySession, seedSession, patchSession, mergeChat, loadPairings, loadApps }`, which push REST results into the store (a REST list never replaces a newer pushed one) |
| `useLiveState(selector)` | any slice of the state; the selector must return a stable reference |

`notice` messages are shown as toasts automatically, and passed to `alertForNotice` (below).

The socket only carries the current profile's notices, so **other live profiles** are watched through successive `profiles` pushes (`profileAlerts` in `profiles.ts`): more destinations down on another streaming profile → a `warn` toast + alert naming it ("DPRTMNT · 1 destination down. Switch to DPRTMNT to see which."); all back → an `info` toast + chime; live → offline without passing through `stopping` → an `info` toast only. The baseline is reset on every `hello` (connect, reconnect, profile switch), so nothing stale is replayed. If the server ever stamps notices with a `profileId` and sends them to every socket, a summary alert for a profile that had its own notice in the last 15 s is skipped.

`chat-moderation` messages remove chat, always within the moderated destination: `message-deleted` drops one message (by hub id, `platformMessageId`, or the derived `<platform>:<id>`), `user-cleared` drops that user's messages (ids win when both sides have one, else display name or login, case-insensitively, like the server), `cleared` drops the destination's whole chat. The removed ids (last 1000, `removedChat`) are remembered so a history snapshot taken before the removal (REST `recentChat`, a reconnect's `hello`) can't bring them back. Pure helpers: `applyModeration`, `moderationRemoves`, `messageFromUser`, `rememberRemoved`.

Moderation that happens while the socket is down only shows up as messages missing from the next `hello`, so a `hello` is reconciled rather than just merged (`reconcileChat`): a snapshot shorter than `HELLO_CHAT_LIMIT` (200, what the server sends) is the server's whole buffer, so every held message missing from it is dropped (after a server restart that clears the chat, like a reload would). A full snapshot is only the newest messages, so a held message is dropped only when it is clearly inside that window: newer than the destination's oldest snapshot message, or for a destination with nothing in the snapshot, newer than the snapshot's first messages. These drops are not added to `removedChat`.

### Alerts (`alerts.ts`)
Opt-in, per-browser alerts for `notice` messages, e.g. "Instagram ended the live (copyright). Starting a new one…" and "Instagram is live again (recovery #1)". While on, `warn`/`error` notices play an alarm and `info` notices a gentle chime, both generated with the Web Audio API (no audio files, nothing external, so the CSP is unaffected), and each shows a browser `Notification` when permission is granted (only on HTTPS or localhost; `notificationStatus()` returns `'insecure'` otherwise, and `notificationHint(status)` explains it). "Read alerts aloud" also speaks the notice with `speechSynthesis`.

- The preference `{ enabled, speak }` lives in `localStorage` under `ctd.alerts`. Every access is wrapped in try/catch, so blocked storage only means the setting isn't remembered. `useAlertPrefs()`, `getAlertPrefs()`, `setAlertPrefs(patch)`; other tabs follow through the `storage` event.
- Browsers start audio only after a user gesture: `enableAlerts()` unlocks it in the click, and `installAlerts()` (installed by `LiveProvider`, which also follows changes from other tabs) unlocks it on the first click or key press after a reload. A sound that can't start within 3 s is dropped rather than played late.
- Identical notices from several open tabs share a notification `tag`, so they show once. `error` notifications stay until dismissed.
- Android browsers refuse `new Notification()` from a page ("Illegal constructor"); only a service worker can show one. `installAlerts()` registers `web/public/sw.js` (served at `/sw.js`) on secure origins. It only handles `notificationclick` (focus the tab, or open `/`) and has no fetch handler, so nothing is cached or intercepted. While it runs, `showAlertNotification` goes through `registration.showNotification()` and returns `true` once it has handed the notification over; otherwise it uses the constructor. Chrome refuses to register a service worker on a self-signed certificate, so on Android `notificationStatus()` returns `'unavailable'` (detected from the user agent, never by creating a test notification) until the worker runs, and the UI says "sound only". A constructor that throws a `TypeError` anywhere sets `'unavailable'` too. `useNotificationStatus()` re-renders on our own permission prompts, on the worker starting and on that refusal. This is not Web Push: a phone that pauses or closes the tab gets no alert, so the Profile page tells phone users to keep the tab open and on screen.
- Pure, injectable helpers for tests: `parseAlertPrefs`, `readAlertPrefs(storage)`, `writeAlertPrefs(prefs, storage)`, `notificationStatus(env)` (`env.worker` / `env.workerOnly` model the service worker), `notificationsNeedWorker(navigator)`, `requestNotificationPermission(env)`, `showAlertNotification(level, message, env)`, `startAlertWorker(container)`, `soundForLevel`, `alertPattern`, `schedulePattern(ctx, steps)`, `alertForNotice(level, message, prefs, outputs)` and `testAlert(outputs)`.

Example (accounts page refetch):

```tsx
const version = useAccountsVersion();
const accounts = useApi(() => api.accounts(), [version]);
useLiveEvent('account', (m) => { if (m.account.status === 'connected') toast.success(`${m.account.label} connected`); });
```

### Hooks (`hooks.ts`)
- `useApi(fetcher, deps)` returns `{ data, error, loading, reload, setData }`. It reloads when `deps` change, ignores stale responses and keeps the old data while reloading.
- `useDestinations()` is `useApi(api.destinations)` for the current profile that refetches on `useDestinationsVersion()` and on a profile change.
- `useNow(intervalMs | null)` returns the current time in milliseconds, updated on an interval, for elapsed timers.

### Errors (`errors.ts`)
- `errorMessage(err)` returns a short user-facing message. It covers server messages, CSRF, forbidden and unreachable-server errors.
- `isApiError(err, status?, code?)`.
- `loginErrorMessage(err, totpSent)` and `setupErrorMessage(err)`.

## Tests

The root `vitest.config.ts` only includes `server/` and `shared/`, so run the web tests through the Vite config:

```
npx vitest run --config vite.config.ts
```

## BrowserViewer

`<BrowserViewer accountId onClosed label className />` shows an account's server-side Playwright page live and lets the user control it (used for manual logins, 2FA and captchas). It is not exported from the barrel; import it from `./BrowserViewer`. Its styles are in `browser-viewer.css`, which the component imports.

- It connects to `WS /api/browser/<accountId>/ws` (`BrowserServerMessage` / `BrowserClientMessage` in `shared/api.ts`). Call `api.browserOpen(accountId, url)` before mounting it and `api.browserClose(accountId, save)` when done; the component only streams and relays input.
- Frames are JPEGs drawn on a `<canvas>` scaled to the container width. Client coordinates are converted to page coordinates from the canvas' displayed size and the frame's `width`/`height`.
- Mouse moves are throttled to about 30 per second. Down/up carry the button and the click count from `event.detail`, and wheel deltas are converted to pixels and coalesced. While a button is held the mouse is followed outside the canvas.
- Keyboard input is relayed only while the page area (`tabIndex=0`, `role="application"`) has focus. Modifiers use the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). Ctrl/Cmd+V is left to the browser so the local clipboard arrives as a `paste` event and is sent as `{ type: 'type' }`. Keys still held when focus leaves are released. Escape pressed twice within a second (or held) is not relayed the second time: it moves focus out of the page area, so keyboard users are never trapped (Tab goes to the remote page).
- Touch: a tap is a click (a double tap is a double click) and a drag scrolls the page. The keyboard button opens a "type text" row with Enter, Tab and Backspace for phones.
- The toolbar has Back, Reload, an address field (http(s) only; a bare host gets `https://`), the connection status and the page title.
- The remote viewport follows the container: its width, and 60% of the window height, clamped to 320–1920 × 320–1200, debounced.
- A `closed` message or a dropped socket shows the reason with a Reconnect button. `error` messages, such as a failed navigation, show as a dismissible notice.
- The socket opens one tick after mount, so React StrictMode's double mount doesn't open two connections. Everything is cleaned up on unmount.
- A `.modal-lg` containing a viewer widens to 1180 px.

Pure helpers are exported for tests: `toFrameCoords`, `cdpModifiers`, `keyMessage`, `isPasteShortcut`, `isReleaseEscape`, `wheelPixels`, `clampViewport`, `viewportFor`, `normalizeAddress`, `parseBrowserMessage`, `closeMessage`, `mouseButton` and `clickCount`.
