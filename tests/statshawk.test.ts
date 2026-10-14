import {afterEach,describe,expect,it,vi} from "vitest";
import {fetchStatsHawkContext} from "@/lib/providers/statshawk";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("StatsHawk documented envelope",()=>{
  it("reads data.items and retains provider fetch time",async()=>{
    vi.stubEnv("STATSHAWK_API_KEY","fixture-not-real");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{items:[{id:"fixture"}]},meta:{fetched_at:"2026-10-14T15:00:00Z",version:"v1"}}),{status:200})));
    expect(await fetchStatsHawkContext(2026)).toMatchObject({contests:1,fetchedAt:"2026-10-14T15:00:00Z"});
  });
  it("rejects schema changes instead of inventing zero contests/current timestamp",async()=>{
    vi.stubEnv("STATSHAWK_API_KEY","fixture-not-real");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[]}),{status:200})));
    await expect(fetchStatsHawkContext(2026)).rejects.toThrow();
  });
});
