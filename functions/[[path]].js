// Cloudflare Pages Function: all /v1/* API calls and /r/* tracking redirects. Static files are served by Pages itself.
import { handle } from '../src/app.js';
import { makeCtx } from '../src/ctx.js';
import { d1Db } from '../src/db.js';
import { adaptersFromEnv } from '../src/adapters.js';

export async function onRequest({ request, env }) {
  const ctx = makeCtx({ db: d1Db(env.DB), env, ...adaptersFromEnv(env, fetch) });
  return handle(ctx, request);
}
