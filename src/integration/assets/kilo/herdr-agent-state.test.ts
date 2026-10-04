import { beforeEach, expect, mock, test } from "bun:test";

const requests: unknown[] = [];
const clients: FakeClient[] = [];
const requestWaiters: Array<() => void> = [];
let autoAcknowledge = true;
let importCounter = 0;

type FakeClient = {
  emit: (event: string) => void;
};

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect: () => void) {
      const handlers = new Map<string, () => void>();
      const client = {
        write(input: string) {
          requests.push(JSON.parse(input.trim()));
          requestWaiters.shift()?.();
          if (autoAcknowledge) {
            queueMicrotask(() => client.emit("data"));
          }
        },
        setTimeout() {},
        on(event: string, handler: () => void) {
          handlers.set(event, handler);
        },
        destroy() {},
        emit(event: string) {
          handlers.get(event)?.();
        },
      };
      clients.push(client);
      queueMicrotask(onConnect);
      return client;
    },
  },
}));

beforeEach(() => {
  requests.length = 0;
  clients.length = 0;
  requestWaiters.length = 0;
  autoAcknowledge = true;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
});

async function loadPlugin() {
  importCounter += 1;
  const { HerdrAgentStatePlugin } = await import(`./herdr-agent-state.js?test=${importCounter}`);
  return HerdrAgentStatePlugin();
}

function waitForNextRequest(): Promise<void> {
  return new Promise((resolve) => requestWaiters.push(resolve));
}

test("object-form idle status clears working state", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    },
  });
  await plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "idle" } },
    },
  });

  expect(requests.map(requestState)).toEqual(["working", "idle"]);
  expect(requests.map(requestSessionID)).toEqual(["root-session", "root-session"]);
});

test("reports retry status as working", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "retry" } },
    },
  });
  await plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: "retry" },
    },
  });

  expect(requests.map(requestMethod)).toEqual(["pane.report_agent", "pane.report_agent"]);
  expect(requests.map(requestState)).toEqual(["working", "working"]);
});

test("serializes lifecycle reports", async () => {
  autoAcknowledge = false;
  const plugin = await loadPlugin();
  const firstDispatched = waitForNextRequest();
  const working = plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    },
  });
  await firstDispatched;

  const secondDispatched = waitForNextRequest();
  const idle = plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "idle" } },
    },
  });
  expect(clients).toHaveLength(1);

  clients[0]?.emit("data");
  await secondDispatched;
  expect(clients).toHaveLength(2);
  clients[1]?.emit("data");
  await Promise.all([working, idle]);

  expect(requests.map(requestState)).toEqual(["working", "idle"]);
  const sequences = requests.map(requestSeq);
  expect(sequences[0]).toEqual(expect.any(Number));
  expect(sequences[1]).toBe((sequences[0] as number) + 1);
});

test("reports child prompts against the root session", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "child-session",
        info: { id: "child-session", parentID: "root-session" },
      },
    },
  });

  for (const type of ["permission.asked", "question.asked"]) {
    await plugin.event({ event: { type, properties: { sessionID: "child-session" } } });
  }
  for (const type of ["permission.replied", "question.replied", "question.rejected"]) {
    await plugin.event({ event: { type, properties: { sessionID: "child-session" } } });
  }

  expect(requests.map(requestState)).toEqual([
    "blocked",
    "blocked",
    "working",
    "working",
    "working",
  ]);
  // Child prompts resolve to the root id so the pane keeps its session
  // identity and the server cross-talk guard stays intact.
  expect(requests.map(requestSessionID)).toEqual([
    "root-session",
    "root-session",
    "root-session",
    "root-session",
    "root-session",
  ]);
});

test("session.created adopts a new root session", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: { type: "session.created", properties: { sessionID: "root-session" } },
  });

  expect(requests.map(requestMethod)).toEqual(["pane.report_agent_session"]);
  expect(requests.map(requestSessionID)).toEqual(["root-session"]);
  expect(requestStartSource(requests[0])).toBe("startup");
});

test("session.created skips child sessions", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "child-session",
        info: { id: "child-session", parentID: "root-session" },
      },
    },
  });

  expect(requests).toEqual([]);
});

test("session.deleted prunes the child entry", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "child-session",
        info: { id: "child-session", parentID: "root-session" },
      },
    },
  });
  await plugin.event({
    event: { type: "session.deleted", properties: { sessionID: "child-session" } },
  });
  await plugin.event({
    event: { type: "permission.asked", properties: { sessionID: "child-session" } },
  });

  // The pruned id is no longer treated as a child, so the prompt is reported
  // as a regular blocked state carrying the session id.
  expect(requests.map(requestState)).toEqual(["blocked"]);
  expect(requests.map(requestSessionID)).toEqual(["child-session"]);
});

test("self-parenting info cannot hang the ancestor walk", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "loop-session",
        info: { id: "loop-session", parentID: "loop-session" },
      },
    },
  });
  await plugin.event({
    event: { type: "permission.asked", properties: { sessionID: "loop-session" } },
  });

  // The self-parent id is never registered as a child, so creation adopts
  // it as a root session and the prompt terminates instead of hanging.
  expect(requests.map(requestMethod)).toEqual([
    "pane.report_agent_session",
    "pane.report_agent",
  ]);
  expect(requests.map(requestState)).toEqual([undefined, "blocked"]);
  expect(requests.map(requestSessionID)).toEqual(["loop-session", "loop-session"]);
});

function requestMethod(request: unknown): unknown {
  return isRecord(request) ? request.method : undefined;
}

function requestState(request: unknown): unknown {
  return requestParam(request, "state");
}

function requestSeq(request: unknown): unknown {
  return requestParam(request, "seq");
}

function requestSessionID(request: unknown): unknown {
  return requestParam(request, "agent_session_id");
}

function requestStartSource(request: unknown): unknown {
  return requestParam(request, "session_start_source");
}

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
