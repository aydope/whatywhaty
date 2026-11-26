const { spawn } = require("node:child_process");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");

const SECRETS = {
  JWT_ACCESS_SECRET: "test_access_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  JWT_REFRESH_SECRET: "test_refresh_secret_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  COOKIE_SECRET: "test_cookie_secret_cccccccccccccccccccccccccccc",
};

const startServer = async ({ port, env = {} }) => {
  const child = spawn("node", [path.join(__dirname, "../src/app.js")], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      MONGODB_URI:
        process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/whatywhaty_test",
      REDIS_URL: process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379",
      ...SECRETS,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    base,
    child,
    output: () => output,
    isAlive: async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    },
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
};

const cookieString = (res) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");

const createClient = (base) => {
  let ipCounter = 0;
  const nextIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  const request = async (method, url, { body, cookie, headers = {}, ip } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: {
        accept: "application/json",
        // Distinct client addresses keep the per-IP rate limits out of the way.
        "x-forwarded-for": ip || nextIp(),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, res, text };
  };

  let counter = 0;
  const register = async (prefix = "user") => {
    const username = `${prefix}${Date.now().toString(36)}${counter++}`.slice(0, 28);
    const res = await request("POST", "/auth/register", {
      body: { username, email: `${username}@example.com`, password: "Passw0rd!x" },
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.text}`);
    const cookie = cookieString(res.res);
    const token = cookie.match(/accessToken=([^;]+)/)[1];
    const userId = jwt.decode(token).userId;
    return { username, email: `${username}@example.com`, cookie, userId };
  };

  const connectSocket = (cookie, { transports = ["websocket"], useCookieOnly = false } = {}) =>
    new Promise((resolve, reject) => {
      const token = cookie?.match(/accessToken=([^;]+)/)?.[1];
      const socket = io(base, {
        transports,
        extraHeaders: cookie ? { cookie } : {},
        auth: token && !useCookieOnly ? { token } : {},
        reconnection: false,
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });

  return { request, register, connectSocket };
};

const waitFor = (socket, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, createClient, waitFor, sleep, SECRETS };
