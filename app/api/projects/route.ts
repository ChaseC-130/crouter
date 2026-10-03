import { endpoint, readBody } from "@/lib/server/security";
import { registerProject, updateProjectDetails } from "@/lib/server/service";
import { projectInput, projectUpdateInput } from "@/lib/server/schemas";
import {
  projectPathBase,
  resolveProjectPath,
} from "@/lib/server/project-paths";
export const runtime = "nodejs";
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
    return registerProject(
      input.name,
      input.path,
      input.aliases,
      input.description,
    );
  });
}

export function PATCH(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, projectUpdateInput);
    return updateProjectDetails(
      input.id,
      input.name,
      input.aliases,
      input.description,
    );
  });
}
