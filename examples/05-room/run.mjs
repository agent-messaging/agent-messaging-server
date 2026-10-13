// A room where three agents share files and work on one task.
//
//   node examples/05-room/run.mjs
//
// A planner opens a durable room (a record and a drive kept by the mesh's
// rooms service) and puts one task on the room's work board. A writer joins,
// claims the task, puts its draft on the drive and marks the task done with
// the draft attached. A reviewer joins, fetches the draft, checks it is the
// exact file the writer put there, and adds its review. The planner reads the
// room's record and its files, then closes the room.

import { createHash } from "node:crypto";
import { check, connect, enroll, run, say, tenant } from "../lib/mesh.mjs";

const team = await tenant(`studio-${run}`);
const [planner, writer, reviewer] = await Promise.all(["planner", "writer", "reviewer"].map((n) => enroll(team, n)));
const [p, w, r] = await Promise.all([planner, writer, reviewer].map((a) => connect(a)));
say("Three agents of one team are connected: a planner, a writer and a reviewer.");

const opened = await p.rooms.open({ name: `launch-note-${run}`, durable: true });
check(Boolean(opened.room_id && opened.token), `the planner opened a durable room (${opened.room_id})`);
const room = opened.room_id;

const posted = await p.board.post({ room, title: "Write a three-sentence launch note for the new release" });
const itemId = posted.item?.id ?? posted.item?.item_id;
check(Boolean(itemId), "the planner put the task on the room's work board");

// The token is the room's invitation; here the planner hands it over directly.
await w.rooms.join({ invite_or_token: opened.token });
await r.rooms.join({ invite_or_token: opened.token });
check(true, "the writer and the reviewer joined the room with its token");

const claimed = await w.board.claim({ room, item_id: itemId });
check(Boolean(claimed.item), "the writer claimed the task (only one member's claim can win)");

const draft = [
  "The new release is out today.",
  "Agents on different brokers now reach each other through one server.",
  "Upgrade by pulling the new image and restarting.",
].join(" ");
const attached = await w.rooms.attach({ room, name: "launch-note.md", content: draft });
check(Boolean(attached.ref), `the writer put its draft on the room's drive (${attached.size} bytes, sha256 ${attached.digest?.slice(0, 16)}...)`);
await w.board.done({ room, item_id: itemId, note: "Draft is on the drive.", artifacts: [attached.ref] });
await w.rooms.post({ room, text: "The draft is on the drive as launch-note.md." });

const fetched = await r.rooms.fetch({ room, ref: attached.ref });
const digest = createHash("sha256").update(fetched.text ?? "").digest("hex");
check(fetched.text === draft && (fetched.digest ?? "").includes(digest), "the reviewer fetched the exact draft and its digest matches");
await r.rooms.attach({ room, name: "review.md", content: "Reads well. Approved as written." });
await r.rooms.post({ room, text: "Approved. My notes are in review.md." });

const files = await p.rooms.files({ room });
const names = (files.files ?? []).map((f) => f.name).sort();
check(names.includes("launch-note.md") && names.includes("review.md"), `the room's drive holds both files (${names.join(", ")})`);
const board = await p.board.list({ room });
check((board.done ?? board.items?.filter((i) => i.state === "done").length ?? 0) >= 1, "the work board shows the task done");
const history = await p.rooms.history({ room });
check((history.entries ?? []).length >= 4, `the room's record holds what happened (${(history.entries ?? []).length} entries${(history.entries ?? []).length ? "" : `: ${JSON.stringify(history).slice(0, 300)}`})`);

// The live room the planner opened: closing tells the members, and reclaim
// deletes the record and the drive and frees the tenant's room quota.
opened.room.close("The launch note is approved.");
await opened.room.reclaim();
const after = await p.rooms.files({ room }).catch((e) => ({ gone: String(e?.message ?? e) }));
check(!(after.files ?? []).length, "the planner closed the room and reclaimed its record and drive");

await Promise.all([p, w, r].map((m) => m.close()));
say("Done: three agents, one room, one task, two files.");
process.exit(0);
