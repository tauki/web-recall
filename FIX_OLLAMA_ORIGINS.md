# 🔐 Allow Chrome Extension Access to Ollama (CORS Configuration)

By default, the local Ollama server only accepts requests from trusted origins.
To securely connect your Chrome Extension to http://127.0.0.1:11434, you must explicitly allow your extension’s origin.

Unfortunately, Ollama does not currently provide a built-in way to set OLLAMA_ORIGINS via its GUI or config files.
Which is a shame, but we can work around this by setting environment variables for the Ollama service.

This guide explains how to configure OLLAMA_ORIGINS across macOS, Linux, and Windows, and how to verify that everything is working.

---

## 🧩 1. Identify Your Extension Origin

Every Chrome extension has a unique ID, visible under chrome://extensions.

Example:

chrome-extension://<extension-id>

This full URL prefix is your extension origin — you’ll use it in the configuration steps below.

---

## 🍏 macOS: Set OLLAMA_ORIGINS with LaunchAgent

The Ollama app runs as a background service managed by launchd.
To make your extension origin permanent, set it via a LaunchAgent.

### 1️⃣ Create a new plist file

```bash
mkdir -p ~/Library/LaunchAgents
nano ~/Library/LaunchAgents/ai.ollama.origin.plist
```

Paste the following XML (update USERNAME and your extension ID if needed):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.ollama.serve</string>

    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/ollama</string>
      <string>serve</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>OLLAMA_ORIGINS</key>
      <string>chrome-extension://<extension-id></string>
    </dict>

    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/ollama-serve.out</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/ollama-serve.err</string>
  </dict>
</plist>
```

Tip: Replace /usr/local/bin/ollama with /opt/homebrew/bin/ollama on Apple Silicon.

---

### 2️⃣ Load the new configuration

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.ollama.origin.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ollama.origin.plist
launchctl enable gui/$(id -u)/ai.ollama.serve
launchctl kickstart -k gui/$(id -u)/ai.ollama.serve
```

---

### 3️⃣ Verify the environment variable

```bash
lsof -nP -iTCP:11434 -sTCP:LISTEN
# Find the PID of the Ollama process:
PID=<the_pid_here>

ps eww -p $PID | tr ' ' '\n' | grep ^OLLAMA_ORIGINS=
```

Expected output:

```text
OLLAMA_ORIGINS=chrome-extension://<extension-id>
```

---

### 4️⃣ Test it from your extension

manifest.json
```json
{
  "manifest_version": 3,
  "name": "My Extension",
  "version": "0.0.1",
  "host_permissions": [
    "http://127.0.0.1:11434/*"
  ]
}
```

popup.js or offscreen.js
```js
async function chat() {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-oss:latest',
      messages: [{ role: 'user', content: 'Hello Ollama!' }],
      stream: false
    })
  });
  console.log(await res.json());
}
chat();
```

---

### 5️⃣ Revert to default

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.ollama.origin.plist
rm ~/Library/LaunchAgents/ai.ollama.origin.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ollama.ollama.plist 2>/dev/null || true
```

---

## 🐧 Linux: Set OLLAMA_ORIGINS with systemd

Most Linux systems run Ollama as a systemd service.

### 1️⃣ Add the environment variable

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment=OLLAMA_ORIGINS=chrome-extension://<extension-id>
EOF

sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama --no-pager
```

If Ollama runs as a user service:

```bash
systemctl --user edit ollama
```

and add the same [Service] block.

---

### 2️⃣ Verify

```bash
curl -i -X OPTIONS \
  -H 'Origin: chrome-extension://<extension-id>' \
  -H 'Access-Control-Request-Method: POST' \
  http://127.0.0.1:11434/api/chat | head
```

Expected:

```http
Access-Control-Allow-Origin: chrome-extension://<extension-id>
```

---

### 3️⃣ Docker example

```bash
docker run -d --name ollama \
  -p 11434:11434 \
  -e OLLAMA_ORIGINS=chrome-extension://<extension-id> \
  ollama/ollama:latest
```

docker-compose.yml
```yaml
services:
  ollama:
    image: ollama/ollama:latest
    ports: ["11434:11434"]
    environment:
      - OLLAMA_ORIGINS=chrome-extension://<extension-id>
```

---

### 4️⃣ Revert

```bash
sudo rm /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

---

## 🪟 Windows: Set OLLAMA_ORIGINS via Environment Variable

Ollama on Windows runs as a service.
You can allow your extension by defining the variable system-wide.

### 1️⃣ Set the variable (Admin PowerShell)

```powershell
[Environment]::SetEnvironmentVariable(
  "OLLAMA_ORIGINS",
  "chrome-extension://<extension-id>",
  "Machine"
)
```

Or set it via Control Panel → System → Advanced → Environment Variables…

---

### 2️⃣ Restart the Ollama service

```powershell
Restart-Service -Name ollama
```

If that fails, open Services (services.msc) and restart the Ollama service manually.

---

### 3️⃣ Verify

```powershell
[Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS","Machine")

Invoke-WebRequest -Method Options `
  -Uri http://127.0.0.1:11434/api/chat `
  -Headers @{ Origin = "chrome-extension://<extension-id>"; "Access-Control-Request-Method"="POST" } `
  -UseBasicParsing | Select-String "Access-Control-Allow-Origin"
```

---

### 4️⃣ Revert

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $null, "Machine")
Restart-Service -Name ollama
```

---

## 🌐 Chrome Extension Requirements (All Platforms)

1. Use http://127.0.0.1:11434 instead of localhost — it consistently includes the correct Origin header.
2. manifest.json must include:

```json
{
  "manifest_version": 3,
  "host_permissions": [
    "http://127.0.0.1:11434/*",
    "http://localhost:11434/*"
  ]
}
```

3. If you call from a background service worker:
   - The Origin header might be missing.
   - Use a popup/offscreen page to perform the fetch, or inject the header with webRequest:

```js
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => ({
    requestHeaders: [...details.requestHeaders, { name: 'Origin', value: 'chrome-extension://' + chrome.runtime.id }]
  }),
  { urls: ["http://127.0.0.1:11434/*"] },
  ["blocking", "requestHeaders", "extraHeaders"]
);
```

---

## 🧠 Troubleshooting

| Symptom                               | Cause                               | Fix                                                       |
|---------------------------------------|-------------------------------------|-----------------------------------------------------------|
| 403 Forbidden on POST                 | Request had no Origin header        | Run from extension page/offscreen doc or inject header    |
| Works with 127.0.0.1 but not localhost| Browser omits Origin on localhost   | Use 127.0.0.1 consistently                                |
| Preflight fails (no ACAO headers)     | Wrong extension ID or CORS not applied | Check OLLAMA_ORIGINS and restart service               |
| Change didn’t apply                   | Service not restarted               | Restart Ollama and verify via PID environment             |
| Extension can’t reach API             | Missing host_permissions            | Add 127.0.0.1 and localhost URLs                          |

---

## ✅ Summary

1. Identify your Chrome extension ID
2. Set OLLAMA_ORIGINS for your platform
3. Restart Ollama
4. Use http://127.0.0.1:11434 in all extension calls
5. Test with fetch() or curl
