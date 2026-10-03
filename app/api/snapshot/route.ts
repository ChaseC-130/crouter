import { endpoint } from "@/lib/server/security";
import { snapshot } from "@/lib/server/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return endpoint(request, false, snapshot);
}
