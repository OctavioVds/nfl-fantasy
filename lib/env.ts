import { z } from "zod";

const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const envSchema = z.object({
  DATABASE_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().regex(/^postgres(ql)?:/).optional()),
  APP_ACCESS_PASSWORD: optionalSecret, EXTERNAL_SYNC_SECRET: optionalSecret, CRON_SECRET: optionalSecret,
  SPORTSDATAIO_API_KEY: optionalSecret, STATSHAWK_API_KEY: optionalSecret, SPORTRADAR_API_KEY: optionalSecret,
  POSTHOG_KEY: optionalSecret, POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
  USE_PREDICTIVE_CORE: z.enum(["true", "false"]).optional(),
});

/** Never include raw input or Zod issue values in errors/logs. */
export function serverEnv(input: Record<string, string | undefined> = process.env) {
  const result = envSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return result.data;
}
