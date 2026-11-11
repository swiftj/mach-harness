// Starts the real host for a project and speaks HTTP to it with full control of every header.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { engine } from "./env.mjs";

export function startHost(binary, project, env, extraArgs = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["--no-open", "--project", project, "--engine", engine, ...extraArgs], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`host did not print its address within 30s:\n${output}`));
    }, 30000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = !settled && output.match(/Open: (http:\/\/127\.0\.0\.1:(\d+)\/\?t=(\S+))/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        const origin = new URL(match[1]).origin;
        resolvePromise({
          url: match[1],
          origin,
          port: Number(match[2]),
          token: match[3],
          child,
          logs: () => output,
          stop: () =>
            new Promise((done) => {
              if (child.exitCode !== null) return done();
              child.once("exit", () => done());
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 10000).unref();
            }),
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`host exited (${code}) before printing its address:\n${output}`));
      }
    });
  });
}

/** One raw HTTP request. `headers` are sent exactly as given (Host included). */
export function raw({ address = "127.0.0.1", port, method = "GET", path, headers = {}, body }) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: address, port, method, path, headers, setHost: false, timeout: 200000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** An API client that speaks to the host exactly as the app does. */
export async function apiClient(host) {
  const hostHeader = `127.0.0.1:${host.port}`;
  const login = await raw({ port: host.port, path: `/?t=${host.token}`, headers: { Host: hostHeader } });
  if (login.status !== 303) throw new Error(`token exchange: HTTP ${login.status} ${login.text}`);
  const setCookie = [].concat(login.headers["set-cookie"] || []);
  const cookie = setCookie[0].split(";")[0];
  const base = { Host: hostHeader, Cookie: cookie };
  const session = await raw({ port: host.port, path: "/api/session", headers: base });
  const csrf = session.json.data.csrf_token;
  const client = {
    cookie,
    setCookie,
    csrf,
    session: session.json.data,
    hostHeader,
    get: (path, headers = {}) => raw({ port: host.port, path, headers: { ...base, ...headers } }),
    send: (method, path, body, headers = {}) =>
      raw({
        port: host.port,
        method,
        path,
        body: body ?? {},
        headers: { ...base, Origin: `http://${hostHeader}`, "X-MACH-CSRF": csrf, "Content-Type": "application/json", ...headers },
      }),
    /** One engine operation; returns the envelope. */
    op: async (operation, args = {}) => (await client.send("POST", `/api/ops/${operation}`, args)).json,
  };
  return client;
}
