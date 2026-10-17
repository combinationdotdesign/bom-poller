// Polls OpenSky around Mumbai (VABB), saves a snapshot, and records runway arrivals/departures.
// Credit use: bounding box <= 25 sq deg = 1 credit per call. One call per ~30 s = ~2,900/day (free account: 4,000/day).
import { createClient } from "npm:@supabase/supabase-js@2";

const ID = Deno.env.get("OPENSKY_CLIENT_ID"), SEC = Deno.env.get("OPENSKY_CLIENT_SECRET");
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const BOX = { lamin: 17.09, lamax: 21.09, lomin: 70.87, lomax: 74.87 }; // 4 x 4 deg around VABB = 16 sq deg (1 credit)
const TICK = 30000, MIN_GAP = 28000, ANON_GAP = 240000, RUN_MS = 20000000, AUTH_TIMEOUT = 15000, STATES_TIMEOUT = 25000;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// VABB runways (OurAirports): [low end, high end, threshold A, threshold B]
const RW: [string, string, number[], number[]][] = [
  ["09", "27", [19.0884, 72.848], [19.0889, 72.881104]],
  ["14", "32", [19.098499, 72.8573], [19.080099, 72.877197]],
];
const KX = 111320 * Math.cos(19.09 * Math.PI / 180), KZ = 110574;
const P = (la: number, lo: number) => [(lo - 72.8672) * KX, -(la - 19.0906) * KZ];
const rwy = RW.map(([le, he, a, b]) => {
  const A = P(a[0], a[1]), B = P(b[0], b[1]), dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz);
  return { le, he, A, L, ux: dx / L, uz: dz / L, hdg: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360 };
});
const angD = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
// Polls are ~30 s apart, so allow a wide window past the runway for departures.
function runwayAt(lat: number, lon: number, trk: number, landing: boolean): string {
  const [x, z] = P(lat, lon);
  for (const r of rwy) {
    const rx = x - r.A[0], rz = z - r.A[1], s = rx * r.ux + rz * r.uz, c = -rx * r.uz + rz * r.ux;
    const fwd = angD(trk, r.hdg) < 25, bwd = angD(trk, r.hdg + 180) < 25;
    if ((!fwd && !bwd) || Math.abs(c) > (landing ? 300 : 700)) continue;
    if (s > -400 && s < r.L + (landing ? 400 : 6000)) return fwd ? r.le : r.he;
  }
  return "";
}

let token = "", tokExp = 0, blockedUntil = 0, authBlockedUntil = 0, loaded = false;
const state = new Map<string, boolean>();
let tickNo = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  if (token && Date.now() < tokExp) return token;
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: ID!, client_secret: SEC! }), signal: AbortSignal.timeout(AUTH_TIMEOUT) }).catch((e) => { throw new Error("OpenSky LOGIN step failed: " + e.name + " (" + (e.message ?? e) + ")"); });
  if (!r.ok) throw new Error("OpenSky login HTTP " + r.status + " (check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET)");
  const j = await r.json(); token = j.access_token; tokExp = Date.now() + (j.expires_in ?? 1800) * 1000 - 60000;
  await sb.from("bom_kv").upsert({ key: "opensky_token_bom", value: { token, exp: tokExp } });
  return token;
}

async function tick() {
  if (Date.now() < blockedUntil) return { skipped: "rate limited until " + new Date(blockedUntil).toISOString() };
  // Try to log in. If login keeps failing, fall back to anonymous access (400 credits/day, so poll slowly).
  let headers: Record<string, string> = {}, mode = "login", note = "";
  if (Date.now() >= authBlockedUntil) {
    try { headers = { Authorization: "Bearer " + await getToken() }; }
    catch (e) { authBlockedUntil = Date.now() + 300000; note = String(e); }
  }
  if (!headers.Authorization) mode = "anonymous";
  // Credit guard: never poll more often than the gap, no matter who calls the function.
  const { data: snap } = await sb.from("bom_snapshot").select("ts").eq("id", 1).single();
  if (snap && Date.now() - Date.parse(snap.ts) < (mode === "login" ? MIN_GAP : ANON_GAP)) return { skipped: "fresh", mode, note };

  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(BOX).map(([k, v]) => [k, String(v)])), extended: "1" });
  const res = await fetch("https://opensky-network.org/api/states/all?" + q, { headers, signal: AbortSignal.timeout(STATES_TIMEOUT) }).catch((e) => { throw new Error("OpenSky DATA step failed: " + e.name + " (" + (e.message ?? e) + ")"); });
  if (res.status === 401) { token = ""; tokExp = 0; throw new Error("OpenSky 401 (token refreshed, retrying next tick)"); }
  if (res.status === 429) { const w = Number(res.headers.get("x-rate-limit-retry-after-seconds")) || 300; blockedUntil = Date.now() + w * 1000; throw new Error("OpenSky 429: out of credits, waiting " + w + " s"); }
  if (!res.ok) throw new Error("OpenSky HTTP " + res.status);
  const j = await res.json(), nowMs = Date.now(), now = new Date(nowMs);
  const ac: any[] = [];
  for (const s of j.states ?? []) {
    const lat = s[6], lon = s[5], ground = s[8] === true, altM = s[7] ?? s[13];
    if (!s[0] || lat == null || lon == null || (!ground && altM == null)) continue;
    ac.push({
      hex: s[0], flight: (s[1] ?? "").trim() || undefined, alt_baro: ground ? "ground" : Math.round(altM * 3.28084),
      gs: s[9] != null ? Math.round(s[9] * 1.94384) : 0, track: s[10] ?? undefined,
      baro_rate: s[11] != null ? Math.round(s[11] * 196.85) : 0, squawk: s[14] ?? undefined, emergency: "none",
      lat, lon, seen: Math.max(0, nowMs / 1000 - (s[4] ?? nowMs / 1000)),
    });
  }
  const moves: any[] = [], states: any[] = [];
  for (const a of ac) {
    const ground = a.alt_baro === "ground", prev = state.get(a.hex);
    if (prev !== undefined && prev !== ground && a.track != null) {
      const id = runwayAt(a.lat, a.lon, a.track, ground);
      if (id) moves.push({ ts: now.toISOString(), type: ground ? "ARR" : "DEP", rwy: id, callsign: a.flight ?? null, hex: a.hex });
    }
    state.set(a.hex, ground);
    states.push({ hex: a.hex, ground, lat: a.lat, lon: a.lon, seen: now.toISOString() });
  }
  const present = new Set(ac.map((a) => a.hex));
  for (const h of state.keys()) if (!present.has(h) && Math.random() < 0.05) state.delete(h);
  // Flight history for the approach graphs: one point per aircraft with a callsign within ~280 km (150 nm).
  const trk = ac.filter((a) => a.flight).filter((a) => { const [x, z] = P(a.lat, a.lon); return Math.hypot(x, z) < 278000; }).map((a) => ({
    ts: now.toISOString(), hex: a.hex, callsign: a.flight, lat: a.lat, lon: a.lon, alt: a.alt_baro === "ground" ? 0 : a.alt_baro,
    gs: a.gs, vs: a.baro_rate, trk: a.track != null ? Math.round(a.track) : null, ground: a.alt_baro === "ground",
  }));
  if (++tickNo % 40 === 0) sb.from("bom_track_points").delete().lt("ts", new Date(Date.now() - 8 * 3600e3).toISOString()).then(() => {}, () => {}); // keep 8 hours
  const results = await Promise.all([
    trk.length ? sb.from("bom_track_points").upsert(trk, { onConflict: "hex,ts", ignoreDuplicates: true }) : null,
    sb.from("bom_snapshot").update({ ts: now.toISOString(), ac }).eq("id", 1),
    states.length ? sb.from("bom_ac_state").upsert(states) : null,
    moves.length ? sb.from("bom_movements").upsert(moves, { onConflict: "hex,type,ts", ignoreDuplicates: true }) : null,
  ]);
  const dbErr = results.find((r: any) => r?.error)?.error;
  if (dbErr) throw new Error("database: " + dbErr.message);
  return { mode, note, aircraft: ac.length, movements: moves.length, creditsLeft: res.headers.get("x-rate-limit-remaining") };
}

async function main() {
  if (!ID || !SEC) throw new Error("OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET are not set");
  const { data: kv } = await sb.from("bom_kv").select("value").eq("key", "opensky_token_bom").maybeSingle();
  if (kv?.value?.exp > Date.now() + 120000) { token = kv.value.token; tokExp = kv.value.exp; }
  const { data } = await sb.from("bom_ac_state").select("hex,ground").gt("seen", new Date(Date.now() - 180000).toISOString());
  data?.forEach((r) => state.set(r.hex, r.ground)); loaded = true;
  const end = Date.now() + RUN_MS;
  while (true) {
    const t0 = Date.now();
    try { console.log(new Date().toISOString(), JSON.stringify(await tick())); } catch (e) { console.log("error", String(e)); }
    const wait = Math.max(0, TICK - (Date.now() - t0));
    if (Date.now() + wait >= end) break;
    await sleep(wait);
  }
}
await main();
