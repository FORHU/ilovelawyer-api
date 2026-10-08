import type { Router } from "express";

export interface RouteEntry {
  method: string;
  path: string;
}

/** Express 4 keeps a mounted router's prefix only as a regexp — "/auth" is stored as
 * ^\/auth\/?(?=\/|$). Turns that back into the path. Every mount in src/routes/index.ts is a
 * plain prefix, so nothing fancier is needed. */
function mountPath(regexp: RegExp): string {
  let source = regexp.source;
  if (source.startsWith("^")) source = source.slice(1);
  const tail = "\\/?(?=\\/|$)";
  if (source.endsWith(tail)) source = source.slice(0, -tail.length);
  return source.split("\\/").join("/");
}

/** Every route reachable through `router`, with Express's own :param names. */
export function listRoutes(router: Router, prefix = ""): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const layer of (router as any).stack) {
    if (layer.route) {
      const paths: string[] = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        for (const path of paths) out.push({ method: method.toUpperCase(), path: `${prefix}${path}` });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      out.push(...listRoutes(layer.handle, `${prefix}${mountPath(layer.regexp)}`));
    }
  }
  return out;
}
