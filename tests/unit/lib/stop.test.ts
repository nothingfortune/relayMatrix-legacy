/**
 * `azeron stop` asks the editor server to stop and waits until its port is quiet. Tested
 * against real loopback servers on ephemeral ports, because what it promises is about what
 * a client sees: what it says when the server stops, when no one is there, and when
 * something else is.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { guardedListener, readBody, STOP_PATH, stopServer } from "../../../src/lib/serve.js";

const open: Server[] = [];

/** A server that answers like the editor's: the guard first, then a stop route. */
async function editorLike(onStop: "close" | "linger" | "unknown"): Promise<number> {
  const route = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === "POST" && request.url === STOP_PATH && onStop !== "unknown") {
      readBody(request, response, 1_000, () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, stopping: true }), () => {
          if (onStop === "close") {
            created.close();
            created.closeAllConnections();
          }
        });
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  };
  const created: Server = createServer(
    guardedListener(route, () => (created.address() as AddressInfo).port),
  );
  open.push(created);
  await new Promise<void>((done) => {
    created.listen(0, "127.0.0.1", done);
  });
  return (created.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of open.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
});

describe("stopServer", () => {
  it("stops a server that says it is stopping, and returns once its port is quiet", async () => {
    const port = await editorLike("close");
    expect(await stopServer(port)).toEqual({ kind: "stopped" });
    // Quiet: nothing now answers there.
    expect(await stopServer(port)).toEqual({ kind: "nothing" });
  });

  it("says nothing is running when no one is listening", async () => {
    const port = await editorLike("close");
    const [server] = open.splice(0);
    await new Promise<void>((done) => {
      server?.close(() => {
        done();
      });
    });
    expect(await stopServer(port)).toEqual({ kind: "nothing" });
  });

  it("does not take another program's answer for a stop", async () => {
    // A server from before `stop` existed answers an unknown route with a 404.
    const port = await editorLike("unknown");
    expect(await stopServer(port)).toEqual({ kind: "not-ours", status: 404 });
  });

  it("reports a server that said it was stopping and is still answering", async () => {
    const port = await editorLike("linger");
    expect(await stopServer(port, { settleMs: 300 })).toEqual({ kind: "still-running" });
  });

  it("reports a port that is open but does not answer in time", async () => {
    const failing = (() => {
      throw new Error("the operation timed out");
    }) as unknown as typeof fetch;
    const result = await stopServer(1, { fetchImpl: failing });
    expect(result.kind).toBe("no-answer");
  });
});

describe("the stop request is not one a web page can send", () => {
  it("is refused without a JSON content type, as every state-changing request is", async () => {
    const port = await editorLike("close");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: STOP_PATH,
          method: "POST",
          headers: { "content-type": "text/plain" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(415);
    // And it is still there.
    expect(await stopServer(port)).toEqual({ kind: "stopped" });
  });

  it("is refused from another site's origin", async () => {
    const port = await editorLike("close");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: STOP_PATH,
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
