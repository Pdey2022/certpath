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

export interface CognitoLearnerSignupAllowlist {
  userPoolId: string;
  learnerEmail: string;
}

function normalizeEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function createCognitoLearnerPreSignUpHandler(
  allowlist: CognitoLearnerSignupAllowlist,
): (event: CognitoPreSignUpEvent) => CognitoPreSignUpEvent {
  const learnerEmail = normalizeEmail(allowlist.learnerEmail);

  return (event) => {
    const email = normalizeEmail(event.request.userAttributes?.email);
    if (
      event.userPoolId !== allowlist.userPoolId ||
      !email ||
      learnerEmail === "" ||
      email !== learnerEmail ||
      event.triggerSource !== "PreSignUp_SignUp"
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
  return createCognitoLearnerPreSignUpHandler({
    userPoolId: process.env.COGNITO_LEARNER_SANDBOX_USER_POOL_ID ?? "",
    learnerEmail: process.env.COGNITO_LEARNER_ALLOWED_EMAIL ?? "",
  })(event);
}
