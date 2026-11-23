// Forwards OpenCode V2 events to the local AlifGunadi Office server.
// Read-only bridge: POSTs Claude-Code-shaped events to /event. Never throws, never blocks OpenCode.
// Install with `node install.js --target opencode`; the installer fills in the repo location below.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.ALIFGUNADI_OFFICE_PORT) || 4317;
const ROOT = process.env.ALIFGUNADI_OFFICE_ROOT || "__ALIFGUNADI_OFFICE_ROOT__";
const ENSURE_SERVER = `${ROOT}/ensure-server.js`;

function send(evt) {
  fetch(`http://127.0.0.1:${PORT}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AlifGunadi-Office": "1" },
    body: JSON.stringify({ v: 1, source: "opencode", ...evt }),
    signal: AbortSignal.timeout(800),
  }).catch(() => {});
}

// Desk ids are basenames of agents ("engineering/lead-dba" -> "lead-dba").
const deskId = (name) => String(name || "subagent").split("/").pop();

// Same privacy rules as hook.js: file base name, program name and a short pattern only.
const baseName = (value) => (typeof value === "string" && value ? value.split(/[\\/]/).pop().slice(0, 100) : undefined);

function programName(command) {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return "env";
  return tokens[0].split(/[\\/]/).pop().slice(0, 40);
}

function slimInput(input) {
  if (!input || typeof input !== "object") return undefined;
  const slim = {};
  const file = baseName(input.filePath || input.file_path || input.path);
  if (file) slim.file_path = file;
  if (typeof input.pattern === "string") slim.pattern = input.pattern.slice(0, 40);
  if (typeof input.command === "string" && input.command.trim()) slim.command = programName(input.command);
  return slim;
}

// ponytail: Tool calls inside a subagent land on the main desk because V2 tool hooks are not mapped to child sessions here.
// Add a child-session -> agent map when the V2 task event exposes the child session id.
export default {
  id: "alifgunadi-office",
  setup(ctx) {
    if (typeof ctx?.event?.subscribe !== "function") return;
    try {
      if (existsSync(ENSURE_SERVER)) {
        spawn("node", [ENSURE_SERVER], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
      }
    } catch {}

    const controller = new AbortController();
    let nextCall = 0;
    const taskCalls = []; // FIFO of running task agent ids; V2 hook payload carries no call id we rely on

    void (async () => {
      for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const d = e.data || {};
          const sid = d.sessionID;
          switch (e.type) {
            case "session.created":
              send({ hook_event_name: "SessionStart", session_id: sid });
              break;
            case "session.deleted":
              send({ hook_event_name: "SessionEnd", session_id: sid });
              break;
            case "session.execution.started":
              send({ hook_event_name: "UserPromptSubmit", session_id: sid });
              break;
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              send({ hook_event_name: "Stop", session_id: sid });
              break;
            case "permission.asked":
              send({ hook_event_name: "Notification", session_id: sid, notification_type: "permission_prompt" });
              break;
            case "form.created":
              send({ hook_event_name: "Notification", session_id: sid, notification_type: "idle_prompt" });
              break;
            default:
              break;
          }
        } catch {}
      }
    })().catch(() => {});

    const hookTool = async (name, fn) => {
      try {
        if (typeof ctx.tool?.hook === "function") await ctx.tool.hook(name, fn);
      } catch {}
    };

    void hookTool("execute.before", (event) => {
      try {
        const sessionId = event.sessionID;
        if (event.tool === "task") {
          const id = `task-${++nextCall}`;
          taskCalls.push({ id, type: deskId(event.input?.subagent_type) });
          send({ hook_event_name: "SubagentStart", session_id: sessionId, agent_id: id, agent_type: deskId(event.input?.subagent_type) });
          return;
        }
        send({ hook_event_name: "PreToolUse", session_id: sessionId, tool_name: event.tool, tool_input: slimInput(event.input) });
      } catch {}
    });

    void hookTool("execute.after", (event) => {
      try {
        if (event.tool !== "task") return;
        const call = taskCalls.shift();
        if (call) send({ hook_event_name: "SubagentStop", session_id: event.sessionID, agent_id: call.id, agent_type: call.type });
      } catch {}
    });

    return () => controller.abort();
  },
};
