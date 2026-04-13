// @vitest-environment node
import { vi, test, expect, beforeEach, describe } from "vitest";
import { jwtVerify } from "jose";

vi.mock("server-only", () => ({}));

const cookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(cookieStore)),
}));

import { createSession, getSession, deleteSession, verifySession } from "@/lib/auth";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

async function makeToken(userId: string, email: string, expiresIn = "7d") {
  return new SignJWT({ userId, email, expiresAt: new Date() })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

const JWT_SECRET = new TextEncoder().encode("development-secret-key");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSession", () => {
  test("sets a cookie named auth-token", async () => {
    await createSession("user1", "user@example.com");
    const [name] = cookieStore.set.mock.calls[0];
    expect(name).toBe("auth-token");
  });

  test("cookie is httpOnly", async () => {
    await createSession("user1", "user@example.com");
    const [, , options] = cookieStore.set.mock.calls[0];
    expect(options.httpOnly).toBe(true);
  });

  test("cookie has sameSite lax and path /", async () => {
    await createSession("user1", "user@example.com");
    const [, , options] = cookieStore.set.mock.calls[0];
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  test("cookie expires approximately 7 days from now", async () => {
    const before = Date.now();
    await createSession("user1", "user@example.com");
    const after = Date.now();

    const [, , options] = cookieStore.set.mock.calls[0];
    const expiresMs = options.expires.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDays - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDays + 1000);
  });

  test("JWT payload contains userId and email", async () => {
    await createSession("user42", "hello@test.com");
    const token = cookieStore.set.mock.calls[0][1];
    const { payload } = await jwtVerify(token, JWT_SECRET);
    expect(payload.userId).toBe("user42");
    expect(payload.email).toBe("hello@test.com");
  });

  test("JWT is signed with HS256", async () => {
    await createSession("user1", "user@example.com");
    const token = cookieStore.set.mock.calls[0][1] as string;
    const header = JSON.parse(atob(token.split(".")[0]));
    expect(header.alg).toBe("HS256");
  });
});

describe("getSession", () => {
  test("returns null when cookie is absent", async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect(await getSession()).toBeNull();
  });

  test("returns session payload for a valid token", async () => {
    const token = await makeToken("u1", "a@b.com");
    cookieStore.get.mockReturnValue({ value: token });

    const session = await getSession();
    expect(session?.userId).toBe("u1");
    expect(session?.email).toBe("a@b.com");
  });

  test("returns null for a tampered token", async () => {
    cookieStore.get.mockReturnValue({ value: "not.a.valid.jwt" });
    expect(await getSession()).toBeNull();
  });

  test("returns null for an expired token", async () => {
    const token = await makeToken("u1", "a@b.com", "-1s");
    cookieStore.get.mockReturnValue({ value: token });
    expect(await getSession()).toBeNull();
  });
});

describe("deleteSession", () => {
  test("deletes the auth-token cookie", async () => {
    await deleteSession();
    expect(cookieStore.delete).toHaveBeenCalledWith("auth-token");
  });

  test("only deletes once per call", async () => {
    await deleteSession();
    expect(cookieStore.delete).toHaveBeenCalledOnce();
  });
});

describe("verifySession", () => {
  test("returns null when request has no cookie", async () => {
    const req = new NextRequest("http://localhost/");
    expect(await verifySession(req)).toBeNull();
  });

  test("returns session payload for a valid token in request", async () => {
    const token = await makeToken("u2", "x@y.com");
    const req = new NextRequest("http://localhost/", {
      headers: { cookie: `auth-token=${token}` },
    });

    const session = await verifySession(req);
    expect(session?.userId).toBe("u2");
    expect(session?.email).toBe("x@y.com");
  });

  test("returns null for an invalid token in request", async () => {
    const req = new NextRequest("http://localhost/", {
      headers: { cookie: "auth-token=garbage" },
    });
    expect(await verifySession(req)).toBeNull();
  });

  test("returns null for an expired token in request", async () => {
    const token = await makeToken("u3", "z@z.com", "-1s");
    const req = new NextRequest("http://localhost/", {
      headers: { cookie: `auth-token=${token}` },
    });
    expect(await verifySession(req)).toBeNull();
  });
});
