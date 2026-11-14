import { describe, expect, it } from "vitest";
import { adminTesterGate, isAdminSurfacePath } from "../src/security/admin-gate.ts";

function request(path: string, clientIp?: string): Request {
  const headers = new Headers();
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  return new Request(`https://localhost${path}`, { headers });
}

describe("admin tester gate", () => {
  it("covers every admin page and admin API path only", () => {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin/question-editor",
      "/admin/sign-in",
      "/api/admin",
      "/api/admin/auth/sign-in",
      "/api/admin/content/certifications",
    ]) {
      expect(isAdminSurfacePath(path)).toBe(true);
    }
    for (const path of [
      "/",
      "/exams",
      "/api/health",
      "/api/practice/dashboard",
      "/administrator",
      "/api/administrator",
      "/app/home",
    ]) {
      expect(isAdminSurfacePath(path)).toBe(false);
    }
  });

  it("closes the admin surface when no allowlist is configured", () => {
    const rejected = adminTesterGate(request("/admin", "203.0.113.10"), {});
    expect(rejected?.status).toBe(503);
    expect(
      adminTesterGate(request("/admin", "203.0.113.10"), {
        ADMIN_TESTER_IPS: " , ",
      })?.status,
    ).toBe(503);
  });

  it("allows only listed client addresses", () => {
    const bindings = { ADMIN_TESTER_IPS: "203.0.113.10, 203.0.113.11" };
    expect(adminTesterGate(request("/admin", "203.0.113.11"), bindings)).toBeNull();
    expect(adminTesterGate(request("/admin", "198.51.100.5"), bindings)?.status).toBe(
      403,
    );
    expect(adminTesterGate(request("/admin"), bindings)?.status).toBe(403);
  });

  it("lets a loopback request through only with the explicit local opt-in", () => {
    const allowlisted = { ADMIN_TESTER_IPS: "203.0.113.10" };
    expect(adminTesterGate(request("/admin"), allowlisted)?.status).toBe(403);
    expect(
      adminTesterGate(request("/admin"), {
        ...allowlisted,
        ADMIN_TESTER_LOCAL: "true",
      }),
    ).toBeNull();
    expect(
      adminTesterGate(
        new Request("https://admin.example/admin"),
        { ...allowlisted, ADMIN_TESTER_LOCAL: "true" },
      )?.status,
    ).toBe(403);
  });

  it("marks rejections private and non-indexable", () => {
    const rejected = adminTesterGate(request("/admin", "198.51.100.5"), {
      ADMIN_TESTER_IPS: "203.0.113.10",
    });
    expect(rejected?.headers.get("cache-control")).toBe("no-store");
    expect(rejected?.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
