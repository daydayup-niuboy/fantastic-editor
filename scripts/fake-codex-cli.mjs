const scenario = process.argv[2] ?? "normal";

const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const complete = () => {
  event({ type: "thread.started" });
  event({ type: "future.event" });
  event({ type: "turn.started" });
  event({ type: "item.completed", item: { type: "agent_message", text: "处理结果" } });
  event({ type: "turn.completed" });
};

if (scenario === "normal") {
  complete();
} else if (scenario === "out-of-order") {
  event({ type: "item.completed", item: { type: "agent_message", text: "结果" } });
} else if (scenario === "truncated") {
  process.stdout.write('{"type":"thread.started"');
} else if (scenario === "non-zero") {
  process.stderr.write("secret-token");
  process.exitCode = 2;
} else if (scenario === "oversized") {
  event({ type: "thread.started" });
  event({ type: "turn.started" });
  event({ type: "item.completed", item: { type: "agent_message", text: "界".repeat(90_000) } });
} else if (scenario === "raw-oversized") {
  process.stdout.write("x".repeat(330_000));
} else if (scenario === "claude-normal") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const required = ["-p", "--input-format", "text", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", "{}"];
    const args = process.argv.slice(3);
    const valid = required.every((value, index) => args[index] === value) && input.includes("<content>\n正文\n</content>");
    process.stdout.write(JSON.stringify(valid
      ? { type: "result", subtype: "success", is_error: false, result: "Claude 处理结果" }
      : { type: "result", subtype: "error", is_error: true, result: "invalid invocation" }));
  });
} else if (scenario === "claude-malformed") {
  process.stdout.write('{"type":"result"');
} else if (scenario === "claude-error") {
  process.stderr.write("secret-token");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "secret-token" }));
} else if (scenario === "claude-oversized") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "界".repeat(88_000) }));
} else if (scenario === "hang") {
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
} else if (scenario === "ui") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.includes("取消测试")) setInterval(() => undefined, 1_000);
    else setTimeout(complete, input.includes("陈旧测试") ? 300 : 0);
  });
}
