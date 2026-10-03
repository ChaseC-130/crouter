import { endpoint } from "@/lib/server/security";
import { providerCatalog } from "@/lib/server/provider-catalog";
import { routingPreferences } from "@/lib/server/routing-preferences";
export const runtime = "nodejs";
export const maxDuration = 150;
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return endpoint(request, false, async () => ({
    providers: await providerCatalog(),
    preferences: routingPreferences(),
  }));
}
