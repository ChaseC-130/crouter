import { after } from "next/server";
import { z } from "zod";
import { endpoint, readBody } from "@/lib/server/security";
import { project } from "@/lib/server/db";
import { generateProjectContext } from "@/lib/server/project-context";

export const runtime = "nodejs";
export const maxDuration = 750;
const inputSchema = z
  .object({ projectId: z.uuid(), retry: z.boolean().default(false) })
  .strict();

export function POST(request: Request) {
  return endpoint(request, true, async () => {
    const { projectId, retry } = await readBody(request, inputSchema);
    const p = project(projectId);
    if (p.kind !== "general" && !p.description?.trim())
      after(() => generateProjectContext(projectId, retry));
    return { project: p };
  });
}
