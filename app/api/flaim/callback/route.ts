import { NextRequest, NextResponse } from "next/server";
import { exchangeAuthorizationCode, publicAppOrigin, readOAuthCookie } from "@/lib/flaim/oauth";
import { saveFlaimConnection } from "@/lib/flaim/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

function home(request: NextRequest, result: "connected" | "error", syncError = false) {
  const target = new URL("/", publicAppOrigin(request.nextUrl.origin));
  target.searchParams.set("flaim", result);
  if (syncError) target.searchParams.set("flaim_sync", "error");
  if (result === "connected" && !syncError) target.searchParams.set("flaim_sync", "1");
  const response = NextResponse.redirect(target);
  response.cookies.set("flaim_oauth_transaction", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/flaim",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get("flaim_oauth_transaction")?.value;
  const returnedState = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");
  if (!cookie || !returnedState || !code || providerError) return home(request, "error");
  try {
    const transaction = readOAuthCookie(cookie);
    if (transaction.state !== returnedState) return home(request, "error");
    const connection = await exchangeAuthorizationCode(transaction, code);
    await saveFlaimConnection(connection);
    return home(request, "connected");
  } catch (error) {
    console.error(JSON.stringify({ event: "flaim_oauth_callback_failed", errorName: error instanceof Error ? error.name : "UnknownError" }));
    return home(request, "error");
  }
}
