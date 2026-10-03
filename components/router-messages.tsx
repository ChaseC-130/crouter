"use client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { GitBranch, CheckCircle2, AlertCircle } from "lucide-react";
import type { Message } from "@/lib/types";
const labels = {
  status: "Status check",
  create_task: "Task created",
  unknown: "Routing",
  worker_completed: "Worker completed",
  worker_failed: "Worker stopped",
};
function convert(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: [{ type: "text", text: message.content }],
    metadata: { custom: { intent: message.intent } },
  };
}
export function RouterMessages({
  messages,
  isRunning,
  onSend,
}: {
  messages: Message[];
  isRunning: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage: convert,
    onNew: async (message) => {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      await onSend(text);
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const intent = message.metadata.custom.intent as Message["intent"];
            const completion =
              intent === "worker_completed" || intent === "worker_failed";
            return (
              <MessagePrimitive.Root
                className={`chat-message ${message.role} ${completion ? "worker-event" : ""}`}
              >
                {message.role === "user" ? (
                  <span className="human-avatar">You</span>
                ) : (
                  <span className="assistant-avatar">
                    {intent === "worker_completed" ? (
                      <CheckCircle2 size={17} />
                    ) : intent === "worker_failed" ? (
                      <AlertCircle size={17} />
                    ) : (
                      <GitBranch size={17} />
                    )}
                  </span>
                )}
                <div className="message-content">
                  <div className="message-meta">
                    <strong>
                      {message.role === "user" ? "You" : "crouter"}
                    </strong>
                    <span>
                      {message.createdAt.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    {intent && (
                      <span className="route-tag">{labels[intent]}</span>
                    )}
                  </div>
                  <MessagePrimitive.Content />
                </div>
              </MessagePrimitive.Root>
            );
          }}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
