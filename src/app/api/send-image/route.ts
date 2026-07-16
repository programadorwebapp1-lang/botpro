import { handleSendImageRequest } from "@/lib/api-handlers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleSendImageRequest(request);
}
