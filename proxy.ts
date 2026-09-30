import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

function validPassword(request: NextRequest, expected: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "fantasy") return false;
    const supplied = Buffer.from(decoded.slice(separator + 1));
    const configured = Buffer.from(expected);
    return supplied.length === configured.length && timingSafeEqual(supplied, configured);
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === "development") return NextResponse.next();
  if (["/api/external-sync", "/api/cron/sync"].includes(request.nextUrl.pathname)) return NextResponse.next();

  const password = process.env.APP_ACCESS_PASSWORD;
  if (!password) {
    return new NextResponse("Acceso privado no configurado.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (validPassword(request, password)) return NextResponse.next();
  return new NextResponse("Autenticación requerida.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Liga ESPN", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
