// READ-ONLY Supabase schema audit. No writes, no DDL. Reads PostgREST OpenAPI
// (lists every exposed table + its columns) and does targeted count reads.
// Run: node schema_audit.mjs   (reads keys from .env.local)
import { readFileSync, writeFileSync } from "node:fs";

function loadEnv() {
  const txt = readFileSync(new URL("./.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY; // service role: bypasses RLS for a true read
const out = [];
const log = (s = "") => out.push(s);

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function main() {
  log(`URL_BASE=${URL_BASE ? URL_BASE : "(MISSING)"}`);
  log(`KEY present=${KEY ? "yes" : "NO"} len=${KEY ? KEY.length : 0}`);

  // 1) OpenAPI root: enumerates tables (definitions) + columns + types + nullability.
  const root = await fetch(`${URL_BASE}/rest/v1/`, { headers });
  log(`OpenAPI root HTTP ${root.status}`);
  const spec = await root.json();
  const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
  const tableNames = Object.keys(defs).sort();

  log("\n===== TABLES (public, PostgREST-exposed) =====");
  log(`count: ${tableNames.length}`);
  for (const t of tableNames) log(t);

  log("\n===== COLUMNS (table | column | type | nullable) =====");
  for (const t of tableNames) {
    const def = defs[t];
    const props = def.properties || {};
    const required = new Set(def.required || []);
    log(`\n-- ${t} --`);
    for (const [col, meta] of Object.entries(props)) {
      // PostgREST encodes the real Postgres type in meta.format; meta.description carries PK/FK notes.
      const type = meta.format || meta.type || "?";
      const nullable = required.has(col) ? "NO" : "YES";
      const note = meta.description ? `  [${meta.description.replace(/\s+/g, " ").trim()}]` : "";
      log(`${t} | ${col} | ${type} | ${nullable}${note}`);
    }
  }

  // 2) Existence probe for specifically-named tables.
  const probe = ["provinces","districts","licenses","ho_access_scopes","elder_assignments","uam_reviews","audit_logs","audit_log","hierarchy_levels","congregations","officers","profiles","users","cashbook_period","cashbook_service","cashbook_line_item","cashbook_attachment","user_hierarchy_access","ho_district_assignments","user_congregation_assignments","congregation_settings"];
  log("\n===== EXISTENCE PROBE =====");
  for (const t of probe) {
    log(`${t}: ${tableNames.includes(t) ? "PRESENT" : "absent"}`);
  }

  // helper: count via Content-Range header (HEAD, count=exact), zero rows transferred
  async function count(t) {
    const r = await fetch(`${URL_BASE}/rest/v1/${t}?select=*`, {
      method: "HEAD",
      headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    });
    if (!r.ok && r.status !== 206 && r.status !== 200) return `ERR ${r.status}`;
    const cr = r.headers.get("content-range"); // e.g. 0-0/123  or  */123
    return cr ? cr.split("/")[1] : "?";
  }

  log("\n===== COUNTS =====");
  if (tableNames.includes("congregations")) log(`total_congregations: ${await count("congregations")}`);
  if (tableNames.includes("officers")) log(`total_officers: ${await count("officers")}`);
  if (tableNames.includes("hierarchy_levels")) log(`total_hierarchy_levels: ${await count("hierarchy_levels")}`);

  // 3) hierarchy_levels grouping by level_type/level (read rows, group in JS)
  if (tableNames.includes("hierarchy_levels")) {
    const r = await fetch(`${URL_BASE}/rest/v1/hierarchy_levels?select=level_type,level`, { headers });
    log("\n===== hierarchy_levels GROUP BY level_type, level =====");
    if (r.ok) {
      const rows = await r.json();
      const g = {};
      for (const row of rows) {
        const k = `${row.level_type} | level=${row.level}`;
        g[k] = (g[k] || 0) + 1;
      }
      for (const k of Object.keys(g).sort()) log(`${k} | count=${g[k]}`);
    } else {
      log(`read failed HTTP ${r.status}: ${await r.text()}`);
    }
  }

  writeFileSync(new URL("./schema_audit_out.txt", import.meta.url), out.join("\n"), "utf8");
  console.log("WROTE schema_audit_out.txt");
}

main().catch((e) => {
  const cause = e && e.cause ? `\nCAUSE: ${e.cause.code || ""} ${e.cause.message || e.cause}` : "";
  writeFileSync(new URL("./schema_audit_out.txt", import.meta.url), out.join("\n") + "\n\nFATAL: " + (e?.stack || e) + cause, "utf8");
  console.log("ERROR; see schema_audit_out.txt");
});
