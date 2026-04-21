# Bridge Session Indicator — UX Spec

> Owner: ClippyArch · Implementer: ClippyEng (CLI-142) · Spec source: ADR-0005 §8 · Status: Accepted, rides CLI-37 / CLI-11 merge

## 0. Scope

Visual + interaction contract for the renderer surface that tells a user a **bridge session** (per ADR-0005) is active, what it can do, and how to revoke it. Two artifacts:

1. **`<BridgeSessionBadge />`** — persistent status-strip element.
2. **`<BridgeSessionDetail />`** — on-demand detail panel rendered inside the existing `SidePanel` primitive (no new shell).

Out of scope: backend bridge state, token verification, audit-log rendering. Those are owned by ADR-0005 §1–§7 and CLI-103/CLI-143.

---

## 0.1. Web-app implementation mapping (addendum 2026-04-21)

This spec inherits Electron-flavoured vocabulary from ADR-0005 ("renderer", "main process", "IPC channel"). Paperclip is a web app, not Electron. Translate as follows — this addendum is authoritative and overrides the prose (not the file paths in §9) wherever they conflict:

| Spec term                               | Real Paperclip surface                                                                                                                   |
|-----------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| "renderer" / "renderer-side"            | The React UI in `ui/` (Vite app).                                                                                                         |
| "main process"                          | The Paperclip server (`server/`), plus the `copilot-local` adapter that writes bridge-audit rows per ADR-0005.                           |
| "IPC channel"                           | A `LiveEvent.kind` on the existing server→UI WebSocket stream consumed by `ui/src/context/LiveUpdatesProvider.tsx`. No Electron IPC.     |
| `bridge:session-state`                  | `LiveEvent.kind = "bridge.session_state"` (full snapshot, debounced 250ms on the server before emit).                                    |
| `bridge:deny-flash`                     | `LiveEvent.kind = "bridge.deny_flash"` (one message per audit row; **never coalesced server-side or client-side** — see §4).              |
| `bridge:revoke` IPC                     | `POST /api/companies/:companyId/bridge-sessions/:jti/revoke` (REST, auth = board operator). Optimistic-UI rules in §6 are unchanged.    |
| "status strip"                          | The top-of-window bar rendered by `ui/src/components/BreadcrumbBar.tsx`. Slot the badge immediately left of the existing `GlobalToolbarPlugins` outlet; that outlet is the spec's "connection-pill group" anchor. |
| `<SidePanel>` primitive                 | `ui/src/components/ui/sheet.tsx` (`<Sheet />`, `<SheetContent side="right">`). "360px SidePanel" ⇒ `SheetContent` with `className="w-[360px] sm:max-w-[360px]"`. |
| `<ConfirmDialog />`                     | `ui/src/components/ui/dialog.tsx`. Build a thin `ConfirmDialog` wrapper co-located with `BridgeSessionDetailPanel.tsx`; do not introduce a new global primitive for this work. |
| "main-process audit-log write path"     | The `copilot-local` adapter's bridge-audit emitter (CLI-103). It publishes `bridge.deny_flash` LiveEvents over the same publisher used for `activity.*`. If that emitter does not yet exist on the copilot-local branch, file a blocker sub-issue on CLI-103 — do **not** fake it from a debounced snapshot diff. |

### 0.1.1 Implementation base — greenfield, no hidden branch

There is no pre-existing "renderer shell" to extend. All files listed in §9 are **new**. Cut the implementation branch directly off `master` at the latest canary tag (e.g. `canary/v2026.420.0-canary.11`, commit `1266954a` or later). Do **not** branch off `feat/copilot-local-adapter`; instead, declare a dependency on the `bridge.deny_flash` LiveEvent kind and land stubs + fixture-driven tests. The copilot-local adapter merge will flow in via ADR-0005.

Minimum files to create, in dependency order:

1. `ui/src/ipc/bridgeChannels.ts` — zod schemas + a `useBridgeLiveEvents()` hook that subscribes to `bridge.session_state` and `bridge.deny_flash` via the existing `LiveUpdatesProvider` context. The two kinds **must** be handled by separate subscriptions so the deny-flash path cannot be accidentally folded into the debounced snapshot reducer.
2. `ui/src/state/bridgeSession.ts` — store + selectors (§5 shape). Computes `kind` from `exp` vs `Date.now()` on the animation frame.
3. `ui/src/components/status-strip/BridgeSessionBadge.tsx` (+ `.module.css`, feature-flag-gated).
4. `ui/src/components/status-strip/BridgeSessionDetailPanel.tsx` (uses `Sheet`).
5. Slot into `BreadcrumbBar.tsx` directly before the `<GlobalToolbarPlugins … />` block; gate render behind the bridge feature flag so feature-off users get zero DOM.
6. Storybook stories per §9, including the "rapid double deny" interaction story.

### 0.1.2 Feature flag

Use the existing company-scoped feature-flag plumbing (whatever `useFeatureFlag` / `useCompanyConfig` hook the codebase already exposes — pick the one used by `PluginLauncherOutlet`). Flag key: `bridge.session_indicator.v1`. Default off. No new flag infrastructure.

### 0.1.3 Revoke endpoint contract

Until the server endpoint lands, stub the revoke call behind a typed `revokeBridgeSession(jti)` client in `ui/src/api/bridge.ts` that hits the REST path above and returns `{ ok: true } | { ok: false, error: string }`. §6's optimistic-UI + 2s rollback rules apply unchanged. If the server endpoint is not merged by the time CLI-142 is ready to review, ship the client + mock handler for tests and file a follow-up sub-issue — do not block on it.

---

## 1. Placement

The badge lives in the top-of-window **status strip**, immediately to the **left of the connection pill**.

Strip grammar (left → right):

```
[ env badge ] · [ connection pill ] · [ bridge badge ]   ← new, leftmost of the bridge group
```

Rationale: bridge state is a security signal, not a connectivity signal — keeping it adjacent but distinct from the connection pill prevents users from conflating "online" with "trusted bridge active". No re-layout of the existing strip is required; the badge slots in beside the existing flex row.

When `state === 'idle'` the slot is collapsed (display: none, not visibility: hidden) so the strip width does not jitter on mount.

---

## 2. Component anatomy

### 2.1 `<BridgeSessionBadge />`

```
┌─────────────────────────────────────────────┐
│  ⚡  Bridge · cap-2af9 · 3 caps   ⏱ 4:12     │
└─────────────────────────────────────────────┘
   ^   ^       ^         ^         ^
   |   |       |         |         └── time-to-expiry (mm:ss), shown only when state ∈ {amber, expiring}
   |   |       |         └── live capability count, "99+" above 99
   |   |       └── short session id (first 4 hex of `jti`)
   |   └── label
   └── leading icon (state-driven, see §3)
```

- **Height:** 24px (matches the connection pill exactly — measure once, share the token).
- **Padding:** 0 8px horizontal.
- **Corner radius:** 12px (full pill, matches connection pill).
- **Font:** `--font-ui-xs` (12px / 16px line-height), `--font-weight-medium` for the label and id, `--font-weight-regular` for the count and timer.
- **Min width:** content-driven; truncate `cap-XXXX` first, then drop the timer, then drop the count, before clipping the label. Never clip the icon.

### 2.2 Click target

The whole badge is a single button (`role="button"`, `tabindex="0"`). Activation opens `<BridgeSessionDetail />`. No hover-only affordance — opening must be reachable by keyboard and screen reader.

### 2.3 `<BridgeSessionDetail />`

Rendered inside the existing `SidePanel`. Sections, top → bottom:

1. **Header:** session short id, full `jti` on hover/long-press, copy-to-clipboard button.
2. **Capabilities table:** scope · source (`bridge-shell` / `bridge-write` / `bridge-url` / `bridge-read`) · last-used timestamp · count.
3. **Token meta:** `iss`, `aud`, `iat`, `exp` (relative + absolute), single-use jtis remaining for `shell:*`/`url:*`.
4. **Recent decisions:** last 10 rows from the audit log filtered by this session's `jti`. Tap-through opens the full audit log filtered to this jti.
5. **Footer actions:** **Revoke session** (destructive, see §6) · **Copy session id** · **Open audit log**.

The panel does not own state; it reads from the same renderer store the badge subscribes to (§5).

---

## 3. States, colors, and transitions

| State        | Trigger                                                       | Bg token              | Fg token            | Icon         | Notes |
|--------------|---------------------------------------------------------------|-----------------------|---------------------|--------------|-------|
| `idle`       | no active session                                             | (collapsed)           | —                   | —            | Slot fully removed from layout. |
| `active`     | session present, `exp - now > 60s`                            | `--color-bg-neutral`  | `--color-fg-default`| ⚡ neutral    | Default. Timer hidden. |
| `amber`      | `0 < exp - now ≤ 60s` ("expiring soon")                       | `--color-bg-warning`  | `--color-fg-warning`| ⏳ warning    | Timer shown, mm:ss countdown. Pulses 1×/sec at 50%→100% opacity on the icon only (never the whole badge — motion sensitivity). |
| `expired`    | `exp - now ≤ 0` until renderer drops it                       | `--color-bg-warning-strong` | `--color-fg-on-warning` | ⏳ warning | Replaces timer with the literal text **"expired — reconnect"**. Click opens the detail panel pre-scrolled to the Token meta section. |
| `deny-flash` | transient: a `bridge-*-deny` audit decision row arrived       | `--color-bg-danger`   | `--color-fg-on-danger` | ⛔ danger | **3 second** flash. **Per-event, not coalesced — see §4.** Returns to whatever the underlying state was (`active` / `amber` / `expired`). |

### 3.1 Token mapping

Use existing semantic tokens — **do not introduce new color tokens** for this work.

- `--color-bg-neutral` → `var(--ds-color-surface-2)`
- `--color-fg-default` → `var(--ds-color-fg-default)`
- `--color-bg-warning` → `var(--ds-color-bg-amber-subtle)`
- `--color-fg-warning` → `var(--ds-color-fg-amber-strong)`
- `--color-bg-warning-strong` → `var(--ds-color-bg-amber-bold)`
- `--color-fg-on-warning` → `var(--ds-color-fg-on-amber-bold)`
- `--color-bg-danger` → `var(--ds-color-bg-red-bold)`
- `--color-fg-on-danger` → `var(--ds-color-fg-on-red-bold)`

If any of these tokens are missing in the design-system package, file a ds-tokens ticket — do **not** inline hex values. The acceptance criterion in CLI-142 includes a Storybook story per state that resolves cleanly through tokens.

---

## 4. The deny-flash IPC contract (non-negotiable)

This is the single most subtle piece of the spec. Get it wrong and two near-simultaneous denials look like one event to the user, which is a real audit-trust regression.

### 4.1 Source

A dedicated IPC channel: **`bridge:deny-flash`**.

- **Producer:** main-process audit-log write path. Whenever a row is appended whose `decision === 'deny'` AND `source` matches `/^bridge-/`, main emits exactly one `bridge:deny-flash` message **per row**, regardless of how many other state updates are in flight.
- **Payload:** `{ jti: string, source: 'bridge-shell'|'bridge-write'|'bridge-url'|'bridge-read', scope: string, ts: number }`.
- **Ordering:** main MUST emit on the row write, not on a debounced state diff.

### 4.2 Renderer consumption

The badge subscribes directly to `bridge:deny-flash` and runs an animation queue:

```
on bridge:deny-flash → enqueue({ start: now, dur: 3000 })
render loop:
  if any flash in queue with end > now → render deny-flash state
  else → render underlying state
on flash end → dequeue
```

Two messages 800ms apart MUST result in **two visible 3s flashes that overlap into a single ≥3.8s sustained red**, not one. The ARIA announcement (§7) MUST also fire twice.

### 4.3 Why it cannot piggyback on the 250ms state debounce

The debounced `bridge:state` channel that drives the steady-state badge is intentionally throttled to avoid layout thrash on rapid capability count changes. Coalescing two denials inside that 250ms window would silently drop the second one from both visual and a11y output. The deny-flash channel exists specifically so this cannot happen.

---

## 5. State subscription

Renderer store shape:

```ts
type BridgeSessionState =
  | { kind: 'idle' }
  | {
      kind: 'active' | 'amber' | 'expired';
      jti: string;            // 16-hex
      shortId: string;        // jti.slice(0, 4) prefixed with 'cap-'
      iat: number;            // ms epoch
      exp: number;            // ms epoch
      capabilityCount: number;
      capabilities: Array<{ source: BridgeSource; scope: string; lastUsedAt: number; count: number }>;
    };
```

- Underlying-state transitions arrive on `bridge:state` (debounced 250ms in main).
- `kind` is computed in the renderer from `exp` and `Date.now()` on every animation frame the badge renders, so the amber→expired transition does not require a server message — wall-clock TTL per ADR-0005 §2.6.
- The detail panel reads the same record. No second source of truth.

---

## 6. Revoke action

Triggered from the detail panel footer.

1. Click → standard destructive-confirm dialog (reuse `<ConfirmDialog />`).
   - **Title:** "Revoke bridge session?"
   - **Body:** "Revoke will terminate **N** active calls and invalidate all remaining single-use tokens. This cannot be undone."
   - **Primary:** "Revoke" (danger styling, default focus is **Cancel**).
   - **Secondary:** "Cancel".
2. On confirm → `bridge:revoke` IPC with `{ jti }`.
3. Optimistic UI: badge transitions immediately to `expired` with timer text replaced by **"revoked"**, panel closes after 250ms.
4. If main responds with an error within 2s, restore prior state + toast "Revoke failed — session still active. Try again or check audit log.".

---

## 7. Accessibility

These items are **non-negotiable** and form part of the CLI-142 acceptance criteria.

- The badge root carries `role="status"`.
- Steady-state amber transitions: `aria-live="polite"`, `aria-atomic="true"`. Announcement text: **"Bridge: cap-`<short>`, `<N>` capabilities active, expires in `<mm:ss>`"**.
- `expired`: `aria-live="polite"`. Text: **"Bridge: cap-`<short>`, expired, reconnect required"**.
- `deny-flash`: `aria-live="assertive"`. Text: **"Bridge denial: `<source>` `<scope>`"**. Announced **per event**, not coalesced (the §4 queue applies to a11y output too).
- Focus order: badge sits between the connection pill and the user menu — confirm with the existing skip-link tests.
- Keyboard: `Enter` and `Space` open the detail panel. `Esc` from inside the detail panel returns focus to the badge.
- Screen reader regression test lives at `ui/src/components/status-strip/__tests__/BridgeSessionBadge.a11y.test.tsx` — required before merge.

---

## 8. Empty/error/edge states

- **No bridge feature flag:** badge unmounted entirely. The slot does not render at all (not even collapsed) so feature-off users see no DOM trace.
- **Token verifier returned `iss` mismatch / `typ` mismatch (ADR-0005 §1 hardening):** badge does not appear; main-process surfaces a one-shot toast via the existing `notifications` channel — out of scope for this component.
- **Clock skew > 30s:** `exp - now` may go negative immediately. We trust wall-clock per §2.6 of the ADR and show `expired` rather than try to second-guess; the suspend/resume path is the dominant case and the alternative (server-relative timer) is worse.

---

## 9. Files this spec governs (for CLI-142)

```
ui/src/components/status-strip/
  BridgeSessionBadge.tsx            ← new
  BridgeSessionBadge.module.css     ← new (token-only, no hex)
  BridgeSessionDetailPanel.tsx      ← new (consumes existing SidePanel)
  __tests__/
    BridgeSessionBadge.test.tsx
    BridgeSessionBadge.a11y.test.tsx
    BridgeSessionDetailPanel.test.tsx

ui/src/state/
  bridgeSession.ts                  ← new store + selectors
  __tests__/bridgeSession.test.ts

ui/src/ipc/
  bridgeChannels.ts                 ← typed wrappers for bridge:state, bridge:deny-flash, bridge:revoke

stories/
  BridgeSessionBadge.stories.tsx    ← one story per state in §3, plus "rapid double deny" interaction story
```

If the existing status-strip directory uses a different name (e.g. `top-bar` or `app-chrome`), follow the existing convention and update this file in the same PR.

---

## 10. Open questions (none blocking)

- **Telemetry:** should opening the detail panel emit a `bridge.detail_opened` analytics event? Default position: **yes**, with `{ jti_short, capability_count }` only — no scope strings, no IP. Confirm with ClippySec before enabling.
- **Internationalization:** all strings in §3, §6, §7 must route through the existing `i18n` layer; placeholder `t()` keys are listed inline above. Translation work is a follow-up sub-issue, not a CLI-142 blocker.

---

## Changelog

- 2026-04-21 — v1.0, ClippyArch. Initial spec, mirrors §8 of ADR-0005 and the contract committed in CLI-37 co-review (comment 2026-04-20 23:49Z) and CLI-11 ack (2026-04-21 00:06Z).
