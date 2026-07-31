# Pi Mobile

A touch-friendly localhost web interface for Pi running in Termux.

## Features

- Streaming Markdown with tappable links
- Stable, sticky mobile composer
- Image and camera attachments
- Collapsible tool activity
- Stop, new-session, model-cycle, and thinking-level controls
- Pi extension dialogs (`select`, `confirm`, `input`, and `editor`)
- Installable PWA shell
- No runtime npm dependencies
- Binds only to `127.0.0.1` and protects RPC endpoints with a random token

## Run

From the project you want Pi to work on:

```sh
pi-mobile
```

Or directly:

```sh
node ~/pi-mobile/server.js --cwd ~/my-project
```

The server prints an authenticated localhost URL and attempts to open it with `termux-open-url`.

Options:

```text
--port 4789       localhost port
--cwd PATH        Pi working directory
--no-open         do not launch the browser
-- PI_ARGS...     additional arguments passed to `pi --mode rpc`
```

Example:

```sh
pi-mobile --port 4790 -- --provider openai-codex --model gpt-5.6-sol
```

## Install the command

```sh
cd ~/pi-mobile
npm link
```

## Security

Pi Mobile listens only on Android loopback. API and event endpoints require the random bearer token shown in the launch URL. The static shell is intentionally public on loopback, but it cannot access Pi without the token. Do not change the bind address to `0.0.0.0` without adding TLS and stronger authentication.

Only one process should write to a given Pi session file at a time. Close the terminal Pi instance before opening the same session through Pi Mobile.
