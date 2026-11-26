import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Notifications } from "../server/notifications.mjs";

// A device that was offline replays a backlog larger than the slow-client limit.
test("a long backlog replays completely and the stream stays open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-replay-"));
  const notifications = await new Notifications(dir).load();
  const body = "x".repeat(1500);
  for (let i = 0; i < 400; i++)
    await notifications.publish({ id: `n${i}`, type: "completed", agentId: "agent", title: "Done", body });
  const server = http.createServer((request, response) => notifications.subscribe(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const ids = [];
    let request;
    const connected = await new Promise((resolve, reject) => {
      request = http.get({ port: server.address().port, headers: { "last-event-id": "n0" } }, (response) => {
        assert.equal(response.statusCode, 200);
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
          if (text.includes(": connected\n\n")) resolve(text);
        });
        response.on("close", () => reject(new Error("stream closed during replay")));
      });
      request.on("error", reject);
    });
    for (const match of connected.matchAll(/^id: (\S+)$/gm)) ids.push(match[1]);
    assert.equal(ids.length, 399);
    assert.equal(ids[0], "n1");
    assert.equal(ids.at(-1), "n399");
    // A live event after the replay still reaches the same stream.
    const live = new Promise((resolve) => request.res.on("data", (chunk) => chunk.includes("id: live") && resolve()));
    await notifications.publish({ id: "live", type: "test", agentId: "agent", title: "Live", body: "" });
    await live;
    request.destroy();
  } finally {
    notifications.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
