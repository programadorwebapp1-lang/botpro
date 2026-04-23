"use client";

import { PropsWithChildren } from "react";
import { AppBar, Box, CssBaseline, Drawer, Toolbar, Typography } from "@mui/material";

const drawerWidth = 260;

export function DashboardShell({ children }: PropsWithChildren) {
  return (
    <Box className="min-h-screen bg-slate-950 text-white">
      <CssBaseline />
      <AppBar position="fixed" sx={{ ml: `${drawerWidth}px`, width: `calc(100% - ${drawerWidth}px)`, bgcolor: "rgba(15,23,42,0.9)" }}>
        <Toolbar>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            WhatsApp ERP
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: drawerWidth, "& .MuiDrawer-paper": { width: drawerWidth, bgcolor: "#0f172a", color: "white" } }}>
        <Toolbar />
        <Box className="p-4 space-y-3">
          <div className="rounded-2xl bg-white/5 p-4">
            <p className="text-sm text-slate-300">Painel SaaS</p>
            <p className="text-lg font-semibold">Operação WhatsApp</p>
          </div>
        </Box>
      </Drawer>
      <Box component="main" sx={{ ml: `${drawerWidth}px` }} className="p-6 pt-24">
        {children}
      </Box>
    </Box>
  );
}
