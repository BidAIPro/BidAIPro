import { Suspense } from "react";
import { LiveVehicleDetail } from "../components/live-vehicle-detail";

export const dynamic = "force-static";

export default function VehiclePage() {
  return (
    <Suspense fallback={<main className="detail-shell"><div className="live-detail-state"><span className="live-detail-spinner" /><h1>Loading vehicle analysis</h1><p>Retrieving the latest GSA listing snapshot…</p></div></main>}>
      <LiveVehicleDetail />
    </Suspense>
  );
}
