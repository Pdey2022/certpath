import type { QuestionItem } from "./client.ts";
import type { QuestionRecord } from "./checkpoint.ts";
import type { TaxonomyIdMap } from "./transform.ts";
import { DriverError } from "./errors.ts";

/**
 * Presence: does the server hold this row of a unit?
 *
 * Two sources, in this order, and never a third.
 *
 * 1. **The checkpoint.** A `questions[]` record whose `questionId` *and*
 *    `revisionId` are both set is proof the row exists. Both ids are written
 *    only from a server answer to a preview or a confirm, `questions_immutable_delete`
 *    (`0003_versioned_content.sql`) aborts every `DELETE FROM questions`, and
 *    `questions_immutable_update` forbids changing a question's id or key. A
 *    recorded id therefore cannot go missing and cannot come to mean another
 *    question: presence is monotone, so the local answer needs no request and
 *    has no expiry.
 *
 *    `state` and `inFlight` must not gate that answer. `state` is workflow
 *    progress and `inFlight` is an intent about a *revision* mutation; neither
 *    can remove a row. Reading them here would call a published question
 *    "absent" and would re-read rows the server already has.
 *
 *    A record with exactly one of the two ids set is not a partial fact, it is
 *    a corrupted checkpoint: no writer produces it. That stops the run with
 *    `CHECKPOINT_INVALID` instead of falling back to the server, because a
 *    hand-edited id would otherwise let the driver adopt a question it never
 *    created.
 *
 * 2. **The server**, only for rows the checkpoint cannot answer. One exhaustive
 *    listing of the row's own topic - `domainId`, `topicId`, `limit`, `cursor`
 *    - following `nextCursor` to `null`, comparing `questionKey` by exact
 *    string. Not `search`: that is `LIKE '%…%'` over the key *or* the stem,
 *    ordered by `question.id`, so an exact key can sit on page seven behind
 *    `cissp-120`, `cissp-112` and any stem that quotes the key. A substring
 *    match is never the row and an unread page is not evidence.
 *
 * Absence is therefore only ever concluded from an exhausted listing, and an
 * inconclusive read stops the run with `PRESENCE_UNKNOWN` rather than
 * reporting "missing". Nothing here creates anything: "absent" can at most
 * retry the same `importId` or re-preview the same bytes, and the server
 * de-duplicates both.
 *
 * Presence is not a revision-identity claim. A locally recorded `revisionId`
 * may lag the server's current revision if someone edited the question (this
 * driver never does). That is fine here; the publish stage is what re-reads
 * `workflowState` and the publication pointer, and stops on
 * `PUBLICATION_CONFLICT`. Do not merge the two ideas.
 */

/** The route's own page size; 2 000 questions per topic is the bound below. */
export const DEFAULT_MAX_PAGES_PER_TOPIC = 40;

export interface PresenceRow {
  key: string;
  domainKey: string;
  topicKey: string;
}

export interface PresentQuestion {
  key: string;
  questionId: string;
  revisionId: string;
  /** `checkpoint`: no request was made. `server`: read from an exhausted listing. */
  source: "checkpoint" | "server";
}

export type UnitPresence =
  | { kind: "all"; ids: PresentQuestion[] }
  | { kind: "some"; present: PresentQuestion[]; missingKeys: string[] }
  | { kind: "none" };

export interface PresenceInput {
  unit: number;
  /** The unit's rows, in row order. The result is rebuilt in this order. */
  rows: readonly PresenceRow[];
  /** Domain and topic server ids from the checkpoint. */
  ids: TaxonomyIdMap;
  /** `checkpoint.questions`, read-only. */
  questions: readonly QuestionRecord[];
  readPage: (
    domainId: string,
    topicId: string,
    cursor: string | null,
  ) => Promise<{ items: QuestionItem[]; nextCursor: string | null }>;
  /** Injectable so a test can prove the bound bites. */
  maxPagesPerTopic?: number;
  /**
   * The preview's `existing_question_key` issue count, on the preview-refused
   * path only. `undefined` off that path; the caller never passes `0`, and a
   * read that finds fewer than this stops rather than believing itself.
   */
  refusedExistingKeys?: number;
}

export async function resolveUnitPresence(input: PresenceInput): Promise<UnitPresence> {
  const { unit, rows } = input;
  if (rows.length === 0) {
    throw new DriverError("CHECKPOINT_INVALID", `unit ${unit} has no rows to resolve`);
  }
  const maxPages = input.maxPagesPerTopic ?? DEFAULT_MAX_PAGES_PER_TOPIC;
  const recorded = new Map(input.questions.map((record) => [record.key, record]));
  const found = new Map<string, PresentQuestion>();
  const unknown = new Set<string>();

  for (const row of rows) {
    const record = recorded.get(row.key);
    if (record === undefined) {
      unknown.add(row.key);
      continue;
    }
    if (record.unit !== unit) {
      throw new DriverError(
        "CHECKPOINT_INVALID",
        `question ${row.key} is recorded under unit ${record.unit}, not unit ${unit}`,
      );
    }
    const questionId = record.questionId;
    const revisionId = record.revisionId;
    if ((questionId === null) !== (revisionId === null)) {
      throw new DriverError(
        "CHECKPOINT_INVALID",
        `question ${row.key} has exactly one of questionId and revisionId`,
      );
    }
    if (questionId !== null && revisionId !== null) {
      found.set(row.key, { key: row.key, questionId, revisionId, source: "checkpoint" });
      continue;
    }
    // Both ids null: a record that has been started but never answered.
    unknown.add(row.key);
  }

  // One traversal per (domain, topic) serves every unknown key in it, so a
  // 5-row unit costs one listing, never five probes.
  const topics = new Map<string, { domainId: string; topicId: string; keys: Set<string> }>();
  for (const row of rows) {
    if (!unknown.has(row.key)) continue;
    const domainId = input.ids.domainIds.get(row.domainKey);
    const topicId = input.ids.topicIds.get(row.topicKey);
    if (domainId === undefined || topicId === undefined) {
      throw new DriverError(
        "CHECKPOINT_INVALID",
        `the checkpoint has no id for ${row.key}'s taxonomy (${row.domainKey}/${row.topicKey})`,
      );
    }
    const groupId = `${domainId}\u0000${topicId}`;
    const group = topics.get(groupId) ?? { domainId, topicId, keys: new Set<string>() };
    group.keys.add(row.key);
    topics.set(groupId, group);
  }

  for (const topic of topics.values()) {
    let cursor: string | null = null;
    for (let page = 1; ; page += 1) {
      if (page > maxPages) {
        throw new DriverError(
          "PRESENCE_UNKNOWN",
          `the question listing for domain ${topic.domainId} topic ${topic.topicId} did not finish ` +
            `within ${maxPages} page(s)`,
        );
      }
      const result = await input.readPage(topic.domainId, topic.topicId, cursor);
      for (const item of result.items) {
        if (!topic.keys.has(item.questionKey)) continue;
        if (item.revisionNumber !== 1) {
          // Present, but not provably the revision an import of these bytes
          // creates: the review note would then describe content this pipeline
          // cannot show it wrote.
          throw new DriverError(
            "PRESENCE_UNKNOWN",
            `question ${item.questionKey} is at revision ${item.revisionNumber}, not revision 1`,
          );
        }
        found.set(item.questionKey, {
          key: item.questionKey,
          questionId: item.id,
          revisionId: item.currentRevisionId,
          source: "server",
        });
        topic.keys.delete(item.questionKey);
      }
      // Checked before the early exit: a page without a usable cursor is a
      // protocol violation whichever page it is.
      const next: unknown = result.nextCursor;
      if (next !== null && typeof next !== "string") {
        throw new DriverError("PROTOCOL_ERROR", "the question page cursor is neither a string nor null");
      }
      if (topic.keys.size === 0) break;
      if (next === null) break;
      cursor = next;
    }
  }

  const present: PresentQuestion[] = [];
  const missingKeys: string[] = [];
  for (const row of rows) {
    const item = found.get(row.key);
    if (item === undefined) missingKeys.push(row.key);
    else present.push(item);
  }

  // The preview asserted that at least this many of the unit's keys exist. A
  // read that finds fewer is two server answers disagreeing, and acting on the
  // weaker one is exactly how a live run reported 3 of 5 rows missing when all
  // five existed.
  const refused = input.refusedExistingKeys;
  if (refused !== undefined && present.length < refused) {
    throw new DriverError(
      "PRESENCE_UNKNOWN",
      `the import preview reported ${refused} existing key(s) but the topic listing proves ${present.length}`,
    );
  }
  if (missingKeys.length === 0) return { kind: "all", ids: present };
  if (present.length === 0) return { kind: "none" };
  return { kind: "some", present, missingKeys };
}
