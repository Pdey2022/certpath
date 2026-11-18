import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Route } from "./+types/admin-question-editor";
import {
  createCorrection,
  createDraft,
  getQuestionPublication,
  getQuestionRevision,
  listCertifications,
  listDomains,
  listExamVersions,
  listQuestionRevisions,
  listQuestions,
  listTopics,
  publishRevision,
  retirePublication,
  reviewRevision,
  submitRevisionForReview,
  ProtectedApiError,
} from "../lib/admin-question-editor-api";
import type {
  Certification,
  Domain,
  ExamVersion,
  Question,
  QuestionContent,
  QuestionPublication,
  QuestionRevision,
  QuestionRevisionSummary,
  Topic,
} from "../lib/admin-question-editor-api";
import { ProtectedCsvTools } from "../components/protected-csv-tools";

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

type WorkflowConfirmation = {
  kind: "publish" | "retire";
  questionId: string;
  revisionId: string;
  expectedPointerVersion: number | null;
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
    return "Your staff session is missing, expired, or revoked. Sign in again, then return here.";
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
    { title: "Protected question editor | CertPath" },
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
  const [publication, setPublication] = useState<QuestionPublication | undefined>(undefined);
  const [reviewNotes, setReviewNotes] = useState("");
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowConflict, setWorkflowConflict] = useState<"revision" | "publication" | null>(null);
  const [workflowRefreshAvailable, setWorkflowRefreshAvailable] = useState(false);
  const [workflowConfirmation, setWorkflowConfirmation] = useState<WorkflowConfirmation | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const scopeRef = useRef({
    certificationId: "",
    examVersionId: "",
    domainId: "",
    topicId: "",
  });
  const selectedQuestionRef = useRef("");
  const formGeneration = useRef(0);
  const requests = useRef({
    versions: 0,
    domains: 0,
    topics: 0,
    questions: 0,
    question: 0,
    revisions: 0,
    revision: 0,
    workflow: 0,
  });

  const selectedQuestion = useMemo(
    () => questions.items.find((question) => question.id === questionId) ?? null,
    [questions.items, questionId],
  );
  const canEditSavedDraft =
    selectedQuestion !== null &&
    selectedRevision !== null &&
    selectedRevision.revisionId === revisionId &&
    selectedRevision.revisionId === selectedQuestion.currentRevisionId &&
    selectedRevision.revisionNumber === selectedQuestion.lockVersion &&
    ["draft", "rejected"].includes(selectedRevision.workflowState);
  const displayedRevisionNeedsRecovery =
    selectedRevision !== null &&
    selectedQuestion !== null &&
    (selectedRevision.revisionNumber !== selectedQuestion.lockVersion ||
      selectedRevision.revisionId !== selectedQuestion.currentRevisionId);
  const revisionLoading =
    questionId !== "" && selectedRevision?.revisionId !== revisionId;
  const savedRevisionHasUnsavedEdits =
    selectedRevision !== null &&
    JSON.stringify(content) !== JSON.stringify(revisionContent(selectedRevision));

  function invalidateForm(): number {
    formGeneration.current += 1;
    selectedQuestionRef.current = "";
    requests.current.questions += 1;
    requests.current.question += 1;
    requests.current.revisions += 1;
    requests.current.revision += 1;
    requests.current.workflow += 1;
    setSaving(false);
    setWorkflowBusy(false);
    setWorkflowRefreshAvailable(false);
    setWorkflowConfirmation(null);
    return formGeneration.current;
  }

  function scopeMatches(scope: typeof scopeRef.current): boolean {
    return (
      scopeRef.current.certificationId === scope.certificationId &&
      scopeRef.current.examVersionId === scope.examVersionId &&
      scopeRef.current.domainId === scope.domainId &&
      scopeRef.current.topicId === scope.topicId
    );
  }

  function formMatches(
    generation: number,
    scope: typeof scopeRef.current,
    expectedQuestionId: string,
  ): boolean {
    return (
      formGeneration.current === generation &&
      scopeMatches(scope) &&
      selectedQuestionRef.current === expectedQuestionId
    );
  }

  function workflowMatches(
    generation: number,
    scope: typeof scopeRef.current,
    expectedQuestionId: string,
    expectedRevisionId: string,
  ): boolean {
    return (
      formMatches(generation, scope, expectedQuestionId) &&
      revisionId === expectedRevisionId &&
      selectedRevision?.revisionId === expectedRevisionId
    );
  }

  function updateQuestionLock(questionId: string, lockVersion: number): void {
    setQuestions((current) => ({
      ...current,
      items: current.items.map((question) =>
        question.id === questionId && lockVersion > question.lockVersion
          ? { ...question, lockVersion }
          : question,
      ),
    }));
  }

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
    const request = ++requests.current.versions;
    try {
      const page = await listExamVersions(id, cursor);
      if (
        request !== requests.current.versions ||
        scopeRef.current.certificationId !== id
      ) return;
      setVersions((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      if (
        request === requests.current.versions &&
        scopeRef.current.certificationId === id
      ) setError(errorMessage(cause));
    }
  }

  async function loadDomains(certId: string, versionId: string, cursor?: string) {
    const request = ++requests.current.domains;
    try {
      const page = await listDomains(certId, versionId, cursor);
      if (
        request !== requests.current.domains ||
        scopeRef.current.certificationId !== certId ||
        scopeRef.current.examVersionId !== versionId
      ) return;
      setDomains((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      if (
        request === requests.current.domains &&
        scopeRef.current.certificationId === certId &&
        scopeRef.current.examVersionId === versionId
      ) setError(errorMessage(cause));
    }
  }

  async function loadTopics(
    certId: string,
    versionId: string,
    selectedDomainId: string,
    cursor?: string,
  ) {
    const request = ++requests.current.topics;
    try {
      const page = await listTopics(certId, versionId, selectedDomainId, cursor);
      if (
        request !== requests.current.topics ||
        scopeRef.current.certificationId !== certId ||
        scopeRef.current.examVersionId !== versionId ||
        scopeRef.current.domainId !== selectedDomainId
      ) return;
      setTopics((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      if (
        request === requests.current.topics &&
        scopeRef.current.certificationId === certId &&
        scopeRef.current.examVersionId === versionId &&
        scopeRef.current.domainId === selectedDomainId
      ) setError(errorMessage(cause));
    }
  }

  async function loadQuestions(
    cursor?: string,
    search = questionSearch,
    selectedTopicId = topicId,
  ) {
    const scope = { ...scopeRef.current };
    const request = ++requests.current.questions;
    if (
      scope.certificationId !== certificationId ||
      scope.examVersionId !== examVersionId ||
      scope.domainId !== domainId ||
      scope.topicId !== selectedTopicId
    ) return;
    try {
      const page = await listQuestions({
        ...scope,
        ...(search ? { search } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (request !== requests.current.questions || !scopeMatches(scope)) return;
      setQuestions((current) => {
        const pageItems = cursor ? [...current.items, ...page.items] : page.items;
        const items = pageItems.map((item) => {
          const previous = current.items.find((question) => question.id === item.id);
          return previous && previous.lockVersion > item.lockVersion
            ? {
                ...item,
                currentRevisionId: previous.currentRevisionId,
                revisionNumber: previous.revisionNumber,
                lockVersion: previous.lockVersion,
                workflowState: previous.workflowState,
              }
            : item;
        });
        const activeQuestion = current.items.find(
          (question) => question.id === selectedQuestionRef.current,
        );
        if (activeQuestion && !items.some((item) => item.id === activeQuestion.id)) {
          items.unshift(activeQuestion);
        }
        return { items, nextCursor: page.nextCursor };
      });
    } catch (cause) {
      if (request === requests.current.questions && scopeMatches(scope)) {
        setError(errorMessage(cause));
      }
    }
  }

  async function chooseQuestion(question: Question) {
    const scope = { ...scopeRef.current };
    const generation = invalidateForm();
    const request = ++requests.current.question;
    selectedQuestionRef.current = question.id;
    setQuestionId(question.id);
    setRevisionId(question.currentRevisionId);
    setSelectedRevision(null);
    setLatestRevision(null);
    setPublication(undefined);
    setReviewNotes("");
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setRevisions(emptyPage());
    setQuestionKey(question.questionKey);
    setContent(emptyContent());
    setValidationErrors([]);
    setError("");
    setStatus("");
    try {
      const [page, detail, publicationStatus] = await Promise.all([
        listQuestionRevisions(certificationId, examVersionId, question.id),
        getQuestionRevision(
          certificationId,
          examVersionId,
          question.id,
          question.currentRevisionId,
        ),
        getQuestionPublication(certificationId, examVersionId, question.id),
      ]);
      if (
        request !== requests.current.question ||
        !formMatches(generation, scope, question.id)
      ) return;
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
      setPublication(publicationStatus.publication);
      setContent(revisionContent(detail));
      updateQuestionLock(question.id, detail.lockVersion);
      const currentLockVersion = Math.max(question.lockVersion, detail.lockVersion);
      const detailIsCurrent =
        detail.revisionNumber === currentLockVersion &&
        detail.revisionId === question.currentRevisionId;
      setStatus(
        detailIsCurrent
          ? `Loaded revision ${detail.revisionNumber} (${detail.workflowState}).`
          : `Revision ${detail.revisionNumber} is not the current question version (${currentLockVersion}). Review the latest revision before saving.`,
      );
    } catch (cause) {
      if (
        request === requests.current.question &&
        formMatches(generation, scope, question.id)
      ) setError(errorMessage(cause));
    }
  }

  async function selectCertification(id: string) {
    const scope = {
      certificationId: id,
      examVersionId: "",
      domainId: "",
      topicId: "",
    };
    scopeRef.current = scope;
    invalidateForm();
    requests.current.versions += 1;
    requests.current.domains += 1;
    requests.current.topics += 1;
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
    setLatestRevision(null);
    setPublication(undefined);
    setReviewNotes("");
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setError("");
    setStatus("");
    setQuestionKey("");
    setContent(emptyContent());
    setValidationErrors([]);
    if (!id) return;
    await loadVersions(id);
  }

  async function selectVersion(id: string) {
    scopeRef.current = {
      ...scopeRef.current,
      examVersionId: id,
      domainId: "",
      topicId: "",
    };
    invalidateForm();
    requests.current.domains += 1;
    requests.current.topics += 1;
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
    setLatestRevision(null);
    setPublication(undefined);
    setReviewNotes("");
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setError("");
    setStatus("");
    setQuestionKey("");
    setContent(emptyContent());
    setValidationErrors([]);
    if (!id || !certificationId) return;
    await loadDomains(certificationId, id);
  }

  async function selectDomain(id: string) {
    scopeRef.current = { ...scopeRef.current, domainId: id, topicId: "" };
    invalidateForm();
    requests.current.topics += 1;
    setDomainId(id);
    setTopicId("");
    setQuestionId("");
    setRevisionId("");
    setTopics(emptyPage());
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setLatestRevision(null);
    setPublication(undefined);
    setReviewNotes("");
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setError("");
    setStatus("");
    setQuestionKey("");
    setContent(emptyContent());
    setValidationErrors([]);
    if (!id || !certificationId || !examVersionId) return;
    await loadTopics(certificationId, examVersionId, id);
  }

  async function selectTopic(id: string) {
    scopeRef.current = { ...scopeRef.current, topicId: id };
    invalidateForm();
    setTopicId(id);
    setQuestionId("");
    setRevisionId("");
    setQuestions(emptyPage());
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setLatestRevision(null);
    setError("");
    setStatus("");
    setQuestionKey("");
    setContent(emptyContent());
    setValidationErrors([]);
    if (!id) return;
    await loadQuestions(undefined, questionSearch, id);
  }

  function startNewQuestion() {
    invalidateForm();
    setQuestionId("");
    setRevisionId("");
    setRevisions(emptyPage());
    setSelectedRevision(null);
    setLatestRevision(null);
    setPublication(undefined);
    setReviewNotes("");
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
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
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const expectedQuestionId = questionId;
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
    if (questionId && !canEditSavedDraft) {
      setError(
        "The displayed revision is not the current editable draft. Review the latest revision before saving.",
      );
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      if (questionId && selectedRevision) {
        const result = await createCorrection(certificationId, examVersionId, questionId, {
          domainId,
          topicId,
          expectedLockVersion: selectedRevision.revisionNumber,
          content,
        });
        if (!formMatches(generation, scope, expectedQuestionId)) return;
        const detail = await getQuestionRevision(
          certificationId,
          examVersionId,
          questionId,
          result.revisionId,
        );
        if (!formMatches(generation, scope, expectedQuestionId)) return;
        setSelectedRevision(detail);
        setRevisionId(detail.revisionId);
        setLatestRevision(null);
        setContent(revisionContent(detail));
        updateQuestionLock(questionId, detail.lockVersion);
        setQuestions((current) => ({
          ...current,
          items: current.items.map((question) =>
            question.id === questionId
              ? {
                  ...question,
                  currentRevisionId: detail.revisionId,
                  revisionNumber: detail.revisionNumber,
                  workflowState: detail.workflowState,
                }
              : question,
          ),
        }));
        await loadQuestions();
        if (!formMatches(generation, scope, expectedQuestionId)) return;
        setStatus(`Saved as revision ${detail.revisionNumber}. Earlier revisions remain unchanged.`);
      } else {
        const result = await createDraft(certificationId, examVersionId, {
          questionKey,
          domainId,
          topicId,
          content,
        });
        if (!formMatches(generation, scope, expectedQuestionId)) return;
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
        if (!formMatches(generation, scope, expectedQuestionId)) return;
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
      if (!formMatches(generation, scope, expectedQuestionId)) return;
      if (cause instanceof ProtectedApiError && cause.status === 409 && questionId) {
        setError(errorMessage(cause));
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      if (formMatches(generation, scope, expectedQuestionId)) setSaving(false);
    }
  }

  async function loadLatestAfterConflict() {
    const expectedQuestionId = questionId;
    if (!expectedQuestionId) return;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.revision;
    try {
      const page = await listQuestionRevisions(
        certificationId,
        examVersionId,
        expectedQuestionId,
      );
      if (
        request !== requests.current.revision ||
        !formMatches(generation, scope, expectedQuestionId)
      ) return;
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
        expectedQuestionId,
        latestSummary.id,
      );
      if (
        request !== requests.current.revision ||
        !formMatches(generation, scope, expectedQuestionId)
      ) return;
      setLatestRevision(latest);
      updateQuestionLock(expectedQuestionId, latest.lockVersion);
      setError("");
      setStatus(
        `Loaded server revision ${latest.revisionNumber}. Your unsaved field values are unchanged.`,
      );
    } catch (cause) {
      if (
        request === requests.current.revision &&
        formMatches(generation, scope, expectedQuestionId)
      ) setError(errorMessage(cause));
    }
  }

  function useLatestAsBase() {
    if (!latestRevision) return;
    setSelectedRevision(latestRevision);
    setRevisionId(latestRevision.revisionId);
    setQuestions((current) => ({
      ...current,
      items: current.items.map((question) =>
        question.id === questionId
          ? {
              ...question,
              ...(latestRevision.revisionNumber === latestRevision.lockVersion &&
              question.lockVersion <= latestRevision.revisionNumber
                ? {
                    currentRevisionId: latestRevision.revisionId,
                    revisionNumber: latestRevision.revisionNumber,
                  }
                : {}),
              lockVersion: Math.max(question.lockVersion, latestRevision.lockVersion),
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
    formGeneration.current += 1;
    setSaving(false);
    const generation = formGeneration.current;
    const expectedQuestionId = questionId;
    const scope = { ...scopeRef.current };
    const request = ++requests.current.revision;
    const previousRevisionId = selectedRevision?.revisionId ?? "";
    setRevisionId(id);
    requests.current.workflow += 1;
    setWorkflowBusy(false);
    setWorkflowConflict(null);
    setWorkflowRefreshAvailable(false);
    setWorkflowConfirmation(null);
    setReviewNotes("");
    setLatestRevision(null);
    setError("");
    setStatus("");
    try {
      const detail = await getQuestionRevision(
        certificationId,
        examVersionId,
        expectedQuestionId,
        id,
      );
      if (
        request !== requests.current.revision ||
        !formMatches(generation, scope, expectedQuestionId)
      ) return;
      setSelectedRevision(detail);
      setContent(revisionContent(detail));
      updateQuestionLock(expectedQuestionId, detail.lockVersion);
      setValidationErrors([]);
      const currentLockVersion = Math.max(
        detail.lockVersion,
        selectedQuestion?.lockVersion ?? 0,
      );
      const knownCurrentRevisionId =
        selectedQuestion && selectedQuestion.lockVersion >= detail.lockVersion
          ? selectedQuestion.currentRevisionId
          : detail.revisionId;
      const detailIsCurrent =
        detail.revisionNumber === currentLockVersion &&
        detail.revisionId === knownCurrentRevisionId;
      setStatus(
        detailIsCurrent
          ? `Loaded current revision ${detail.revisionNumber}.`
          : detail.revisionNumber < currentLockVersion
            ? `Revision ${detail.revisionNumber} is not the current question version (${currentLockVersion}) and is read-only.`
            : `Revision ${detail.revisionNumber} is historical and read-only.`,
      );
    } catch (cause) {
      if (
        request === requests.current.revision &&
        formMatches(generation, scope, expectedQuestionId)
      ) {
        setRevisionId(previousRevisionId);
        setError(errorMessage(cause));
      }
    }
  }

  async function loadMoreRevisions(cursor: string) {
    const expectedQuestionId = questionId;
    if (!expectedQuestionId) return;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.revisions;
    try {
      const page = await listQuestionRevisions(
        certificationId,
        examVersionId,
        expectedQuestionId,
        cursor,
      );
      if (
        request !== requests.current.revisions ||
        !formMatches(generation, scope, expectedQuestionId)
      ) return;
      setRevisions((current) => ({
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      if (
        request === requests.current.revisions &&
        formMatches(generation, scope, expectedQuestionId)
      ) setError(errorMessage(cause));
    }
  }

  async function refreshWorkflowData(
    generation: number,
    scope: typeof scopeRef.current,
    expectedQuestionId: string,
    expectedRevisionId: string,
    request: number,
  ) {
    const affectedQuestion = questions.items.find(
      (question) => question.id === expectedQuestionId,
    );
    if (!affectedQuestion) throw new Error("The selected question summary is unavailable.");
    const [page, detail, publicationStatus, questionPage] = await Promise.all([
      listQuestionRevisions(
        scope.certificationId,
        scope.examVersionId,
        expectedQuestionId,
      ),
      getQuestionRevision(
        scope.certificationId,
        scope.examVersionId,
        expectedQuestionId,
        expectedRevisionId,
      ),
      getQuestionPublication(
        scope.certificationId,
        scope.examVersionId,
        expectedQuestionId,
      ),
      listQuestions({
        ...scope,
        questionId: affectedQuestion.id,
      }),
    ]);
    if (
      request !== requests.current.workflow ||
      !workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)
    ) return false;
    const refreshedQuestion = questionPage.items.find(
      (question) => question.id === expectedQuestionId,
    );
    if (!refreshedQuestion) {
      throw new Error("The selected question summary could not be refreshed.");
    }
    setRevisions({
      ...page,
      items: page.items.some((item) => item.id === expectedRevisionId)
        ? page.items
        : [
            ...page.items,
            {
              id: expectedRevisionId,
              revisionNumber: detail.revisionNumber,
              workflowState: detail.workflowState,
              createdAt: 0,
            },
          ],
    });
    setSelectedRevision(detail);
    setPublication(publicationStatus.publication);
    setQuestions((current) => ({
      ...current,
      items: current.items.map((question) =>
        question.id === expectedQuestionId ? refreshedQuestion : question,
      ),
    }));
    return true;
  }

  async function refreshWorkflowState() {
    if ((!workflowConflict && !workflowRefreshAvailable) || !questionId || !selectedRevision) return;
    const expectedQuestionId = questionId;
    const expectedRevisionId = selectedRevision.revisionId;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.workflow;
    setWorkflowBusy(true);
    setError("");
    setStatus("");
    try {
      const refreshed = await refreshWorkflowData(
        generation,
        scope,
        expectedQuestionId,
        expectedRevisionId,
        request,
      );
      if (!refreshed) return;
      setWorkflowConflict(null);
      setWorkflowRefreshAvailable(false);
      setStatus("Workflow state refreshed. Review it and deliberately choose an action again.");
    } catch (cause) {
      if (
        request === requests.current.workflow &&
        workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)
      ) setError(errorMessage(cause));
    } finally {
      if (request === requests.current.workflow) setWorkflowBusy(false);
    }
  }

  async function submitSelectedForReview() {
    if (!questionId || !selectedRevision) return;
    const expectedQuestionId = questionId;
    const expectedRevisionId = selectedRevision.revisionId;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.workflow;
    setWorkflowBusy(true);
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setError("");
    setStatus("");
    try {
      await submitRevisionForReview(
        scope.certificationId,
        scope.examVersionId,
        expectedQuestionId,
        expectedRevisionId,
      );
      if (!workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)) return;
      if (await refreshWorkflowData(generation, scope, expectedQuestionId, expectedRevisionId, request)) {
        setStatus(`Revision ${selectedRevision.revisionNumber} was submitted for review.`);
      }
    } catch (cause) {
      if (!workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)) return;
      if (cause instanceof ProtectedApiError && cause.status === 409) {
        setWorkflowConflict("revision");
        setError("The review state changed. Your question fields and review notes are preserved; refresh the revision before choosing an action again.");
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      if (request === requests.current.workflow) setWorkflowBusy(false);
    }
  }

  async function recordSelectedReview(decision: "approved" | "rejected") {
    if (!questionId || !selectedRevision) return;
    if (!reviewNotes.trim()) {
      setError("Add review notes before approving or rejecting this revision.");
      return;
    }
    const expectedQuestionId = questionId;
    const expectedRevisionId = selectedRevision.revisionId;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.workflow;
    setWorkflowBusy(true);
    setWorkflowConflict(null);
    setWorkflowConfirmation(null);
    setError("");
    setStatus("");
    try {
      await reviewRevision(
        scope.certificationId,
        scope.examVersionId,
        expectedQuestionId,
        expectedRevisionId,
        { decision, notes: reviewNotes },
      );
      if (!workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)) return;
      if (await refreshWorkflowData(generation, scope, expectedQuestionId, expectedRevisionId, request)) {
        setReviewNotes("");
        setStatus(
          `Revision ${selectedRevision.revisionNumber} was ${decision}. The review decision is recorded separately from publication.`,
        );
      }
    } catch (cause) {
      if (!workflowMatches(generation, scope, expectedQuestionId, expectedRevisionId)) return;
      if (cause instanceof ProtectedApiError && cause.status === 409) {
        setWorkflowConflict("revision");
        setError("The review state changed. Your question fields and review notes are preserved; refresh the revision before choosing an action again.");
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      if (request === requests.current.workflow) setWorkflowBusy(false);
    }
  }

  function requestPublishConfirmation() {
    if (!questionId || !selectedRevision || selectedRevision.workflowState !== "approved") return;
    const currentPointerVersion = publication?.pointerVersion ?? null;
    if (publication?.state === "retired") {
      setError("This question's publication is retired and cannot be republished through the current workflow.");
      return;
    }
    if (publication?.state === "published" && publication.revisionId === selectedRevision.revisionId) return;
    const confirmation = {
      kind: "publish" as const,
      questionId,
      revisionId: selectedRevision.revisionId,
      expectedPointerVersion: currentPointerVersion,
    };
    if (publication?.state === "published") {
      setWorkflowConfirmation(confirmation);
      setError("");
      return;
    }
    void performWorkflowConfirmation(confirmation);
  }

  function requestRetireConfirmation() {
    if (!questionId || !selectedRevision || publication?.state !== "published") return;
    setWorkflowConfirmation({
      kind: "retire",
      questionId,
      revisionId: selectedRevision.revisionId,
      expectedPointerVersion: publication.pointerVersion,
    });
    setError("");
  }

  async function performWorkflowConfirmation(confirmation: WorkflowConfirmation) {
    if (
      confirmation.questionId !== questionId ||
      confirmation.revisionId !== selectedRevision?.revisionId
    ) return;
    const scope = { ...scopeRef.current };
    const generation = formGeneration.current;
    const request = ++requests.current.workflow;
    setWorkflowBusy(true);
    setWorkflowConfirmation(null);
    setWorkflowConflict(null);
    setError("");
    setStatus("");
    let mutationSaved = false;
    try {
      if (confirmation.kind === "publish") {
        const currentPointerVersion = publication?.pointerVersion ?? null;
        if (confirmation.expectedPointerVersion !== currentPointerVersion) {
          setWorkflowConflict("publication");
          setError("Publication changed while confirmation was open. Refresh its state and confirm the replacement again.");
          return;
        }
        await publishRevision(
          scope.certificationId,
          scope.examVersionId,
          confirmation.questionId,
          {
            revisionId: confirmation.revisionId,
            expectedPointerVersion: confirmation.expectedPointerVersion,
          },
        );
      } else {
        if (
          publication?.state !== "published" ||
          confirmation.expectedPointerVersion !== publication.pointerVersion
        ) {
          setWorkflowConflict("publication");
          setError("Publication changed while confirmation was open. Refresh its state and confirm retirement again.");
          return;
        }
        await retirePublication(
          scope.certificationId,
          scope.examVersionId,
          confirmation.questionId,
          { expectedPointerVersion: confirmation.expectedPointerVersion },
        );
      }
      mutationSaved = true;
      if (!workflowMatches(
        generation,
        scope,
        confirmation.questionId,
        confirmation.revisionId,
      )) return;
      const refreshed = await refreshWorkflowData(
        generation,
        scope,
        confirmation.questionId,
        confirmation.revisionId,
        request,
      );
      if (!refreshed) return;
      setWorkflowRefreshAvailable(false);
      setStatus(
        confirmation.kind === "publish"
          ? `Revision ${selectedRevision.revisionNumber} is published. The revision, history, publication pointer, and question summary are refreshed.`
          : "The question was retired from future selection. Its publication and revision history are preserved.",
      );
    } catch (cause) {
      if (!workflowMatches(
        generation,
        scope,
        confirmation.questionId,
        confirmation.revisionId,
      )) return;
      if (mutationSaved) {
        setWorkflowRefreshAvailable(true);
        setError("");
        setStatus(
          confirmation.kind === "publish"
            ? "Publication was saved, but the editor could not refresh its revision, history, publication pointer, and question summary. Refresh the saved workflow state; do not resubmit the publication."
            : "Retirement was saved, but the editor could not refresh its revision, history, publication pointer, and question summary. Refresh the saved workflow state; do not resubmit the retirement.",
        );
      } else if (cause instanceof ProtectedApiError && cause.status === 409) {
        setWorkflowConflict("publication");
        setError("Publication changed since it was loaded. Your question fields and review notes are preserved; refresh publication state before choosing an action again.");
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      if (request === requests.current.workflow) setWorkflowBusy(false);
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
        <a className="brand" href="/">CertPath</a>
        <span>Protected staff content</span>
      </header>
      <div id="protected-editor-main" className="protected-editor-main">
        <p className="eyebrow">Staff question editor</p>
        <h1>Question editor</h1>
        <p className="protected-editor-intro">
          This editor reads and saves drafts and manages review and publication through the protected service.
          Sign in with an approved tester staff account; provisioning is an owner-approved, off-panel step.
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

            {certifications.items.length > 0 && (
              <ProtectedCsvTools
                certificationId={certificationId}
                certificationName={
                  certifications.items.find((item) => item.id === certificationId)?.displayName ?? ""
                }
                examVersionId={examVersionId}
                examVersionName={
                  versions.items.find((item) => item.id === examVersionId)?.title ?? ""
                }
              />
            )}

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
                    onClick={() => void loadMoreRevisions(revisions.nextCursor!)}
                  >
                    Load more revisions
                  </button>
                )}
                {questionId && selectedRevision && selectedRevision.revisionId === revisionId && (
                  <section className="protected-workflow-panel" aria-labelledby="protected-workflow-title">
                    <h3 id="protected-workflow-title">Review and publication</h3>
                    <p>
                      Exact revision {selectedRevision.revisionNumber}: <strong>{selectedRevision.workflowState}</strong>
                    </p>
                    {publication === undefined ? (
                      <p role="status">Loading publication status…</p>
                    ) : publication ? (
                      <div className="protected-publication-status">
                        <p>
                          Publication: <strong>{publication.state}</strong> · revision{" "}
                          {revisions.items.find((item) => item.id === publication.revisionId)
                            ? revisions.items.find((item) => item.id === publication.revisionId)?.revisionNumber
                            : publication.revisionId} · pointer version {publication.pointerVersion}
                        </p>
                        {publication.state === "retired" && (
                          <p>
                            Retirement removes this question from future selection and preserves its publication and revision history.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p>This question has no publication pointer yet.</p>
                    )}
                    {["draft", "rejected"].includes(selectedRevision.workflowState) && (
                      <button
                        className="button-primary"
                        type="button"
                        disabled={workflowBusy || workflowRefreshAvailable || saving || savedRevisionHasUnsavedEdits}
                        onClick={() => void submitSelectedForReview()}
                      >
                        {workflowBusy ? "Updating workflow…" : "Submit saved revision for review"}
                      </button>
                    )}
                    {["draft", "rejected"].includes(selectedRevision.workflowState) &&
                      savedRevisionHasUnsavedEdits && (
                        <p className="muted">
                          Save your current edits as a correction before submitting that new content for review.
                        </p>
                      )}
                    {selectedRevision.workflowState === "submitted" && (
                      <form
                        className="protected-review-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void recordSelectedReview("approved");
                        }}
                      >
                        <label>
                          Review notes
                          <textarea
                            rows={3}
                            maxLength={3000}
                            value={reviewNotes}
                            disabled={workflowBusy}
                            onChange={(event) => setReviewNotes(event.target.value)}
                            required
                          />
                        </label>
                        <div className="protected-editor-actions">
                          <button
                            className="button-primary"
                            type="submit"
                            disabled={workflowBusy || workflowRefreshAvailable || !reviewNotes.trim()}
                          >
                            Approve exact revision
                          </button>
                          <button
                            className="button-secondary"
                            type="button"
                            disabled={workflowBusy || workflowRefreshAvailable || !reviewNotes.trim()}
                            onClick={() => void recordSelectedReview("rejected")}
                          >
                            Reject exact revision
                          </button>
                        </div>
                      </form>
                    )}
                    {selectedRevision.workflowState === "approved" &&
                      publication !== undefined &&
                      publication?.state !== "retired" &&
                      publication?.revisionId !== selectedRevision.revisionId && (
                        <button
                          className="button-primary"
                          type="button"
                          disabled={workflowBusy || workflowRefreshAvailable}
                          onClick={requestPublishConfirmation}
                        >
                          {publication?.state === "published"
                            ? "Replace published revision"
                            : "Publish approved revision"}
                        </button>
                      )}
                    {publication?.state === "published" && (
                      <button
                        className="button-secondary"
                        type="button"
                        disabled={workflowBusy || workflowRefreshAvailable}
                        onClick={requestRetireConfirmation}
                      >
                        Retire published question
                      </button>
                    )}
                    {workflowConfirmation && (
                      <div className="protected-workflow-confirmation" role="group" aria-labelledby="workflow-confirmation-title">
                        <h4 id="workflow-confirmation-title">
                          {workflowConfirmation.kind === "publish"
                            ? "Confirm publication replacement"
                            : "Confirm retirement"}
                        </h4>
                        <p>
                          {workflowConfirmation.kind === "publish"
                            ? "Publishing this approved revision replaces the currently published revision for this exam version."
                            : "Retirement removes the question from future selection and keeps its publication and revision history."}
                        </p>
                        <div className="protected-editor-actions">
                          <button
                            className="button-primary"
                            type="button"
                            disabled={workflowBusy || workflowRefreshAvailable}
                            onClick={() => void performWorkflowConfirmation(workflowConfirmation)}
                          >
                            Confirm {workflowConfirmation.kind === "publish" ? "replacement" : "retirement"}
                          </button>
                          <button
                            className="button-secondary"
                            type="button"
                            disabled={workflowBusy}
                            onClick={() => setWorkflowConfirmation(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {(workflowConflict || workflowRefreshAvailable) && (
                      <div className="protected-workflow-conflict" role="alert">
                        <p>
                          {workflowRefreshAvailable
                            ? "The change was saved, but its latest state could not be loaded. Your question fields and review notes are retained."
                            : workflowConflict === "revision"
                              ? "Review state changed on the server. Your question fields and review notes are retained."
                              : "Publication state changed on the server. Your question fields and review notes are retained."}{" "}
                          {workflowRefreshAvailable
                            ? "Refresh the saved state; this will not resubmit the mutation."
                            : "Refresh before choosing an action again."}
                        </p>
                        <button
                          className="button-secondary"
                          type="button"
                          disabled={workflowBusy}
                          onClick={() => void refreshWorkflowState()}
                        >
                          {workflowRefreshAvailable
                            ? "Refresh saved workflow state"
                            : "Refresh workflow and publication state"}
                        </button>
                      </div>
                    )}
                  </section>
                )}
                {questionId && !canEditSavedDraft && (
                  <p className="protected-editor-status" role="note">
                    {displayedRevisionNeedsRecovery
                      ? "The question advanced after this revision was listed or loaded. Your form values are preserved; load and review the latest revision before saving."
                      : "This revision is historical and read-only. Select the current draft or rejected revision to create a correction."}
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
                <form
                  className="protected-editor-form"
                  aria-busy={saving || revisionLoading}
                  onSubmit={(event) => void submitQuestion(event)}
                >
                  <fieldset
                    className="protected-editor-fields"
                    disabled={saving || revisionLoading}
                  >
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
                      disabled={
                        saving ||
                        (questionId !== "" && !canEditSavedDraft) ||
                        (questionId !== "" && selectedRevision?.revisionId !== revisionId)
                      }
                    >
                      {saving ? "Saving…" : questionId ? "Save correction" : "Save draft"}
                    </button>
                    {(error.includes("changed since it was loaded") ||
                      displayedRevisionNeedsRecovery) && questionId && (
                      <button
                        className="button-secondary"
                        type="button"
                        disabled={saving}
                        onClick={() => void loadLatestAfterConflict()}
                      >
                        Load latest revision
                      </button>
                    )}
                  </div>
                  </fieldset>
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
