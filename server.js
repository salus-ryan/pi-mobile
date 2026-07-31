#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const port = Number(option("--port", process.env.PI_MOBILE_PORT ?? "4789"));
const cwd = resolve(option("--cwd", process.env.PI_MOBILE_CWD ?? process.cwd()));
const noOpen = args.includes("--no-open") || process.env.PI_MOBILE_NO_OPEN === "1";
const separator = args.indexOf("--");
const extraPiArgs = separator >= 0 ? args.slice(separator + 1) : [];
const token = process.env.PI_MOBILE_TOKEN || randomBytes(24).toString("base64url");
const clients = new Set();
const pending = new Map();
let rpcBuffer = "";
let stderrTail = "";
let shuttingDown = false;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("pi-mobile: --port must be between 1 and 65535");
  process.exit(2);
}

const agent = spawn("pi", ["--mode", "rpc", ...extraPiArgs], {
  cwd,
  env: { ...process.env, PI_MOBILE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(line);
}

function handleRpcRecord(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
  } catch (error) {
    broadcast({ type: "pi_mobile_protocol_error", error: String(error), line: line.slice(0, 500) });
    return;
  }

  if (event.type === "response" && event.id && pending.has(event.id)) {
    const waiter = pending.get(event.id);
    pending.delete(event.id);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }
  broadcast(event);
}

agent.stdout.on("data", (chunk) => {
  rpcBuffer += chunk.toString("utf8");
  while (true) {
    const newline = rpcBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = rpcBuffer.slice(0, newline);
    rpcBuffer = rpcBuffer.slice(newline + 1);
    handleRpcRecord(line);
  }
});

agent.stdout.on("end", () => {
  if (rpcBuffer) handleRpcRecord(rpcBuffer);
  rpcBuffer = "";
});

agent.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk.toString("utf8")).slice(-12000);
});

agent.on("error", (error) => {
  broadcast({ type: "pi_mobile_agent_error", error: String(error) });
});

agent.on("exit", (code, signal) => {
  for (const { resolve: finish, timer } of pending.values()) {
    clearTimeout(timer);
    finish({ type: "response", command: "agent", success: false, error: `Pi exited (${code ?? signal})` });
  }
  pending.clear();
  broadcast({ type: "pi_mobile_agent_exit", code, signal });
  if (!shuttingDown) console.error(`\nPi RPC exited (${code ?? signal}).`);
});

function send(command, timeoutMs = 30000) {
  if (!agent.stdin.writable) {
    return Promise.resolve({ type: "response", command: command.type, success: false, error: "Pi is not running" });
  }
  const id = command.id || randomUUID();
  const message = { ...command, id };
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolvePromise({ type: "response", id, command: command.type, success: false, error: "RPC response timed out" });
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, timer });
    agent.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function sendWithoutResponse(message) {
  if (agent.stdin.writable) agent.stdin.write(`${JSON.stringify(message)}\n`);
}

function authorized(req, url) {
  const header = req.headers.authorization;
  return header === `Bearer ${token}` || url.searchParams.get("token") === token;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 12 * 1024 * 1024) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function staticFile(pathname, res) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": pathname === "/" ? "no-cache" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname === "/events") {
      if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized" });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "pi_mobile_connected" })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized" });
      const command = await bodyJson(req);
      if (!command || typeof command.type !== "string") return json(res, 400, { error: "Command type is required" });
      if (command.type === "extension_ui_response") {
        sendWithoutResponse(command);
        return json(res, 200, { success: true });
      }
      const response = await send(command, command.type === "compact" ? 180000 : 30000);
      return json(res, response.success === false ? 400 : 200, response);
    }

    if (url.pathname === "/api/info") {
      if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized" });
      return json(res, 200, { cwd, port, pid: process.pid, agentPid: agent.pid, agentRunning: agent.exitCode === null });
    }

    if (url.pathname === "/api/logs") {
      if (!authorized(req, url)) return json(res, 401, { error: "Unauthorized" });
      return json(res, 200, { stderr: stderrTail });
    }

    if (await staticFile(url.pathname, res)) return;
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const heartbeat = setInterval(() => {
  for (const client of clients) client.write(": heartbeat\n\n");
}, 20000);
heartbeat.unref();

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  server.close();
  agent.kill("SIGTERM");
  setTimeout(() => agent.kill("SIGKILL"), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  if (agent.exitCode === null) agent.kill("SIGTERM");
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  console.log("\nPi Mobile is ready");
  console.log(`Project: ${cwd}`);
  console.log(`Open:    ${url}\n`);
  if (!noOpen) {
    const opener = spawn("termux-open-url", [url], { stdio: "ignore", detached: true });
    opener.unref();
  }
});
