import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(__dirname, "public");
const port = Number(process.env.PORT || 5174);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const allowedHosts = new Set(["api.nubra.io", "uatapi.nubra.io"]);
const authFlows = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function nubraBaseUrl(environment) {
  return environment === "uat" || environment === "UAT" || environment === "https://uatapi.nubra.io"
    ? "https://uatapi.nubra.io"
    : "https://api.nubra.io";
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function findString(payload, key) {
  if (!payload || typeof payload !== "object") return "";
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function extractError(payload, status) {
  if (payload && typeof payload === "object") {
    return payload.detail || payload.message || payload.error || `Nubra request failed with ${status}`;
  }
  if (typeof payload === "string" && payload.trim()) return payload;
  return `Nubra request failed with ${status}`;
}

async function nubraJson(method, url, headers, payload) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: payload == null ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function startAuth(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { detail: "method not allowed" });
    return;
  }

  try {
    const input = await readJson(req);
    const phone = digits(input.phone);
    if (phone.length < 10) {
      sendJson(res, 400, { detail: "Enter a valid Nubra phone number." });
      return;
    }

    const authMethod = input.auth_method === "totp" ? "totp" : "otp";
    const environment = input.environment === "uat" || input.environment === "UAT" ? "UAT" : "PROD";
    const deviceId = `Nubra-OSS-${phone}`;
    const flowId = randomId();

    if (authMethod === "totp") {
      authFlows.set(flowId, { phone, environment, deviceId, authMethod, createdAt: Date.now() });
      sendJson(res, 200, {
        flow_id: flowId,
        next_step: "totp",
        environment,
        device_id: deviceId,
        message: "TOTP mode enabled. Enter your authenticator code, then continue to MPIN verification."
      });
      return;
    }

    const baseUrl = nubraBaseUrl(environment);
    const first = await nubraJson("POST", `${baseUrl}/sendphoneotp`, {}, { phone, skip_totp: false });
    if (first.status >= 400) {
      sendJson(res, first.status, { detail: extractError(first.body, first.status) });
      return;
    }

    let tempToken = findString(first.body, "temp_token");
    if (!tempToken) {
      sendJson(res, 502, { detail: "Nubra did not return a temp token in login step 1." });
      return;
    }

    const second = await nubraJson(
      "POST",
      `${baseUrl}/sendphoneotp`,
      { "x-temp-token": tempToken, "x-device-id": deviceId },
      { phone, skip_totp: true }
    );
    if (second.status >= 400) {
      sendJson(res, second.status, { detail: extractError(second.body, second.status) });
      return;
    }

    tempToken = findString(second.body, "temp_token") || tempToken;
    authFlows.set(flowId, { phone, environment, deviceId, authMethod, tempToken, createdAt: Date.now() });
    sendJson(res, 200, {
      flow_id: flowId,
      next_step: "otp",
      environment,
      device_id: deviceId,
      message: "OTP sent. Verify the SMS OTP, then continue to MPIN verification."
    });
  } catch (error) {
    sendJson(res, 502, { detail: error.message || "Unable to start Nubra login." });
  }
}

async function verifyOtpAuth(req, res) {
  try {
    const input = await readJson(req);
    const flow = authFlows.get(input.flow_id);
    if (!flow) {
      sendJson(res, 404, { detail: "Login flow not found. Start login again." });
      return;
    }
    if (!/^\d+$/.test(String(input.otp || ""))) {
      sendJson(res, 400, { detail: "OTP must be numeric." });
      return;
    }

    const response = await nubraJson(
      "POST",
      `${nubraBaseUrl(flow.environment)}/verifyphoneotp`,
      { "x-temp-token": flow.tempToken, "x-device-id": flow.deviceId },
      { phone: flow.phone, otp: String(input.otp) }
    );
    if (response.status >= 400) {
      sendJson(res, response.status, { detail: extractError(response.body, response.status) });
      return;
    }
    const authToken = findString(response.body, "auth_token");
    if (!authToken) {
      sendJson(res, 502, { detail: "Nubra did not return auth_token after OTP verification." });
      return;
    }
    flow.authToken = authToken;
    authFlows.set(input.flow_id, flow);
    sendJson(res, 200, { flow_id: input.flow_id, next_step: "mpin", message: "OTP accepted. Continue with MPIN verification." });
  } catch (error) {
    sendJson(res, 502, { detail: error.message || "Unable to verify OTP." });
  }
}

async function verifyTotpAuth(req, res) {
  try {
    const input = await readJson(req);
    const flow = authFlows.get(input.flow_id);
    if (!flow) {
      sendJson(res, 404, { detail: "Login flow not found. Start login again." });
      return;
    }
    if (!/^\d+$/.test(String(input.totp || ""))) {
      sendJson(res, 400, { detail: "TOTP must be numeric." });
      return;
    }

    const response = await nubraJson(
      "POST",
      `${nubraBaseUrl(flow.environment)}/totp/login`,
      { "x-device-id": flow.deviceId },
      { phone: flow.phone, totp: Number(input.totp) }
    );
    if (response.status >= 400) {
      sendJson(res, response.status, { detail: extractError(response.body, response.status) });
      return;
    }
    const authToken = findString(response.body, "auth_token");
    if (!authToken) {
      sendJson(res, 502, { detail: "Nubra did not return auth_token after TOTP verification." });
      return;
    }
    flow.authToken = authToken;
    authFlows.set(input.flow_id, flow);
    sendJson(res, 200, { flow_id: input.flow_id, next_step: "mpin", message: "TOTP accepted. Continue with MPIN verification." });
  } catch (error) {
    sendJson(res, 502, { detail: error.message || "Unable to verify TOTP." });
  }
}

async function verifyMpinAuth(req, res) {
  try {
    const input = await readJson(req);
    const flow = authFlows.get(input.flow_id);
    if (!flow) {
      sendJson(res, 404, { detail: "Login flow not found. Start login again." });
      return;
    }
    if (!flow.authToken) {
      sendJson(res, 409, { detail: "OTP or TOTP must be verified first." });
      return;
    }
    if (!/^\d+$/.test(String(input.mpin || ""))) {
      sendJson(res, 400, { detail: "MPIN must be numeric." });
      return;
    }

    const response = await nubraJson(
      "POST",
      `${nubraBaseUrl(flow.environment)}/verifypin`,
      { Authorization: `Bearer ${flow.authToken}`, "x-device-id": flow.deviceId },
      { pin: String(input.mpin) }
    );
    if (response.status >= 400) {
      sendJson(res, response.status, { detail: extractError(response.body, response.status) });
      return;
    }
    const sessionToken = findString(response.body, "session_token") || findString(response.body, "token");
    if (!sessionToken) {
      sendJson(res, 502, { detail: "Nubra did not return session_token after MPIN verification." });
      return;
    }
    authFlows.delete(input.flow_id);
    sendJson(res, 200, {
      access_token: sessionToken,
      user_name: "Nubra User",
      account_id: `NUBRA-${flow.phone.slice(-4)}`,
      device_id: flow.deviceId,
      environment: flow.environment,
      broker: "Nubra",
      expires_in: 3600,
      message: "Nubra session established using the REST API login flow."
    });
  } catch (error) {
    sendJson(res, 502, { detail: error.message || "Unable to verify MPIN." });
  }
}

async function proxy(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const target = new URL(url.searchParams.get("url") || "");

    if (!allowedHosts.has(target.host)) {
      sendJson(res, 400, { error: "Only Nubra API hosts are allowed." });
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = {};
    for (const key of ["authorization", "x-device-id", "x-temp-token", "content-type"]) {
      if (req.headers[key]) headers[key] = req.headers[key];
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(responseBody);
  } catch (error) {
    sendJson(res, 502, { error: error.message || "Proxy request failed." });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicRoot, requested));

  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mime[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

http.createServer((req, res) => {
  if (req.url === "/api/auth/start") {
    startAuth(req, res);
    return;
  }
  if (req.url === "/api/auth/verify-otp") {
    verifyOtpAuth(req, res);
    return;
  }
  if (req.url === "/api/auth/verify-totp") {
    verifyTotpAuth(req, res);
    return;
  }
  if (req.url === "/api/auth/verify-mpin") {
    verifyMpinAuth(req, res);
    return;
  }
  if (req.url?.startsWith("/api/proxy")) {
    proxy(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(port, () => {
  console.log(`Nubra Spot Chart running at http://localhost:${port}`);
});
