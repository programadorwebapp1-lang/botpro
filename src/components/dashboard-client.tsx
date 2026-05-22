"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Card, CardContent, CircularProgress, Snackbar, Stack, TextField, Typography } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import Image from "next/image";

type StatusPayload = {
  tenant_id?: string;
  status: string;
  qr: string | null;
  numero: string | null;
  lastError?: string | null;
  lastConnectedAt?: string | null;
  lastQrAt?: string | null;
  reconnectAttempts?: number;
  nextRetryAt?: string | null;
};

type LogRow = {
  _id: string;
  kind: "message" | "system" | "error";
  numero?: string;
  mensagem?: string;
  status: string;
  detail?: string;
  created_at: string;
};

type DashboardClientProps = {
  authToken: string;
};

export function DashboardClient({ authToken }: DashboardClientProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [numero, setNumero] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [loading, setLoading] = useState(false);
  const [snack, setSnack] = useState<{ open: boolean; message: string; severity: "success" | "error" }>({
    open: false,
    message: "",
    severity: "success",
  });

  const columns = useMemo<GridColDef[]>(
    () => [
      { field: "kind", headerName: "Tipo", width: 100 },
      { field: "numero", headerName: "Numero", flex: 1 },
      { field: "mensagem", headerName: "Mensagem", flex: 2 },
      { field: "status", headerName: "Status", width: 140 },
      { field: "detail", headerName: "Detalhe", flex: 2 },
      { field: "created_at", headerName: "Data", width: 220 },
    ],
    []
  );

  const authHeaders = useCallback((): Record<string, string> => {
    if (!authToken) {
      return {};
    }
    return { Authorization: `Bearer ${authToken}` };
  }, [authToken]);

  const refresh = useCallback(async () => {
    const [statusRes, logsRes] = await Promise.all([
      fetch("/status", { headers: authHeaders() }).then((r) => r.json()),
      fetch("/api/logs", { headers: authHeaders() }).then((r) => r.json()),
    ]);

    setStatus(statusRes);
    if (statusRes?.status === "connected") {
      setQrCode(null);
    } else if (statusRes?.qr) {
      setQrCode(statusRes.qr);
    }
    setLogs(logsRes.logs ?? []);
  }, [authHeaders]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  async function connect() {
    setLoading(true);
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao conectar");
      setSnack({ open: true, message: "Conexao iniciada", severity: "success" });
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
      const res = await fetch("/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ numero, mensagem }),
      });
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
              <Typography color="text.secondary">Integracao interna com ERP via sessao persistente</Typography>
              <Typography className="mt-2" color={status?.status === "connected" ? "success.main" : "error.main"} sx={{ fontWeight: 700 }}>
                {status?.status === "connected" ? "Conectado" : "Desconectado"}
              </Typography>
              {status?.lastError && status.status !== "connected" && (
                <Typography className="mt-2" color="warning.main" variant="body2">
                  Ultimo erro: {status.lastError}
                </Typography>
              )}
              {status?.nextRetryAt && status.status !== "connected" && (
                <Typography className="mt-2" color="info.main" variant="body2">
                  Proxima tentativa: {status.nextRetryAt}
                </Typography>
              )}
            </Box>
            <Stack direction="row" spacing={2}>
              <Button variant="contained" onClick={connect} disabled={loading}>
                {loading ? <CircularProgress size={20} /> : "Reconectar"}
              </Button>
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
            <TextField label="Numero" value={numero} onChange={(e) => setNumero(e.target.value)} fullWidth />
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
