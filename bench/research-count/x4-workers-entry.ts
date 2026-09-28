/** workerd entry for the X4 micro-benchmark: POST /prepare {items, scope}; GET /<op> runs one op and reports in-worker time. */
import { prepare, ops } from './x4-workers-ops.js';
export default {
  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.slice(1);
    try {
      if (op === 'prepare') { const b = await req.json() as any; return Response.json(await prepare(b.items, b.scope)); }
      const f = ops[op]; if (!f) return new Response('no op', { status: 404 });
      const t0 = performance.now(), d0 = Date.now(); const n = await f(); const t1 = performance.now(), d1 = Date.now();
      return Response.json({ n, inWorkerPerfMs: t1 - t0, inWorkerDateMs: d1 - d0 });
    } catch (e: any) { return new Response(String(e?.stack ?? e), { status: 500 }); }
  },
};
