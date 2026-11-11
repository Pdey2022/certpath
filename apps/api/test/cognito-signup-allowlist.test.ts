import { describe, expect, it } from "vitest";
import {
  createCognitoSandboxPreSignUpHandler,
  type CognitoPreSignUpEvent,
} from "../src/cognito-signup-allowlist.ts";

const userPoolId = "us-east-1_synthetic";
const learnerEmail = "learner@example.test";
const staffEmails = ["admin@example.test", "manager@example.test"];
const handler = createCognitoSandboxPreSignUpHandler({
  userPoolId,
  learnerEmail,
  staffEmails,
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

describe("Cognito sandbox PreSignUp allowlist", () => {
  it("allows only the configured learner self-signup without bypassing email verification", () => {
    const signup = event("PreSignUp_SignUp", " Learner@Example.Test ");
    const result = handler(signup);

    expect(result).toBe(signup);
    expect(result.response).toEqual({
      autoConfirmUser: false,
      autoVerifyEmail: false,
    });
  });

  it("rejects other self-signups and rejects staff through the public signup trigger", () => {
    for (const email of ["outsider@example.test", staffEmails[0]]) {
      expect(() => handler(event("PreSignUp_SignUp", email))).toThrow(
        "signup_not_allowlisted",
      );
    }
  });

  it("allows only the two configured staff accounts through administrative creation", () => {
    for (const email of staffEmails) {
      const created = event("PreSignUp_AdminCreateUser", email);
      expect(handler(created).response).toEqual({
        autoConfirmUser: false,
        autoVerifyEmail: false,
      });
    }
    expect(() =>
      handler(event("PreSignUp_AdminCreateUser", "outsider@example.test")),
    ).toThrow("signup_not_allowlisted");
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
