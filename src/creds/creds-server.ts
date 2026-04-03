// src/creds/creds-server.ts

import { createServer, Server } from "http";
import { getCreds } from "./vk-creds";

// ─── HTTP-сервер для выдачи credentials клиенту ──────────────

const CREDS_PORT = Number(process.env.CREDS_SERVER_PORT) || 3100;

let server: Server | null = null;

/**
 * Запускает HTTP-сервер на localhost для выдачи TURN credentials.
 * Go-клиент делает GET /creds?link=TOKEN и получает JSON:
 * { username, password, turnServer }
 */
export function startCredsServer(): void {
  server = createServer(async (req, res) => {
    // Только GET /creds
    if (req.method !== "GET" || !req.url?.startsWith("/creds")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${CREDS_PORT}`);
    const link = url.searchParams.get("link");

    if (!link) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing link parameter" }));
      return;
    }

    try {
      const creds = await getCreds(link);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(creds));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Creds server error: ${msg}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(CREDS_PORT, "127.0.0.1", () => {
    console.log(`Creds server: 127.0.0.1:${CREDS_PORT}`);
  });
}

export function stopCredsServer(): void {
  server?.close();
}
