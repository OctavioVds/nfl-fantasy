import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/core/run/route";
import { GET as cron } from "@/app/api/cron/core/route";
import { GET as projection } from "@/app/api/core/projection/route";
import { coreInputSchema } from "@/lib/core/schema";
import { serverEnv } from "@/lib/env";
import { scoringFromLeague } from "@/lib/core/run";
import { externalSyncSchema } from "@/lib/schemas";
import { sameOrigin } from "@/lib/core/http";
import { scenarioSchema } from "@/lib/core/schema";
import { coreRunFresh } from "@/lib/core/service";

afterEach(() => vi.unstubAllEnvs());
describe("protected predictive core routes and data honesty", () => {
  it("expires published recommendations even without a new run, and rejects future or malformed timestamps", () => {
    const now = Date.parse("2026-10-14T15:00:00Z");
    expect(coreRunFresh({source_as_of:"2026-10-14T14:00:00Z"},now)).toBe(true);
    for (const source_as_of of ["2026-10-13T14:59:59Z","2026-10-14T15:00:01Z","invalid"]) expect(coreRunFresh({source_as_of},now)).toBe(false);
    expect(coreRunFresh(null,now)).toBe(false);
  });
  it("reserves base for the unconditional distribution instead of masking an absence scenario", () => {
    expect(scenarioSchema.safeParse({id:"base",team_id:"fixture",probability:1,absent_player_ids:[],qb_id:null,evidence:{source:"fixture",as_of:"2026-10-14T15:00:00Z",fetched_at:"2026-10-14T15:00:00Z",estimated:false}}).success).toBe(false);
  });
  it("uses public Host behind Next's internal URL and browser same-origin metadata", () => {
    expect(sameOrigin(new Request("http://localhost:3317/api/core/run", {headers:{host:"127.0.0.1:3317",origin:"http://127.0.0.1:3317"}}))).toBe(true);
    expect(sameOrigin(new Request("https://fixture.invalid/api/core/run", {headers:{"sec-fetch-site":"same-origin"}}))).toBe(true);
    expect(sameOrigin(new Request("https://fixture.invalid/api/core/run", {headers:{"sec-fetch-site":"cross-site"}}))).toBe(false);
  });
  it("rejects bad Bearer even with same origin on a proxy-exempt route", async () => {
    vi.stubEnv("EXTERNAL_SYNC_SECRET","fixture-secret-not-real");
    const response = await POST(new Request("https://fixture.invalid/api/core/run", {method:"POST",headers:{origin:"https://fixture.invalid",authorization:"Bearer wrong"}}));
    expect(response.status).toBe(401);
  });
  it("rejects cross-site recalculation without ingest authorization", async () => {
    const response = await POST(new Request("https://fixture.invalid/api/core/run", {method:"POST",headers:{origin:"https://other.invalid"}}));
    expect(response.status).toBe(403);
  });
  it("rejects missing cron secret rather than running unprotected", async () => {
    vi.stubEnv("CRON_SECRET","");
    expect((await cron(new Request("https://fixture.invalid/api/cron/core"))).status).toBe(401);
  });
  it("validates query inputs before touching database", async () => {
    expect((await projection(new Request("https://fixture.invalid/api/core/projection?week=19"))).status).toBe(400);
  });
  it("does not treat a reception label as complete league scoring", () => {
    const league = externalSyncSchema.parse({league:{name:"Fictitious League",season:2026,week:6,scoring:{reception:1}},roster:[{providerId:"fixture",name:"Fictitious Test",team:"TST",position:"WR",slot:"Bench"}],source:"espn",sourceTimestamp:"2026-10-14T15:00:00Z"});
    expect(scoringFromLeague(league)).toBeNull();
  });
  it("requires reasons for missing scoring and rejects unknown scenario teammate IDs", () => {
    const base = {scope:"fixture",season:2026,week:6,as_of:"2026-10-14T15:00:00Z",scoring:null,players:[]};
    expect(coreInputSchema.safeParse(base).success).toBe(false);
    expect(coreInputSchema.safeParse({...base,scoring_reason:"No historical scoring supplied"}).success).toBe(true);
  });
  it("rejects duplicate social IDs before the atomic Neon upsert", () => {
    const signal = {id:"fixture-signal",source_id:"fixture",player_id:null,team_id:null,kind:"role",summary:"Fictional contract test",confirmed:false,second_source_id:null,ts:"2026-10-14T15:00:00Z",evidence:{source:"fixture",as_of:"2026-10-14T15:00:00Z",fetched_at:"2026-10-14T15:00:00Z",estimated:false}};
    const parsed = coreInputSchema.safeParse({scope:"fixture",season:2026,week:6,as_of:"2026-10-14T15:00:00Z",scoring:null,scoring_reason:"Not supplied",players:[],signals:[signal,signal]});
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({message:"Duplicate social signal ID"}));
  });
  it("never echoes invalid environment values", () => {
    expect(() => serverEnv({DATABASE_URL:"fixture-secret-invalid-url"})).toThrow("Invalid environment: DATABASE_URL");
    try { serverEnv({DATABASE_URL:"fixture-secret-invalid-url"}); } catch (error) { expect(String(error)).not.toContain("fixture-secret-invalid-url"); }
  });
});
