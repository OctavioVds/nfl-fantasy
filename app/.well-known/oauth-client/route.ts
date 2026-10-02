import { NextRequest } from "next/server";
import { publicAppOrigin } from "@/lib/flaim/oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = publicAppOrigin(request.nextUrl.origin);
  return Response.json({
    client_id: origin + "/.well-known/oauth-client",
    client_name: "NFL Fantasy Command Center",
    client_uri: origin,
    redirect_uris: [origin + "/api/flaim/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}
