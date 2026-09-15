import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import pino from "pino";
import sharp from "sharp";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { digitsOnlyPhone } from "./phone.js";

const logger = pino({ level: "silent" });

export type WhatsAppConnectionStatus =
  | "idle"
  | "connecting"
  | "qr"
  | "connected"
  | "disconnected"
  | "logged_out";

export type WhatsAppSessionSnapshot = {
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  connectedJid: string | null;
  lastError: string | null;
  updatedAt: string;
};

type SessionState = WhatsAppSessionSnapshot & {
  socket: WASocket | null;
  starting: Promise<void> | null;
};

// Stable path next to the package (not process.cwd) so pm2 restarts keep the session
const SERVICE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_DIR =
  (process.env.AUTH_DIR || "").trim() || path.join(SERVICE_ROOT, "data", "baileys_auth");

let state: SessionState = {
  status: "idle",
  qrDataUrl: null,
  connectedJid: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
  socket: null,
  starting: null,
};

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function touch(patch: Partial<SessionState>) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
}

function hasAuthFiles(): boolean {
  try {
    return fs.existsSync(path.join(AUTH_DIR, "creds.json"));
  } catch {
    return false;
  }
}

export function getWhatsAppSnapshot(): WhatsAppSessionSnapshot {
  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    connectedJid: state.connectedJid,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  };
}

export function getAuthDir(): string {
  return AUTH_DIR;
}

function toJid(phone: string): string {
  const digits = digitsOnlyPhone(phone);
  if (!digits) throw new Error("WhatsApp destination number is empty.");
  return `${digits}@s.whatsapp.net`;
}

function isSocketOpen(socket: WASocket | null | undefined): boolean {
  if (!socket) return false;
  const ws = (socket as WASocket & { ws?: { readyState?: number; isOpen?: boolean } }).ws;
  if (!ws) return false;
  if (typeof ws.isOpen === "boolean") return ws.isOpen;
  return ws.readyState === 1;
}

function isConnectionClosedError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return /connection closed|timed out|socket closed|statusCode":428|1006/i.test(message);
}

function scheduleReconnect(delayMs = 2500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsAppSession(true).catch((error) => {
      touch({
        status: "disconnected",
        lastError: error instanceof Error ? error.message : "Reconnect failed.",
      });
    });
  }, delayMs);
}

async function waitForConnectionOpen(socket: WASocket, timeoutMs = 45_000): Promise<void> {
  if (state.status === "connected" && isSocketOpen(socket)) return;
  if (state.status === "qr") return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (state.status === "qr" || state.status === "connected") {
        resolve();
        return;
      }
      reject(new Error("Timed out waiting for WhatsApp connection."));
    }, timeoutMs);

    const onUpdate = (update: { connection?: string; qr?: string }) => {
      if (update.qr || state.status === "qr") {
        cleanup();
        resolve();
        return;
      }
      if (update.connection === "open") {
        cleanup();
        resolve();
        return;
      }
      if (update.connection === "close") {
        cleanup();
        // Pairing often closes with restartRequired — reconnect handles it
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.ev.off("connection.update", onUpdate);
    };

    socket.ev.on("connection.update", onUpdate);

    if (state.status === "connected" && isSocketOpen(socket)) {
      cleanup();
      resolve();
    } else if (state.status === "qr") {
      cleanup();
      resolve();
    }
  });
}

async function createSocket() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[whatsapp] auth dir: ${AUTH_DIR} (creds=${hasAuthFiles()})`);

  const socket = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
  });

  socket.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (error) {
      console.error("[whatsapp] failed to save creds", error);
    }
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Avoid flashing a new QR when we already have saved credentials (reconnect)
      if (!hasAuthFiles()) {
        const qrDataUrl = await qrcode.toDataURL(qr, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: "M",
        });
        touch({
          status: "qr",
          qrDataUrl,
          connectedJid: null,
          lastError: null,
        });
      }
    }

    if (connection === "open") {
      touch({
        status: "connected",
        qrDataUrl: null,
        connectedJid: socket.user?.id ?? null,
        lastError: null,
        socket,
      });
      console.log(`[whatsapp] connected as ${socket.user?.id ?? "unknown"}`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      // After QR pair, WhatsApp often sends 515 restartRequired — must reconnect with same auth
      const restartRequired =
        statusCode === DisconnectReason.restartRequired || statusCode === 515;

      touch({
        status: loggedOut ? "logged_out" : "disconnected",
        qrDataUrl: null,
        connectedJid: null,
        lastError: loggedOut
          ? "WhatsApp session logged out. Scan a new QR code."
          : restartRequired
            ? "Pairing complete — reconnecting…"
            : lastDisconnect?.error?.message || "WhatsApp disconnected.",
        socket: null,
      });

      if (loggedOut) {
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        return;
      }

      scheduleReconnect(restartRequired ? 1000 : 2500);
    }
  });

  return socket;
}

function endSocketQuietly(socket: WASocket | null) {
  if (!socket) return;
  try {
    socket.end(undefined);
  } catch {
    // ignore
  }
}

export async function startWhatsAppSession(force = false): Promise<WhatsAppSessionSnapshot> {
  // Keep live sessions — page refresh / accidental Connect must not wipe them
  if (!force && state.status === "connected" && isSocketOpen(state.socket)) {
    return getWhatsAppSnapshot();
  }
  if (!force && state.status === "qr" && state.socket) {
    return getWhatsAppSnapshot();
  }
  if (!force && state.starting) {
    await state.starting;
    return getWhatsAppSnapshot();
  }

  if (state.starting) {
    await state.starting;
    if (!force || (state.status === "connected" && isSocketOpen(state.socket))) {
      return getWhatsAppSnapshot();
    }
  }

  state.starting = (async () => {
    touch({
      status: "connecting",
      lastError: null,
      qrDataUrl: force ? null : state.qrDataUrl,
    });

    try {
      endSocketQuietly(state.socket);
      state.socket = null;

      const socket = await createSocket();
      touch({ socket });
      await waitForConnectionOpen(socket);
    } catch (error) {
      if (state.status !== "qr" && state.status !== "connected") {
        touch({
          status: "disconnected",
          lastError: error instanceof Error ? error.message : "Failed to start WhatsApp.",
          socket: null,
        });
      }
      throw error;
    } finally {
      state.starting = null;
    }
  })();

  await state.starting;
  return getWhatsAppSnapshot();
}

export async function logoutWhatsAppSession(): Promise<WhatsAppSessionSnapshot> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (state.socket) {
      await state.socket.logout();
    }
  } catch {
    // ignore
  }

  endSocketQuietly(state.socket);

  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }

  state = {
    status: "logged_out",
    qrDataUrl: null,
    connectedJid: null,
    lastError: "Logged out. Start again and scan a new QR code.",
    updatedAt: new Date().toISOString(),
    socket: null,
    starting: null,
  };

  return getWhatsAppSnapshot();
}

export type WhatsAppMediaAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

function isImageMime(mime: string | undefined, filename: string): boolean {
  if (mime?.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp)$/i.test(filename);
}

async function ensureConnectedSocket(forceReconnect = false): Promise<WASocket> {
  if (forceReconnect || state.status !== "connected" || !isSocketOpen(state.socket)) {
    await startWhatsAppSession(true);
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (state.status === "connected" && isSocketOpen(state.socket)) {
      return state.socket!;
    }
    if (state.status === "qr" || state.status === "logged_out") {
      throw new Error("WhatsApp is not connected. Scan the QR code in Admin → Settings.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("WhatsApp is not connected. Scan the QR code in Admin → Settings.");
}

async function writeTempMedia(media: WhatsAppMediaAttachment): Promise<{
  filePath: string;
  filename: string;
  mimetype: string;
  isImage: boolean;
  jpegThumbnail?: string;
}> {
  const asImage = isImageMime(media.contentType, media.filename);
  const tmpRoot = path.join(SERVICE_ROOT, "data", "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });

  if (asImage) {
    const filePath = path.join(tmpRoot, `wa-${Date.now()}.jpg`);
    const jpeg = await sharp(media.content)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    fs.writeFileSync(filePath, jpeg);

    const thumb = await sharp(jpeg)
      .resize(64, 64, { fit: "cover" })
      .jpeg({ quality: 40 })
      .toBuffer();

    return {
      filePath,
      filename: media.filename.replace(/\.[^.]+$/, "") + ".jpg",
      mimetype: "image/jpeg",
      isImage: true,
      jpegThumbnail: thumb.toString("base64"),
    };
  }

  const safeName = media.filename.replace(/[^\w.\-]+/g, "_") || "brief-upload";
  const filePath = path.join(tmpRoot, `wa-${Date.now()}-${safeName}`);
  fs.writeFileSync(filePath, media.content);
  return {
    filePath,
    filename: media.filename || safeName,
    mimetype: media.contentType || "application/octet-stream",
    isImage: false,
  };
}

async function sendWithReconnectRetry(run: (socket: WASocket) => Promise<void>): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const socket = await ensureConnectedSocket(attempt > 0);
      await run(socket);
      return;
    } catch (error) {
      lastError = error;
      if (!isConnectionClosedError(error) || attempt === 2) {
        throw error;
      }
      console.error(`[whatsapp] attempt ${attempt + 1} failed, reconnecting…`, error);
      touch({ status: "disconnected", socket: null, lastError: "Reconnecting…" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("WhatsApp send failed.");
}

export async function sendWhatsAppBrief(
  phone: string,
  text: string,
  media?: WhatsAppMediaAttachment | null,
): Promise<void> {
  const message = text.trim();
  if (!message) throw new Error("WhatsApp message is empty.");
  const jid = toJid(phone);

  await sendWithReconnectRetry(async (socket) => {
    await socket.sendMessage(jid, { text: message });
  });

  if (!media || media.content.length === 0) return;

  await new Promise((resolve) => setTimeout(resolve, 800));

  const prepared = await writeTempMedia(media);
  try {
    await sendWithReconnectRetry(async (socket) => {
      if (prepared.isImage) {
        try {
          await socket.sendMessage(
            jid,
            {
              image: { url: prepared.filePath },
              mimetype: prepared.mimetype,
              caption: prepared.filename,
              jpegThumbnail: prepared.jpegThumbnail,
            },
            { mediaUploadTimeoutMs: 120_000 },
          );
          return;
        } catch (imageError) {
          console.error("[whatsapp] image send failed, falling back to document", imageError);
        }
      }

      await socket.sendMessage(
        jid,
        {
          document: { url: prepared.filePath },
          mimetype: prepared.mimetype,
          fileName: prepared.filename,
          caption: prepared.filename,
        },
        { mediaUploadTimeoutMs: 120_000 },
      );
    });
  } finally {
    try {
      fs.unlinkSync(prepared.filePath);
    } catch {
      // ignore
    }
  }
}
