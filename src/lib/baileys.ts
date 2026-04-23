import fs from "fs";
import path from "path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState as loadMultiFileAuthState,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { connectMongo } from "./mongo";
import Log from "@/models/Log";
import { jidFromPhone, normalizePhoneNumber } from "./wa-utils";
import { emitRealtime } from "./realtime";
import { DEFAULT_INSTANCE_ID } from "./app-config";

type SessionState = {
  socket: ReturnType<typeof makeWASocket> | null;
  status: "connected" | "disconnected" | "connecting";
  qr: string | null;
  lastQrAt: number | null;
  reconnecting: boolean;
  lastError: string | null;
};

const sessionId = DEFAULT_INSTANCE_ID;
const sessions = new Map<string, SessionState>();
const sendLocks = new Map<string, number>();
const authRoot = path.join(process.cwd(), ".wa-sessions");

function ensureSession(id: string) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      socket: null,
      status: "disconnected",
      qr: null,
      lastQrAt: null,
      reconnecting: false,
      lastError: null,
    });
  }
  return sessions.get(id)!;
}

export async function startBaileysSession() {
  await connectMongo();
  const state = ensureSession(sessionId);
  if (state.socket) return state;

  fs.mkdirSync(authRoot, { recursive: true });
  const authPath = path.join(authRoot, sessionId);
  const { state: authState, saveCreds } = await loadMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  state.socket = sock;
  state.status = "connecting";

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      state.qr = await QRCode.toDataURL(update.qr);
      state.lastQrAt = Date.now();
      state.status = "disconnected";
      emitRealtime("whatsapp:qr", { instance_id: sessionId, qr: state.qr, status: state.status });
    }

    if (update.connection === "open") {
      state.status = "connected";
      state.qr = null;
      emitRealtime("whatsapp:status", {
        instance_id: sessionId,
        status: state.status,
        numero: normalizePhoneNumber(sock.user?.id?.split(":")[0] ?? ""),
      });
    }

    if (update.connection === "close") {
      state.status = "disconnected";
      state.socket = null;
      const disconnectError = update.lastDisconnect?.error as { message?: string; output?: { statusCode?: number } } | undefined;
      state.lastError =
        disconnectError?.message ??
        (disconnectError?.output?.statusCode ? `statusCode:${disconnectError.output.statusCode}` : "desconhecido");
      emitRealtime("whatsapp:status", { instance_id: sessionId, status: state.status, error: state.lastError });
      const shouldReconnect =
        typeof disconnectError?.output?.statusCode === "number"
          ? disconnectError.output.statusCode !== DisconnectReason.loggedOut
          : true;
      if (shouldReconnect && !state.reconnecting) {
        state.reconnecting = true;
        setTimeout(() => {
          state.reconnecting = false;
          void startBaileysSession();
        }, 4000);
      }
    }
  });

  return state;
}

export async function getSessionStatus() {
  await connectMongo();
  const state = ensureSession(sessionId);
  return {
    instance_id: sessionId,
    status: state.status,
    qr: state.qr,
    numero: null,
    lastQrAt: state.lastQrAt,
    lastError: state.lastError,
  };
}

export async function sendWhatsAppMessage(numero: string, mensagem: string) {
  await connectMongo();
  const state = ensureSession(sessionId);
  const now = Date.now();
  const dedupeKey = `${sessionId}:${normalizePhoneNumber(numero)}:${mensagem}`;
  const lastSent = sendLocks.get(dedupeKey);
  if (lastSent && now - lastSent < 20000) {
    throw new Error("Mensagem bloqueada por anti-spam de 20s");
  }
  if (!state.socket || state.status !== "connected") {
    throw new Error("WhatsApp desconectado");
  }
  const jid = jidFromPhone(numero);
  await state.socket.sendMessage(jid, { text: mensagem });
  sendLocks.set(dedupeKey, now);
  const log = await Log.create({
    instance_id: sessionId,
    numero: normalizePhoneNumber(numero),
    mensagem,
    status: "sent",
  });
  emitRealtime("log:new", { instance_id: sessionId, log });
  return { success: true };
}

export async function getCompanyLogs() {
  await connectMongo();
  return Log.find({ instance_id: sessionId }).sort({ created_at: -1 }).limit(200).lean();
}
