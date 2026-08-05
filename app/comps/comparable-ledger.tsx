"use client";

import { ArrowLeft, Database, ExternalLink, Gauge, MapPin, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApiUrl } from "../../lib/public-api";

interface ComparableRow {
  id: string;
  canonical_url: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  mileage: number | null;
  condition: string | null;
  state: string | null;
  closed_high_bid_cents: number;
  awarded_price_cents: number | null;
  award_status: string;
  outcome_status: string;
  ended_at: string;
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function ComparableLedger() {
  const [rows, setRows] = useState<ComparableRow[]>([]);
  const [status, setStatus] = useState<"loading" | "available" | "unavailable">("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(publicApiUrl("/api/comps"), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Comparable ledger request failed");
        return response.json() as Promise<{ data?: ComparableRow[]; meta?: { status?: string } }>;
      })
      .then((payload) => {
        setRows(Array.isArray(payload.data) ? payload.data : []);
        setStatus(payload.meta?.status === "available" ? "available" : "unavailable");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus("unavailable");
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="ledger-page">
      <header className="ledger-topbar">
        <Link href="/" className="ledger-back"><ArrowLeft size={16} /> Deal board</Link>
        <div className="brand-lockup ledger-brand"><div className="brand-mark"><Database size={19} /></div><div><strong>BIDAI</strong><span>PRO</span><small>Comparable outcome ledger</small></div></div>
        <span className={`ledger-health ${status}`}>{status === "loading" ? "Checking ledger" : status === "available" ? "D1 ledger online" : "Ledger unavailable"}</span>
      </header>

      <div className="ledger-wrap">
        <section className="ledger-hero">
          <p className="eyebrow"><span /> Outcome evidence</p>
          <h1>Comparable ledger</h1>
          <p>Closed GSA observations collected by this installation, with high bids kept separate from authoritative awarded prices.</p>
          <div className="ledger-guardrail"><ShieldCheck size={18} /><span><strong>Semantics matter</strong> A closed high bid is not proof that the reserve was met, payment cleared, or an award occurred.</span></div>
        </section>

        <section className="ledger-panel">
          <div className="ledger-panel-head"><div><span>Observed outcomes</span><strong>{rows.length} records</strong></div><p>Newest first · up to 100</p></div>
          {rows.length > 0 ? (
            <div className="ledger-table-wrap">
              <table className="ledger-table">
                <thead><tr><th>Vehicle</th><th>Mileage</th><th>Location</th><th>Closed high bid</th><th>Awarded price</th><th>Outcome</th><th>Ended</th><th /></tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.year} {row.make} {row.model}</strong><span>{row.trim ?? row.condition ?? "Details pending"}</span></td>
                    <td><span className="ledger-icon-value"><Gauge size={13} />{row.mileage === null ? "Unknown" : `${integer.format(row.mileage)} mi`}</span></td>
                    <td><span className="ledger-icon-value"><MapPin size={13} />{row.state ?? "Unknown"}</span></td>
                    <td><strong>{money.format(row.closed_high_bid_cents / 100)}</strong></td>
                    <td>{row.awarded_price_cents === null ? <em>Unconfirmed</em> : <strong>{money.format(row.awarded_price_cents / 100)}</strong>}</td>
                    <td><span className="ledger-status">{row.outcome_status.replaceAll("-", " ")}</span></td>
                    <td>{new Date(row.ended_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td>{row.canonical_url ? <a href={row.canonical_url} target="_blank" rel="noreferrer" aria-label="Open official record"><ExternalLink size={15} /></a> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <div className="ledger-empty"><Database size={30} /><h2>{status === "loading" ? "Loading outcome evidence" : "No observed outcomes yet"}</h2><p>The ledger begins populating after this installation tracks a lot through two confirmed post-close catalog misses. Historical bulk backfill is not active.</p></div>
          )}
        </section>
      </div>
    </main>
  );
}
