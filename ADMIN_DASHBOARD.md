# ZaloBot Admin Dashboard

The dashboard is an operations layer over the existing bot. `main.js` remains the source of truth for notification delivery, scheduler behavior, Zalo API calls, and chat health. The dashboard only calls the authenticated API exposed by `adminServer.js`.

## Local configuration

Add these values to `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<long-random-password>
# Prefer this in production; generate with `ADMIN_PASSWORD_TO_HASH=... npm run admin:hash-password`
# ADMIN_PASSWORD_HASH=scrypt$...
ADMIN_PORT=6003
ADMIN_BASE_PATH=/zalobot
ADMIN_COOKIE_SECURE=true
CHAT_MAX_CONSECUTIVE_FAILURES=3
```

`ADMIN_COOKIE_SECURE=true` is required when the dashboard is accessed over HTTPS. For local HTTP-only testing, omit it or set it to `false`.

## API surface

All endpoints below require the HttpOnly `zalobot_admin` session cookie except login and logout:

| Endpoint | Purpose |
| --- | --- |
| `POST /zalobot/api/admin/auth/login` | Start an admin session; rate limited after failed attempts |
| `POST /zalobot/api/admin/auth/logout` | Revoke the current session |
| `GET /zalobot/api/admin/dashboard` | Health, counts, invalid chats, errors, and recent audit events |
| `GET /zalobot/api/admin/workspace` | Unified users, groups, chats, MSSV subscriptions, notification times, and access summary |
| `GET /zalobot/api/admin/chats` | Filter users/groups by `status` and `type` |
| `GET /zalobot/api/admin/users` | Unified user/member records, MSSV, chat contexts, and notification status |
| `POST /zalobot/api/admin/users` | Add a user/member to a private chat or group |
| `PATCH /zalobot/api/admin/users/:userId` | Update display name or active/disabled/removed membership state in a chat |
| `DELETE /zalobot/api/admin/users/:userId?chatId=...` | Remove a member; add `hard=1` to also delete that chat-specific subscription |
| `GET /zalobot/api/admin/groups` | Registered group chats |
| `GET /zalobot/api/admin/chats/:chatId` | Chat detail and subscriptions |
| `PATCH /zalobot/api/admin/chats/:chatId` | Change status or a feature override |
| `POST /zalobot/api/admin/chats/:chatId/retry` | Send a test through the existing `sendNotification()` path |
| `GET /zalobot/api/admin/notifications` | Active schedule registrations |
| `GET /zalobot/api/admin/audit` | Recent administrative and authentication events |
| `GET /zalobot/api/admin/logs` | Bot warnings/errors, delivery errors, per-delivery trace (`deliveries`), and audit events. `?limit=` up to 1000 |
| `POST /zalobot/api/admin/chats` | Add or update a chat-directory record |
| `DELETE /zalobot/api/admin/chats/:chatId` | Soft-remove by default; `?hard=1` permanently deletes the record |
| `GET /zalobot/api/admin/settings` | List configured admin user/chat identities |
| `POST /zalobot/api/admin/settings/admins` | Add or update an admin identity |
| `DELETE /zalobot/api/admin/settings/admins?id=...` | Remove an admin identity |
| `GET /zalobot/api/admin/target-users` | Deduplicated target-user list for the Command console |
| `POST /zalobot/api/admin/commands` | Execute a command for one recipient (legacy shape, still supported) |
| `POST /zalobot/api/admin/commands/batch` | Start a multi-recipient run; returns `202` with a `jobId` |
| `GET /zalobot/api/admin/commands/batch/:jobId` | Progress, per-recipient results, and summary for a run |
| `GET /zalobot/api/admin/friend-requests` | ZCA friend requests: pending, history, settings, accounts, recipient status |
| `POST /zalobot/api/admin/friend-requests/sync` | Re-read pending requests from Zalo (`botId` optional) |
| `POST /zalobot/api/admin/friend-requests/accept` | Accept one request by `requestId`; `409` if already processed |
| `POST /zalobot/api/admin/friend-requests/reject` | Reject one request by `requestId` |
| `POST /zalobot/api/admin/friend-requests/settings` | Update handling mode, safety limits, notification channels, welcome message |
| `POST /zalobot/api/admin/friend-requests/test-notification` | Send a test notification on one channel |
| `POST /zalobot/api/admin/friend-requests/retry-notification` | Retry only the failed channel of one request |
| `POST /zalobot/api/admin/group-policy` | Per-group reply mode: `{ botId, chatId, mode }` where `mode` is `mention` or `ingest`; `null` clears the override |
| `GET /zalobot/api/admin/ai-pause` | Current AI assistant pause state: global entry plus one entry per conversation |
| `POST /zalobot/api/admin/ai-pause` | Pause or resume the assistant: `{ scope: "global"\|"chat", botId, chatId, paused, minutes, reason }` |

State-changing requests require same-origin `Origin` headers when a browser supplies one. The server also applies security headers, request-size limits, and a basic IP rate limit.

## Chat lifecycle

The existing `chatDirectory` record is reused. A permanent Zalo destination error such as `EZALO: 410 The chat_id is invalid` immediately sets `inactive`; transient errors use `CHAT_MAX_CONSECUTIVE_FAILURES`. Admin actions set `disabled`, `active`, or `removed`, with historical data retained. Delivery retry calls the bot's existing sender, so a successful retry updates the same health fields and a failed retry follows the same error policy.

## CloudPanel / Nginx

Keep the existing root proxy and `/lythuyet` block. Add this block before the generic `location /` block:

```nginx
location = /zalobot { return 301 /zalobot/; }

location /zalobot/ {
    proxy_pass http://127.0.0.1:6003/zalobot/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

The trailing slash on both `location /zalobot/` and `proxy_pass .../zalobot/` preserves the application base path and prevents `/zalobot/zalobot` or missing-prefix requests. The dashboard currently uses HTTP polling and does not require WebSocket proxy headers.

Older `unknown` chat types are enriched from the existing interaction registry. New inbound messages persist `private`/`group`, latest `userId`, chat title, and display name in `chatDirectory`. Command execution remains protected by the existing owner check and requires a user/chat identity from `adminSettings` or `OWNER_USER_ID`/`OWNER_CHAT_ID`.

The web UI is organized into tabs: Overview, Chat directory, Users, Groups, Notifications, Chat health, Command console, Settings, and Logs/Audit. The Room 411 duty tab and its `/api/admin/duty/*` endpoints were removed together with the extracted feature; the Room 411 bot manages duty data through its own Zalo commands. It defaults to a dark theme and has a light-theme toggle. The styling is a single flat/minimal design system driven by CSS custom properties in `admin-ui/styles.css`: one radius, spacing, and type scale, 1px borders instead of shadows, visible focus rings, and `prefers-reduced-motion` support for every transition. `admin-ui/admin-controls.css` holds deployment-specific overrides only. Users are separate from chats: a user can have different MSSV and notification times in different group contexts. Admins can add/edit/remove members, promote an identity to admin, manage chat metadata, and review the creation/update timestamp of every notification time.

## Deployment checklist

1. Set the admin credentials in the server environment, never in frontend files.
2. Start the bot normally; it starts the dashboard on `127.0.0.1:6003` by default.
3. Add the `/zalobot` Nginx location and reload Nginx.
4. Open `https://mrnauthdev.dpdns.org/zalobot/` and sign in.
5. Confirm login, dashboard counts, chat filtering, reactivation, disable, soft removal, feature overrides, retry, and logout.
6. Confirm `/lythuyet` and the root proxy still work.
## Windows production

The reproducible Windows Server deployment is documented in [deployment/windows/README.md](deployment/windows/README.md). It uses IIS + URL Rewrite + ARR at `https://zalobot.mrnauthdev.dpdns.org/`, with Node listening privately on `127.0.0.1:3000`, PM2 process `zalobot`, and Firebase credentials stored at `C:\Secure\ZaloBot`.
# Pagination and Commands

Data-heavy dashboard views use shared pagination controls with first/previous/number/next/last navigation, a displayed range, and rows-per-page values of 10, 20, 25, 50, or 100. Search and filters are applied before pagination, and changing either resets the view to page one. The global default is configured under Settings and persisted with `adminSettings` (25 by default).

The Command console and Available commands section are backed by `commandRegistry.js`. The console suggests registered commands as an administrator types and shows the authenticated session as the executor. No executor user ID is accepted from the browser. Server-side command handling and owner checks remain authoritative.

`GET /zalobot/api/admin/target-users` returns the searchable list behind the Command console's recipient picker. It is derived from the same merged workspace data as the rest of the dashboard (`chatDirectory`, the interaction registry, and subscriptions), keyed strictly by **User ID** and deduplicated on it. Manual entry stays available: a value that is not in the directory is accepted unchanged.

## Bots

The dashboard serves one process that can run up to three Zalo identities. Each bot is a separate identity, so counts and health are reported **per bot**, never merged.

- The topbar **Bot** filter applies to every list — Chats, Users, Groups, Notifications, Chat health, Delivery errors and the overview metrics. One shared filter means the tabs cannot disagree about which bot you are looking at.
- The overview shows a card per bot with its status, token fingerprint and source, and its own chat/user/subscription/delivery-error counts. **The token itself is never sent to the browser** — only the 8-character fingerprint, which is enough to tell two tokens apart.
- Rows carry a bot label when the filter is set to *all bots*; the label is hidden when you have already filtered to one bot.
- `GET /api/admin/bots` returns the bot list. `?botId=` filters `/chats`, `/users` and `/notifications`.
- Chat detail and every chat/subscription write send the bot id, so opening a chat that exists under two bots opens the right record rather than whichever came first.

### Command console and bots

A command that sends a message **requires an explicit bot selection**. The confirmation dialog names the bot that will send, and the batch results carry it.

Recipients that belong to a different bot are refused rather than silently messaged: a User ID or Chat ID that looks identical under two bots is a different person's conversation. Broadcast scope is the selected bot's active chats — not every bot's.

## Browser console warnings

Two warnings commonly appear in the dashboard console. Neither is caused by the dashboard code, and neither is related to the chat-delete behaviour.

### `Permissions-Policy: Unrecognized feature: ...`

**Not from this repository.** The dashboard sets exactly one Permissions-Policy header, in `securityHeaders()` in `adminServer.js`:

```text
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

All three of those are standard, Chrome-recognised features and do not produce this warning. The warning appears when a header lists a feature the browser does not know — commonly `interest-cohort` or `browsing-topics`, which are injected by Cloudflare or by a reverse-proxy config.

Find out which layer is sending it:

```bash
curl -sI https://<your-host>/zalobot/ | grep -i permissions-policy
```

- **One** `Permissions-Policy` line containing only `camera`, `microphone`, `geolocation` → this repository, and it is correct.
- A line mentioning `interest-cohort`, `browsing-topics`, `run-ad-auction` or similar → it comes from **Cloudflare** (Cloudflare → your zone → Speed / Optimization features, or a Transform Rule adding headers) or from the **reverse proxy** (`add_header Permissions-Policy ...` in the nginx site config, or a Cloudflare Transform Rule).

Fix it where it is defined. Removing an unrecognised feature from that header is safe; do not add it to this repository.

### Cloudflare Insights script blocked by CSP

**Injected by Cloudflare, blocked by this repository's CSP.** Nothing in this project references `cloudflareinsights.com`, `cdn-cgi` or `beacon.min.js` — Cloudflare Web Analytics / Insights injects that script into HTML responses at the edge.

The dashboard CSP is deliberately tight, because this is a private admin panel:

```text
default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

Recommended fix — turn the injection off rather than widening the CSP:

1. Cloudflare dashboard → your zone → **Speed → Optimization → Content Optimization** (or **Analytics → Web Analytics**).
2. Disable **Cloudflare Web Analytics / Insights** for this hostname, or add a rule so it does not apply to `/zalobot/*`.

Adding `https://static.cloudflareinsights.com` to `script-src` would silence the warning, but it means allowing third-party JavaScript to execute inside an authenticated admin panel for the sake of an analytics beacon. That is a worse trade than switching the beacon off, so this repository does not do it.

## Command console: multiple recipients

The console runs one command for several recipients in a single submission. Recipients are picked with a searchable multi-select: type to filter by name, MSSV, or User ID, or use `↑`/`↓` + `Enter`. Each selection appears as a removable chip showing the display name and User ID, `Backspace` on an empty input removes the last one, and the panel offers **select all filtered** and **clear selection** with a running count. Mobile layouts stack the chips and make the action buttons full width.

Every command is classified in `commandTargeting.js`:

| Mode | Behaviour | Examples |
| --- | --- | --- |
| `per-user` | Runs once per recipient, with that recipient's context. | `/luumssv`, `/lich`, `/lichtuan`, `/nhanlich`, `/xoagionhanlich`, `/tatnhanlich`, `/batnhaclich`, `/ai`, `/help` |
| `broadcast` | Sends to every active chat, so it runs **exactly once** regardless of how many recipients are selected. The confirmation explains this. | `/thongbao`, `/update`, `/test6h` |
| `none` | Not meaningful per user. The batch is rejected with a specific reason **before anything runs**. | `/quanlychat`, `/accessmode`, `/accesslist`, `/chitietchat`, `/chatfeature`, `/myid`, `/time`, `/helpadmin` |

The dashboard does not keep its own copy of these lists: `GET /api/admin/commands` returns a `targeting` block per command, produced by `commandTargeting.js`, and the console uses it directly. That is why a renamed command cannot silently become untargetable in the UI.

A command that is not in either explicit list defaults to `none`, so a new command is never silently targetable. Old command names (for example `/dangky`) resolve to the same canonical name before classification, so an alias and its canonical form behave identically and a recipient is never processed twice.

Notification times in the subscription panel carry the target day for each entry (`homnay` = today's schedule, `homsau` = tomorrow's). The add/edit dialog requires choosing one, and `PATCH /api/admin/subscriptions` rejects anything other than `0` or `1` with the same rule the chat commands use.

### How a recipient is resolved

Chat IDs are only derived from a recipient when the association is unambiguous — exactly one active private chat context. The chip states which case applied (`Gửi tới chat …`, `Nhiều ngữ cảnh chat — sẽ bỏ qua`, `Chưa có chat đang hoạt động — sẽ bỏ qua`). A recipient without a reliable chat is **skipped**, never silently redirected to another chat. A group Chat ID is rejected outright and never treated as a User ID.

The `Target Chat ID` field was removed: it had no effect on execution, and a manually typed Chat ID is no longer needed because the resolved chat is shown per recipient.

### Execution

`POST /zalobot/api/admin/commands/batch` validates the whole request, then starts an in-memory job and returns `202` with a `jobId`; `GET /zalobot/api/admin/commands/batch/:jobId` reports `completed`/`total`, per-recipient results, and the summary. The UI polls this to show a progress bar and a per-recipient table (User ID, display name, chat, status, note).

- Recipients are normalised, trimmed, deduplicated by User ID, and capped by `maxBatchSize` (default 25, configurable under Settings).
- Each recipient runs through the same command engine and authorisation checks as a normal Zalo command. The executor is always the authenticated admin from the session; a `userId`/`role`/`executor` in the request body is ignored.
- Runs are sequential with a configurable `batchDelayMs` pause (default 350 ms) so Zalo is not flooded.
- One recipient failing never stops the rest. Statuses are `delivered`, `failed`, and `skipped`; a command that produced no message is reported as `skipped`, so parsing success is never mistaken for delivery.
- Every applied batch is recorded in `adminAudit` with the admin identity, command, target User IDs, duplicate count, and per-recipient outcomes. Rejected batches are recorded too.

`POST /zalobot/api/admin/commands` is unchanged for existing clients: it still accepts a single `targetUserId` and returns `deliveredToChatId`, `messages`, `executor`, and `target` in the old shape, plus the new `summary`/`results` fields.

A Chat ID that belongs to a group is never treated as a User ID: the API rejects it with a clear error and the list never exposes it as a user entry. The list is capped at 50 rendered rows with a "type to narrow" note, and shows an explicit empty state when no user has interacted with the bot yet.

# Friend requests (ZCA)

Friend requests only exist for the **ZCA personal account** (`zca-js`). Official Bot
Token identities have no friend list and are never allowed to accept anything: the
service looks up the account and refuses anything that does not expose `friendApi`.

## Verified zca-js surface (2.2.0)

Checked against `node_modules/zca-js/dist/**/*.d.ts`, not against the website:

| Capability | Installed 2.2.0 |
| --- | --- |
| `api.acceptFriendRequest(uid)` | present, resolves `""`, throws on failure |
| `api.rejectFriendRequest(uid)` | present |
| `api.getFriendRequestStatus(uid)` | present → `{ is_friend, is_requested, is_requesting, isSeenFriendReq }` |
| `api.getFriendRecommendations()` | present → `recommItems[]`, `dataInfo.recommType === 2` = received request |
| `api.getReceivedFriendRequests()` | **not present** — that is an older API name |
| `listener.on("friend_event")` | present, `FriendEventType.REQUEST / UNDO_REQUEST / REJECT_REQUEST / ADD` |

`getFriendRecommendations()` also returns plain suggestions, so the provider filters on
`recommType === 2` (received request) — that is what establishes the *direction*.
`getFriendRequestStatus()` is used for relationship state only.

**The status flags are not trustworthy — measured, not assumed.** In production a request
was still alive in Zalo, still listed as `ReceivedFriendRequest`, and
`getFriendRequestStatus()` returned **both** `is_requested` and `is_requesting` as `0`.
An earlier version treated that as "withdrawn" and marked a real request `cancelled`,
where the accept button could never work. So:

- Direction is never inferred from the flags; it comes from `recommType` or from
  `friend_event.toUid === ownUid`.
- `outgoingRequest && !incomingRequest` is the only flag pattern used to exclude someone
  (we invited them).
- All flags `0` means **unknown**, not "gone". It is kept as pending.
- "Cancelled" requires positive evidence: the person is gone from
  `getFriendRecommendations()`. If that list cannot be read, the request is kept and Zalo
  gets to decide — a `failed` row is retryable, a wrongly cancelled row is not.

## Detection

Two independent paths, both feeding the same store:

1. **Event** — `friend_event` → `REQUEST` (incoming only). `UNDO_REQUEST` and
   `REJECT_REQUEST` close the record as `cancelled`; `ADD` closes it as `accepted`
   (someone accepted on the phone).
2. **Sync** — reads `getFriendRecommendations()`, verifies each candidate, caps at 30
   candidates per pass. Runs after login, after every reconnect, on the configured
   interval, and when the admin clicks Refresh. One worker per account, guarded by a
   lock, so the listener and the interval cannot overlap.

Records are keyed `zca::<accountId>::<userId>`, so a restart never creates a duplicate
and never re-notifies. If a previously processed person sends a **new** request the
`generation` counter increments and notifications are sent again — but a sync that
merely arrives late (within 10 minutes of processing) cannot resurrect a handled
request, because Zalo's relationship state lags behind its own API.

## Handling modes

| Mode | Behaviour |
| --- | --- |
| `manual` (default) | Detect, notify, wait for an administrator |
| `auto` | Accept verified eligible requests within the safety limits below |
| `disabled` | No automatic processing; sync and review still work |

`mode` is the single source of truth. Mode changes apply immediately — the scheduler
re-reads settings on every tick and reschedules itself.

Safety limits, all enforced **server-side** (`friendRequests.normalizeSettings` clamps
whatever the client sends):

| Setting | Range | Default |
| --- | --- | --- |
| `maxPerHour` | 1–30 | 5 |
| `minIntervalMs` | 5s–10min | 60s |
| `suspendAfterErrors` | 1–10 | 3 |
| `syncIntervalMs` | 30s–10min | 60s |

Auto-accept is **suspended** after `suspendAfterErrors` consecutive provider errors.
Suspension survives until an administrator changes the mode (which clears it) — this is
deliberate: repeated Zalo refusals usually mean a rate limit or an account restriction,
and continuing would make it worse. Hourly usage is counted from stored records, so a
restart cannot bypass the cap.

## Notifications

Two independent channels, both able to be on at once. Recipients are **reused from the
existing owner configuration** — no new ID list, no re-entering IDs.

| Channel | Recipient resolution | Default |
| --- | --- | --- |
| `official` | `getAdminIdentities()` filtered to non-ZCA identities (so `OWNER_CHAT_ID` and `adminSettings` admins), optionally narrowed by `botId`/`chatId` | **on** |
| `zca` | explicit `chatId`, else `OWNER_USER_ID`, else a private conversation from `chatDirectory` | off |

For ZCA the thread id of a private chat *is* the user id, so `OWNER_USER_ID` is the
natural reuse — but a bot-platform `chat_id` is **not** interchangeable with a ZCA user
id, which is why the two channels resolve recipients separately. The account is never
allowed to message itself; if the only candidate is the account's own uid the UI reports
"no valid recipient" instead of trying.

Delivery is recorded **per channel** (`notifications.official`, `notifications.zca`).
A successful channel is never re-sent; only the failed one can be retried. Outcome
notifications are stored under separate keys (`official:accepted`, `zca:failed`, …) so
they cannot overwrite the "new request" result. A notification failure never removes the
request and never blocks manual approval.

The manage link is built from the live public origin (`publicOrigin.js`) plus the real
base path — `https://<domain>/zalobot/#friendrequests` — and opens the tab directly.
If the origin is not known yet the message falls back to instructions rather than
sending a dead localhost link.

## Accept / reject flow

1. Session-derived actor (never the request body).
2. In-memory lock per `requestId` — a double click cannot reach Zalo twice.
3. Claim the record as `processing` with a status precondition.
4. `getFriendRequestStatus()` — `is_friend` ⇒ `already_friends`. If no flag suggests a
   pending request, re-read `getFriendRecommendations()`; only when the person is absent
   does it become `cancelled`. Unknown ⇒ proceed and let Zalo answer.
5. `acceptFriendRequest()` / `rejectFriendRequest()`.
6. Confirm by re-reading the relationship **several times** (immediately, then after
   ~1.2s and ~2.5s). Zalo accepts the call instantly but publishes `is_friend` late, so a
   single immediate read reported success as failure — the owner had to accept by hand.
   If every read still says "not friends", the accept call is retried **once** (an event
   can arrive before Zalo has registered the request server-side) and confirmed again.
   Only then does the record become `requires_verification`, **not** `accepted` — and the
   reason is stored so the notification can state it. If every read throws, that is
   *unknown*, not failure: the record stays `accepted` with a note.
7. Optional welcome message (default off, only after real acceptance, once per request).
8. Audit entry.

`failed` and `requires_verification` stay retryable. A record stuck in `processing`
because the process died is unlocked to `requires_verification` on the next start.
`cancelled` is retryable too — cancelling means nothing was done, so accepting again
cannot double up, and a wrongly cancelled row needs an escape hatch. History cards for
those statuses therefore keep their Accept / Reject buttons.

## Welcome message

Off by default. Sent only after a confirmed acceptance, only once per request, and a
send failure is recorded separately (`notifications.zca:welcome`) without touching the
friendship status.

The configured text **replaces the bot's built-in greeting** for that person. Without
this, a newly accepted friend who then messaged the bot received
`formatWelcomeMessage()` ("[LỊCH HỌC LHU] XIN CHÀO" plus the command list) and never saw
what the administrator wrote. Two rules make the configured text win:

- On a successful welcome the chat is marked admitted, so the generic greeting does not
  fire on their first message.
- If the welcome was already sent, the greeting is skipped entirely — otherwise they get
  two different greetings.
- If the welcome is off, the built-in greeting still applies, and the Admin UI warns when
  a message is saved while the switch is off.

Because the welcome only goes out at the moment of acceptance, a missed one can be sent
later with **Gửi tin chào** on the history card (`POST .../send-welcome`). It refuses with
a reason when the feature is off, the message is empty, or it was already delivered.

Sending is **claimed before the message goes out** (`claimNotification`), not recorded
afterwards. The accept path and the greeting path can otherwise both observe "not sent
yet" while the first send is still in flight — that produced two identical messages for
one accepted friend. A claim left behind by a skipped send is released, so a later
attempt is not blocked.

## Deploy and test with a real account

```bash
cd ~/htdocs/zalobot.mrnauthdev.dpdns.org/ZaloBot
git pull origin dev
pm2 restart zalobot
```

Prerequisites:

- `ZCA_ENABLED=true` and a valid ZCA session (QR login in the overview tab).
- `OWNER_CHAT_ID` for the official channel (already set if owner notifications work).
- `OWNER_USER_ID` for the ZCA channel — this is the owner's Zalo **user id**, not a chat id.

Then:

1. Open **Friend Requests**. The banner lists anything misconfigured.
2. Pick a mode. Leave `manual` first.
3. Press **Send test** on each channel you enabled — this proves the recipient works
   before a real request depends on it.
4. From another Zalo account, send a friend request to the ZCA account.
5. The card appears within seconds (event) or one sync interval; the owner gets the
   notification with the request details.
6. Press **Accept**. The card moves to Accepted; history records actor, method, and time.
7. Switch to `auto`, send another request, and confirm it is accepted automatically and
   still listed in history.

## Known limitations

- **Live acceptance has not been exercised against Zalo in this environment.** The API
  names, argument order, and response shapes were verified from the installed typings and
  the flows are covered by mocked-provider tests, but a real `acceptFriendRequest()` call
  needs one live account to confirm end to end.
- There is no Zalo API to *list* pending requests other than `getFriendRecommendations()`,
  so a request that never appears there is only caught by the `friend_request` event.
  Both paths are used for exactly this reason.
- If the ZCA session is disconnected, actions return `account_offline` and the request
  stays pending — nothing is marked failed and nothing is auto-accepted.


# Group replies (support groups)

By default the bot **ignores untagged group messages**. That is correct for a class
group — otherwise every casual message triggers a reply — but wrong for a **support
group**, where the administrator needs to see what members wrote in order to help.

The reply mode is therefore set **per group**, not per bot:

| Mode | Behaviour |
| --- | --- |
| `mention` (default) | Only tagged messages and `/...` commands are processed. Everything else is dropped before it is recorded. |
| `ingest` | Every message is recorded into Chat Center so an administrator can read it and answer manually. The bot still does **not** answer plain text — only commands. |

Set it on the **Groups** tab (each card has a *Nhận tin* selector), or paste a chat id
into the field next to the search box when the group is not listed yet. Stored in
`groupPolicy.json`, keyed `botId::chatId` — the same chat id on two bots is two
different groups.

`POST /zalobot/api/admin/group-policy` accepts `{ botId, chatId, mode }`; `mode: null`
removes the override. Unknown modes are rejected rather than silently coerced, and the
scope is validated so an incomplete payload cannot write a meaningless key.

## The bot never sends a greeting in a group

This is a hard rule, not a setting. Two reasons:

- A greeting in a group is broadcast to **every** member, not to the person who spoke.
- The admission gate that decides "already greeted?" lives in memory and is lost on
  restart, so the greeting would repeat after every deploy.

The greeting branch is therefore skipped for every group chat, in every mode. Direct
chats keep the existing behaviour.

Two related automatic replies are also suppressed for untagged group messages in
`ingest` mode: the "no permission" warning and the invalid-command hint. Without that,
each ordinary message from a member would emit a notice to the whole group.

If you ever want the bot to actually **answer** plain text in a group, that is a
different feature (an AI reply path) and is deliberately not part of this: `ingest`
only makes the bot a listener.

## Why not `GROUP_MENTION_ONLY=0`

That switch turns the gate off for **all** groups at once, which is why it also
produces the greeting storm. Keep it at `1` and use the per-group selector.

# Diagnosing "Chat Center says sent, Zalo shows nothing"

The Chat Center writes an outbound record **only after the provider resolved
successfully**, and since this version it also writes the record when the provider
refuses (status `failed`, with the error). So a `✓` means Zalo accepted the send;
it does not prove the message was rendered on the recipient's device.

Order of checks:

1. **Logs & audit → Nhật ký gửi tin.** Every scheduled delivery leaves one row with
   the bot, the chat, the operation, the result and the `message_id` Zalo returned.
   A `sent` row with a message id means the API call succeeded; a `failed` row shows
   the exact reason (410 invalid chat, 403/422 no permission, 429 rate limit).
2. **Nhận lịch → Quản lý → Gửi thử tới chat này.** This sends a test message through
   the same `sendNotification()` path, right now. If the test arrives, the delivery
   path is alive and the problem was specific to that run (content, timing, provider
   hiccup). If the test does **not** arrive either, the chat has lost its link to the
   bot — the user blocked it, switched accounts, or the stored Chat ID is stale — and
   the schedule is not at fault.
3. **Check the bot identity.** A subscription belongs to one bot. The same Chat ID
   under two bots is two different conversations; looking at the wrong bot's account
   shows nothing even though the send succeeded.

The trace buffer lives in memory and is lost on restart, which is why every row
carries a Vietnam timestamp to match `pm2 logs`.

# Vietnam timestamps in `pm2 logs`

`pm2 logs` prints timestamps in the **PM2 daemon's** timezone, not the app's `TZ`.
On a UTC host a 06:30 delivery shows as 23:30 of the previous day. The process now
prefixes every log line with `[dd/mm/yyyy HH:mm:ss]` in `Asia/Ho_Chi_Minh`
(`logTime.js`, enabled by `LOG_VN_TIMESTAMPS=1`, set `0` to disable). Dashboard log
views use the same timezone explicitly, so they never depend on the operator's
browser settings.

# AI assistant pause

Settings → **Tạm dừng trợ lý AI** pauses the conversational assistant globally, and
Chat Center can pause it for one conversation. While paused the assistant does not
call the model and stays silent — the intended mode while an admin answers users by
hand.

Not affected: `/` commands, deterministic command batches, pending confirmations,
and every scheduled notification. The pause is stored in `adminSettings.aiPause`
(`global` plus a `botId::chatId` map), evaluated at read time, so it expires on its
own without a timer and survives a restart. A banner stays visible on every tab
while a pause is active.

# Broadcast: why "sent to 100+" did not reach everyone

Reported symptom: `/thongbao` reported more than 100 successful deliveries, the
Chat Center showed `✓` for each of them, and many users received nothing.

## Root cause

`zca-js` resolves `sendMessage` with `{ message: null }` when Zalo accepts the
request but does **not** create the message — which is what happens when a
personal account is being rate-limited for sending in bulk. No error is thrown, so
the delivery layer counted it as success and the Chat Center recorded `✓`.

Two problems stacked:

1. **No proof of delivery.** The provider returned whatever Zalo answered without
   checking for a `msgId`. `providers/zca/zcaProvider.js` now throws unless Zalo
   returns a message id (or an attachment id). The error is tagged
   `deliveryKind: "rate_limit"`, so the send layer slows down instead of treating
   the chat as broken.
2. **No pacing.** Broadcasts and scheduled notifications were fired as fast as the
   API answered (100+ messages in seconds). `sendPacing.js` now sends one message
   at a time per provider: 1.2 s between messages on an official bot, 3 s on a
   personal account.

## What the numbers mean now

| Counter | Meaning |
| --- | --- |
| `Gửi thành công` | Zalo accepted the request |
| `trong đó N chưa có mã tin nhắn xác nhận` | Accepted, but Zalo returned no `message_id` — no proof a message was created |
| `Gửi lỗi` | Rejected (410/422) or the provider could not create the message |
| `Hoãn do bị giới hạn tốc độ` | Not sent because the provider is throttled — run the command again later |

A rate-limit failure is **never** written to the chat record: otherwise one
throttled broadcast would push `consecutiveFailureCount` up for every recipient and
suspend them all, silently unsubscribing users because we sent too fast.

## Operational rules

- Broadcasting from a **personal account** to a large audience is what Zalo
  throttles hardest. The command now warns before and after when more than 10
  recipients belong to a personal account. Use an official bot for large
  announcements.
- The start notice says "đang gửi" before the run begins — do **not** re-run the
  command while it is running; each run is another full broadcast.
- Tune pacing with `BROADCAST_INTERVAL_MS` (official) and
  `BROADCAST_ZCA_INTERVAL_MS` (personal). Raising them is always safe; lowering
  them brings the silent-drop problem back.

# Presend: keeping the delivery time while keeping the delay

## The conflict

A 06:30 slot with 50 recipients cannot be sent at 06:30 any more. Each message
needs a safe gap (5 s on a personal account), so starting at 06:30 means the last
person receives at 06:34 — late, and later still if the delay is raised to be
safer.

## The rule

The slot time stays the user's registration time. The **run starts earlier by
exactly the time it needs**, so the last message still lands at 06:30:

```
window = recipients × (delay + ~1s) + 90s, clamped to [PRESEND_MIN, PRESEND_MAX]
start  = slot − window        (never before 00:00 of the same day)
end    = slot + SCHEDULE_LATE_GRACE_MINUTES
```

| Recipients (personal account, 5 s) | Window | Starts |
| --- | --- | --- |
| 5 | 5 min (floor) | 06:25 |
| 50 | 6.5 min | 06:23 |
| 100 | 11.5 min | 06:18 |
| 200 | 20 min (ceiling) | 06:10 |

The delay is computed per provider, so a slot mixing an official bot (1.2 s) and a
personal account (5 s) gets the right total.

## Two safety rules

1. **Never before midnight.** A 00:05 slot with a 20-minute window would start at
   23:45 the *previous* day, and "today's schedule" would resolve to the wrong
   date. The window is clipped to 00:00 of the slot's own day.
2. **Still send late.** The slot stays eligible for
   `SCHEDULE_LATE_GRACE_MINUTES` (15) after its time, so a restart at 06:28 still
   delivers instead of losing the whole day.

## The ledger is mandatory

The job runs every minute and a window lasts 5–20 minutes, so without a record of
who already received the message each person would get it 5–20 times.
`dailyScheduleLedger.js` stores one record per
`botId | chatId | MSSV | HH:mm | today/tomorrow | date` in the
`dailyScheduleDeliveries` Firestore document:

- `claim` immediately before sending — two overlapping runs cannot both send;
- `markDelivered` after success — never sent again that day;
- `release` on failure — retried by the next minute inside the window;
- a claim older than 3 minutes is considered dead (process crashed mid-send) and
  can be taken again, so a restart cannot silently skip a recipient.

Records older than 7 days are pruned on write.

## Not affected

- **Class-start reminders** ("còn 10 phút vào lớp") are not presend: moving them
  earlier would make the "10 minutes" text wrong. They keep their own lead-time
  logic.
- **Schedule-change alerts** are event-driven, not tied to a slot.
- `/test6h` bypasses the ledger so an operator can run it repeatedly.

## Tuning

`PRESEND_MIN_MINUTES` (5), `PRESEND_MAX_MINUTES` (20),
`SCHEDULE_LATE_GRACE_MINUTES` (15), `BROADCAST_ZCA_INTERVAL_MS` (5000). Raising the
interval widens the window automatically; no other change is needed.
