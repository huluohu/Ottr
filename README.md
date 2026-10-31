<div align="center">

<img src="docs/screenshots/mark.svg" alt="Ottr" width="140" />

# Ottr

### An AI-native personal server manager

*Swim through your servers.*

**Open source · Free · macOS / Windows / Linux · Your data stays yours**

[![GitHub](https://img.shields.io/badge/GitHub-huluohu%2FOttr-0F172A)](https://github.com/huluohu/Ottr)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-14B8A6)](#-download--install)
[![License](https://img.shields.io/badge/license-MIT-5EEAD4)](#-license--author)

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Italiano](README.it.md)

</div>

---

**Ottr** is a lightweight, open-source AI SSH client — about 8 MB installed (84 MB for the AppImage), roughly 100 MB of resident memory, no background service and no agent to install. It turns "connect to a server and type commands" into "your terminal understands AI": failed commands are diagnosed for you, commands are generated from plain language, and your history is searchable from anywhere.

The hard rule it never breaks: **you bring your own AI key (BYOK)**. Requests go straight from your machine to the model endpoint you picked — there is no Ottr server in the middle. Secrets are encrypted at rest on your own machine; host metadata and command history live in a local SQLite file. The exact data boundary for AI requests and optional sync is described in [Privacy & AI](#-privacy--ai-data-boundaries).

![Welcome screen: time-of-day greeting, quick actions and the icon rail](docs/screenshots/home-welcome.png)

## ✨ What it does

### Terminal & sessions

- **Tabs and split panes** (side by side or stacked), GPU-accelerated rendering, search, URL detection, full escape-sequence support
- **Encoding that adapts**: UTF-8 / GBK / GB18030 detected automatically and switchable by hand — essential for Chinese Windows servers
- **Self-healing connections**: automatic reconnect with backoff, keepalive dead-link detection, a connection health light, and tabs restored after a restart
- **Session recording** in [asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/) format, with an in-app timeline player (scrub, speed up) and export as **redacted text** you can share

### Hosts & credentials

- Groups, tags, search and **⌘K fuzzy quick-connect**; import and export support `~/.ssh/config`, Tabby (JSON/YAML), Xshell sessions and CSV — exports carry host metadata only, never secrets
- Credential vault: passwords, SSH keys (ed25519/ecdsa/rsa — generate, import, deploy the public key) and TOTP two-factor, bound to hosts and **nameable**, so one credential can serve several hosts
- **Jump host chains** arranged visually; **port forwarding** for local, dynamic SOCKS and remote forwards, re-established automatically after a drop
- known_hosts with **trust-on-first-use plus periodic fingerprint audits**, to catch man-in-the-middle attacks

![Dark theme: icon rail, host panel, floating tab islands and connection status dots](docs/screenshots/main-dark.png)

### AI that respects your data

- **Diagnose on failure**: a non-zero exit surfaces the likely cause and a suggested fix; nothing runs without your confirmation, and risky commands are flagged in red
- **⌘J to generate a command**: describe what you want in Chinese or English and get a single line back, anchored to the current directory
- **Select to explain**: right-click any selected text to explain, translate or repair it; sessions can end with an auto-generated summary, searchable with ⌘R
- **BYOK across many providers**: OpenAI-compatible endpoints (**OpenAI / DeepSeek / Zhipu GLM / any endpoint you host**), Anthropic Claude, and local Ollama — presets fill in the endpoint for you, and keys are encrypted on your machine
- **Redaction by rule**: matches in diagnostics, explanations and summaries are replaced with placeholders. This cannot be guaranteed to catch every secret; natural-language command input and the current directory context are **not** redacted. Ottr also ships an MCP server (all three platforms) that any stdio MCP client — Claude Desktop, Cursor, … — can talk to, with per-host authorization and per-call approval

### Monitoring, alerts & operations

- **Agent-free monitoring**: live CPU / memory / disk / load / network charts and a process browser, with a multi-host overview
- **Alert rules** (disk, CPU, process, log keyword) routed through **12 notification channels**: WeCom, DingTalk, Feishu, Telegram, Slack, Discord, SMTP email and more, with rate limiting, retries and a durable delivery log
- **Scheduled tasks** run by a native scheduler (missed runs are recorded, not lost), plus **batch execution** across selected hosts with a snippet library, concurrency and timeout control

### Files & sync

- **Two-pane SFTP browser**: drag-and-drop transfer, parallel chunks, resumable uploads; trzsz (trz/tsz) supported; FTP and FTPS too
- **Remote editing** in your local editor with atomic saves (a failure never corrupts the remote file) and binary sniffing to prevent accidental edits
- **Multi-device sync** through an end-to-end encrypted envelope (AES-256-GCM + PBKDF2) over one of three channels — **WebDAV, Git, or a local folder** (WebDAV goes through a native proxy straight to your own drive, with no cross-origin restrictions) — with per-category push/pull and a manual decision for each conflict

### Security you can audit

- Secrets and credentials are protected with **AES-256-GCM** (not whole-database encryption). Two modes: **keychain mode** is the default (the master key lives in your system keychain, so the app just opens), or **master-password mode** (Argon2id derivation — without the password, secret fields cannot be decrypted). Switch at any time; secrets are re-encrypted when you do
- Sensitive copies clear themselves on a schedule, and the lock screen offers a guided "forgot my password" reset (with confirmation; cloud backups are untouched)
- Ottr sends **no telemetry**. AI and sync features still send the data they need — that does not mean "no host data ever leaves your machine"

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="Command palette"></td>
    <td width="50%"><img src="docs/screenshots/cron.png" alt="Scheduled task center"></td>
  </tr>
  <tr>
    <td width="50%">⌘K command palette (fuzzy search)</td>
    <td width="50%">Scheduled task center</td>
  </tr>
</table>

<details>
<summary>More screenshots</summary>

![Multi-host overview](docs/screenshots/overview.png)
![Credential manager](docs/screenshots/credentials.png)

</details>

## 📦 Download & install

Grab the build for your platform from [**Releases**](https://github.com/huluohu/Ottr/releases):

| Platform | Formats |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` installer, or **`_x64_portable.zip` (no install needed)** |
| Linux | `.deb` / `.rpm` / `.AppImage` |

On first launch Ottr asks how you want to encrypt secret fields on this machine (not the whole database): **keychain mode** (no password to remember) or **master-password mode** (secret fields cannot be decrypted without it).

**Windows portable build**: unzip anywhere and run `Ottr.exe` — nothing is installed, and your configuration and data live next to the app in `Ottr/data/` (copy the folder to move your setup, delete it to uninstall; WebView2 is required, but Win10/11 usually ships it). The portable build cannot update itself — download the new zip and overwrite the old one, keeping `data/` to keep everything.

The installed build has **in-app updates** (Settings → About, signed packages only), and you can always come back to this page for a manual download.

<details>
<summary><strong>🍎 macOS says "damaged" or cannot reach your LAN? Open for the fix</strong></summary>

Ottr is not signed with an Apple Developer ID yet, so macOS treats it more strictly than usual — **the download is not corrupt**. Two steps and you are done.

**1️⃣ "Ottr is damaged and can't be opened. You should move it to the Trash."**

Open Terminal and run this once, then open Ottr normally (repeat after every update):

```bash
xattr -cr /Applications/Ottr.app
```

**2️⃣ "No route to host" when connecting to a machine on your LAN**

Since macOS 15, an app must be granted "Local Network" access before it can reach devices on your network. If the prompt appears, click **Allow**. If it never appears and the connection fails, pick one:

- **Launch Ottr from Terminal** (apps started this way are not affected):

  ```bash
  /Applications/Ottr.app/Contents/MacOS/ottr &
  ```

- **Allow your LAN range once** (asks for an admin password; replace `192.168.9.0/24` with your own range, then restart):

  ```bash
  sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.9.0/24"
  sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.9.0/24"
  ```

  To restore the system default later, run these and restart once more:

  ```bash
  sudo defaults delete com.apple.network.local-network AllowedWiFiLocalNetworkAddresses
  sudo defaults delete com.apple.network.local-network AllowedEthernetLocalNetworkAddresses
  ```

Once Ottr ships with a proper Apple Developer ID signature, none of this will be needed.

</details>

## 🚀 Quick start

1. **Add a host**: "New host" in the sidebar (hover a group header and press **＋** to add straight into that group) or "Import ssh config"; double-click a host row to connect — the fingerprint is shown on first contact and never asked again once you trust it
2. **Turn on AI**: Settings → AI → add a provider (pick a preset such as Zhipu GLM, DeepSeek or Ollama and paste your key). After that, failed commands are diagnosed automatically, and **⌘J** turns a plain-language request into a command
3. **Set up alerts**: Settings → Alerts → add a notification channel (send a test message to verify it) → create a rule such as "root partition > 90%". The "notification types" section of the same page decides which events notify you at all
4. **Sync across devices**: install Ottr on the second device, choose a channel in Settings → Sync (for WebDAV, enter your drive URL), set a sync passphrase, then press **Sync now**
5. **Go further**: **⌘R** searches history, **⌘D** (Ctrl+⇧D on Windows/Linux) splits the pane, the "File" menu (macOS) imports and exports hosts, and the "Tools" menu (macOS) or the **⌘K** palette reach port forwarding, jump host chains, scheduled tasks, batch execution and the notification center (unread counts sit right on the icon rail and in the menus)

## 🔐 Privacy & AI data boundaries

- **Local storage**: SSH passwords, private keys, key passphrases and AI API keys are encrypted per field with AES-256-GCM. Host addresses, usernames, notes, command history and ordinary settings stay as plain text in a local SQLite file — locking the vault or setting a master password does not encrypt those. Sync uses its own encrypted envelope and does not change how the local database is stored.
- **Diagnostics and explanations**: a diagnostic sends the failed command and the tail of the terminal output (up to 8 KB); an explanation sends the text you selected. Before sending, rules replace IP addresses, password assignments, e-mail addresses and — if enabled — host names and your own custom patterns. Summaries apply similar rules to command sequences. Rules can miss secrets that do not look like the samples, internal names or business data; "N items redacted" counts matches, it is not a completeness guarantee. The panel may still show the original text locally.
- **Generating commands from plain language**: your request and the current directory (OSC 7) are sent to the model endpoint you chose as context, without the redaction above. Do not type passwords, tokens or anything you would not want sent. A direct connection does not stop the provider from receiving or keeping the content — that depends on the provider.
- **Ollama**: the preset endpoint is `http://localhost:11434/v1`. Processing is local only while the endpoint and the inference both stay on this machine; once you point it at a remote address, a proxy or a cloud model, we can no longer promise the content stays local.
- **Inserting AI commands**: only single-line text without newlines or control characters is accepted, and no carriage return is appended. Multi-line content is kept as-is and insertion is disabled — review it and prepare the command yourself; nothing is concatenated or truncated to the first line. The danger rating is a hint, not a proof that a command is safe. Still confirm that the terminal is in the state you expect before inserting, and check what is already typed; custom key bindings and interactive programs are not covered by this guarantee.

## 📄 License & author

**Ottr** is developed by [@huluohu](https://github.com/huluohu) and released under the [MIT](LICENSE-MIT) license — issues and pull requests are welcome. Repository: [github.com/huluohu/Ottr](https://github.com/huluohu/Ottr).

<div align="center">

*Swim through your servers.* 🦦

</div>
