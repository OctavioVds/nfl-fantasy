import { FLAIM_MCP_URL } from "./oauth";
import type { FlaimTokenSet } from "./storage";

type JsonRecord = Record<string, unknown>;
type RpcResponse = { result?: unknown; error?: { message?: string }; sessionId?: string };

function responsePayload(text: string, contentType: string) {
  if (!text.trim()) return null;
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    for (let index = data.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(data[index]); } catch { /* Read the next SSE data event. */ }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export class FlaimMcpClient {
  private sessionId: string | undefined;
  private requestId = 0;
  private toolsCache: JsonRecord[] | null = null;

  constructor(private readonly tokens: FlaimTokenSet) {}

  private async send(method: string, params?: JsonRecord, notification = false): Promise<RpcResponse> {
    const request: JsonRecord = { jsonrpc: "2.0", method };
    if (!notification) request.id = ++this.requestId;
    if (params) request.params = params;
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer " + this.tokens.access_token,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(FLAIM_MCP_URL, {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify(request),
    });
    if (response.status === 401) throw new Error("Flaim rechazó la autorización. Vuelve a conectar la cuenta.");
    if (!response.ok && response.status !== 202) throw new Error("Flaim no respondió a la consulta de la liga.");
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const text = await response.text();
    const envelope = responsePayload(text, response.headers.get("content-type") || "") as JsonRecord | null;
    if (envelope && envelope.error && typeof envelope.error === "object") {
      const message = (envelope.error as JsonRecord).message;
      throw new Error(typeof message === "string" ? message : "Flaim no pudo completar la consulta.");
    }
    return { result: envelope?.result, sessionId: this.sessionId };
  }

  async initialize() {
    await this.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "nfl-fantasy-command-center", version: "1.0.0" },
    });
    await this.send("notifications/initialized", undefined, true);
  }

  async listTools() {
    if (this.toolsCache) return this.toolsCache;
    const response = await this.send("tools/list");
    const result = response.result as JsonRecord | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    this.toolsCache = tools.filter((tool): tool is JsonRecord => Boolean(tool && typeof tool === "object"));
    return this.toolsCache;
  }

  async callTool(logicalName: string, argumentsValue: JsonRecord = {}) {
    const tools = await this.listTools();
    const definition = tools.find((tool) => typeof tool.name === "string" && (
      tool.name === logicalName || tool.name.endsWith("_" + logicalName)
    ));
    if (!definition || typeof definition.name !== "string") {
      throw new Error("Flaim no ofrece la consulta requerida: " + logicalName + ".");
    }
    const response = await this.send("tools/call", { name: definition.name, arguments: argumentsValue });
    const result = response.result as JsonRecord | undefined;
    if (!result) throw new Error("Flaim devolvió una respuesta vacía.");
    if (result.isError === true) throw new Error("Flaim no pudo leer los datos de la liga.");
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    const content = Array.isArray(result.content) ? result.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object" || typeof (item as JsonRecord).text !== "string") continue;
      const text = (item as JsonRecord).text as string;
      try { return JSON.parse(text); } catch { /* Try the next content block. */ }
    }
    return result;
  }
}
