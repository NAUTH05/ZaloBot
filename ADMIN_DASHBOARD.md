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
| `GET /zalobot/api/admin/workspace` | Unified users, groups, chats, MSSV subscriptions, notification times, duty data, and access summary |
| `GET /zalobot/api/admin/chats` | Filter users/groups by `status` and `type` |
| `GET /zalobot/api/admin/users` | Unified user/member records, MSSV, chat contexts, and notification status |
| `POST /zalobot/api/admin/users` | Add a user/member to a private chat or group |
| `PATCH /zalobot/api/admin/users/:userId` | Update display name or active/disabled/removed membership state in a chat |
| `DELETE /zalobot/api/admin/users/:userId?chatId=...` | Remove a member; add `hard=1` to also delete that chat-specific subscription |
| `GET /zalobot/api/admin/groups` | Registered group chats |
| `GET /zalobot/api/admin/chats/:chatId` | Chat detail, subscriptions, and duty registration |
| `PATCH /zalobot/api/admin/chats/:chatId` | Change status or a feature override |
| `POST /zalobot/api/admin/chats/:chatId/retry` | Send a test through the existing `sendNotification()` path |
| `GET /zalobot/api/admin/notifications` | Active schedule/duty registrations and duty schedule data |
| `GET /zalobot/api/admin/audit` | Recent administrative and authentication events |
| `GET /zalobot/api/admin/logs` | Bot warnings/errors, delivery errors, and audit events |
| `POST /zalobot/api/admin/chats` | Add or update a chat-directory record |
| `DELETE /zalobot/api/admin/chats/:chatId` | Soft-remove by default; `?hard=1` permanently deletes the record |
| `GET /zalobot/api/admin/settings` | List configured admin user/chat identities |
| `POST /zalobot/api/admin/settings/admins` | Add or update an admin identity |
| `DELETE /zalobot/api/admin/settings/admins?id=...` | Remove an admin identity |
| `POST /zalobot/api/admin/commands` | Execute an existing bot command with a configured admin context |

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

The web UI is organized into tabs: Overview, Chat directory, Users, Groups, Notifications, Duty, Chat health, Command console, Settings, and Logs/Audit. It defaults to a dark blue theme and has a light-theme toggle. Users are separate from chats: a user can have different MSSV and notification times in different group contexts. Admins can add/edit/remove members, promote an identity to admin, manage chat metadata, and review the creation/update timestamp of every notification time.

## Deployment checklist

1. Set the admin credentials in the server environment, never in frontend files.
2. Start the bot normally; it starts the dashboard on `127.0.0.1:6003` by default.
3. Add the `/zalobot` Nginx location and reload Nginx.
4. Open `https://mrnauthdev.dpdns.org/zalobot/` and sign in.
5. Confirm login, dashboard counts, chat filtering, reactivation, disable, soft removal, feature overrides, retry, and logout.
6. Confirm `/lythuyet` and the root proxy still work.
