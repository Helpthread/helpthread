/**
 * `/api/**` — the engine, mounted. See `src/engine/mount.ts`. Node runtime
 * (the engine needs `node:crypto`); never statically rendered; the same
 * duration ceiling the split deployment gave `api/index.ts`.
 */

import { handleEngineRequest as handler } from '@/engine/mount'

export const dynamic = 'force-dynamic'
export const maxDuration = 50

export {
  handler as DELETE,
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as PATCH,
  handler as POST,
  handler as PUT,
}
