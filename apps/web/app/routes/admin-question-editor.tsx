import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Route } from "./+types/admin-question-editor";
import {
  createCorrection,
  createDraft,
  getQuestionRevision,
  listCertifications,
  listDomains,
  listExamVersions,
  listQuestionRevisions,
  listQuestions,
  listTopics,
  ProtectedApiError,
} from "../lib/admin-question-editor-api";
import type {
  Certification,
  Domain,
  ExamVersion,
  Question,
  QuestionContent,
  QuestionRevision,
  QuestionRevisionSummary,
  Topic,
} from "../lib/admin-question-editor-api";

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}

function emptyContent(): QuestionContent {
  return {
    stem: "",
    difficulty: "medium",
    sourceReference: "",
    licenseReference: "",
    options: [
      { key: "A", text: "", correct: true, explanation: "" },
      { key: "B", text: "", correct: false, explanation: "" },
      { key: "C", text: "", correct: false, explanation: "" },
      { key: "D", text: "", correct: false, explanation: "" },
    ],
  };
}

function revisionContent(revision: QuestionRevision): QuestionContent {
  return {
    stem: revision.stem,
    difficulty: revision.difficulty,
    sourceReference: revision.sourceReference,
    licenseReference: revision.licenseReference,
    options: revision.options.map(({ key, text, correct, explanation }) => ({
      key,
      text,
      correct,
      explanation,
    })),
  };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ProtectedApiError)) {
    return "The protected editor could not reach the service. Your current edits are preserved.";
  }
  if (error.status === 401) {
    return "Your staff session is missing, expired, or revoked. Sign in through the approved staff identity flow, then return here.";
  }
  if (error.status === 403) {
    return "Your account does not have the required staff role or current MFA assurance.";
  }
  if (error.status === 404) {
    return "This certification or question is unavailable in your current assignment.";
  }
  if (error.status === 409) {
    return "This question changed since it was loaded. Your edits are preserved; load the latest revision before retrying.";
  }
  if (error.status === 400 && error.code === "invalid_csrf") {
    return "The security token was rejected. Reload the protected editor and retry; your edits are preserved.";
  }
  if (error.status === 400 || error.status === 413) {
    return "Some fields were rejected. Review the validation feedback below; your edits are preserved.";
  }
  if (error.status === 503) {
    return "The protected editor is unavailable because its security configuration or database service is unavailable.";
  }
  return "The protected editor could not complete that request. Your edits are preserved.";
}

export function headers() {
  return {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Protected question editor | Exam Prep" },
    { name: "robots", content: "noindex,nofollow" },
  ];
}

export default function AdminQuestionEditor() {
  const [loading, setLoading] = useState(true);
  const [certifications, setCertifications] = useState<Page<Certification>>(emptyPage);
  const [versions, setVersions] = useState<Page<ExamVersion>>(emptyPage);
  const [domains, setDomains] = useState<Page<Domain>>(emptyPage);
  const [topics, setTopics] = useState<Page<Topic>>(emptyPage);
  const [questions, setQuestions] = useState<Page<Question>>(emptyPage);
  const [revisions, setRevisions] = useState<Page<QuestionRevisionSummary>>(emptyPage);
  const [certificationId, setCertificationId] = useState("");
  const [examVersionId, setExamVersionId] = useState("");
  const [domainId, setDomainId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [questionSearch, setQuestionSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [questionKey, setQuestionKey] = useState("");
  const [content, setContent] = useState<QuestionContent>(emptyContent);
  const [selectedRevision, setSelectedRevision] = useState<QuestionRevision | null>(null);
  const [latestRevision, setLatestRevision] = useState<QuestionRevision | null>(null);
  const [baseLockVersion, setBaseLockVersion] = useState<number | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedQuestion = useMemo(
    () => questions.items.find((question) => question.id === questionId) ?? null,
    [questions.items, questionId],
  );
  const canEditSavedDraft =
    selectedQuestion !== null &&
    selectedRevision !== null &&
    selectedRevision.revisionId === selectedQuestion.currentRevisionId &&
    ["draft", "rejected"].includes(selectedRevision.workflowState);

  useEffect(() => {
    let active = true;
    listCertifications()
      .then((page) => {
        if (active) {
          setCertifications(page);
          setLoading(false);
          setError(
            page.items.length === 0
              ? "No certifications are currently assigned to this staff account."
              : "",
          );
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoading(false);
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function loadVersions(id: string, cursor?: string) {
    const page = await listExamVersions(id, cursor);
    setVersions((current) => ({
      items: cursor ? [...current.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    }));
  }

  async function loadDomains(certId: string, versionId: string, cursor?: string) {
    const page = await listDomains(certId, versionId, cursor);
    setDomains((current) => ({
      items: cursor ? [...current.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    }));
  }

  async function loadTopics(
    certId: string,
    versionId: string,
    selectedDomainId: string,
    cursor?: string,
  ) {
    const page = await listTopics(certId, versionId, selectedDomainId, cursor);
    setTopics((current) => ({
      items: cursor ? [...current.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    }));
  }

  async function loadQuestions(
    cursor?: string,
    search = questionSearch,
    selectedTopicId = topicId,
  ) {
    const page = await listQuestions({
      certificationId,
      examVersionId,
      domainId,
      topicId: selectedTopicId,
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });
    setQuestions((current) => ({
      items: cursor ? [...current.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    }));
  }

  async function chooseQuestion(question: Question) {
    setQuestionId(question.id);
    setRevisionId(question.currentRevisionId);
    setSelectedRevision(null);
    setLatestRevision(null);
    setRevisions(emptyPage());
    setQuestionKey(question.questionKey);
    setBaseLockVersion(question.lockVersion);
    setValidationErrors([]);
    setError("");
    setStatus("");
    try {
      const [page, detail] = await Promise.all([
        listQuestionRevisions(certificationId, examVersionId, question.id),
        getQuestionRevision(
          certificationId,
          examVersionId,
          question.id,
          question.currentRevisionId,
        ),
      ]);
      setRevisions({
        ...page,
        items: page.items.some((revision) => revision.id === question.currentRevisionId)
          ? page.items
          : [
              ...page.items,
              {
                id: question.currentRevisionId,
                revisionNumber: question.revisionNumber,
                workflowState: question.workflowState,
                createdAt: 0,
              },
            ],
      });
      setSelectedRevision(detail);
      setContent(revisionContent(detail));
      setStatus(`Loaded revision ${detail.revisionNumber} (${detail.workflowState}).`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function selectCertification(id: string) {
    setCertificationId(id);
    setExamVersionId("");
    setDomainId("");
    setTopicId("");
    setQuestionId("");
    setRevisionId("");
    setVersions(emptyPage());
    setDomains(emptyPage());
    setTopics(emptyPage());
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setBaseLockVersion(null);
    setError("");
    setStatus("");
    setQuestionKey("");
    setContent(emptyContent());
    if (!id) return;
    try {
      await loadVersions(id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function selectVersion(id: string) {
    setExamVersionId(id);
    setDomainId("");
    setTopicId("");
    setQuestionId("");
    setRevisionId("");
    setDomains(emptyPage());
    setTopics(emptyPage());
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setBaseLockVersion(null);
    setError("");
    setStatus("");
    if (!id || !certificationId) return;
    try {
      await loadDomains(certificationId, id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function selectDomain(id: string) {
    setDomainId(id);
    setTopicId("");
    setQuestionId("");
    setRevisionId("");
    setTopics(emptyPage());
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setBaseLockVersion(null);
    setError("");
    setStatus("");
    if (!id || !certificationId || !examVersionId) return;
    try {
      await loadTopics(certificationId, examVersionId, id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function selectTopic(id: string) {
    setTopicId(id);
    setQuestionId("");
    setRevisionId("");
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setBaseLockVersion(null);
    setError("");
    setStatus("");
    if (!id) return;
    try {
      await loadQuestions(undefined, questionSearch, id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function startNewQuestion() {
    setQuestionId("");
    setRevisionId("");
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setLatestRevision(null);
    setBaseLockVersion(null);
    setQuestionKey("");
    setContent(emptyContent());
    setValidationErrors([]);
    setError("");
    setStatus("New content will be saved as an immutable draft revision.");
  }

  function updateContent<K extends keyof QuestionContent>(
    key: K,
    value: QuestionContent[K],
  ) {
    setContent((current) => ({ ...current, [key]: value }));
  }

  function updateOption(
    index: number,
    field: "key" | "text" | "explanation",
    value: string,
  ) {
    setContent((current) => ({
      ...current,
      options: current.options.map((option, optionIndex) =>
        optionIndex === index ? { ...option, [field]: value } : option,
      ),
    }));
  }

  function validateDraft(): string[] {
    const errors: string[] = [];
    if (content.stem.trim().length < 5) errors.push("Question stem must be at least 5 characters.");
    if (content.stem.length > 4000) errors.push("Question stem must not exceed 4,000 characters.");
    if (content.options.length < 2 || content.options.length > 8) {
      errors.push("Provide between 2 and 8 answer choices.");
    }
    if (content.options.filter((option) => option.correct).length !== 1) {
      errors.push("Select exactly one correct answer.");
    }
    content.options.forEach((option, index) => {
      if (!option.key.trim()) errors.push(`Answer ${index + 1} needs an option key.`);
      if (!option.text.trim()) errors.push(`Answer ${index + 1} needs option text.`);
      if (!option.explanation.trim()) errors.push(`Answer ${index + 1} needs an explanation.`);
    });
    if (!content.sourceReference.trim()) errors.push("Source reference is required.");
    if (!content.licenseReference.trim()) errors.push("Licence reference is required.");
    return errors;
  }

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateDraft();
    if (!questionId && !questionKey.trim()) errors.push("Question key is required for a new question.");
    setValidationErrors(errors);
    if (errors.length > 0) {
      setStatus("");
      setError("Review the validation feedback. Your field values are still available to edit.");
      return;
    }
    if (!certificationId || !examVersionId || !domainId || !topicId) {
      setError("Select an authorised certification, exam version, domain, and topic first.");
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      if (questionId && baseLockVersion !== null) {
        const result = await createCorrection(certificationId, examVersionId, questionId, {
          domainId,
          topicId,
          expectedLockVersion: baseLockVersion,
          content,
        });
        const detail = await getQuestionRevision(
          certificationId,
          examVersionId,
          questionId,
          result.revisionId,
        );
        setSelectedRevision(detail);
        setRevisionId(detail.revisionId);
        setBaseLockVersion(detail.lockVersion);
        setLatestRevision(null);
        setContent(revisionContent(detail));
        await loadQuestions();
        setStatus(`Saved as revision ${detail.revisionNumber}. Earlier revisions remain unchanged.`);
      } else {
        const result = await createDraft(certificationId, examVersionId, {
          questionKey,
          domainId,
          topicId,
          content,
        });
        const createdQuestion = {
          id: result.questionId,
          questionKey,
          currentRevisionId: result.revisionId,
          revisionNumber: result.revisionNumber,
          lockVersion: result.revisionNumber,
          stem: content.stem.slice(0, 200),
          workflowState: "draft",
        };
        const page = await listQuestions({
          certificationId,
          examVersionId,
          domainId,
          topicId,
        });
        setQuestionSearch("");
        setSearchDraft("");
        setQuestions({
          items: [
            createdQuestion,
            ...page.items.filter((question) => question.id !== createdQuestion.id),
          ],
          nextCursor: page.nextCursor,
        });
        await chooseQuestion(createdQuestion);
        setStatus("Draft created. It is not published or visible to learners.");
      }
      setValidationErrors([]);
    } catch (cause) {
      if (cause instanceof ProtectedApiError && cause.status === 409 && questionId) {
        setError(errorMessage(cause));
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  }

  async function loadLatestAfterConflict() {
    if (!questionId) return;
    try {
      const page = await listQuestionRevisions(
        certificationId,
        examVersionId,
        questionId,
      );
      setRevisions(page);
      const latestSummary = page.items.reduce<QuestionRevisionSummary | null>(
        (latest, revision) =>
          latest === null || revision.revisionNumber > latest.revisionNumber
            ? revision
            : latest,
        null,
      );
      if (!latestSummary) throw new Error("No revision is available.");
      const latest = await getQuestionRevision(
        certificationId,
        examVersionId,
        questionId,
        latestSummary.id,
      );
      setLatestRevision(latest);
      setError("");
      setStatus(
        `Loaded server revision ${latest.revisionNumber}. Your unsaved field values are unchanged.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function useLatestAsBase() {
    if (!latestRevision) return;
    setBaseLockVersion(latestRevision.lockVersion);
    setSelectedRevision(latestRevision);
    setRevisionId(latestRevision.revisionId);
    setQuestions((current) => ({
      ...current,
      items: current.items.map((question) =>
        question.id === questionId
          ? {
              ...question,
              currentRevisionId: latestRevision.revisionId,
              revisionNumber: latestRevision.revisionNumber,
              lockVersion: latestRevision.lockVersion,
              stem: latestRevision.stem.slice(0, 200),
              workflowState: latestRevision.workflowState,
            }
          : question,
      ),
    }));
    setLatestRevision(null);
    setError("");
    setStatus(
      `Revision ${latestRevision.revisionNumber} is now the save base. Your unsaved edits were retained.`,
    );
  }

  async function selectRevision(id: string) {
    if (!id || !questionId) return;
    setRevisionId(id);
    setError("");
    setStatus("");
    try {
      const detail = await getQuestionRevision(
        certificationId,
        examVersionId,
        questionId,
        id,
      );
      setSelectedRevision(detail);
      setContent(revisionContent(detail));
      setBaseLockVersion(detail.lockVersion);
      setLatestRevision(null);
      setValidationErrors([]);
      setStatus(
        detail.revisionId === selectedQuestion?.currentRevisionId
          ? `Loaded current revision ${detail.revisionNumber}.`
          : `Revision ${detail.revisionNumber} is historical and read-only.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function addOption() {
    if (content.options.length >= 8) return;
    updateContent("options", [
      ...content.options,
      {
        key: `OPTION-${content.options.length + 1}`,
        text: "",
        correct: false,
        explanation: "",
      },
    ]);
  }

  function removeOption(index: number) {
    if (content.options.length <= 2) return;
    updateContent(
      "options",
      content.options.filter((_, optionIndex) => optionIndex !== index),
    );
  }

  return (
    <main className="protected-editor-page">
      <a className="skip-link" href="#protected-editor-main">Skip to editor</a>
      <header className="protected-editor-header">
        <a className="brand" href="/">Exam Prep</a>
        <span>Protected staff content</span>
      </header>
      <div id="protected-editor-main" className="protected-editor-main">
        <p className="eyebrow">Staff question editor</p>
        <h1>Question editor</h1>
        <p className="protected-editor-intro">
          This editor reads and saves drafts through the protected service. It does not provide sign-in,
          review, or publication.
        </p>
        <p className="protected-demo-separation">
          Separate from the synthetic admin preview. Preview role selectors and demo data do not grant access here.
        </p>

        {loading ? (
          <section className="protected-editor-status" role="status" aria-live="polite">
            Checking the current staff session…
          </section>
        ) : error && certifications.items.length === 0 ? (
          <section className="protected-editor-status protected-editor-status--error" role="alert">
            {error}
          </section>
        ) : (
          <>
            <section className="protected-editor-selectors" aria-label="Content scope">
              <label>
                Certification
                <select
                  value={certificationId}
                  onChange={(event) => void selectCertification(event.target.value)}
                >
                  <option value="">Select an authorised certification</option>
                  {certifications.items.map((certification) => (
                    <option key={certification.id} value={certification.id}>
                      {certification.displayName} ({certification.slug})
                    </option>
                  ))}
                </select>
              </label>
              {certifications.nextCursor && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void listCertifications(certifications.nextCursor!).then((page) =>
                    setCertifications((current) => ({
                      items: [...current.items, ...page.items],
                      nextCursor: page.nextCursor,
                    })),
                  ).catch((cause: unknown) => setError(errorMessage(cause)))}
                >
                  Load more certifications
                </button>
              )}
              <label>
                Exam version
                <select
                  value={examVersionId}
                  disabled={!certificationId}
                  onChange={(event) => void selectVersion(event.target.value)}
                >
                  <option value="">Select an exam version</option>
                  {versions.items.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.title} ({version.versionKey})
                    </option>
                  ))}
                </select>
              </label>
              {versions.nextCursor && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void loadVersions(certificationId, versions.nextCursor!).catch((cause: unknown) => setError(errorMessage(cause)))}
                >
                  Load more versions
                </button>
              )}
              <label>
                Domain
                <select
                  value={domainId}
                  disabled={!examVersionId}
                  onChange={(event) => void selectDomain(event.target.value)}
                >
                  <option value="">Select a domain</option>
                  {domains.items.map((domain) => (
                    <option key={domain.id} value={domain.id}>{domain.title}</option>
                  ))}
                </select>
              </label>
              {domains.nextCursor && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void loadDomains(certificationId, examVersionId, domains.nextCursor!).catch((cause: unknown) => setError(errorMessage(cause)))}
                >
                  Load more domains
                </button>
              )}
              <label>
                Topic
                <select
                  value={topicId}
                  disabled={!domainId}
                  onChange={(event) => void selectTopic(event.target.value)}
                >
                  <option value="">Select a topic</option>
                  {topics.items.map((topic) => (
                    <option key={topic.id} value={topic.id}>{topic.title}</option>
                  ))}
                </select>
              </label>
              {topics.nextCursor && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void loadTopics(certificationId, examVersionId, domainId, topics.nextCursor!).catch((cause: unknown) => setError(errorMessage(cause)))}
                >
                  Load more topics
                </button>
              )}
            </section>

            {topicId && (
              <section className="protected-question-picker" aria-labelledby="question-picker-title">
                <div className="protected-editor-section-heading">
                  <div>
                    <h2 id="question-picker-title">Questions</h2>
                    <p>Search within the selected topic, or create a new draft.</p>
                  </div>
                  <button className="button-primary" type="button" onClick={startNewQuestion}>
                    New question
                  </button>
                </div>
                <form
                  className="protected-question-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setQuestionSearch(searchDraft.trim());
                    setQuestions(emptyPage());
                    void loadQuestions(undefined, searchDraft.trim()).catch((cause: unknown) =>
                      setError(errorMessage(cause)),
                    );
                  }}
                >
                  <label>
                    Find by question key or stem
                    <input
                      value={searchDraft}
                      maxLength={100}
                      onChange={(event) => setSearchDraft(event.target.value)}
                    />
                  </label>
                  <button className="button-secondary" type="submit">Search</button>
                </form>
                {questions.items.length > 0 ? (
                  <ul className="protected-question-list">
                    {questions.items.map((question) => (
                      <li key={question.id}>
                        <button
                          className="protected-question-choice"
                          type="button"
                          aria-pressed={questionId === question.id}
                          onClick={() => void chooseQuestion(question)}
                        >
                          <strong>{question.questionKey}</strong>
                          <span>{question.stem}</span>
                          <small>Revision {question.revisionNumber} · {question.workflowState}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No questions match this topic and search.</p>
                )}
                {questions.nextCursor && (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void loadQuestions(questions.nextCursor!).catch((cause: unknown) => setError(errorMessage(cause)))}
                  >
                    Load more questions
                  </button>
                )}
              </section>
            )}

            {(topicId && (!questionId || selectedQuestion)) && (
              <section className="protected-question-editor" aria-labelledby="question-editor-title">
                <h2 id="question-editor-title">
                  {questionId ? `Edit ${questionKey}` : "Create a draft question"}
                </h2>
                {questionId && revisions.items.length > 0 && (
                  <label className="protected-revision-select">
                    Exact revision
                    <select value={revisionId} onChange={(event) => void selectRevision(event.target.value)}>
                      {revisions.items
                        .slice()
                        .sort((left, right) => left.revisionNumber - right.revisionNumber)
                        .map((revision) => (
                          <option key={revision.id} value={revision.id}>
                            Revision {revision.revisionNumber} · {revision.workflowState}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {revisions.nextCursor && (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void listQuestionRevisions(
                      certificationId,
                      examVersionId,
                      questionId,
                      revisions.nextCursor!,
                    ).then((page) => setRevisions((current) => ({
                      items: [...current.items, ...page.items],
                      nextCursor: page.nextCursor,
                    }))).catch((cause: unknown) => setError(errorMessage(cause)))}
                  >
                    Load more revisions
                  </button>
                )}
                {questionId && !canEditSavedDraft && (
                  <p className="protected-editor-status" role="note">
                    This revision is read-only. Select the current draft or rejected revision to create a correction.
                  </p>
                )}
                {latestRevision && (
                  <section className="protected-latest-revision" aria-label="Latest server revision">
                    <h3>Latest saved revision {latestRevision.revisionNumber}</h3>
                    <p>{latestRevision.stem}</p>
                    <p>
                      Your editor values remain unchanged. Review this latest revision before choosing it as the save base.
                    </p>
                    <button className="button-secondary" type="button" onClick={useLatestAsBase}>
                      Use latest revision as base and keep my edits
                    </button>
                  </section>
                )}
                {validationErrors.length > 0 && (
                  <div className="form-errors" role="alert" aria-labelledby="protected-error-title">
                    <h3 id="protected-error-title">Fix these items</h3>
                    <ul>{validationErrors.map((message) => <li key={message}>{message}</li>)}</ul>
                  </div>
                )}
                <form className="protected-editor-form" onSubmit={(event) => void submitQuestion(event)}>
                  {!questionId && (
                    <label>
                      Stable question key
                      <input
                        value={questionKey}
                        maxLength={120}
                        aria-invalid={validationErrors.some((message) => message.includes("Question key"))}
                        onChange={(event) => setQuestionKey(event.target.value)}
                        required
                      />
                    </label>
                  )}
                  <label>
                    Question stem
                    <textarea
                      rows={4}
                      maxLength={4000}
                      value={content.stem}
                      aria-invalid={validationErrors.some((message) => message.includes("Question stem"))}
                      onChange={(event) => updateContent("stem", event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Difficulty
                    <select
                      value={content.difficulty}
                      onChange={(event) => updateContent("difficulty", event.target.value as QuestionContent["difficulty"])}
                    >
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </label>
                  <fieldset>
                    <legend>Answer choices and explanations</legend>
                    {content.options.map((option, index) => (
                      <div className="protected-option-editor" key={`${questionId || "new"}-${index}`}>
                        <h3>Answer {index + 1}</h3>
                        <label className="protected-correct-choice">
                          <input
                            type="radio"
                            name="protected-correct-answer"
                            checked={option.correct}
                            onChange={() => updateContent(
                              "options",
                              content.options.map((item, optionIndex) => ({
                                ...item,
                                correct: optionIndex === index,
                              })),
                            )}
                          />
                          <span>Mark answer {index + 1} as correct</span>
                        </label>
                        <label>
                          Option key
                          <input
                            maxLength={32}
                            value={option.key}
                            onChange={(event) => updateOption(index, "key", event.target.value)}
                            required
                          />
                        </label>
                        <label>
                          Answer {index + 1} text
                          <textarea
                            rows={2}
                            maxLength={1000}
                            value={option.text}
                            aria-invalid={validationErrors.some((message) => message.includes(`Answer ${index + 1} needs option text`))}
                            onChange={(event) => updateOption(index, "text", event.target.value)}
                            required
                          />
                        </label>
                        <label>
                          Explanation for answer {index + 1}
                          <textarea
                            rows={2}
                            maxLength={3000}
                            value={option.explanation}
                            aria-invalid={validationErrors.some((message) => message.includes(`Answer ${index + 1} needs an explanation`))}
                            onChange={(event) => updateOption(index, "explanation", event.target.value)}
                            required
                          />
                        </label>
                        {content.options.length > 2 && (
                          <button
                            className="button-secondary"
                            type="button"
                            onClick={() => removeOption(index)}
                          >
                            Remove answer {index + 1}
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={content.options.length >= 8}
                      onClick={addOption}
                    >
                      Add answer choice
                    </button>
                  </fieldset>
                  <label>
                    Source reference
                    <textarea
                      rows={2}
                      maxLength={1000}
                      value={content.sourceReference}
                      onChange={(event) => updateContent("sourceReference", event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Licence reference
                    <textarea
                      rows={2}
                      maxLength={200}
                      value={content.licenseReference}
                      onChange={(event) => updateContent("licenseReference", event.target.value)}
                      required
                    />
                  </label>
                  <div className="protected-editor-actions">
                    <button
                      className="button-primary"
                      type="submit"
                      disabled={saving || (questionId !== "" && !canEditSavedDraft)}
                    >
                      {saving ? "Saving…" : questionId ? "Save correction" : "Save draft"}
                    </button>
                    {error.includes("changed since it was loaded") && questionId && (
                      <button
                        className="button-secondary"
                        type="button"
                        onClick={() => void loadLatestAfterConflict()}
                      >
                        Load latest revision
                      </button>
                    )}
                  </div>
                </form>
              </section>
            )}
          </>
        )}

        {error && certifications.items.length > 0 && (
          <div className="form-errors" role="alert">{error}</div>
        )}
        {status && <p className="protected-editor-status" role="status" aria-live="polite">{status}</p>}
        <footer className="protected-editor-footer">
          <a href="/admin">Synthetic admin preview</a>
          <span>Demo role controls do not apply to this protected route.</span>
        </footer>
      </div>
    </main>
  );
}
