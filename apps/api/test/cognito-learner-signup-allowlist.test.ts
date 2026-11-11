import { describe, expect, it } from "vitest";
import {
  createCognitoLearnerPreSignUpHandler,
  type CognitoPreSignUpEvent,
} from "../src/cognito-learner-signup-allowlist.ts";

const userPoolId = "us-east-1_synthetic";
const learnerEmail = "learner@example.test";
const handler = createCognitoLearnerPreSignUpHandler({
  userPoolId,
  learnerEmail,
});

function event(
  triggerSource: string,
  email: string,
  overrides: Partial<CognitoPreSignUpEvent> = {},
): CognitoPreSignUpEvent {
  return {
    userPoolId,
    triggerSource,
    request: { userAttributes: { email } },
    response: {},
    ...overrides,
  };
}

describe("learner-only Cognito PreSignUp allowlist", () => {
  it("allows only the configured self-signup without bypassing verification", () => {
    const signup = event("PreSignUp_SignUp", " Learner@Example.Test ");
    const result = handler(signup);

    expect(result).toBe(signup);
    expect(result.response).toEqual({
      autoConfirmUser: false,
      autoVerifyEmail: false,
    });
  });

  it("rejects other learners and all administrative account creation", () => {
    expect(() => handler(event("PreSignUp_SignUp", "other@example.test"))).toThrow(
      "signup_not_allowlisted",
    );
    expect(() =>
      handler(event("PreSignUp_AdminCreateUser", learnerEmail)),
    ).toThrow("signup_not_allowlisted");
  });

  it("fails closed for missing email, an unexpected pool, and unsupported triggers", () => {
    expect(() => handler(event("PreSignUp_SignUp", ""))).toThrow(
      "signup_not_allowlisted",
    );
    expect(() =>
      handler(
        event("PreSignUp_SignUp", learnerEmail, {
          userPoolId: "us-east-1_other",
        }),
      ),
    ).toThrow("signup_not_allowlisted");
    expect(() =>
      handler(event("PreTokenGeneration_Authentication", learnerEmail)),
    ).toThrow("signup_not_allowlisted");
  });
});
