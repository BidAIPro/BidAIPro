import type { Metadata } from "next";
import { ComparableLedger } from "./comparable-ledger";

export const metadata: Metadata = {
  title: "Comparable Ledger",
  description: "Observed GSA vehicle closed-high-bid evidence with award status kept explicit.",
};

export default function ComparableLedgerPage() {
  return <ComparableLedger />;
}
