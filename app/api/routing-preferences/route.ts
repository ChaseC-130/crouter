import { endpoint, readBody } from "@/lib/server/security";
import { routingPreferenceInput } from "@/lib/server/schemas";
import {
  routingPreferences,
  updateRoutingPreferences,
} from "@/lib/server/routing-preferences";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return endpoint(request, false, async () => ({
    preferences: routingPreferences(),
  }));
}
export function POST(request: Request) {
  return endpoint(request, true, async () => ({
    preferences: updateRoutingPreferences(
      await readBody(request, routingPreferenceInput, 65536),
    ),
  }));
}
