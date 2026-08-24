import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

export type FileShareConfig = {
  path: string;
  port: number;
  token?: string;
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".pdf": "application/pdf",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".xml": "application/xml; charset=utf-8", ".zip": "application/zip",
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function securityHeaders(response: ServerResponse) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function sameToken(supplied: string | undefined, expected: string) {
  if (!supplied) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

function cookieToken(request: IncomingMessage) {
  const match = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("ants_share="));
  if (!match) return undefined;
  try { return decodeURIComponent(match.slice("ants_share=".length)); } catch { return undefined; }
}

function authPage(response: ServerResponse, invalid = false) {
  const nonce = randomBytes(16).toString("base64");
  securityHeaders(response);
  response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'`);
  response.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected share · Ants Nest</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0b;color:#e8e5de;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.card{width:min(420px,calc(100% - 32px));padding:30px;border:1px solid #303030;border-radius:16px;background:#121212;box-shadow:0 18px 60px #0008}.mark{width:42px;height:42px;display:grid;place-items:center;border-radius:11px;background:#e8e5de;color:#111;font-weight:900}h1{margin:20px 0 8px;font-size:22px}p{margin:0 0 20px;color:#898680;font-size:13px;line-height:1.6}label{display:block;margin-bottom:7px;color:#aaa7a0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}input{width:100%;height:46px;padding:0 13px;border:1px solid ${invalid ? "#8c4949" : "#3a3a3a"};border-radius:9px;outline:none;background:#0b0b0b;color:#eee;font:14px ui-monospace,monospace}input:focus{border-color:#888}button{width:100%;height:44px;margin-top:10px;border:0;border-radius:9px;background:#e8e5de;color:#111;font-weight:800;cursor:pointer}.error{margin:9px 0 0;color:#d98b8b;font-size:11px}</style></head><body><main class="card"><div class="mark">A</div><h1>Token required</h1><p>This file share is protected. Enter the token provided by its owner to continue.</p><form method="post" action="/__ants/auth"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="one-time-code" autofocus required><button>Open share</button>${invalid ? '<div class="error">That token is not valid.</div>' : ""}</form></main><script nonce="${nonce}">const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token){history.replaceState(null,'',location.pathname+location.search);document.querySelector('#token').value=token;document.querySelector('form').requestSubmit()}</script></body></html>`);
}

async function requestBody(request: IncomingMessage, limit = 4096) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redirectAuthorized(response: ServerResponse, token: string, destination = "/") {
  securityHeaders(response);
  response.writeHead(303, {
    Location: destination,
    "Cache-Control": "no-store",
    "Set-Cookie": `ants_share=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  });
  response.end();
}

async function sendFile(response: ServerResponse, file: string, downloadName?: string) {
  const content = await fs.readFile(file);
  securityHeaders(response);
  const headers: Record<string, string | number> = {
    "Content-Type": contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": "private, no-store",
  };
  if (downloadName && !contentTypes[path.extname(file).toLowerCase()]) headers["Content-Disposition"] = `attachment; filename="${downloadName.replaceAll('"', "")}"`;
  response.writeHead(200, headers);
  response.end(content);
}

async function directoryPage(response: ServerResponse, directory: string, requestPath: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const prefix = requestPath.endsWith("/") ? requestPath : `${requestPath}/`;
  const rows = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => {
    const href = `${prefix}${encodeURIComponent(entry.name)}${entry.isDirectory() ? "/" : ""}`.replaceAll("//", "/");
    return `<li><a href="${escapeHtml(href)}"><span>${entry.isDirectory() ? "Folder" : "File"}</span>${escapeHtml(entry.name)}${entry.isDirectory() ? "/" : ""}</a></li>`;
  }).join("");
  securityHeaders(response);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(requestPath)} · Ants Nest</title><style>*{box-sizing:border-box}body{max-width:850px;margin:50px auto;padding:0 22px;background:#0b0b0b;color:#e5e2db;font-family:ui-sans-serif,system-ui}h1{font-size:21px}p{color:#777}ul{padding:0;border:1px solid #303030;border-radius:12px;overflow:hidden}li{list-style:none;border-bottom:1px solid #292929}li:last-child{border:0}a{display:flex;gap:14px;padding:13px 16px;color:#ddd;text-decoration:none;background:#111}a:hover{background:#181818}a span{width:45px;color:#777;font-size:10px;text-transform:uppercase}</style></head><body><h1>${escapeHtml(requestPath)}</h1><p>Shared securely with Ants Nest</p><ul>${requestPath !== "/" ? '<li><a href="../"><span>Back</span>..</a></li>' : ""}${rows}</ul></body></html>`);
}

export async function createFileShareServer(config: FileShareConfig) {
  const root = await fs.realpath(config.path);
  const rootStat = await fs.stat(root);
  if (!rootStat.isFile() && !rootStat.isDirectory()) throw new Error("Share path must be a regular file or directory");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (config.token) {
        const queryToken = url.searchParams.get("token") || undefined;
        if (sameToken(queryToken, config.token)) {
          url.searchParams.delete("token");
          return redirectAuthorized(response, config.token, `${url.pathname}${url.search}`);
        }
        if (request.method === "POST" && url.pathname === "/__ants/auth") {
          const supplied = new URLSearchParams(await requestBody(request)).get("token") || undefined;
          return sameToken(supplied, config.token) ? redirectAuthorized(response, config.token) : authPage(response, true);
        }
        if (!sameToken(cookieToken(request), config.token)) return authPage(response, Boolean(queryToken));
      }
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); return response.end(); }
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400); return response.end("Bad request"); }
      if (pathname.includes("\0")) { response.writeHead(400); return response.end("Bad request"); }
      if (rootStat.isFile()) {
        if (pathname !== "/" && pathname !== `/${encodeURIComponent(path.basename(root))}` && pathname !== `/${path.basename(root)}`) { response.writeHead(404); return response.end("Not found"); }
        if (request.method === "HEAD") { securityHeaders(response); response.writeHead(200); return response.end(); }
        return await sendFile(response, root, path.basename(root));
      }
      const candidate = path.resolve(root, `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) { response.writeHead(403); return response.end("Forbidden"); }
      const realCandidate = await fs.realpath(candidate).catch(() => undefined);
      if (!realCandidate || (realCandidate !== root && !realCandidate.startsWith(`${root}${path.sep}`))) { response.writeHead(404); return response.end("Not found"); }
      const stat = await fs.stat(realCandidate);
      if (stat.isDirectory()) {
        const index = path.join(realCandidate, "index.html");
        if (await fs.stat(index).then((value) => value.isFile()).catch(() => false)) return await sendFile(response, index);
        return await directoryPage(response, realCandidate, pathname);
      }
      if (!stat.isFile()) { response.writeHead(404); return response.end("Not found"); }
      if (request.method === "HEAD") { securityHeaders(response); response.writeHead(200); return response.end(); }
      await sendFile(response, realCandidate, path.basename(realCandidate));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Internal server error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export async function runFileShareWorker(configFile: string) {
  const config = JSON.parse(await fs.readFile(configFile, "utf8")) as FileShareConfig;
  const server = await createFileShareServer(config);
  const close = () => server.close(() => process.exit(0));
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
