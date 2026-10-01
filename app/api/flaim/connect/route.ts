import { NextRequest, NextResponse } from "next/server";
import { createAuthorizationTransaction, oauthCookieValue, publicAppOrigin } from "@/lib/flaim/oauth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (process.env.FLAIM_MCP_SYNC_V1 !== "1") return new NextResponse("Flaim sync is disabled.", { status: 404 });
  try {
    const result = await createAuthorizationTransaction(request.nextUrl.origin);
    const response = NextResponse.redirect(result.authorizationUrl);
    response.cookies.set("flaim_oauth_transaction", oauthCookieValue(result.transaction), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/flaim",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    console.error(JSON.stringify({ event: "flaim_oauth_start_failed", errorName: error instanceof Error ? error.name : "UnknownError" }));
    const target = new URL("/", publicAppOrigin(request.nextUrl.origin));
    target.searchParams.set("flaim_error", "setup");
    return NextResponse.redirect(target);
  }
}
