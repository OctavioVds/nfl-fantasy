import { createHash, randomBytes } from "node:crypto";
import { encryptJson, decryptJson, type FlaimTokenSet } from "./storage";

export const FLAIM_MCP_URL = "https://api.flaim.app/mcp";

type JsonRecord = Record<string, unknown>;
export type FlaimOAuthFailureCode =
  | "authorization_metadata_unavailable"
  | "pkce_unavailable"
  | "client_registration_unavailable"
  | "client_registration_failed"
  | "redirect_uri_rejected"
  | "read_scope_unavailable"
  | "oauth_setup_failed";

export class FlaimOAuthSetupError extends Error {
  constructor(readonly code: FlaimOAuthFailureCode, message: string) {
    super(message);
    this.name = "FlaimOAuthSetupError";
  }
}

export function classifyRegistrationFailure(providerCode: unknown): FlaimOAuthFailureCode {
  return providerCode === "invalid_redirect_uri" ? "redirect_uri_rejected" : "client_registration_failed";
}

export function flaimReadOnlyScope(supportedScopes: unknown, challengeScope?: string) {
  const supported = Array.isArray(supportedScopes) ? supportedScopes.filter((scope): scope is string => typeof scope === "string") : [];
  const challenged = challengeScope?.split(/\s+/).filter(Boolean) ?? [];
  return [...supported, ...challenged].includes("mcp:read") ? "mcp:read" : undefined;
}

type OAuthMetadata = JsonRecord & {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer?: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
};

export type OAuthTransaction = {
  state: string;
  verifier: string;
  createdAt: number;
  redirectUri: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
};

export function publicAppOrigin(requestOrigin?: string) {
  if (requestOrigin) return new URL(requestOrigin).origin;
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) {
    const value = configured.startsWith("http") ? configured : "https://" + configured;
    return new URL(value).origin;
  }
  if (process.env.NODE_ENV === "production") return "https://q-ecru-nu.vercel.app";
  return "http://localhost:3000";
}

export function oauthCookieValue(transaction: OAuthTransaction) {
  return encryptJson(transaction);
}

export function readOAuthCookie(value: string) {
  return decryptJson<OAuthTransaction>(value);
}

function flaimUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Flaim returned invalid OAuth configuration.");
  }
  if (url.protocol !== "https:" || !(url.hostname === "flaim.app" || url.hostname.endsWith(".flaim.app"))) {
    throw new Error("Flaim returned an untrusted OAuth URL.");
  }
  return url.toString();
}

async function jsonRequest(url: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(flaimUrl(url), { cache: "no-store", ...init });
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = {};
  }
  if (!response.ok || !value || typeof value !== "object") {
    const providerCode = value && typeof value === "object" && typeof (value as JsonRecord).error === "string"
      ? (value as JsonRecord).error as string
      : "";
    const code = classifyRegistrationFailure(providerCode);
    const message = code === "redirect_uri_rejected"
      ? "Flaim rechazó la URL de retorno OAuth de esta app."
      : "Flaim no pudo registrar el cliente OAuth.";
    throw new FlaimOAuthSetupError(code, message);
  }
  return value as JsonRecord;
}

function metadataUrl(issuer: string, suffix: string, append = false) {
  const base = new URL(flaimUrl(issuer));
  const path = base.pathname.replace(/\/+$/, "");
  const wellKnown = "/.well-known/" + suffix;
  base.pathname = path ? append ? path + wellKnown : wellKnown + path : wellKnown;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function challengeParameters(header: string | null) {
  const result: { resourceMetadata?: string; scope?: string } = {};
  if (!header) return result;
  const parts = header.split(",");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim().replace(/^"|"$/g, "");
    if (key === "resource_metadata") result.resourceMetadata = value;
    if (key === "scope") result.scope = value;
  }
  return result;
}

async function resourceMetadata() {
  let challenge: { resourceMetadata?: string; scope?: string } = {};
  try {
    const response = await fetch(FLAIM_MCP_URL, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nfl-fantasy-command-center", version: "1.0.0" } } }),
    });
    challenge = challengeParameters(response.headers.get("www-authenticate"));
  } catch {
    // Discovery continues through the standard well-known URLs below.
  }

  const candidates = [
    challenge.resourceMetadata,
    "https://api.flaim.app/.well-known/oauth-protected-resource/mcp",
    "https://api.flaim.app/.well-known/oauth-protected-resource",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const metadata = await jsonRequest(candidate);
      const servers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : [];
      if (servers.length && typeof servers[0] === "string") {
        return { metadata, issuer: flaimUrl(servers[0]), scope: flaimReadOnlyScope(metadata.scopes_supported, challenge.scope) };
      }
    } catch {
      // Try the next discovery location.
    }
  }
  throw new FlaimOAuthSetupError("authorization_metadata_unavailable", "Flaim no publicó la información de autorización OAuth necesaria.");
}

async function authorizationMetadata(issuer: string): Promise<OAuthMetadata> {
  const candidates = [
    metadataUrl(issuer, "oauth-authorization-server"),
    metadataUrl(issuer, "openid-configuration"),
    metadataUrl(issuer, "openid-configuration", true),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const value = await jsonRequest(candidate);
      if (typeof value.authorization_endpoint === "string" && typeof value.token_endpoint === "string") {
        return value as OAuthMetadata;
      }
    } catch {
      // Try the next standards-defined discovery URL.
    }
  }
  throw new FlaimOAuthSetupError("authorization_metadata_unavailable", "Flaim no publicó sus endpoints de autorización OAuth.");
}

async function registerClient(metadata: OAuthMetadata, origin: string, redirectUri: string) {
  const configuredClientId = process.env.FLAIM_OAUTH_CLIENT_ID?.trim();
  if (configuredClientId) {
    const configuredClientSecret = process.env.FLAIM_OAUTH_CLIENT_SECRET?.trim();
    return {
      clientId: configuredClientId,
      clientSecret: configuredClientSecret || undefined,
    };
  }
  if (metadata.client_id_metadata_document_supported === true) {
    return { clientId: origin + "/.well-known/oauth-client", clientSecret: undefined };
  }
  if (!metadata.registration_endpoint) {
    throw new FlaimOAuthSetupError("client_registration_unavailable", "Flaim no ofrece registro automático de clientes OAuth.");
  }
  const registration = await jsonRequest(metadata.registration_endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "NFL Fantasy Command Center",
      client_uri: origin,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (typeof registration.client_id !== "string") {
    throw new FlaimOAuthSetupError("client_registration_failed", "Flaim no devolvió un identificador de cliente OAuth.");
  }
  return {
    clientId: registration.client_id,
    clientSecret: typeof registration.client_secret === "string" ? registration.client_secret : undefined,
  };
}

export async function createAuthorizationTransaction(requestOrigin: string) {
  const origin = publicAppOrigin(requestOrigin);
  const redirectUri = origin + "/api/flaim/callback";
  const resource = FLAIM_MCP_URL;
  const discoveredResource = await resourceMetadata();
  if (discoveredResource.scope !== "mcp:read") {
    throw new FlaimOAuthSetupError("read_scope_unavailable", "Flaim no ofrece un permiso de solo lectura para esta conexión.");
  }
  const auth = await authorizationMetadata(discoveredResource.issuer);
  if (!auth.code_challenge_methods_supported?.includes("S256")) {
    throw new FlaimOAuthSetupError("pkce_unavailable", "Flaim no ofrece PKCE S256, que se requiere para proteger el acceso.");
  }
  const client = await registerClient(auth, origin, redirectUri);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const transaction: OAuthTransaction = {
    state,
    verifier,
    createdAt: Date.now(),
    redirectUri,
    resource,
    authorizationEndpoint: flaimUrl(auth.authorization_endpoint),
    tokenEndpoint: flaimUrl(auth.token_endpoint),
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    scope: discoveredResource.scope,
  };
  const authorize = new URL(transaction.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", transaction.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("resource", resource);
  if (transaction.scope) authorize.searchParams.set("scope", transaction.scope);
  return { transaction, authorizationUrl: authorize.toString() };
}

export async function exchangeAuthorizationCode(transaction: OAuthTransaction, code: string): Promise<FlaimTokenSet> {
  if (Date.now() - transaction.createdAt > 10 * 60 * 1000) throw new Error("La autorización expiró. Vuelve a conectar Flaim.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: transaction.redirectUri,
    client_id: transaction.clientId,
    code_verifier: transaction.verifier,
    resource: transaction.resource,
  });
  if (transaction.clientSecret) body.set("client_secret", transaction.clientSecret);
  const response = await fetch(flaimUrl(transaction.tokenEndpoint), {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error("Flaim no completó la autorización. Vuelve a conectar la cuenta.");
  }
  return {
    access_token: result.access_token,
    refresh_token: typeof result.refresh_token === "string" ? result.refresh_token : undefined,
    token_type: typeof result.token_type === "string" ? result.token_type : "Bearer",
    scope: typeof result.scope === "string" ? result.scope : transaction.scope,
    expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1000 : undefined,
    resource: transaction.resource,
    clientId: transaction.clientId,
    clientSecret: transaction.clientSecret,
    tokenEndpoint: transaction.tokenEndpoint,
  };
}

export async function refreshFlaimTokens(tokens: FlaimTokenSet): Promise<FlaimTokenSet> {
  if (!tokens.refresh_token) throw new Error("La autorización de Flaim expiró. Vuelve a conectar la cuenta.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: tokens.clientId,
    resource: tokens.resource,
  });
  if (tokens.clientSecret) body.set("client_secret", tokens.clientSecret);
  const response = await fetch(flaimUrl(tokens.tokenEndpoint), {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok || typeof result.access_token !== "string") {
    throw new Error("La sesión con Flaim expiró. Pulsa Conectar Flaim otra vez.");
  }
  return {
    ...tokens,
    access_token: result.access_token,
    refresh_token: typeof result.refresh_token === "string" ? result.refresh_token : tokens.refresh_token,
    token_type: typeof result.token_type === "string" ? result.token_type : tokens.token_type,
    scope: typeof result.scope === "string" ? result.scope : tokens.scope,
    expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1000 : undefined,
  };
}
