# Web UI design system

React 19 components for the CTD Multi-Stream web UI. Import from the barrel (`import { Button, Card } from '../components'`) or from the individual files. Styling lives in `web/src/styles.css`: CSS variables, dark by default, light through `prefers-color-scheme`. There are no external fonts or CDNs, because the CSP is `'self'` only. Inline `style` attributes are allowed.

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
`<Toggle checked onChange={(next) => ...} label disabled busy size="sm|md" aria-label />` is a switch (`role="switch"`). `busy` disables it and animates the thumb while a request is in flight. With `label`, the label text is clickable too.

### Badge / StatusDot
`<Badge tone dot pulse title>{text}</Badge>` and `<StatusDot tone pulse label />`.
Tones (`Tone`): `neutral`, `info`, `success`, `warn`, `danger`, `live`, `accent`. Without a `label`, `StatusDot` is decorative.

### PlatformBadge
`<PlatformBadge platform size="sm|md|lg" withName />` is a colored circle with the platform's initial (no logos). The colors are twitch #9146FF, youtube #FF0000, kick #53FC18, facebook #1877F2, x #000, instagram #E1306C, tiktok #00F2EA and custom #888.
Helpers: `PLATFORM_META`, `platformMeta(id)` (unknown ids fall back to custom styling) and `platformName(id)`.

### PhaseBadge
`<PhaseBadge phase={DestinationPhase} />` shows a label and tone for each destination phase. For example, `live` is a red pulsing "Live", `error` is a red "Error" and `waiting-for-feed` is an amber "Waiting for feed". Helpers: `PHASE_META` and `phaseMeta(phase)`.

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

Value semantics: `onChange` receives the whole values object. A key that is absent (`undefined`) means unset. For secrets, an absent key means "keep the stored value", so send only the secrets the user typed. Secret inputs carry `autocomplete="new-password"` and password-manager ignore attributes.

Pure helpers in `dynamic-form.ts`, all exported from the barrel:

- `initialValues(fields, existing?)` applies existing values first, then defaults. Booleans default to `false`, and secrets are never prefilled.
- `validateValues(fields, values, secretsSet?)` returns `{ [key]: message }`. A stored secret counts as satisfying `required`. URLs must be http(s), rtmp(s) or srt.
- `cleanValues(fields, values)` trims strings and drops empty values.
- `coerceNumber(raw)` and `isValidUrl(raw)`.
- `destinationFormValues(fields, destination)` maps `Destination.options` and `ingestUrl` to form values, according to each field's `target`.
- `destinationSecretsSet(fields, destination | null)` returns `{ [streamKeyField]: destination.hasStreamKey }`.
- `splitDestinationValues(fields, values)` returns `{ options, ingestUrl?, streamKey? }` for `CreateDestinationRequest` / `UpdateDestinationRequest`. `streamKey` is present only when the user typed a new key.

### ChatLog
`<ChatLog messages={ChatMessage[]} compact emptyText />` is a scrolling chat list, oldest first. It sticks to the bottom while the user is there. Once the user scrolls up it shows a "N new / Jump to latest" button. Each row shows a timestamp, a `PlatformBadge`, the author and the text, all as plain text. Author colors are accepted only as hex. When the message set changes completely, for example a filter change, pass a new `key` to reset it.

### Toasts
`toast(message, { tone, durationMs })`, `toast.success/info/warn/error(message)` and `dismissToast(id)` work anywhere, with no hook needed. `<ToastProvider>`, mounted once in `App.tsx`, renders them. A repeated identical message bumps a counter instead of stacking. At most 4 are visible. `durationMs: 0` keeps a toast until it is dismissed. The store lives in `state/toast.ts`. While a modal is open, the toasts render inside the topmost one (a modal dialog makes the rest of the page inert and covers it).

### Other
- `AppShell` is the top bar (brand, live indicator, nav, user menu) plus the main area. The nav collapses to a menu below 900 px.
- `LiveIndicator` is the session status pill and shows "Reconnecting…" while the socket is down.
- `AuthLayout` is the centered card used by the sign-in and setup pages.
- `ErrorBoundary` catches a crashing page without taking down the shell. `App.tsx` resets it on every route. Lazy admin pages that fail to load after an update (missing chunk) reload the page once (`state/chunk-reload.ts`); if that fails too, the boundary offers Reload instead of Try again.
- `icons.tsx` holds small inline SVG icons (`CloseIcon`, `MenuIcon`, `LandscapeIcon`, `VerticalIcon`, `BroadcastIcon`, `ChatIcon`, `ExternalIcon`, `RetryIcon`, `ArrowDownIcon`, `ShieldIcon`).
- `format.ts` has `formatDuration`, `elapsedSeconds`, `formatBitrate`, `formatFps`, `formatResolution`, `formatCodecs`, `formatAudio`, `formatClock`, `formatDateTime` and `plural`.
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

The routes are `/`, `/chat`, `/destinations`\*, `/accounts`\*, `/settings`\*, `/profile`, `/login` and `/setup`. The ones marked \* are admin-only: `App.tsx` shows "Admins only" to operators, and `AppShell` hides them from the operator nav.

## State (`web/src/state/`)

### Auth (`auth.tsx`)
`useAuth()` returns `{ status, user, isAdmin, error, refresh, logout, signedIn, retry }`.
`status` is one of `'loading' | 'setup' | 'anonymous' | 'authenticated' | 'error'`.

On boot the app calls `api.setupStatus()`. If setup is needed it goes to `/setup`; otherwise it calls `api.me()` and either signs in or goes to `/login`. Any 401 `unauthenticated` response clears the user and redirects to `/login`. The page the user was on is remembered and restored after login; use `rememberReturnTo` and `takeReturnTo` to control this. Call `refresh()` after anything that changes the current user, for example enabling 2FA. `MIN_PASSWORD` is 10.

### Live store (`live.tsx`, logic in `live-store.ts`)
While a user is logged in, the app keeps one WebSocket open to `/api/ws`. If it drops, it reconnects with backoff (1 s, 2 s, 4 s, 8 s, then 15 s). It reconnects immediately when the network comes back or the tab becomes visible again. If a connection fails before the server's `hello`, the client calls `api.me()` first and stops if the session is gone.

| Hook | Returns |
|---|---|
| `useSession()` | `SessionState \| null`, kept current from `hello`, `session`, `feed` and `destination` messages |
| `useChat()` | `ChatMessage[]`, oldest first, the last 500, deduplicated by id |
| `useLiveStatus()` | `boolean`: socket connected |
| `useLiveConnections()` | number of successful connections (0 means still connecting) |
| `useAccountUpdates()` | `Record<accountId, Account>`, the latest pushed `account` messages |
| `useAccountsVersion()` | number that changes on every `account` message and after a reconnect; use it as a refetch dependency |
| `useDestinationsVersion()` | number that changes on `destinations-changed` and after a reconnect |
| `useLiveEvent(type, handler)` | runs the handler for each server message of that `type` |
| `useLiveActions()` | `{ applySession, seedSession, patchSession, mergeChat }`, which push REST results into the store |
| `useLiveState(selector)` | any slice of the state; the selector must return a stable reference |

`notice` messages are shown as toasts automatically.

Example (accounts page refetch):

```tsx
const version = useAccountsVersion();
const accounts = useApi(() => api.accounts(), [version]);
useLiveEvent('account', (m) => { if (m.account.status === 'connected') toast.success(`${m.account.label} connected`); });
```

### Hooks (`hooks.ts`)
- `useApi(fetcher, deps)` returns `{ data, error, loading, reload, setData }`. It reloads when `deps` change, ignores stale responses and keeps the old data while reloading.
- `useDestinations()` is `useApi(api.destinations)` that refetches on `useDestinationsVersion()`.
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
