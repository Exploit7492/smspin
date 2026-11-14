// Vercel domain provisioning for white-label tenants.
//
// A store owner can point their own domain at the product host. That requires
// two things the static build cannot do: registering the host on the Vercel
// project (so requests for it are routed to this deployment) and telling the
// owner which DNS record to publish. Both happen here, server-side, with a
// scoped Vercel token that only ever lives in the Edge Function environment —
// never in the database or the browser.
//
// When no custom domain is given, a store gets a free host on the shared
// Vercel domain: `<slug>-<project>.vercel.app`. Vercel owns that zone, so it
// verifies instantly and needs no DNS work from the owner.
const TOKEN = Deno.env.get("VERCEL_TOKEN") || "";
const PROJECT = Deno.env.get("VERCEL_PROJECT_ID") || "";
const TEAM = Deno.env.get("VERCEL_TEAM_ID") || "";
const PROJECT_NAME = Deno.env.get("VERCEL_PROJECT_NAME") || "smspin";

export function vercelConfigured(): boolean {
  return Boolean(TOKEN && PROJECT);
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com${path}${TEAM ? `${sep}teamId=${encodeURIComponent(TEAM)}` : ""}`;
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export type DnsRecord = { type: string; name: string; value: string };

export type ProvisionResult = {
  ok: boolean;
  verified: boolean;
  status: string;
  verification: DnsRecord[] | null;
  error?: string;
};

// The DNS record(s) the owner must publish. Vercel returns TXT challenges while
// a domain is unverified and, once it owns the zone, nothing (A/CNAME are
// inferred). We surface a CNAME to the product host as the primary instruction.
function recordsFromVerification(v: unknown): DnsRecord[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    return { type: String(o.type || "TXT"), name: String(o.domain || ""), value: String(o.value || "") };
  });
}

export async function addDomain(domain: string): Promise<ProvisionResult> {
  const r = await api(`/v10/projects/${PROJECT}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const err = (data.error as Record<string, unknown>)?.message || data.error || "could not register domain";
    return { ok: false, verified: false, status: "error", verification: null, error: String(err) };
  }
  const verified = data.verified === true;
  return {
    ok: true, verified,
    status: verified ? "active" : "pending",
    verification: recordsFromVerification(data.verification),
  };
}

export async function domainStatus(domain: string): Promise<ProvisionResult> {
  const r = await api(`/v9/projects/${PROJECT}/domains/${encodeURIComponent(domain)}`);
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    return { ok: false, verified: false, status: "error", verification: null,
      error: String((data.error as Record<string, unknown>)?.message || "domain not found") };
  }
  const verified = data.verified === true;
  return {
    ok: true, verified,
    status: verified ? "active" : "pending",
    verification: recordsFromVerification(data.verification),
  };
}

export async function removeDomain(domain: string): Promise<boolean> {
  const r = await api(`/v9/projects/${PROJECT}/domains/${encodeURIComponent(domain)}`, { method: "DELETE" });
  return r.ok;
}

// The DNS record an owner publishes to point a custom domain here.
export function dnsInstructions(domain: string): DnsRecord[] {
  const apex = domain.split(".").length === 2;
  return apex
    ? [{ type: "A", name: "@", value: "76.76.21.21" }]
    : [{ type: "CNAME", name: domain.split(".")[0], value: "cname.vercel-dns.com" }];
}

// A store's free host on the shared Vercel zone, e.g. zenith-verify-smspin.vercel.app.
export function managedHost(slug: string): string {
  return `${slug}-${PROJECT_NAME}.vercel.app`;
}
