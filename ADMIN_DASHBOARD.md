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
| `GET /zalobot/api/admin/logs` | Bot warnings/errors, delivery errors, and audit events |
| `POST /zalobot/api/admin/chats` | Add or update a chat-directory record |
| `DELETE /zalobot/api/admin/chats/:chatId` | Soft-remove by default; `?hard=1` permanently deletes the record |
| `GET /zalobot/api/admin/settings` | List configured admin user/chat identities |
| `POST /zalobot/api/admin/settings/admins` | Add or update an admin identity |
| `DELETE /zalobot/api/admin/settings/admins?id=...` | Remove an admin identity |
| `GET /zalobot/api/admin/target-users` | Deduplicated target-user list for the Command console |
| `POST /zalobot/api/admin/commands` | Execute a command for one recipient (legacy shape, still supported) |
| `POST /zalobot/api/admin/commands/batch` | Start a multi-recipient run; returns `202` with a `jobId` |
| `GET /zalobot/api/admin/commands/batch/:jobId` | Progress, per-recipient results, and summary for a run |

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

## Command console: multiple recipients

The console runs one command for several recipients in a single submission. Recipients are picked with a searchable multi-select: type to filter by name, MSSV, or User ID, or use `↑`/`↓` + `Enter`. Each selection appears as a removable chip showing the display name and User ID, `Backspace` on an empty input removes the last one, and the panel offers **select all filtered** and **clear selection** with a running count. Mobile layouts stack the chips and make the action buttons full width.

Every command is classified in `commandTargeting.js`:

| Mode | Behaviour | Examples |
| --- | --- | --- |
| `per-user` | Runs once per recipient, with that recipient's context. | `/luumssv`, `/lich`, `/lichtuan`, `/nhanlich`, `/xoagionhanlich`, `/tatnhanlich`, `/batnhaclich`, `/sinhnhat`, `/ai`, `/help` |
| `broadcast` | Sends to every active chat, so it runs **exactly once** regardless of how many recipients are selected. The confirmation explains this. | `/thongbao`, `/update`, `/congbocauhoi`, `/test6h` |
| `none` | Not meaningful per user. The batch is rejected with a specific reason **before anything runs**. | `/quanlychat`, `/accessmode`, `/accesslist`, `/chitietchat`, `/chatfeature`, `/myid`, `/time`, `/helpadmin` |

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
