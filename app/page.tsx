import type { Metadata } from "next";
import { DealBoard } from "./components/deal-board";

export const metadata: Metadata = {
  title: "Deal Board",
  description:
    "Active official GSA vehicle auctions organized by source freshness, valuation evidence, risk, and available bid headroom.",
};

export default function Home() {
  return <DealBoard />;
}
