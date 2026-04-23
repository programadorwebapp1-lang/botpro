import "dotenv/config";
import http from "http";
import next from "next";
import { Server } from "socket.io";
import { parse } from "url";
import { setRealtimeServer } from "./src/lib/realtime";

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const app = next({ dev });
  const handle = app.getRequestHandler();

  await app.prepare();

  const server = http.createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "", true);
    void handle(req, res, parsedUrl);
  });

  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/socket.io",
  });

  setRealtimeServer(io);

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
