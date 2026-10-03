import { z } from "zod";
import { AppError } from "./errors";
const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function assertLocal(request: Request, mutation = false) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  let supplied: URL;
  try {
    supplied = new URL(`http://${host}`);
  } catch {
    throw new AppError("Invalid host.", 403);
  }
  const origin = request.headers.get("origin");
  let expected = process.env.CROUTER_ORIGIN || url.origin;
  const tailnet = process.env.CROUTER_TAILSCALE_ORIGIN;
  if (tailnet) {
    let configured: URL;
    try {
      configured = new URL(tailnet);
    } catch {
      throw new AppError(
        "Invalid private Tailscale origin configuration.",
        503,
      );
    }
    if (
      configured.protocol !== "https:" ||
      !configured.hostname.endsWith(".ts.net") ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash ||
      configured.username ||
      configured.password
    )
      throw new AppError("Set an exact HTTPS ts.net origin with no path.", 503);
    const allowed = (process.env.CROUTER_TAILSCALE_USERS || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const identity = request.headers.get("tailscale-user-login")?.toLowerCase();
    if (!identity || !allowed.includes(identity))
      throw new AppError(
        "A permitted Tailscale Serve identity is required.",
        403,
      );
    if (supplied.host !== configured.host && !hosts.has(supplied.hostname))
      throw new AppError("Unexpected private proxy host.", 403);
    expected = configured.origin;
  } else if (!hosts.has(supplied.hostname) || supplied.port !== url.port)
    throw new AppError("Only loopback requests are accepted.", 403);
  if (origin && origin !== expected)
    throw new AppError("Cross-origin requests are blocked.", 403);
  if (
    mutation &&
    (!origin ||
      origin !== expected ||
      request.headers.get("x-crouter-request") !== "1")
  )
    throw new AppError("A same-origin application request is required.", 403);
  if (
    mutation &&
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    throw new AppError("Send JSON.", 415);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError("Cross-site requests are blocked.", 403);
}
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("Request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new AppError("Request is too large.", 413);
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new AppError(parsed.error.issues.map((i) => i.message).join("; "));
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Invalid JSON.");
  }
}
export async function endpoint(
  request: Request,
  mutation: boolean,
  handler: () => Promise<unknown>,
) {
  try {
    assertLocal(request, mutation);
    return Response.json(await handler(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const { safeError } = await import("./errors");
    return Response.json(
      { error: safeError(error) },
      {
        status: error instanceof AppError ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
