import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "@whiskeysockets/baileys";
import { delay } from "@whiskeysockets/baileys";
import { connectMongo } from "./mongo";
import { DEFAULT_TENANT_ID, LEGACY_SESSION_ID } from "./app-config";
import { normalizePhoneNumber, jidFromPhone } from "./wa-utils";
import { emitRealtime } from "./realtime";
import WhatsAppSession from "@/models/WhatsAppSession";
import MessageLog from "@/models/MessageLog";

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

type RuntimeState = {
  socket: ReturnType<typeof makeWASocket> | null;
  connectPromise: Promise<RuntimeState> | null;
  status: ConnectionStatus;
  qr: string | null;
  lastError: string | null;
  lastQrAt: Date | null;
  lastConnectedAt: Date | null;
  reconnectAttempts: number;
  nextRetryAt: Date | null;
  reconnectTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  authResetAttempts: number;
  writeChain: Promise<void>;
  socketGeneration: number;
};

type ConnectionUpdate = {
  connection?: "close" | "connecting" | "open";
  qr?: string;
  lastDisconnect?: {
    error?: {
      message?: string;
      output?: { statusCode?: number };
    };
  };
};

const SESSION_ID = DEFAULT_TENANT_ID;
const MESSAGE_LOG_TTL_DAYS = Number(process.env.MESSAGE_LOG_TTL_DAYS ?? 30);
const RECONNECT_BASE_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_BASE_MS ?? 1500);
const RECONNECT_MAX_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_MAX_MS ?? 60000);
const RECONNECT_MAX_ATTEMPTS = Number(process.env.WHATSAPP_RECONNECT_MAX_ATTEMPTS ?? 8);
const AUTH_RESET_MAX_ATTEMPTS = Number(process.env.WHATSAPP_AUTH_RESET_MAX_ATTEMPTS ?? 2);
const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS ?? 900);
const SEND_WAIT_TIMEOUT_MS = Number(process.env.WHATSAPP_SEND_WAIT_TIMEOUT_MS ?? 15000);
const MESSAGE_DEDUPE_WINDOW_MS = Number(process.env.WHATSAPP_MESSAGE_DEDUPE_WINDOW_MS ?? 15000);
const MAX_MESSAGE_LENGTH = Number(process.env.WHATSAPP_MAX_MESSAGE_LENGTH ?? 4096);
const sessions = new Map<string, RuntimeState>();
const recentMessages = new Map<string, number>();
let bootPromise: Promise<void> | null = null;

function createRuntimeState(): RuntimeState {
  return {
    socket: null,
    connectPromise: null,
    status: "idle",
    qr: null,
    lastError: null,
    lastQrAt: null,
    lastConnectedAt: null,
    reconnectAttempts: 0,
    nextRetryAt: null,
    reconnectTimer: null,
    stopRequested: false,
    authResetAttempts: 0,
    writeChain: Promise.resolve(),
    socketGeneration: 0,
  };
}

function getState(sessionId = SESSION_ID) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createRuntimeState());
  }
  return sessions.get(sessionId)!;
}

function getSessionAlias(sessionId: string) {
  return sessionId === DEFAULT_TENANT_ID ? LEGACY_SESSION_ID : sessionId;
}

function buildSessionFilter(sessionId: string) {
  const alias = getSessionAlias(sessionId);
  if (alias === sessionId) {
    return { tenant_id: sessionId };
  }
  return {
    $or: [{ tenant_id: sessionId }, { session_id: alias }],
  };
}

function buildLogFilter(sessionId: string) {
  const alias = getSessionAlias(sessionId);
  if (alias === sessionId) {
    return {
      $or: [{ tenant_id: sessionId }, { session_id: sessionId }],
    };
  }

  return {
    $or: [{ tenant_id: sessionId }, { session_id: alias }],
  };
}

async function migrateLegacyDefaultSession() {
  await connectMongo();

  const [defaultDoc, legacyDoc] = await Promise.all([
    WhatsAppSession.findOne({ tenant_id: DEFAULT_TENANT_ID }).lean().exec(),
    WhatsAppSession.findOne({ session_id: LEGACY_SESSION_ID }).lean().exec(),
  ]);

  if (!legacyDoc && !defaultDoc) {
    return;
  }

  if (defaultDoc && !legacyDoc) {
    return;
  }

  if (defaultDoc && legacyDoc && String(defaultDoc._id) !== String(legacyDoc._id)) {
    const preferLegacy = !isUsableAuthCreds(defaultDoc.creds as Partial<AuthenticationState["creds"]>) &&
      isUsableAuthCreds(legacyDoc.creds as Partial<AuthenticationState["creds"]>);
    const source = preferLegacy ? legacyDoc : defaultDoc;

    await WhatsAppSession.updateOne(
      { _id: defaultDoc._id },
      {
        $set: {
          tenant_id: DEFAULT_TENANT_ID,
          session_id: LEGACY_SESSION_ID,
          creds: source.creds,
          keys: source.keys,
          status: source.status,
          qr: source.qr ?? null,
          last_error: source.last_error ?? null,
          last_connected_at: source.last_connected_at ?? null,
          last_qr_at: source.last_qr_at ?? null,
          reconnect_attempts: source.reconnect_attempts ?? 0,
          next_retry_at: source.next_retry_at ?? null,
        },
      }
    ).exec();

    await WhatsAppSession.deleteOne({ _id: legacyDoc._id }).exec();
    return;
  }

  const sourceDoc = defaultDoc ?? legacyDoc;
  if (!sourceDoc) {
    return;
  }

  await WhatsAppSession.updateOne(
    { _id: sourceDoc._id },
    {
      $set: {
        tenant_id: DEFAULT_TENANT_ID,
        session_id: LEGACY_SESSION_ID,
      },
    }
  ).exec();
}

async function ensureSessionDocument(sessionId: string) {
  await connectMongo();

  if (sessionId === DEFAULT_TENANT_ID) {
    await migrateLegacyDefaultSession();
  }

  const existing = await WhatsAppSession.findOne(buildSessionFilter(sessionId)).lean().exec();
  if (existing) {
    const desiredSessionId = getSessionAlias(sessionId);
    if (existing.tenant_id !== sessionId || existing.session_id !== desiredSessionId) {
      await WhatsAppSession.updateOne(
        { _id: existing._id },
        { $set: { tenant_id: sessionId, session_id: desiredSessionId } }
      ).exec();
    }
    return;
  }

  await WhatsAppSession.updateOne(
    { tenant_id: sessionId },
    {
      $setOnInsert: {
        tenant_id: sessionId,
        session_id: getSessionAlias(sessionId),
        creds: serializeValue(initAuthCreds()),
        keys: {},
        status: "idle",
        qr: null,
        last_error: null,
        reconnect_attempts: 0,
        next_retry_at: null,
        last_connected_at: null,
        last_qr_at: null,
      },
    },
    { upsert: true }
  ).exec();
}

function serializeValue<T>(value: T) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as T;
}

function reviveValue<T>(value: unknown) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

function isUsableAuthCreds(
  creds: Partial<AuthenticationState["creds"]> | null | undefined
): creds is AuthenticationState["creds"] {
  return Boolean(
    creds &&
      creds.noiseKey?.public &&
      creds.signedIdentityKey?.public &&
      creds.signedPreKey?.keyPair?.public &&
      creds.registrationId != null &&
      creds.advSecretKey
  );
}

function isAuthShapeError(error: unknown) {
  const message = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
  return message.includes("reading 'public'") || (message.includes("public") && message.includes("baileys"));
}

function encodeAuthId(id: string) {
  return encodeURIComponent(id).replace(/\./g, "%2E").replace(/\$/g, "%24");
}

function persistSessionPatch(sessionId: string, patch: Record<string, unknown>) {
  const state = getState(sessionId);
  state.writeChain = state.writeChain.then(async () => {
    await WhatsAppSession.updateOne(
      buildSessionFilter(sessionId),
      { $set: { ...patch, tenant_id: sessionId, session_id: getSessionAlias(sessionId) } },
      { upsert: true }
    ).exec();
  }, async () => undefined);
  return state.writeChain;
}

function clearReconnectTimer(state: RuntimeState) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function computeReconnectDelay(attempt: number) {
  const delayMs = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(delayMs, RECONNECT_MAX_DELAY_MS);
}

function isDisconnectCode(code: number | undefined, reason: number) {
  return code === reason;
}

function parseDisconnect(update: ConnectionUpdate) {
  const code = update.lastDisconnect?.error?.output?.statusCode;
  const message = update.lastDisconnect?.error?.message ?? (typeof code === "number" ? `statusCode:${code}` : "desconhecido");
  return { code, message };
}

function isValidPhoneNumber(input: string) {
  const digits = normalizePhoneNumber(input);
  return /^\d{12,15}$/.test(digits);
}

function buildMessageLogExpireAt() {
  const expireAt = new Date();
  expireAt.setDate(expireAt.getDate() + MESSAGE_LOG_TTL_DAYS);
  return expireAt;
}

function pruneRecentMessages() {
  const now = Date.now();
  for (const [key, timestamp] of recentMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUPE_WINDOW_MS * 4) {
      recentMessages.delete(key);
    }
  }
}

async function writeMessageLog(sessionId: string, payload: {
  kind: "message" | "system" | "error";
  status: string;
  numero?: string;
  mensagem?: string;
  detail?: string;
  direction?: "inbound" | "outbound";
  provider_message_id?: string;
}) {
  const log = await MessageLog.create({
    tenant_id: sessionId,
    session_id: getSessionAlias(sessionId),
    expire_at: buildMessageLogExpireAt(),
    ...payload,
  });
  emitRealtime("log:new", { session_id: sessionId, log });
  return log;
}

async function updateSessionDoc(sessionId: string, patch: Record<string, unknown>) {
  await persistSessionPatch(sessionId, patch);
}

async function loadAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  resetAuth: () => Promise<void>;
}> {
  await ensureSessionDocument(sessionId);
  const session = await WhatsAppSession.findOneAndUpdate(
    buildSessionFilter(sessionId),
    {
      $setOnInsert: {
        tenant_id: sessionId,
        session_id: getSessionAlias(sessionId),
        creds: serializeValue(initAuthCreds()),
        keys: {},
        status: "idle",
        qr: null,
        last_error: null,
        reconnect_attempts: 0,
        next_retry_at: null,
        last_connected_at: null,
        last_qr_at: null,
      },
    },
    { upsert: true, returnDocument: "after" }
  ).lean().exec();

  const storedCreds = session?.creds ? (reviveValue(session.creds) as Partial<AuthenticationState["creds"]>) : null;
  let creds = isUsableAuthCreds(storedCreds) ? storedCreds : initAuthCreds();

  const saveCreds = async () => {
    await updateSessionDoc(sessionId, {
      creds: serializeValue(creds),
    });
  };

  const keysStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const current = await WhatsAppSession.findOne(buildSessionFilter(sessionId)).lean().exec();
      const result = {} as Record<string, SignalDataTypeMap[T]>;

      for (const id of ids) {
        const stored = current?.keys?.[type]?.[encodeAuthId(id)];
        if (stored == null) {
          result[id] = undefined as never;
          continue;
        }

        let value = reviveValue<unknown>(stored);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as never);
        }

        result[id] = value as SignalDataTypeMap[T];
      }

      return result;
    },
    set: async (data) => {
      const $set: Record<string, unknown> = {};
      const $unset: Record<string, string> = {};

      for (const [category, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const path = `keys.${category}.${encodeAuthId(id)}`;
          if (value == null) {
            $unset[path] = "";
            continue;
          }
          $set[path] = serializeValue(value);
        }
      }

      await WhatsAppSession.updateOne(
        buildSessionFilter(sessionId),
        {
          ...(Object.keys($set).length ? { $set } : {}),
          ...(Object.keys($unset).length ? { $unset } : {}),
          $setOnInsert: {
            tenant_id: sessionId,
            session_id: getSessionAlias(sessionId),
            creds: serializeValue(initAuthCreds()),
            keys: {},
            status: "idle",
            qr: null,
            last_error: null,
            reconnect_attempts: 0,
            next_retry_at: null,
            last_connected_at: null,
            last_qr_at: null,
          },
        },
        { upsert: true }
      ).exec();
    },
    clear: async () => {
      await WhatsAppSession.updateOne(
        buildSessionFilter(sessionId),
        {
          $set: {
            creds: serializeValue(initAuthCreds()),
            keys: {},
            tenant_id: sessionId,
            session_id: getSessionAlias(sessionId),
          },
        },
        { upsert: true }
      ).exec();
      creds = initAuthCreds();
    },
  } satisfies SignalKeyStore & { clear: () => Promise<void> };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keysStore),
    },
    saveCreds,
    resetAuth: async () => {
      creds = initAuthCreds();
      await keysStore.clear();
      await saveCreds();
    },
  };
}

async function connectFreshSocket(sessionId: string) {
  const state = getState(sessionId);
  if (state.socket || state.connectPromise) {
    return state;
  }

  state.connectPromise = (async () => {
    await connectMongo();
    await ensureSessionDocument(sessionId);
    if (state.stopRequested) {
      state.status = "disconnected";
      return state;
    }
    state.stopRequested = false;
    state.status = "connecting";
    state.lastError = null;
    await updateSessionDoc(sessionId, {
      status: state.status,
      last_error: null,
      next_retry_at: null,
    });

    let resetAuth: (() => Promise<void>) | null = null;

    try {
      const { state: authState, saveCreds, resetAuth: resetAuthFn } = await loadAuthState(sessionId);
      resetAuth = resetAuthFn;
      if (state.stopRequested) {
        return state;
      }
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: authState.keys,
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        syncFullHistory: false,
      });

      state.socketGeneration += 1;
      const generation = state.socketGeneration;
      state.socket = sock;
      clearReconnectTimer(state);

      const onCredsUpdate = async (update: Partial<typeof authState.creds>) => {
        if (state.socketGeneration !== generation) {
          return;
        }
        Object.assign(authState.creds, update);
        await saveCreds();
      };

      const onConnectionUpdate = async (update: ConnectionUpdate) => {
        if (state.socketGeneration !== generation) {
          return;
        }

        if (update.qr) {
          state.qr = await import("qrcode").then((mod) => mod.default.toDataURL(update.qr as string));
          state.lastQrAt = new Date();
          state.status = "connecting";
          await updateSessionDoc(sessionId, {
            status: state.status,
            qr: state.qr,
            last_qr_at: state.lastQrAt,
          });
          emitRealtime("whatsapp:qr", {
            session_id: sessionId,
            tenant_id: sessionId,
            qr: state.qr,
            status: state.status,
          });
        }

        if (update.connection === "open") {
          state.socket = sock;
          state.status = "connected";
          state.qr = null;
          state.lastError = null;
          state.lastConnectedAt = new Date();
          state.reconnectAttempts = 0;
          state.authResetAttempts = 0;
          state.nextRetryAt = null;
          clearReconnectTimer(state);
          await updateSessionDoc(sessionId, {
            status: state.status,
            qr: null,
            last_error: null,
            last_connected_at: state.lastConnectedAt,
            reconnect_attempts: 0,
            next_retry_at: null,
          });
          emitRealtime("whatsapp:status", {
            session_id: sessionId,
            tenant_id: sessionId,
            status: state.status,
            numero: normalizePhoneNumber(sock.user?.id?.split(":")[0] ?? ""),
          });
          await writeMessageLog(sessionId, {
            kind: "system",
            status: "connected",
            detail: "WhatsApp connection opened",
          });
        }

        if (update.connection === "close") {
          const { code, message } = parseDisconnect(update);
          state.socket = null;
          state.status = "disconnected";
          state.lastError = message;
          sock.ev.removeAllListeners("creds.update");
          sock.ev.removeAllListeners("connection.update");

          await updateSessionDoc(sessionId, {
            status: state.status,
            last_error: state.lastError,
          });

          emitRealtime("whatsapp:status", {
            session_id: sessionId,
            tenant_id: sessionId,
            status: state.status,
            error: state.lastError,
          });
          await writeMessageLog(sessionId, {
            kind: "system",
            status: "disconnected",
            detail: `WhatsApp connection closed: ${message}`,
          });

          if (state.stopRequested) {
            return;
          }

          if (
            isDisconnectCode(code, DisconnectReason.loggedOut) ||
            isDisconnectCode(code, DisconnectReason.badSession)
          ) {
            state.authResetAttempts += 1;
            await writeMessageLog(sessionId, {
              kind: "error",
              status: "auth_reset",
              detail: `Auth reset triggered after disconnect code ${code ?? "unknown"}`,
            });

            if (state.authResetAttempts > AUTH_RESET_MAX_ATTEMPTS) {
              state.lastError = "Falha repetida de autenticação. QR precisa ser revalidado manualmente.";
              await updateSessionDoc(sessionId, {
                last_error: state.lastError,
              });
              return;
            }

            try {
              await resetAuth?.();
            } catch (resetError) {
              state.lastError = resetError instanceof Error ? resetError.message : "Falha ao resetar auth";
            }
          }

          if (isDisconnectCode(code, DisconnectReason.connectionReplaced)) {
            state.lastError = "Conexão substituída por outro socket. Auto-reconnect pausado.";
            await updateSessionDoc(sessionId, {
              last_error: state.lastError,
            });
            await writeMessageLog(sessionId, {
              kind: "error",
              status: "connection_replaced",
              detail: state.lastError,
            });
            return;
          }

          const nextAttempt = Math.min(state.reconnectAttempts + 1, RECONNECT_MAX_ATTEMPTS);
          state.reconnectAttempts = nextAttempt;
          const reconnectDelay = isDisconnectCode(code, DisconnectReason.restartRequired)
            ? 1000
            : computeReconnectDelay(nextAttempt);
          state.nextRetryAt = new Date(Date.now() + reconnectDelay);

          await updateSessionDoc(sessionId, {
            reconnect_attempts: state.reconnectAttempts,
            next_retry_at: state.nextRetryAt,
          });
          await writeMessageLog(sessionId, {
            kind: "system",
            status: "reconnect_scheduled",
            detail: `Reconnect scheduled in ${reconnectDelay}ms (attempt ${state.reconnectAttempts})`,
          });

          clearReconnectTimer(state);
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            void connectFreshSocket(sessionId).catch(async (error) => {
              const detail = error instanceof Error ? error.message : "Falha ao reconectar";
              state.lastError = detail;
              await updateSessionDoc(sessionId, { last_error: detail });
              await writeMessageLog(sessionId, {
                kind: "error",
                status: "reconnect_failed",
                detail,
              });
            });
          }, reconnectDelay);
        }
      };

      sock.ev.on("creds.update", onCredsUpdate);
      sock.ev.on("connection.update", onConnectionUpdate);
    } catch (error) {
      if (!state.stopRequested && resetAuth && isAuthShapeError(error)) {
        await resetAuth().catch(() => undefined);
      }
      if (state.stopRequested) {
        state.status = "disconnected";
        state.socket = null;
        return state;
      }
      state.status = "disconnected";
      state.socket = null;
      state.lastError = error instanceof Error ? error.message : "Falha ao iniciar conexão";
      await updateSessionDoc(sessionId, {
        status: state.status,
        last_error: state.lastError,
      }).catch(() => undefined);
      await writeMessageLog(sessionId, {
        kind: "error",
        status: "start_failed",
        detail: state.lastError,
      }).catch(() => undefined);

      const nextAttempt = Math.min(state.reconnectAttempts + 1, RECONNECT_MAX_ATTEMPTS);
      state.reconnectAttempts = nextAttempt;
      const reconnectDelay = computeReconnectDelay(nextAttempt);
      state.nextRetryAt = new Date(Date.now() + reconnectDelay);
      await updateSessionDoc(sessionId, {
        reconnect_attempts: state.reconnectAttempts,
        next_retry_at: state.nextRetryAt,
      }).catch(() => undefined);

      clearReconnectTimer(state);
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        void connectFreshSocket(sessionId).catch(() => undefined);
      }, reconnectDelay);
    } finally {
      state.connectPromise = null;
    }

    return state;
  })();

  return state.connectPromise;
}

async function waitForConnectedSocket(sessionId: string, timeoutMs = SEND_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  const state = getState(sessionId);

  if (!state.socket && !state.connectPromise) {
    void connectFreshSocket(sessionId).catch(() => undefined);
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (state.socket && state.status === "connected") {
      return state.socket;
    }
    await delay(500);
  }

  throw new Error("WhatsApp indisponível para envio no momento");
}

function trackRecentMessage(sessionId: string, numero: string, mensagem: string) {
  pruneRecentMessages();
  const key = `${sessionId}:${numero}:${mensagem}`;
  const now = Date.now();
  const lastSent = recentMessages.get(key);
  if (lastSent && now - lastSent < MESSAGE_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentMessages.set(key, now);
  return true;
}

async function getAutoStartTenantIds() {
  await ensureSessionDocument(DEFAULT_TENANT_ID);
  const sessions = await WhatsAppSession.find({}).lean().exec();
  const tenantIds = new Set<string>([DEFAULT_TENANT_ID]);

  for (const session of sessions) {
    const tenantId = typeof session.tenant_id === "string" && session.tenant_id.trim() ? session.tenant_id : "";
    const sessionId = typeof session.session_id === "string" && session.session_id.trim() ? session.session_id : "";
    const resolvedTenantId = tenantId || (sessionId === LEGACY_SESSION_ID ? DEFAULT_TENANT_ID : sessionId);
    if (!resolvedTenantId) {
      continue;
    }

    const hasUsableCreds = isUsableAuthCreds(
      session.creds as Partial<AuthenticationState["creds"]> | null | undefined
    );
    if (resolvedTenantId === DEFAULT_TENANT_ID || hasUsableCreds || session.status === "connected" || session.status === "connecting") {
      tenantIds.add(resolvedTenantId);
    }
  }

  return Array.from(tenantIds);
}

export async function startBaileysSession(sessionId = SESSION_ID) {
  return connectFreshSocket(sessionId);
}

export async function stopBaileysSession(sessionId = SESSION_ID) {
  const state = getState(sessionId);
  state.stopRequested = true;
  clearReconnectTimer(state);
  if (state.socket) {
    try {
      state.socket.ev.removeAllListeners("creds.update");
      state.socket.ev.removeAllListeners("connection.update");
      state.socket.end(undefined);
    } catch {
      // ignore shutdown errors
    }
  }
  state.socket = null;
  state.status = "disconnected";
}

export async function stopAllBaileysSessions() {
  for (const sessionId of sessions.keys()) {
    await stopBaileysSession(sessionId);
  }
}

export async function getSessionStatus(sessionId = SESSION_ID) {
  await connectMongo();
  await ensureSessionDocument(sessionId);
  const state = getState(sessionId);
  const sessionDoc = await WhatsAppSession.findOne(buildSessionFilter(sessionId)).lean().exec();
  return {
    tenant_id: sessionId,
    session_id: getSessionAlias(sessionId),
    name: typeof sessionDoc?.name === "string" && sessionDoc.name.trim() ? sessionDoc.name : null,
    status: state.status,
    qr: state.qr,
    numero: state.socket?.user?.id ? normalizePhoneNumber(state.socket.user.id.split(":")[0] ?? "") : null,
    lastQrAt: state.lastQrAt,
    lastConnectedAt: state.lastConnectedAt,
    lastError: state.lastError,
    reconnectAttempts: state.reconnectAttempts,
    nextRetryAt: state.nextRetryAt,
  };
}

export async function updateSessionMetadata(sessionId: string, metadata: { name?: string | null }) {
  await connectMongo();
  await ensureSessionDocument(sessionId);
  const name = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null;
  await WhatsAppSession.updateOne(
    buildSessionFilter(sessionId),
    {
      $set: {
        tenant_id: sessionId,
        session_id: getSessionAlias(sessionId),
        name,
      },
    },
    { upsert: true }
  ).exec();
}

export async function sendWhatsAppMessage(numero: string, mensagem: string, sessionId = SESSION_ID) {
  await connectMongo();
  await ensureSessionDocument(sessionId);
  const state = getState(sessionId);
  const normalizedNumber = normalizePhoneNumber(numero);
  const messageText = mensagem.trim();

  if (!isValidPhoneNumber(numero)) {
    throw new Error("Número de telefone inválido");
  }

  if (!messageText) {
    throw new Error("Mensagem vazia");
  }

  if (messageText.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Mensagem excede o limite de ${MAX_MESSAGE_LENGTH} caracteres`);
  }

  if (!trackRecentMessage(sessionId, normalizedNumber, messageText)) {
    throw new Error("Mensagem duplicada bloqueada por anti-spam");
  }

  return enqueueSend(state, async () => {
    const sock = await waitForConnectedSocket(sessionId);
    await delay(SEND_DELAY_MS);
    const jid = jidFromPhone(normalizedNumber);
    const result = await sock.sendMessage(jid, { text: messageText });

    const log = await writeMessageLog(sessionId, {
      kind: "message",
      direction: "outbound",
      numero: normalizedNumber,
      mensagem: messageText,
      status: "sent",
      provider_message_id: result?.key?.id ?? undefined,
    });

    emitRealtime("whatsapp:message-sent", {
      session_id: sessionId,
      tenant_id: sessionId,
      numero: normalizedNumber,
      status: "sent",
      message_id: result?.key?.id ?? null,
    });

    return { success: true, message_id: result?.key?.id ?? null, log };
  });
}

function enqueueSend<T>(state: RuntimeState, task: () => Promise<T>) {
  const nextTask = state.writeChain.then(task, task);
  state.writeChain = nextTask.then(() => undefined, () => undefined);
  return nextTask;
}

export async function getCompanyLogs(sessionId = SESSION_ID) {
  await connectMongo();
  await ensureSessionDocument(sessionId);
  return MessageLog.find(buildLogFilter(sessionId)).sort({ created_at: -1 }).limit(200).lean().exec();
}

export async function ensureWhatsAppBoot() {
  if (bootPromise) {
    return bootPromise;
  }

  bootPromise = (async () => {
    await startBaileysSession(DEFAULT_TENANT_ID);
    const tenantIds = await getAutoStartTenantIds();
    for (const tenantId of tenantIds) {
      if (tenantId === DEFAULT_TENANT_ID) {
        continue;
      }
      await startBaileysSession(tenantId);
    }
  })();

  try {
    await bootPromise;
  } finally {
    bootPromise = null;
  }
}
