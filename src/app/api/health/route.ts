import { handleHealthRequest } from "@/lib/api-handlers";

export const runtime = "nodejs";

export async function GET() {
  return handleHealthRequest();
}
