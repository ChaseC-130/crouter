import { endpoint, readBody } from "@/lib/server/security";
import { after } from "next/server";
import { generateProjectContext } from "@/lib/server/project-context";
import { registerProject, updateProjectDetails } from "@/lib/server/service";
import { projectInput, projectUpdateInput } from "@/lib/server/schemas";
import {
  projectPathBase,
  resolveProjectPath,
} from "@/lib/server/project-paths";
export const runtime = "nodejs";
export const maxDuration = 750;
export function GET(request: Request) {
  return endpoint(request, false, async () => ({
    path: await resolveProjectPath(
      new URL(request.url).searchParams.get("path") || "",
    ),
    base: projectPathBase(),
  }));
}
export function POST(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, projectInput);
    const result = await registerProject(
      input.name,
      input.path,
      input.aliases,
      input.description,
    );
    if (!result.project.description?.trim())
      after(() => generateProjectContext(result.project.id));
    return result;
  });
}

export function PATCH(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, projectUpdateInput);
    const result = await updateProjectDetails(
      input.id,
      input.name,
      input.aliases,
      input.description,
    );
    if (!result.project.description?.trim())
      after(() => generateProjectContext(result.project.id));
    return result;
  });
}
