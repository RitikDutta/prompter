import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4173;
const ROOT_DIR = process.cwd();
const LIBRARY_DIR = path.join(ROOT_DIR, "library");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function formatTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

export async function readLibraryItems() {
  await mkdir(LIBRARY_DIR, { recursive: true });

  const entries = await readdir(LIBRARY_DIR, { withFileTypes: true });
  const textFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const items = [];

  for (const fileName of textFiles) {
    const content = await readFile(path.join(LIBRARY_DIR, fileName), "utf8");

    if (!content.trim()) {
      continue;
    }

    items.push({
      title: formatTitle(fileName),
      fileName,
      description: `Saved script from ${fileName}`,
      content,
    });
  }

  return items;
}

function resolveStaticPath(requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const localPath = path.resolve(ROOT_DIR, `.${normalizedPath}`);

  if (localPath !== ROOT_DIR && !localPath.startsWith(`${ROOT_DIR}${path.sep}`)) {
    return null;
  }

  return localPath;
}

export const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || HOST}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/library") {
    try {
      const items = await readLibraryItems();
      sendJson(response, 200, items);
    } catch (error) {
      sendJson(response, 500, {
        error: "Failed to read library folder",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed");
    return;
  }

  const filePath = resolveStaticPath(requestUrl.pathname);

  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let fileStats;

  try {
    fileStats = await stat(filePath);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  if (!fileStats.isFile()) {
    sendText(response, 404, "Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": fileStats.size,
    "Content-Type": contentType,
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
});

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  server.listen(PORT, HOST, () => {
    console.log(`Prompter server running at http://${HOST}:${PORT}`);
  });
}
