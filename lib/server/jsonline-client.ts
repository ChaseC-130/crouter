import "server-only";
import { spawn } from "node:child_process";
import { AppError } from "./errors";
type Packet = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
export class JsonLineClient {
  private child;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private buffer = "";
  private total = 0;
  private closed = false;
  constructor(
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    onNotification: (packet: Packet) => void = () => {},
    private dialect: "codex" | "acp" = "codex",
  ) {
    this.child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk) => {
      this.total += chunk.length;
      if (this.total > 2 * 1024 * 1024) {
        this.close();
        return;
      }
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const packet = JSON.parse(line) as Packet;
          if (packet.method && packet.id !== undefined) {
            if (packet.method === "session/request_permission")
              this.send({
                id: packet.id,
                result: { outcome: { outcome: "cancelled" } },
              });
            else
              this.send({
                id: packet.id,
                error: {
                  code: -32601,
                  message: "Client tool access is disabled",
                },
              });
            continue;
          }
          if (packet.method) {
            onNotification(packet);
            continue;
          }
          if (typeof packet.id !== "number") continue;
          const request = this.pending.get(packet.id);
          if (!request) continue;
          this.pending.delete(packet.id);
          clearTimeout(request.timer);
          if (packet.error)
            request.reject(
              new AppError(
                "The official CLI rejected this operation. Check its login and supported protocol.",
                503,
              ),
            );
          else request.resolve(packet.result);
        } catch {
          /* Diagnostic lines never reach the browser. */
        }
      }
    });
    this.child.on("error", () => this.close());
    this.child.on("close", () => this.close());
    this.child.stdin.on("error", () => this.close());
  }
  private send(packet: Packet) {
    if (this.closed) return;
    this.child.stdin.write(
      JSON.stringify(
        this.dialect === "acp" ? { jsonrpc: "2.0", ...packet } : packet,
      ) + "\n",
    );
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 10000,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new AppError("CLI connection is closed.", 503));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("The official CLI did not respond in time.", 503));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params: Record<string, unknown> = {}) {
    this.send({ method, params });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new AppError(
          "The official CLI connection ended before completing the operation.",
          503,
        ),
      );
    }
    this.pending.clear();
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {
      /* Already exited. */
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && this.child.pid)
          process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, 250);
    timer.unref();
  }
}
