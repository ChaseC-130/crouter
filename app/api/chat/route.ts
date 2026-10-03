import { endpoint, readBody } from "@/lib/server/security";
import { chat } from "@/lib/server/service";
import { chatInput } from "@/lib/server/schemas";
export const runtime = "nodejs";
export function POST(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, chatInput);
    return chat(input.turn, input.provider);
  });
}
