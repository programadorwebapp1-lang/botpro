import "dotenv/config";
import http from "http";
import next from "next";
import { Server } from "socket.io";
import { startBaileysSession, stopBaileysSession } from "./src/lib/baileys";
import { requireSocketToken } from "./src/lib/auth";
import { setRealtimeServer } from "./src/lib/realtime";

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const app = next({ dev });
  const handle = app.getRequestHandler();

  await app.prepare();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handle(req, res, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) } as never);
  });

  const io = new Server(server, {
    cors: { origin: false },
    path: "/socket.io",
  });

  io.use((socket, nextAuth) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!requireSocketToken(token ?? "")) {
      return nextAuth(new Error("unauthorized"));
    }
    return nextAuth();
  });

  setRealtimeServer(io);
  void startBaileysSession().catch((error) => {
    console.error("[whatsapp] startup error", error);
  });

  const shutdown = async () => {
    try {
      await stopBaileysSession();
    } catch {
      // ignore shutdown errors
    }
    server.close(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandledRejection", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] uncaughtException", error);
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
