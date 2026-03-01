# openclaw-telegram-files

[![npm version](https://img.shields.io/npm/v/openclaw-telegram-files.svg)](https://www.npmjs.com/package/openclaw-telegram-files)
[![GitHub](https://img.shields.io/github/license/audichuang/openclaw-telegram-files)](https://github.com/audichuang/openclaw-telegram-files)

Telegram Mini App for managing agent workspace files on mobile.

## Overview

This plugin adds a `/files` command that opens a Telegram Mini App (WebApp) directly inside Telegram, allowing you to:

- Browse directories on the agent's filesystem
- View and edit text files with a mobile-friendly editor
- Create new files and folders
- Delete files and directories
- Search for files by name
- Toggle hidden file visibility

All operations are secured with token-based authentication, path whitelisting, and automatic token expiration.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) with Telegram channel configured
- Your gateway must be reachable over **HTTPS** (required by Telegram Mini Apps)

## Installation

```bash
openclaw plugins install openclaw-telegram-files
```

> **Note:** The npm package name is `openclaw-telegram-files`, but the plugin registers under the id `telegram-files`. All config keys use `telegram-files` (e.g. `plugins.entries.telegram-files.config.*`).

Add `--pin` to lock the exact version in your config, so `openclaw plugins update --all` will not auto-upgrade without confirmation:

```bash
openclaw plugins install openclaw-telegram-files --pin
```

## Setup Guide

### Step 1: Expose gateway over HTTPS

Telegram Mini Apps require HTTPS. Choose one of the following methods:

<details>
<summary><b>Option A: Tailscale Funnel (recommended for personal use)</b></summary>

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) shares your local service over HTTPS without port forwarding or DNS configuration.

```bash
# Install Tailscale (if not installed)
# macOS: brew install tailscale
# Linux: curl -fsSL https://tailscale.com/install.sh | sh

# Expose gateway port (default: 3117) via Funnel
tailscale funnel 3117
```

Your URL will be: `https://<hostname>.<tailnet>.ts.net`

Check your hostname with:
```bash
tailscale status | head -1
```

> **Important:** Tailscale Funnel is required for public HTTPS access. A regular Tailscale MagicDNS URL (`https://<hostname>.<tailnet>.ts.net` without Funnel) is only reachable within your tailnet — Telegram's servers cannot reach it and the Mini App will fail to load.

</details>

<details>
<summary><b>Option B: Cloudflare Tunnel (recommended for always-on servers)</b></summary>

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) creates a secure tunnel without opening ports.

```bash
# Install cloudflared
# macOS: brew install cloudflared
# Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/

# Quick tunnel (no Cloudflare account needed)
cloudflared tunnel --url http://localhost:3117

# Or create a named tunnel (requires Cloudflare account)
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
cloudflared tunnel run openclaw
```

</details>

<details>
<summary><b>Option C: ngrok (quick testing)</b></summary>

```bash
# Install ngrok
# https://ngrok.com/download

ngrok http 3117
```

> **Note**: Free ngrok URLs change on every restart. For persistent use, consider Tailscale or Cloudflare.

</details>

### Step 2: Configure the plugin

```bash
# Set your HTTPS URL (replace with your actual URL)
openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host.example.com"
```

> **Tip:** To confirm your gateway port, run `openclaw config get gateway.port` (default is `3117`). Make sure your HTTPS tunnel points to the same port.

### Step 3: (Optional) Restrict filesystem access

By default, only the user's home directory is accessible. To limit or expand access:

```bash
# Allow specific directories only
openclaw config set plugins.entries.telegram-files.config.allowedPaths '["/home/user/projects", "/opt/openclaw"]'

# macOS example
openclaw config set plugins.entries.telegram-files.config.allowedPaths '["/Users/you/Documents", "/Users/you/Projects"]'
```

### Step 4: Restart and verify

```bash
# Restart the gateway to load the plugin
openclaw restart

# Verify plugin is loaded
openclaw plugins list
```

Then send `/files` to your bot in Telegram. You should see a button to open the file manager.

## Configuration

| Key            | Type     | Default       | Description                                                                 |
| -------------- | -------- | ------------- | --------------------------------------------------------------------------- |
| `externalUrl`  | string   | required      | HTTPS URL where the gateway is reachable (used for Mini App button URL)     |
| `allowedPaths` | string[] | `[os.homedir()]` | Allowed filesystem paths. If empty, defaults to the user's home directory |

### Example Config

```json
{
  "plugins": {
    "entries": {
      "telegram-files": {
        "config": {
          "externalUrl": "https://my-server.ts.net",
          "allowedPaths": ["/home/user", "/opt/openclaw"]
        }
      }
    }
  }
}
```

## Usage

1. Send `/files` to your bot in Telegram
2. Tap the **Open File Manager** button
3. Browse, edit, create, or delete files from your phone

### Features

- **Directory browsing** — navigate the filesystem with breadcrumb path display
- **File editing** — full-screen textarea with save via Telegram MainButton
- **File metadata** — file size (KB/MB) and relative modification time (e.g. "2h ago")
- **Hidden files toggle** — show/hide dotfiles, preference saved in localStorage
- **New file** — tap "+ New File", enter a name, and start editing
- **New folder** — tap "+ New Folder" to create directories
- **Delete** — delete files or folders with confirmation dialog
- **Search** — search files by name within current directory (recursive, max 5 levels deep)
- **Binary protection** — binary files show a friendly "cannot edit" notice instead of garbled text

## Security

### Authentication Flow

1. User sends `/files` in Telegram
2. Bot generates a one-time pairing code (5-minute TTL)
3. Mini App exchanges the code for a session token
4. Session token expires after **24 hours** — user must re-run `/files` to get a new one

### Path Whitelisting

All API endpoints enforce path restrictions:

- If `allowedPaths` is configured, only those directories (and their children) are accessible
- If `allowedPaths` is empty (default), only the home directory is accessible
- Attempting to access paths outside the whitelist returns `403 Forbidden`

### Operation Logging

All write operations are logged to the gateway console:

```
[telegram-files] WRITE /home/user/file.txt by token a1b2c3d4...
[telegram-files] DELETE /home/user/old.txt by token a1b2c3d4...
[telegram-files] MKDIR /home/user/new-dir by token a1b2c3d4...
```

## API Reference

All endpoints are under `/plugins/telegram-files/api/` and require `Authorization: Bearer <token>` (except exchange).

| Method | Endpoint       | Description                        |
| ------ | -------------- | ---------------------------------- |
| POST   | `/api/exchange`| Exchange pairing code for token    |
| GET    | `/api/ls`      | List directory (`?path=`)          |
| GET    | `/api/read`    | Read file content (`?path=`)       |
| POST   | `/api/write`   | Write file (`{ path, content }`)   |
| POST   | `/api/mkdir`   | Create directory (`{ path }`)      |
| DELETE | `/api/delete`  | Delete file/dir (`?path=`)         |
| GET    | `/api/search`  | Search files (`?path=&q=`)         |

## Layout

```
telegram-files/
├── openclaw.plugin.json     # Plugin metadata and config schema
├── package.json
├── index.ts                 # Plugin entry point
├── src/
│   ├── register.ts          # Command + HTTP API registration
│   ├── api-handlers.ts      # File operation handlers (ls/read/write/delete/search)
│   ├── auth.ts              # Token auth (issue/check/evict)
│   ├── pairing.ts           # One-time pairing code store
│   ├── path-utils.ts        # Path traversal prevention + search
│   ├── runtime.ts           # OpenClaw runtime bridge
│   └── static-server.ts     # Static file server for webapp
├── dist/webapp/             # Built webapp assets (auto-generated)
└── webapp/
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── main.ts           # Webapp entry
        ├── app.ts            # Routing (dir list ↔ editor)
        ├── utils.ts          # Utility helpers
        ├── services/
        │   ├── auth.ts       # Token exchange
        │   ├── files-api.ts  # REST client
        │   └── telegram.ts   # Telegram WebApp SDK
        ├── views/
        │   ├── file-list.ts  # Directory browser
        │   └── file-editor.ts # File editor
        └── styles/
            └── theme.css     # Telegram theme integration
```

## Troubleshooting

### "Please set externalUrl" error

Set the external URL where your gateway is reachable over HTTPS:

```bash
openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"
```

### Mini App shows "unauthorized"

The session token has expired (24h TTL). Send `/files` again to get a fresh pairing code.

### Cannot access certain directories

Check your `allowedPaths` configuration. By default, only the home directory is accessible. Add paths as needed:

```bash
openclaw config set plugins.entries.telegram-files.config.allowedPaths '["/path/to/allow"]'
```

### Binary file error

Binary files (images, executables, etc.) cannot be edited as text. The editor will show a "Binary File" notice.

## License

MIT
