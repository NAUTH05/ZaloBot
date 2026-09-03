# ZaloBot Windows Server Deployment Runbook

This runbook deploys the dev_windows branch on Windows Server 2019 or later. The public URL is https://zalobot.mrnauthdev.dpdns.org/.

## Architecture

    Cloudflare -> HTTPS :443 -> IIS -> URL Rewrite -> ARR -> http://127.0.0.1:3000 -> ZaloBot

IIS is the public TLS/reverse-proxy endpoint. PM2 owns the Node process. ZaloBot's admin server is a plain Node HTTP server and does not use Express, Socket.IO, or WebSockets; WebSocket Protocol is optional unless a future feature adds one.

## 1. Install IIS

### Server Manager

1. Open Server Manager -> Add roles and features.
2. Select Role-based or feature-based installation and the local server.
3. Select Web Server (IIS), keep Management Tools -> IIS Management Console selected.
4. Under Common HTTP Features select Static Content, Default Document, HTTP Errors, and HTTP Logging.
5. Keep Request Filtering enabled.
6. Under Application Development select WebSocket Protocol only if a future ZaloBot feature needs it.
7. Complete installation and open IIS Manager from Tools.

### PowerShell

Run as Administrator:

    Install-WindowsFeature -Name Web-Server -IncludeManagementTools
    Install-WindowsFeature -Name Web-Http-Logging,Web-Request-Monitor,Web-Filtering,Web-Default-Doc,Web-Static-Content
    # Optional for a future WebSocket endpoint
    Install-WindowsFeature -Name Web-WebSockets
    Get-WindowsFeature Web-Server,Web-Mgmt-Console,Web-Http-Logging,Web-Filtering
    Get-Service W3SVC
    Get-Command inetmgr.exe -ErrorAction SilentlyContinue

Install State must be Installed, W3SVC must be running, and inetmgr.exe must resolve.

## 2. Prepare directories and application

    New-Item -ItemType Directory -Force C:\Apps\ZaloBot,C:\Secure\ZaloBot,C:\inetpub\zalobot-proxy | Out-Null
    Set-Location C:\Apps
    git clone -b dev_windows https://github.com/NAUTH05/ZaloBot ZaloBot
    Set-Location C:\Apps\ZaloBot
    npm ci
    Copy-Item .env.example .env

Place the Firebase JSON at C:\Secure\ZaloBot\firebase-service-account.json. Disable NTFS inheritance, remove broad users, and grant read access only to the deployment account and Administrators. The IIS directory contains proxy configuration only; Node source and secrets are separate.

Set the real BOT_TOKEN, owner IDs, and hashed admin password. The Windows root-mounted dashboard uses:

    NODE_ENV=production
    PORT=3000
    ADMIN_PORT=3000
    ADMIN_BASE_PATH=/
    FIREBASE_SERVICE_ACCOUNT_FILE=C:\Secure\ZaloBot\firebase-service-account.json
    TZ=Asia/Ho_Chi_Minh

Verify before PM2:

    npm run verify:firebase-admin
    npm run build:admin
    npm test

## 3. Configure the Node listener

main.js binds the admin server to 127.0.0.1 and uses ADMIN_PORT, then PORT, then 6003. Set both ports to 3000. IIS owns public port 443, so port 3000 needs no Internet firewall rule.

    npm start
    Test-NetConnection 127.0.0.1 -Port 3000
    Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing

Expect HTTP 200 and the ZaloBot admin page. Stop a foreground test with Ctrl+C; PM2 is used for production.

## 4. PM2 and reboot persistence

    npm install -g pm2
    pm2 start ecosystem.config.js --update-env
    pm2 status
    pm2 logs zalobot
    pm2 save

Create a Task Scheduler task named ZaloBot PM2 resurrect:

1. Open Task Scheduler -> Create Task (not Basic Task).
2. On General choose the same deployment account that owns PM2, Run whether user is logged on or not, and Run with highest privileges.
3. On Triggers add At startup. A 30-second delay is useful on slow servers.
4. On Actions configure:

    Program: C:\Program Files\nodejs\pm2.cmd
    Arguments: resurrect
    Start in: C:\Apps\ZaloBot

5. Clear AC-power-only restrictions on a server.
6. Save, run once manually, reboot, and verify pm2 status reports zalobot online.

Do not use pm2 startup, systemctl, or service; those are Linux-only.

## 5. Install URL Rewrite and ARR

Download the current official Microsoft IIS installers:

    https://www.iis.net/downloads/microsoft/url-rewrite
    https://www.iis.net/downloads/microsoft/application-request-routing

Run both installers as Administrator, then:

    iisreset
    Get-WebGlobalModule | Where-Object Name -Match 'Rewrite|Request|ARR' | Select-Object Name,ImagePath

In IIS Manager select the server node -> Application Request Routing Cache -> Server Proxy Settings -> check Enable proxy -> Apply. ARR forwards the URL Rewrite target to Node.

## 6. Create the IIS site and application pool

### GUI

1. Application Pools -> Add Application Pool.
2. Name it ZaloBot; select No Managed Code, Integrated pipeline, and Start immediately.
3. Advanced Settings: Start Mode AlwaysRunning and Idle Time-out (minutes) 0.
4. Sites -> Add Website.
5. Site name ZaloBot; physical path C:\inetpub\zalobot-proxy; application pool ZaloBot.
6. Add an HTTP binding on port 80 with host zalobot.mrnauthdev.dpdns.org when HTTP-01 validation or redirect testing is needed. Add HTTPS after the certificate exists.

The app pool serves web.config only. PM2 runs Node.js.

### PowerShell

    Import-Module WebAdministration
    New-WebAppPool -Name ZaloBot -Force
    Set-ItemProperty IIS:\AppPools\ZaloBot -Name managedRuntimeVersion -Value ''
    Set-ItemProperty IIS:\AppPools\ZaloBot -Name managedPipelineMode -Value 0
    Set-ItemProperty IIS:\AppPools\ZaloBot -Name startMode -Value AlwaysRunning
    Set-ItemProperty IIS:\AppPools\ZaloBot -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
    New-Website -Name ZaloBot -PhysicalPath C:\inetpub\zalobot-proxy -ApplicationPool ZaloBot -Port 80 -HostHeader zalobot.mrnauthdev.dpdns.org

## 7. Create web.config

    Copy-Item C:\Apps\ZaloBot\deployment\windows\web.config C:\inetpub\zalobot-proxy\web.config -Force
    Get-Content C:\inetpub\zalobot-proxy\web.config

The complete XML is:

    <configuration>
      <system.webServer>
        <rewrite>
          <rules>
            <rule name="ZaloBot HTTP to HTTPS" stopProcessing="true">
              <match url="(.*)" />
              <conditions>
                <add input="{HTTPS}" pattern="^OFF$" />
              </conditions>
              <action type="Redirect" url="https://zalobot.mrnauthdev.dpdns.org/{R:0}" redirectType="Permanent" appendQueryString="true" />
            </rule>
            <rule name="ZaloBot reverse proxy" stopProcessing="true">
              <match url="(.*)" />
              <action type="Rewrite" url="http://127.0.0.1:3000/{R:0}" appendQueryString="true" />
            </rule>
          </rules>
        </rewrite>
      </system.webServer>
    </configuration>

configuration is the XML root. system.webServer scopes settings to IIS. rewrite/rules evaluates rules in order. The first rule redirects only when HTTPS is OFF, preventing HTTPS loops. The second captures the entire relative URL as {R:0}; / becomes http://127.0.0.1:3000/ and /api/admin/dashboard remains the same path. appendQueryString preserves query parameters. stopProcessing prevents later rules from changing a request.

ARR performs the outbound proxy after Rewrite. IIS/ARR preserves Host by default and supplies forwarding metadata. ZaloBot is a Node HTTP server rather than Express, so app.set('trust proxy', 1) is not applicable. Production forces Secure cookies and the admin server recognizes X-Forwarded-Proto when present.

## 8. HTTPS binding and certificates

In IIS Manager select Sites -> ZaloBot -> Bindings -> Add. Set Type https, IP All Unassigned, Port 443, Host name zalobot.mrnauthdev.dpdns.org, enable SNI when sharing the IP, and select a certificate whose subject/SAN matches the hostname.

Expected binding:

    https *:443:zalobot.mrnauthdev.dpdns.org sslFlags=1

Verify:

    Get-WebBinding -Name ZaloBot -Protocol https | Select-Object bindingInformation,certificateHash,certificateStoreName,sslFlags

### win-acme / WACS

1. Download the current release from https://www.win-acme.com/ and extract to C:\Tools\win-acme.
2. Run C:\Tools\win-acme\wacs.exe as Administrator.
3. Choose Create certificate (N), IIS source, site ZaloBot, and hostname zalobot.mrnauthdev.dpdns.org.
4. Select the Windows Certificate Store and IIS installation/binding steps.
5. Choose HTTP-01 (requires TCP 80 and an HTTP binding) or DNS-01. With Cloudflare proxying, use DNS-only during HTTP-01 if required.
6. Confirm issuance and allow WACS to create its renewal scheduled task.
7. Keep private keys out of C:\Apps\ZaloBot. After issuance use Cloudflare Full (strict).

A Cloudflare Origin Certificate is an alternative when all clients use Cloudflare. Install it in Cert:\LocalMachine\My and bind it to IIS; it is not browser-trusted for direct origin access.

    Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -Match 'zalobot\.mrnauthdev\.dpdns\.org' | Select-Object Subject,Thumbprint,NotAfter
    Get-WebBinding -Name ZaloBot -Protocol https | Select-Object bindingInformation,certificateHash,certificateStoreName,sslFlags

Check Task Scheduler Library -> win-acme for renewal.

## 9. Cloudflare and firewall

Create an A or AAAA record for zalobot.mrnauthdev.dpdns.org pointing to the Windows Server and set it to Proxied. Set SSL/TLS to Full (strict). Cloudflare connects to IIS HTTPS, never directly to Node port 3000.

    New-NetFirewallRule -DisplayName 'IIS HTTPS 443' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
    New-NetFirewallRule -DisplayName 'IIS HTTP 80 for ACME' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
    Get-NetFirewallRule -Enabled True | Where-Object DisplayName -Match 'IIS|HTTP|HTTPS' | Select-Object DisplayName,Enabled,Direction,Action

Remove port 80 after HTTP-01 if not needed. Do not create a public 3000 rule.

## 10. HTTP to HTTPS redirect

The first web.config rule redirects HTTP to https://zalobot.mrnauthdev.dpdns.org/{path}. Cloudflare must use Full or Full (strict), never Flexible; Flexible can cause redirect loops because the origin receives HTTP.

## 11. End-to-end validation

1. Node: Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing and Test-NetConnection 127.0.0.1 -Port 3000; expect 200.
2. IIS HTTP: request http://zalobot.mrnauthdev.dpdns.org/ with port 80 enabled; expect redirect to HTTPS.
3. IIS HTTPS: Invoke-WebRequest https://zalobot.mrnauthdev.dpdns.org/ -UseBasicParsing; expect 200.
4. Browser: verify CSS, JavaScript, login, dashboard tabs, and API calls.
5. Bot: verify Zalo connection, a safe command, scheduler startup, and a test notification.
6. Restart: pm2 restart zalobot --update-env, then repeat public HTTPS and login checks.
7. Reboot Windows and confirm W3SVC, Task Scheduler PM2 task, pm2 status, Firestore state, IIS HTTPS, Cloudflare, dashboard, and bot.

## 12. Troubleshooting matrix

| Symptom | Likely cause | Diagnostic | Fix |
|---|---|---|---|
| 500.19 | Invalid web.config or missing Rewrite | IIS log and Get-Content | Fix XML or install URL Rewrite |
| 500.50 / 500.52 | Rewrite or ARR configuration | appcmd rewrite rules | Correct rule and enable ARR proxy |
| 502.3 | Node stopped, wrong port, or unreachable | localhost request, Test-NetConnection, pm2 status | Restart PM2 and use 127.0.0.1:3000 |
| 404 | Wrong binding or base path | Compare localhost/public URI | Keep ADMIN_BASE_PATH=/ and root binding |
| 403 | NTFS permissions or request filtering | IIS log | Grant site read access and review filtering |
| 525 / 526 | Cloudflare origin TLS failure | Certificate and Get-WebBinding | Bind matching certificate and use Full (strict) |
| Assets 404 | Incorrect frontend base path | Browser Network tab | Keep <base href="./"> and run npm run build:admin |
| Login loop | Secure cookie or hostname mismatch | Browser cookies | Use HTTPS hostname and ADMIN_BASE_PATH=/ |
| WebSocket failure | Future feature lacks IIS WebSocket support | Browser network log | Install WebSocket Protocol and configure ARR; current ZaloBot does not use it |
| Firebase failure | Missing/invalid service account | npm run verify:firebase-admin and PM2 logs | Fix path, JSON, IAM permissions, or clock sync |

Debug in order: Node, PM2, IIS binding, URL Rewrite, ARR, certificate, Cloudflare, public HTTPS. Change one layer at a time.

## 13. IIS logs and diagnostics

IIS logs are stored under C:\inetpub\logs\LogFiles. Focus on sc-status, sc-substatus, sc-win32-status, request URI, and time taken.

    Get-ChildItem C:\inetpub\logs\LogFiles -Recurse -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 10
    $log = Get-ChildItem C:\inetpub\logs\LogFiles -Recurse -Filter *.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Get-Content $log.FullName -Tail 50
    Get-Website
    Get-WebBinding
    Get-WebAppPoolState -Name ZaloBot
    Get-WebGlobalModule | Select-Object Name,ImagePath
    Get-WindowsFeature Web-Server,Web-WebSockets
    & "$env:WINDIR\System32\inetsrv\appcmd.exe" list site
    & "$env:WINDIR\System32\inetsrv\appcmd.exe" list apppool
    & "$env:WINDIR\System32\inetsrv\appcmd.exe" list config "ZaloBot/" /section:system.webServer/rewrite/rules

## 14. Fresh-server acceptance checklist

- [ ] IIS role, management console, logging, filtering, and required features installed.
- [ ] URL Rewrite and ARR installed; ARR proxy enabled.
- [ ] C:\Apps\ZaloBot, C:\Secure\ZaloBot, and C:\inetpub\zalobot-proxy exist.
- [ ] npm ci, npm test, npm run build:admin, and Firebase verification pass.
- [ ] Node listens on 127.0.0.1:3000 and port 3000 is not public.
- [ ] PM2 process zalobot is online, saved, and resurrects after reboot.
- [ ] IIS site/app pool, web.config, binding, certificate, and WACS renewal are correct.
- [ ] Cloudflare is proxied with Full (strict); TCP 443 works and TCP 80 is limited.
- [ ] Dashboard assets, authentication, APIs, commands, scheduler, notifications, and Firestore restart recovery work.

## Final topology

    Internet
        |
        v
    Cloudflare DNS/CDN
        | HTTPS :443
        v
    IIS site ZaloBot
        |
    URL Rewrite + ARR
        | HTTP
        v
    127.0.0.1:3000
        |
    ZaloBot Node.js
       / \
    Zalo API  Firestore
