import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WhatsApp ERP",
  description: "Painel WhatsApp Web com Baileys, Next.js, MUI, Tailwind e MongoDB",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
