import { LIMITS, QUESTION_IMPORT_FORMAT } from "../contract.ts";
import type { Item, ItemOption } from "../parse.ts";
import type { QuestionProfile } from "../profile.ts";
import type { Finding, FindingScope } from "../report.ts";
import type { TaxonomyIndex } from "../taxonomy.ts";

/**
 * Per-row errors: the tool's exclusive judgement. A batch carrying any of these
 * cannot be passed by PROF — there is no flag that turns an error into a
 * warning, and `combine` refuses a verdict that says otherwise.
 */
export interface StructureContext {
  profile: QuestionProfile;
  index: TaxonomyIndex;
  importedKeys: ReadonlySet<string>;
  questionKeyPattern: RegExp;
}

function scopeFor(item: Item): FindingScope {
  return {
    file: item.file,
    row: item.row,
    questionKey: item.questionKey.length > 0 ? item.questionKey : null,
    domainId: item.domainId.length > 0 ? item.domainId : null,
  };
}

function error(
  code: string,
  item: Item,
  message: string,
  evidence: Record<string, string | number | boolean | null> = {},
): Finding {
  return { code, severity: "error", owner: "tool", scope: scopeFor(item), message, evidence };
}

function populatedOptions(item: Item): ItemOption[] {
  return item.options.filter((option) => option.populated);
}

function capCheck(
  item: Item,
  findings: Finding[],
  field: string,
  value: string,
  cap: { minimum: number; maximum: number },
): void {
  if (value.trim().length === 0) return; // FIELD_REQUIRED owns the empty case.
  if (value.length < cap.minimum || value.length > cap.maximum) {
    findings.push(
      error("FIELD_CAP", item, `${field} is outside its length cap`, {
        field,
        length: value.length,
        minimum: cap.minimum,
        maximum: cap.maximum,
      }),
    );
  }
}

function requiredCheck(item: Item, findings: Finding[], field: string, value: string): void {
  if (value.trim().length === 0) {
    findings.push(error("FIELD_REQUIRED", item, `${field} is required`, { field }));
  }
}

export function checkItem(item: Item, context: StructureContext): Finding[] {
  const findings: Finding[] = [];
  const { profile, index } = context;

  requiredCheck(item, findings, "format_version", item.formatVersion);
  requiredCheck(item, findings, "question_key", item.questionKey);
  requiredCheck(item, findings, "exam_version_id", item.examVersionId);
  requiredCheck(item, findings, "domain_id", item.domainId);
  requiredCheck(item, findings, "topic_id", item.topicId);
  requiredCheck(item, findings, "stem", item.stem);
  requiredCheck(item, findings, "difficulty", item.difficulty);
  requiredCheck(item, findings, "source_reference", item.sourceReference);
  requiredCheck(item, findings, "license_reference", item.licenseReference);

  if (item.formatVersion.trim().length > 0 && item.formatVersion !== QUESTION_IMPORT_FORMAT) {
    findings.push(
      error("FORMAT_VERSION", item, "the row names an unsupported format version", {
        value: item.formatVersion,
        expected: QUESTION_IMPORT_FORMAT,
      }),
    );
  }
  if (item.questionKey.length > 0 && !context.questionKeyPattern.test(item.questionKey)) {
    findings.push(
      error("QUESTION_KEY_INVALID", item, "the question key does not match the profile pattern", {
        value: item.questionKey,
        pattern: profile.questionKeyPattern,
      }),
    );
  }
  if (item.examVersionId.length > 0 && item.examVersionId !== profile.examVersionId) {
    findings.push(
      error("EXAM_VERSION_MISMATCH", item, "the exam version differs from the profile's", {
        value: item.examVersionId,
        expected: profile.examVersionId,
      }),
    );
  }
  if (item.difficulty.length > 0 && !["easy", "medium", "hard"].includes(item.difficulty)) {
    findings.push(
      error("DIFFICULTY_INVALID", item, "the difficulty is not easy, medium or hard", {
        value: item.difficulty,
      }),
    );
  }

  capCheck(item, findings, "stem", item.stem, LIMITS.stem);
  capCheck(item, findings, "source_reference", item.sourceReference, LIMITS.sourceReference);
  capCheck(item, findings, "license_reference", item.licenseReference, LIMITS.licenseReference);
  capCheck(item, findings, "question_key", item.questionKey, LIMITS.questionKey);

  if (item.domainId.length > 0 && !index.domainIds.has(item.domainId)) {
    findings.push(
      error("UNKNOWN_DOMAIN_KEY", item, "the domain key is not in the taxonomy", {
        value: item.domainId,
      }),
    );
  }
  if (item.topicId.length > 0 && !index.topicDomain.has(item.topicId)) {
    findings.push(
      error("UNKNOWN_TOPIC_KEY", item, "the topic key is not in the taxonomy", {
        value: item.topicId,
      }),
    );
  } else if (item.topicId.length > 0 && item.domainId.length > 0) {
    const topicDomain = index.topicDomain.get(item.topicId);
    if (topicDomain !== item.domainId) {
      findings.push(
        error("DOMAIN_TOPIC_MISMATCH", item, "the topic belongs to another domain", {
          domainId: item.domainId,
          topicId: item.topicId,
          topicDomainId: topicDomain ?? null,
        }),
      );
    }
  }

  const populated = populatedOptions(item);
  if (populated.length !== profile.optionCount) {
    findings.push(
      error("OPTION_COUNT", item, "the item does not have the profile's option count", {
        count: populated.length,
        expected: profile.optionCount,
      }),
    );
  }
  const gap = populated.some((option, index_) => option.slot !== index_ + 1);
  if (gap) {
    findings.push(
      error("OPTION_SLOT_GAP", item, "option slots are not contiguous from 1", {
        slots: populated.map((option) => option.slot).join(","),
      }),
    );
  }

  const seenKeys = new Set<string>();
  for (const option of populated) {
    if (option.key.trim().length === 0) {
      findings.push(
        error("FIELD_REQUIRED", item, "an option key is required", { field: `option_${option.slot}_key` }),
      );
    } else {
      if (seenKeys.has(option.key)) {
        findings.push(
          error("OPTION_KEY_DUPLICATE", item, "an option key is repeated in the item", {
            key: option.key,
            slot: option.slot,
          }),
        );
      }
      seenKeys.add(option.key);
      capCheck(item, findings, `option_${option.slot}_key`, option.key, LIMITS.optionKey);
    }
    if (option.text.trim().length === 0) {
      findings.push(
        error("FIELD_REQUIRED", item, "an option text is required", { field: `option_${option.slot}_text` }),
      );
    } else {
      capCheck(item, findings, `option_${option.slot}_text`, option.text, LIMITS.optionText);
    }
    if (option.correct !== "true" && option.correct !== "false") {
      findings.push(
        error("CORRECT_FLAG_NOT_BOOLEAN", item, "the correct flag is not the literal true or false", {
          slot: option.slot,
          value: option.correct.length > 0 ? option.correct : null,
        }),
      );
    }
    if (option.explanation.trim().length === 0) {
      findings.push(
        error("EXPLANATION_MISSING", item, "a populated option has no explanation", {
          field: `option_${option.slot}_explanation`,
          slot: option.slot,
        }),
      );
    } else {
      capCheck(item, findings, `option_${option.slot}_explanation`, option.explanation, LIMITS.explanation);
    }
  }

  const correct = populated.filter((option) => option.correct === "true");
  if (correct.length !== 1) {
    findings.push(
      error("CORRECT_OPTION_COUNT", item, "the item does not have exactly one correct option", {
        count: correct.length,
      }),
    );
  }
  const correctOption = correct[0];
  if (correctOption !== undefined && correctOption.explanation.trim().length > 0) {
    const copied = populated.find(
      (option) =>
        option.slot !== correctOption.slot &&
        option.explanation.trim().length > 0 &&
        option.explanation === correctOption.explanation,
    );
    if (copied !== undefined) {
      findings.push(
        error("EXPLANATION_COPY", item, "the correct explanation is copied from a distractor", {
          correctSlot: correctOption.slot,
          copiedSlot: copied.slot,
        }),
      );
    }
  }

  return findings;
}

/**
 * Keys are unique within a file and across the run, and a key already in the
 * platform is refused here rather than at preview: a re-imported key is
 * rejected with `existing_question_key`, and catching it earlier costs nothing.
 */
export function checkKeys(items: readonly Item[], context: StructureContext): Finding[] {
  const findings: Finding[] = [];
  const firstSeen = new Map<string, { file: string; row: number }>();
  for (const item of items) {
    const key = item.questionKey;
    if (key.length === 0) continue;
    const previous = firstSeen.get(key);
    if (previous !== undefined) {
      findings.push(
        error("DUPLICATE_QUESTION_KEY", item, "the question key appears more than once", {
          key,
          firstFile: previous.file,
          firstRow: previous.row,
        }),
      );
    } else {
      firstSeen.set(key, { file: item.file, row: item.row });
    }
    if (context.importedKeys.has(key)) {
      findings.push(
        error("KEY_ALREADY_IMPORTED", item, "the question key already exists in the platform", {
          key,
        }),
      );
    }
  }
  return findings;
}

export function runStructureChecks(items: readonly Item[], context: StructureContext): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) findings.push(...checkItem(item, context));
  findings.push(...checkKeys(items, context));
  return findings;
}
