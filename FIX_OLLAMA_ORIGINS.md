# Allow Web Recall to access Ollama

If Ollama responds with **HTTP 403**, it may be rejecting the extension's origin.
This is an access configuration problem, not a missing or incomplete embedding.
Changing the embedding model or retrying individual passages will not fix it.

1. Open `chrome://extensions`, enable Developer mode, and copy Web Recall's ID.
2. Add `chrome-extension://YOUR_EXTENSION_ID` to `OLLAMA_ORIGINS` on the machine
   running Ollama. Keep any other origins you intentionally use, separated by commas.
3. Restart Ollama, then retry the failed operation. In Memory Manager, use
   **Backfill missing**; leave **Force re-embed all** unchecked.

Use the ID of the extension you actually loaded. An unpacked checkout, a separate
worktree and a Chrome Web Store installation may have different IDs. The error
message includes the requesting extension's exact origin.

## macOS app

Quit Ollama from its menu bar icon. In Terminal, run the following with your actual ID,
then reopen the Ollama app:

```sh
launchctl setenv OLLAMA_ORIGINS "chrome-extension://YOUR_EXTENSION_ID"
```

This sets the environment for applications started in the current login session.
If you already manage Ollama with a LaunchAgent or another service manager, add the
variable to that existing service configuration and restart that service instead
of creating a second server.

## Terminal server (macOS or Linux)

Stop the existing terminal server, then start it with:

```sh
OLLAMA_ORIGINS="chrome-extension://YOUR_EXTENSION_ID" ollama serve
```

## Linux systemd service

Run `sudo systemctl edit ollama.service` and add:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://YOUR_EXTENSION_ID"
```

Then run:

```sh
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

## Windows app

Quit Ollama from the taskbar. Add or edit the user environment variable
`OLLAMA_ORIGINS` in Windows' environment-variable settings, set it to
`chrome-extension://YOUR_EXTENSION_ID`, and restart Ollama from the Start menu.

## Verify

This checks access without generating embeddings or modifying your library:

```sh
curl -i -X OPTIONS \
  -H 'Origin: chrome-extension://YOUR_EXTENSION_ID' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  http://localhost:11434/api/embed
```

A successful response includes `Access-Control-Allow-Origin` for the extension.
A successful `curl` call **without** an Origin header does not establish that Chrome
can access the server. Both `localhost` and `127.0.0.1` work when configured correctly;
neither bypasses the server's origin rules. No extra extension permissions or header
rewriting are needed.

Web Recall does not impose an inference deadline: slow local embeddings, answers,
query rewriting and reranking can finish in their own time. Use **Stop** in Ask,
Search or Memory Manager's embedding backfill to cancel the active request. Connection checks and model-list requests still have short
timeouts because they do not perform inference. Server, proxy, browser shutdown or
network failures can still interrupt requests.

See the [official Ollama FAQ](https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama)
for environment configuration on other installations.
