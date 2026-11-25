// Cloudflare Pages Function: all /v1/* API calls and /r/* tracking redirects. Static files are served by Pages itself.
import { handle, errorResponse } from '../src/app.js';
import { makeCtx } from '../src/ctx.js';
import { d1Db } from '../src/db.js';
import { adaptersFromEnv } from '../src/adapters.js';
import { enginesFromEnv } from '../src/engines.js';

export async function onRequest({ request, env }) {
  let ctx;
  try {
    ctx = makeCtx({ db: d1Db(env.DB), env, ...adaptersFromEnv(env, fetch), engines: enginesFromEnv(env, fetch) });
  } catch (e) {
    return errorResponse(e); // a bad PAYOUT_MODE / key pairing answers with a clear JSON error instead of an HTML crash page
  }
  return handle(ctx, request);
}
