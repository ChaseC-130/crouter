// One fresh process per operation. No global history, tools, network, or model context.
import { operate } from "./project-state.mjs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 20000)
    throw new Error("Input budget exceeded.");
}
try {
  process.stdout.write(
    JSON.stringify({ ok: true, result: await operate(JSON.parse(input)) }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error.code
        ? "Cannot access project state. Check directory permissions."
        : error.message,
    }),
  );
  process.exitCode = 1;
}
