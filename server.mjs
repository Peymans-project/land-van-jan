import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist", "client");
const port = Number(process.env.PORT || 3000);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendFile(response, path, method) {
  response.writeHead(200, {
    "Content-Type": mime[extname(path)] || "application/octet-stream",
    "Cache-Control": path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}

createServer((request, response) => {
  const method = request.method || "GET";
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    return response.end();
  }

  const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const candidate = join(root, relative);
  const isSafeFile = candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile();
  sendFile(response, isSafeFile ? candidate : join(root, "index.html"), method);
}).listen(port, "0.0.0.0", () => {
  console.log(`Land van Jan listens on ${port}`);
});
