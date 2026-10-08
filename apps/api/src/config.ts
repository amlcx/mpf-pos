import * as v from 'valibot';

const EnvSchema = v.object({
  DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
  SESSION_SECRET: v.pipe(v.string(), v.minLength(16)),
  PORT: v.pipe(v.optional(v.string(), '8787'), v.transform(Number), v.integer()),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = v.safeParse(EnvSchema, env);
  if (!result.success) {
    const fields = result.issues.map((i) => `${v.getDotPath(i)}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment:\n  ${fields}`);
  }
  return result.output;
}
