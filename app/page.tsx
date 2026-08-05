import type { Metadata } from "next";
import { DealBoard } from "./components/deal-board";

export const metadata: Metadata = {
  title: "Deal Board",
  description:
    "Active official GSA vehicle auctions ranked by projected value, risk, and bid headroom.",
};

export default function Home() {
  return <DealBoard />;
}
