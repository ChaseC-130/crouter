import { endpoint } from "@/lib/server/security";
import { providerCatalog } from "@/lib/server/provider-catalog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return endpoint(request, false, async () => ({
    providers: await providerCatalog(),
  }));
}
