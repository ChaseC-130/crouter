import { endpoint, readBody } from "@/lib/server/security";
import { previewAction, approveAction } from "@/lib/server/service";
import { approvalInput } from "@/lib/server/schemas";
export const runtime = "nodejs";
export function POST(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, approvalInput);
    return input.operation === "preview"
      ? previewAction(input.action)
      : approveAction(input.id, input.confirmation);
  });
}
