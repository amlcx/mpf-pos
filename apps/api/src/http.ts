import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import * as v from 'valibot';

/** Ends the request with `{ error, ...extra }`. */
export function fail(status: ContentfulStatusCode, error: string, extra: object = {}): never {
  throw new HTTPException(status, { res: Response.json({ error, ...extra }, { status }) });
}

export function parse<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, input);
  if (!result.success) {
    fail(400, 'invalid_request', {
      issues: result.issues.map((i) => ({ path: v.getDotPath(i), message: i.message })),
    });
  }
  return result.output;
}

export async function body<S extends v.GenericSchema>(c: Context, schema: S): Promise<v.InferOutput<S>> {
  return parse(schema, await c.req.json().catch(() => undefined));
}

const IdParam = v.pipe(v.string(), v.uuid());
/** A uuid path parameter; anything else is simply not found. */
export function idParam(c: Context, name = 'id'): string {
  const result = v.safeParse(IdParam, c.req.param(name));
  if (!result.success) fail(404, 'not_found');
  return result.output;
}
