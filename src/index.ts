import http from "http";
import {
  getAuthDir,
  getWhatsAppSnapshot,
  logoutWhatsAppSession,
  sendWhatsAppBrief,
  startWhatsAppSession,
  type WhatsAppSessionSnapshot,
} from "./baileys.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const SECRET = (process.env.WHATSAPP_SERVICE_SECRET || "").trim();

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: http.ServerResponse) {
  json(res, 401, { error: "Unauthorized" });
}

function requireSecret(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!SECRET) {
    json(res, 500, { error: "WHATSAPP_SERVICE_SECRET is not configured on the VPS." });
    return false;
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== SECRET) {
    unauthorized(res);
    return false;
  }
  return true;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

type SendBody = {
  phone?: string;
  text?: string;
  media?: {
    filename?: string;
    contentBase64?: string;
    contentType?: string;
  } | null;
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/health") {
      const snapshot = getWhatsAppSnapshot();
      json(res, 200, {
        ok: true,
        status: snapshot.status,
        updatedAt: snapshot.updatedAt,
        authDir: getAuthDir(),
      });
      return;
    }

    if (!requireSecret(req, res)) return;

    if (method === "GET" && url.pathname === "/session") {
      json(res, 200, getWhatsAppSnapshot());
      return;
    }

    if (method === "POST" && url.pathname === "/session/start") {
      const snapshot = await startWhatsAppSession();
      json(res, 200, snapshot);
      return;
    }

    if (method === "POST" && url.pathname === "/session/logout") {
      const snapshot = await logoutWhatsAppSession();
      json(res, 200, snapshot);
      return;
    }

    if (method === "POST" && url.pathname === "/send") {
      const body = await readJson<SendBody>(req);
      const phone = String(body.phone || "").trim();
      const text = String(body.text || "").trim();
      const hasMedia = Boolean(body.media?.contentBase64);
      if (!phone || (!text && !hasMedia)) {
        json(res, 400, { error: "phone and text (or media) are required." });
        return;
      }

      let media: { filename: string; content: Buffer; contentType?: string } | null = null;
      if (body.media?.contentBase64) {
        media = {
          filename: body.media.filename?.trim() || "brief-upload",
          content: Buffer.from(body.media.contentBase64, "base64"),
          contentType: body.media.contentType || undefined,
        };
      }

      await sendWhatsAppBrief(phone, text || `Attachment: ${media?.filename || "file"}`, media);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    console.error("[whatsapp-service]", message);
    json(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[whatsapp-service] listening on http://${HOST}:${PORT}`);
  console.log(`[whatsapp-service] auth dir: ${getAuthDir()}`);
  if (!SECRET) {
    console.warn("[whatsapp-service] WARNING: WHATSAPP_SERVICE_SECRET is empty");
  }
  void startWhatsAppSession().catch((error) => {
    console.warn(
      "[whatsapp-service] auto-start:",
      error instanceof Error ? error.message : error,
    );
  });
});

export type { WhatsAppSessionSnapshot };
