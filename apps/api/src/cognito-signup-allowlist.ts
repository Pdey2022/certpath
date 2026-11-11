export interface CognitoPreSignUpEvent {
  userPoolId: string;
  triggerSource: string;
  request: {
    userAttributes?: Record<string, string>;
  };
  response: {
    autoConfirmUser?: boolean;
    autoVerifyEmail?: boolean;
    [key: string]: unknown;
  };
}

export interface CognitoSandboxSignupAllowlist {
  userPoolId: string;
  learnerEmail: string;
  staffEmails: string[];
}

function normalizeEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function createCognitoSandboxPreSignUpHandler(
  allowlist: CognitoSandboxSignupAllowlist,
): (event: CognitoPreSignUpEvent) => CognitoPreSignUpEvent {
  const learnerEmail = normalizeEmail(allowlist.learnerEmail);
  const staffEmails = new Set(allowlist.staffEmails.map(normalizeEmail));

  return (event) => {
    const email = normalizeEmail(event.request.userAttributes?.email);
    const allowedLearner =
      event.triggerSource === "PreSignUp_SignUp" &&
      learnerEmail !== "" &&
      email === learnerEmail;
    const allowedStaff =
      event.triggerSource === "PreSignUp_AdminCreateUser" &&
      staffEmails.has(email);

    if (
      event.userPoolId !== allowlist.userPoolId ||
      !email ||
      (!allowedLearner && !allowedStaff)
    ) {
      throw new Error("signup_not_allowlisted");
    }

    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
    return event;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
};

export function handler(event: CognitoPreSignUpEvent): CognitoPreSignUpEvent {
  const staffEmails =
    process.env.COGNITO_SANDBOX_ALLOWED_STAFF_EMAILS?.split(",") ?? [];
  return createCognitoSandboxPreSignUpHandler({
    userPoolId: process.env.COGNITO_SANDBOX_USER_POOL_ID ?? "",
    learnerEmail: process.env.COGNITO_SANDBOX_LEARNER_EMAIL ?? "",
    staffEmails,
  })(event);
}
