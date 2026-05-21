import { NextResponse } from "next/server";

export function getExpectedToken() {
  return process.env.API_TOKEN ?? process.env.WHATSAPP_API_TOKEN ?? process.env.ERP_API_TOKEN ?? "";
}

export function requireApiToken(request: Request) {
  const expected = getExpectedToken();
  if (!expected) {
    return null;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export function requireSocketToken(token: string | undefined | null) {
  const expected = getExpectedToken();
  if (!expected) {
    return true;
  }
  return token === expected;
}
