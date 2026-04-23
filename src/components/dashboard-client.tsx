"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Card, CardContent, CircularProgress, Snackbar, Stack, TextField, Typography } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import Image from "next/image";
import { io, Socket } from "socket.io-client";

type StatusPayload = { status: string; qr: string | null; numero: string | null; lastError?: string | null };
type LogRow = { _id: string; numero: string; mensagem: string; status: string; created_at: string };

export function DashboardClient() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [numero, setNumero] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [loading, setLoading] = useState(false);
  const [snack, setSnack] = useState<{ open: boolean; message: string; severity: "success" | "error" }>({ open: false, message: "", severity: "success" });

  const columns = useMemo<GridColDef[]>(() => [
    { field: "numero", headerName: "Número", flex: 1 },
    { field: "mensagem", headerName: "Mensagem", flex: 2 },
    { field: "status", headerName: "Status", width: 120 },
    { field: "created_at", headerName: "Data", width: 220 },
  ], []);

  const refresh = useCallback(async () => {
    const [statusRes, logsRes] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/logs").then((r) => r.json()),
    ]);
    setStatus(statusRes);
    if (statusRes?.status === "connected") {
      setQrCode(null);
    } else if (statusRes?.qr) {
      setQrCode(statusRes.qr);
    }
    setLogs(logsRes.logs ?? []);
  }, []);

  useEffect(() => {
    const boot = window.setTimeout(() => {
      refresh().catch(() => undefined);
    }, 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      window.clearTimeout(boot);
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const socket: Socket = io({ path: "/socket.io" });
    socket.on("whatsapp:qr", (payload: StatusPayload) => {
      setStatus(payload);
      if (payload.qr) setQrCode(payload.qr);
    });
    socket.on("whatsapp:status", (payload: StatusPayload) => {
      setStatus((current) => ({ ...(current ?? payload), ...payload }));
      if (payload.status === "connected") setQrCode(null);
    });
    socket.on("log:new", (payload: { log: LogRow }) => {
      setLogs((current) => [payload.log, ...current]);
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  async function connect() {
    setLoading(true);
    try {
      const res = await fetch("/api/connect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao conectar");
      setSnack({ open: true, message: "Conexão iniciada", severity: "success" });
      await refresh();
    } catch (error) {
      setSnack({ open: true, message: error instanceof Error ? error.message : "Erro", severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    setLoading(true);
    try {
      const res = await fetch("/api/send-message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numero, mensagem }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao enviar");
      setSnack({ open: true, message: "Mensagem enviada", severity: "success" });
      setNumero("");
      setMensagem("");
      await refresh();
    } catch (error) {
      setSnack({ open: true, message: error instanceof Error ? error.message : "Erro", severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Card className="bg-slate-900 text-white">
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ justifyContent: "space-between", alignItems: { md: "center" } }}>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>Status do WhatsApp</Typography>
              <Typography color="text.secondary">Integração única para ERP via Socket.IO e polling</Typography>
              <Typography className="mt-2" color={status?.status === "connected" ? "success.main" : "error.main"} sx={{ fontWeight: 700 }}>
                {status?.status === "connected" ? "🟢 Conectado" : "🔴 Desconectado"}
              </Typography>
              {status?.lastError && status.status !== "connected" && (
                <Typography className="mt-2" color="warning.main" variant="body2">
                  Último erro: {status.lastError}
                </Typography>
              )}
            </Box>
            <Stack direction="row" spacing={2}>
              <Button variant="contained" onClick={connect} disabled={loading}>{loading ? <CircularProgress size={20} /> : "Conectar"}</Button>
              <Button variant="outlined" onClick={connect} disabled={loading}>Reconectar</Button>
            </Stack>
          </Stack>
          {qrCode && status?.status !== "connected" && (
            <Box className="mt-6 flex justify-center">
              <Image src={qrCode} alt="QR Code WhatsApp" width={256} height={256} className="h-64 w-64 rounded-2xl bg-white p-4" unoptimized />
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Enviar Mensagem</Typography>
          <Stack spacing={2}>
            <TextField label="Número" value={numero} onChange={(e) => setNumero(e.target.value)} fullWidth />
            <TextField label="Mensagem" value={mensagem} onChange={(e) => setMensagem(e.target.value)} fullWidth multiline minRows={4} />
            <Button variant="contained" onClick={send} disabled={loading}>Enviar</Button>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent style={{ height: 520 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }} className="mb-4">Logs</Typography>
          <DataGrid rows={logs} columns={columns} getRowId={(row) => row._id} disableRowSelectionOnClick />
        </CardContent>
      </Card>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack((s) => ({ ...s, open: false }))}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Stack>
  );
}
