import { endpoint, readBody } from "@/lib/server/security";
import { runTask, recoverTask } from "@/lib/server/service";
import { taskDetail } from "@/lib/server/orchestrator";
import { project } from "@/lib/server/db";
import { taskInput, detailInput } from "@/lib/server/schemas";
import { AppError } from "@/lib/server/errors";
export const runtime = "nodejs";
export const maxDuration = 660;
export function POST(request: Request) {
  return endpoint(request, true, async () => {
    const input = await readBody(request, taskInput);
    return input.operation === "run"
      ? runTask(input.projectId, input.taskId)
      : recoverTask(input.projectId, input.taskId);
  });
}
export function GET(request: Request) {
  return endpoint(request, false, async () => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const input = detailInput.safeParse(query);
    if (!input.success)
      throw new AppError("Valid project and task IDs are required.");
    return taskDetail(project(input.data.projectId), input.data.taskId);
  });
}
