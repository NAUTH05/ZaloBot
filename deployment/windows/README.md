# ZaloBot Windows Server Deployment

Target: Windows Server 2019+, production hostname `zalobot.mrnauthdev.dpdns.org`.

## Install

Run PowerShell as the deployment account. Install Node.js LTS 64-bit, Git for Windows, IIS, IIS URL Rewrite, ARR, and WebSocket Protocol when required.

```powershell
New-Item -ItemType Directory -Force C:\Apps\ZaloBot,C:\Secure\ZaloBot,C:\inetpub\zalobot-proxy | Out-Null
Set-Location C:\Apps
git clone -b dev_windows https://github.com/NAUTH05/ZaloBot ZaloBot
Set-Location C:\Apps\ZaloBot
npm ci
Copy-Item .env.example .env
```

Place the Firebase key at `C:\Secure\ZaloBot\firebase-service-account.json` and grant access only to the deployment account and Administrators.

## Configuration and verification

Set the actual bot token, owner IDs, and hashed admin password in `.env`. The Windows minimum is:

```env
NODE_ENV=production
PORT=3000
ADMIN_PORT=3000
ADMIN_BASE_PATH=/
FIREBASE_SERVICE_ACCOUNT_FILE=C:\Secure\ZaloBot\firebase-service-account.json
TZ=Asia/Ho_Chi_Minh
```

```powershell
npm run verify:firebase-admin
npm run build:admin
npm test
```

## Local runtime

```powershell
npm start
Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing
```

Expected status is `200`. Keep Node bound to localhost and do not expose port 3000 publicly.

## PM2 and reboot persistence

```powershell
npm install -g pm2
pm2 start ecosystem.config.js --update-env
pm2 status
pm2 logs zalobot
pm2 save
```

Create a Task Scheduler task named `ZaloBot PM2 resurrect`, trigger **At startup**, under the same service account:

```text
Program: C:\Program Files\nodejs\pm2.cmd
Arguments: resurrect
Start in: C:\Apps\ZaloBot
```

Do not use `pm2 startup`, `systemctl`, or `service` on Windows. Reboot once and verify `pm2 status`.

## IIS, URL Rewrite, ARR

Create IIS site `ZaloBot` with physical path `C:\inetpub\zalobot-proxy`, HTTPS port `443`, host `zalobot.mrnauthdev.dpdns.org`, and SNI when sharing an IP. Copy [web.config](web.config) into the site root. Enable **Server -> Application Request Routing Cache -> Server Proxy Settings -> Enable proxy**.

The production flow is Cloudflare -> IIS :443 -> URL Rewrite/ARR -> `http://127.0.0.1:3000`. The dashboard is mounted at the domain root, not `/zalobot/`.

## HTTPS and Cloudflare

Run current win-acme/WACS as Administrator, create an IIS certificate for `zalobot.mrnauthdev.dpdns.org`, store it in `Cert:\LocalMachine\My`, bind it to `ZaloBot`, and keep renewal enabled. HTTP-01 may require temporary TCP 80 and DNS-only mode; DNS-01 avoids that.

Set Cloudflare DNS for `zalobot.mrnauthdev.dpdns.org` to the server, keep it proxied, and set SSL/TLS to **Full (strict)**. Never proxy Cloudflare directly to port 3000. Allow TCP 443 and TCP 80 only when validation requires it.

```powershell
Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -Match 'zalobot' | Select-Object Subject, Thumbprint, NotAfter
Get-WebBinding -Name ZaloBot -Protocol https | Select-Object bindingInformation, certificateHash, certificateStoreName, sslFlags
```

## Diagnostics

```powershell
Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing
Invoke-WebRequest https://zalobot.mrnauthdev.dpdns.org/ -UseBasicParsing
pm2 status
pm2 logs zalobot
Get-Website
Get-WebBinding
Get-WebGlobalModule | Select-Object Name, ImagePath
Get-WindowsFeature Web-WebSockets
Get-Content C:\inetpub\zalobot-proxy\web.config
& "$env:WINDIR\System32\inetsrv\appcmd.exe" list config "ZaloBot/" /section:system.webServer/rewrite/rules
$log = Get-ChildItem C:\inetpub\logs\LogFiles -Recurse -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName -Tail 30
```

Debug in order: Node, PM2, IIS, Rewrite, ARR, certificate/binding, Cloudflare, public HTTPS. `500.19` means invalid XML or missing Rewrite; `500.50/500.52` indicates Rewrite/ARR; `502.3` means IIS cannot reach Node; `525` indicates an origin TLS/binding problem. Firebase errors are diagnosed with `npm run verify:firebase-admin`.

## Validation checklist

- [ ] `npm ci`, `npm test`, and `npm run build:admin` pass.
- [ ] External service-account file exists and Firebase verification passes.
- [ ] Node starts cleanly; scheduler initializes once; commands and notifications work.
- [ ] PM2 is online, saved, and resurrects after reboot.
- [ ] IIS, URL Rewrite, ARR, `web.config`, HTTPS binding, and certificate renewal are configured.
- [ ] Cloudflare is proxied with Full (strict); TCP 443 is public and 3000 is private.
- [ ] `https://zalobot.mrnauthdev.dpdns.org/` loads, authenticates, serves assets/API calls, and preserves Firestore state after restart.
