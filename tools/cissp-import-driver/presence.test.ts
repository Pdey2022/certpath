import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionItem } from "./client.ts";
import type { QuestionRecord } from "./checkpoint.ts";
import { DriverError } from "./errors.ts";
import { pageOf } from "./fixtures.ts";
import {
  resolveUnitPresence,
  type PresenceInput,
  type PresenceRow,
  type UnitPresence,
} from "./presence.ts";
import type { TaxonomyIdMap } from "./transform.ts";

const IDS: TaxonomyIdMap = {
  examVersionId: "version-1",
  domainIds: new Map([
    ["cissp-d1", "dom-1"],
    ["cissp-d2", "dom-2"],
  ]),
  topicIds: new Map([
    ["cissp-d1-topic-1", "top-1"],
    ["cissp-d2-topic-1", "top-2"],
  ]),
};

function rows(
  count: number,
  domainKey = "cissp-d1",
  topicKey = "cissp-d1-topic-1",
  first = 1,
): PresenceRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `cissp-${first + index}`,
    domainKey,
    topicKey,
  }));
}

function record(key: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    key,
    unit: 1,
    domainKey: "cissp-d1",
    topicKey: "cissp-d1-topic-1",
    questionId: `question-${key}`,
    revisionId: `revision-${key}`,
    state: "draft",
    pointerVersion: null,
    inFlight: null,
    ...overrides,
  };
}

function item(key: string, overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id: `id-${key}`,
    questionKey: key,
    currentRevisionId: `current-revision-${key}`,
    revisionNumber: 1,
    ...overrides,
  };
}

interface ReaderCall {
  domainId: string;
  topicId: string;
  cursor: string | null;
}

/**
 * A faithful page store over the given items: honours `limit` and `cursor`,
 * orders by id and sets `nextCursor` only when more remain.
 */
function paged(
  items: readonly QuestionItem[],
  options: { limit?: number; nextCursor?: (next: string | null) => unknown } = {},
) {
  const calls: ReaderCall[] = [];
  const limit = options.limit ?? 50;
  return {
    calls,
    async readPage(domainId: string, topicId: string, cursor: string | null) {
      calls.push({ domainId, topicId, cursor });
      const page = pageOf(items, { cursor, limit }, (entry) => entry.id);
      const next = options.nextCursor ? options.nextCursor(page.nextCursor) : page.nextCursor;
      return { items: page.items, nextCursor: next as string | null };
    },
  };
}

function input(overrides: Partial<PresenceInput> & Pick<PresenceInput, "rows" | "readPage">): PresenceInput {
  return {
    unit: 1,
    ids: IDS,
    questions: [],
    ...overrides,
  };
}

function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DriverError, `expected DriverError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("five keys the checkpoint holds are present with no read at all", async () => {
  const reader = paged([]);
  const presence = await resolveUnitPresence(
    input({
      rows: rows(5),
      questions: ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"].map((key) => record(key)),
      readPage: reader.readPage,
    }),
  );

  assert.equal(presence.kind, "all");
  assert.equal(presence.kind === "all" ? presence.ids.length : 0, 5);
  assert.deepEqual(
    presence.kind === "all" ? presence.ids.map((entry) => entry.source) : [],
    ["checkpoint", "checkpoint", "checkpoint", "checkpoint", "checkpoint"],
  );
  assert.equal(reader.calls.length, 0);
});

test("a published record is still present: workflow state does not gate presence", async () => {
  const reader = paged([]);
  const presence = await resolveUnitPresence(
    input({
      rows: rows(1),
      questions: [record("cissp-1", { state: "published", pointerVersion: 3 })],
      readPage: reader.readPage,
    }),
  );
  assert.equal(presence.kind, "all");
  assert.equal(reader.calls.length, 0);
});

test("a record with a publish in flight is still present", async () => {
  const reader = paged([]);
  const presence = await resolveUnitPresence(
    input({
      rows: rows(1),
      questions: [record("cissp-1", { inFlight: "publish" })],
      readPage: reader.readPage,
    }),
  );
  assert.equal(presence.kind, "all");
  assert.equal(reader.calls.length, 0);
});

test("a record with exactly one of the two ids is a corrupt checkpoint", async () => {
  const reader = paged([]);
  await expectCode(
    () =>
      resolveUnitPresence(
        input({
          rows: rows(1),
          questions: [record("cissp-1", { revisionId: null })],
          readPage: reader.readPage,
        }),
      ),
    "CHECKPOINT_INVALID",
  );
  assert.equal(reader.calls.length, 0);
});

test("a dropped id, an empty id or a record with no ids is a corrupt checkpoint", async () => {
  // A hand-edited checkpoint can lose a field entirely. `undefined === null` is
  // false, so a null-vs-undefined comparison would call the record complete and
  // hand out `questionId: undefined`, which JSON.stringify then drops. A record
  // with neither id is the same class: no writer produces one and nothing can
  // repair it, so it is not a reason to ask the server.
  const reader = paged([]);
  for (const patched of [
    { questionId: undefined },
    { questionId: "" },
    { revisionId: undefined },
    { revisionId: "" },
    { questionId: null, revisionId: null },
  ] as Array<Partial<QuestionRecord>>) {
    await expectCode(
      () =>
        resolveUnitPresence(
          input({
            rows: rows(1),
            questions: [{ ...record("cissp-1"), ...patched } as QuestionRecord],
            readPage: reader.readPage,
          }),
        ),
      "CHECKPOINT_INVALID",
    );
  }
  assert.equal(reader.calls.length, 0);
});

test("a unit that names the same key twice is a validation bug, not an absent row", async () => {
  const reader = paged([]);
  await expectCode(
    () =>
      resolveUnitPresence(
        input({
          rows: [{ key: "cissp-1", domainKey: "cissp-d1", topicKey: "cissp-d1-topic-1" },
            { key: "cissp-1", domainKey: "cissp-d1", topicKey: "cissp-d1-topic-1" }],
          readPage: reader.readPage,
        }),
      ),
    "DUPLICATE_QUESTION_KEY",
  );
  assert.equal(reader.calls.length, 0);
});

test("a key recorded under another unit is a corrupt checkpoint", async () => {
  const reader = paged([]);
  await expectCode(
    () =>
      resolveUnitPresence(
        input({
          rows: rows(1),
          questions: [record("cissp-1", { unit: 2 })],
          readPage: reader.readPage,
        }),
      ),
    "CHECKPOINT_INVALID",
  );
});

test("two local rows and three found on page three come back in row order", async () => {
  // The local rows sit at positions 2 and 4, so an implementation that returned
  // the order in which ids were *found* (local first, then the walk) would come
  // back as 2, 4, 1, 3, 5. Only the rebuild from row order passes.
  const reader = paged(
    [
      // The ids interleave: `id-cissp-1` sorts before `id-cissp-100`, so the
      // exact rows arrive one per page (cissp-1 on page 1, cissp-3 on page 2,
      // cissp-5 on page 3) and three reads are unavoidable.
      item("cissp-100"),
      item("cissp-101"),
      item("cissp-102"),
      item("cissp-103"),
      item("cissp-1"),
      item("cissp-3"),
      item("cissp-5"),
    ],
    { limit: 3 },
  );
  const presence = await resolveUnitPresence(
    input({
      rows: rows(5),
      questions: [record("cissp-2"), record("cissp-4")],
      readPage: reader.readPage,
    }),
  );

  assert.equal(presence.kind, "all");
  assert.deepEqual(
    presence.kind === "all" ? presence.ids.map((entry) => entry.key) : [],
    ["cissp-1", "cissp-2", "cissp-3", "cissp-4", "cissp-5"],
  );
  assert.deepEqual(
    presence.kind === "all" ? presence.ids.map((entry) => entry.source) : [],
    ["server", "checkpoint", "server", "checkpoint", "server"],
  );
  assert.equal(reader.calls.length, 3);
});

test("decoys only: an exhausted listing makes the keys absent, never the decoy", async () => {
  // `cissp-120` contains `cissp-1` as a substring and is not the row. The
  // listing is exhausted and no key matches exactly, so the answer is "none
  // present" - and no decoy id is handed back as if it were the row.
  const reader = paged([item("cissp-120"), item("cissp-112"), item("cissp-212")]);
  const presence = await resolveUnitPresence(
    input({ rows: rows(3), readPage: reader.readPage }),
  );

  assert.equal(presence.kind, "none");
  assert.equal(reader.calls.length, 1);
});

test("a page whose cursor is neither a string nor null is a protocol error", async () => {
  const reader = paged([item("cissp-1")], { nextCursor: () => undefined });
  await expectCode(
    () => resolveUnitPresence(input({ rows: rows(1), readPage: reader.readPage })),
    "PROTOCOL_ERROR",
  );
});

test("a walk that passes its page bound stops instead of concluding", async () => {
  const reader = paged(
    [
      item("cissp-100"),
      item("cissp-101"),
      item("cissp-102"),
      item("cissp-103"),
      item("cissp-104"),
      item("cissp-105"),
    ],
    { limit: 2 },
  );
  await expectCode(
    () =>
      resolveUnitPresence(
        input({ rows: rows(2), readPage: reader.readPage, maxPagesPerTopic: 2 }),
      ),
    "PRESENCE_UNKNOWN",
  );
  assert.equal(reader.calls.length, 2);
});

test("a key present only at a later revision is not adoptable", async () => {
  const reader = paged([item("cissp-1"), item("cissp-2", { revisionNumber: 2 })]);
  await expectCode(
    () => resolveUnitPresence(input({ rows: rows(2), readPage: reader.readPage })),
    "PRESENCE_UNKNOWN",
  );
});

test("a refusal that reported more existing keys than the read proves is PRESENCE_UNKNOWN", async () => {
  // This is the live incident: the preview said five keys exist and the read
  // found two. Two server answers disagreeing is not a partial import.
  const reader = paged([item("cissp-1"), item("cissp-2")]);
  await expectCode(
    () =>
      resolveUnitPresence(
        input({ rows: rows(5), readPage: reader.readPage, refusedExistingKeys: 5 }),
      ),
    "PRESENCE_UNKNOWN",
  );
});

test("a refusal the read corroborates, with rows still absent, is a genuine partial", async () => {
  const reader = paged([item("cissp-1"), item("cissp-2"), item("cissp-3")]);
  const presence = await resolveUnitPresence(
    input({ rows: rows(5), readPage: reader.readPage, refusedExistingKeys: 2 }),
  );
  assert.equal(presence.kind, "some");
  assert.deepEqual(
    presence.kind === "some" ? presence.present.map((entry) => entry.key) : [],
    ["cissp-1", "cissp-2", "cissp-3"],
  );
  assert.deepEqual(presence.kind === "some" ? presence.missingKeys : [], ["cissp-4", "cissp-5"]);
});

test("a row whose taxonomy has no server id is a corrupt checkpoint", async () => {
  const reader = paged([]);
  await expectCode(
    () =>
      resolveUnitPresence(
        input({
          rows: [{ key: "cissp-1", domainKey: "cissp-d9", topicKey: "cissp-d9-topic-1" }],
          readPage: reader.readPage,
        }),
      ),
    "CHECKPOINT_INVALID",
  );
});

test("two topics cost one traversal each, never one request per key", async () => {
  const listings = new Map<string, QuestionItem[]>([
    ["top-1", [item("cissp-1"), item("cissp-2")]],
    ["top-2", [item("cissp-3"), item("cissp-4")]],
  ]);
  const calls: ReaderCall[] = [];
  const readPage = async (domainId: string, topicId: string, cursor: string | null) => {
    calls.push({ domainId, topicId, cursor });
    const page = pageOf(listings.get(topicId) ?? [], { cursor, limit: 50 }, (entry) => entry.id);
    return { items: page.items, nextCursor: page.nextCursor };
  };

  const presence: UnitPresence = await resolveUnitPresence(
    input({
      rows: [...rows(2, "cissp-d1", "cissp-d1-topic-1"), ...rows(2, "cissp-d2", "cissp-d2-topic-1", 3)],
      readPage,
    }),
  );

  assert.equal(presence.kind, "all");
  assert.deepEqual(
    presence.kind === "all" ? presence.ids.map((entry) => entry.key) : [],
    ["cissp-1", "cissp-2", "cissp-3", "cissp-4"],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual([...new Set(calls.map((call) => call.topicId))], ["top-1", "top-2"]);
});
