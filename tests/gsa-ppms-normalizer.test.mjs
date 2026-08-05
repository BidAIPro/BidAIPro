import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePpmsVehicleAuction,
  parsePpmsCentralDate,
  ppmsImageAttachments,
} from "../lib/gsa-ppms-normalizer.ts";
import {
  fetchPpmsVehicleAuctions,
  PpmsClientError,
} from "../lib/gsa-ppms-client.ts";

test("normalizes offset-less PPMS auction times as America/Chicago across DST", () => {
  assert.equal(parsePpmsCentralDate("2026-08-05T10:21:00"), "2026-08-05T15:21:00.000Z");
  assert.equal(parsePpmsCentralDate("2026-01-05T10:21:00"), "2026-01-05T16:21:00.000Z");
  assert.equal(parsePpmsCentralDate("2026-08-05T10:21:00-05:00"), "2026-08-05T15:21:00.000Z");
});

test("prefers structured mileage but preserves conflicts, condition evidence, damage, and official images", () => {
  const catalog = {
    lotId: 391952,
    auctionId: 365000,
    lotNumber: 2,
    salesNumber: "TEST26001",
    status: "Active",
    startDate: "2026-08-01T10:00:00",
    endDate: "2026-08-10T10:00:00",
    lotName: "2018 Ford F-150 Pickup Truck",
    currentBid: 10_100,
    numberOfBidders: 6,
    location: { city: "Dallas", state: "TX", zipCode: "75201" },
  };
  const detail = {
    propertyLocation: {
      addressLine1: "Federal Fleet Yard",
      city: "Dallas",
      state: "TX",
      zipCode: "75201",
    },
    sellingAgency: "GSA",
    lotAgencyBureau: "4700",
    imagesAndDocs: {
      image: [
        { id: 2, uri: "sales/test/2.jpg", name: "side.jpg", attachmentOrder: 2, valid: true },
        { id: 1, uri: "sales/test/1.jpg", name: "front.jpg", attachmentOrder: 1, valid: true },
        { id: 3, uri: "sales/test/3.jpg", name: "bad.jpg", attachmentOrder: 3, valid: false },
      ],
    },
    biddingDetailsDTO: { templateCodes: { bidIncrement: 100, inactiveTime: 10 } },
    auctionDescriptionDTO: {
      make: "FORD MOTOR CO",
      model: "F150",
      odometer: "78781",
      conditionCode: "U",
      itemDescription: `
        <h4>Specifications</h4>
        <ul>
          <li>Model Year: 2018</li><li>Transmission Type: Automatic</li>
          <li>No of Cylinders: 6</li><li>Fuel Type: Gasoline</li>
          <li>Body Style: Pickup Truck</li><li>Mileage: 79,401</li>
          <li>Color: White</li><li>Open Recall: Yes</li>
          <li>VIN: 1FTEW1EG0JFA12345</li>
        </ul>
        <h4>Condition &amp; Markings</h4>
        <ul><li>Body has dents and rust.</li><li>Vehicle does not start; battery is dead.</li></ul>`,
    },
  };

  assert.deepEqual(ppmsImageAttachments(detail).map((image) => image.id), ["1", "2"]);
  const auction = normalizePpmsVehicleAuction(
    catalog,
    detail,
    ["https://example.s3.amazonaws.com/front.jpg", "https://example.s3.amazonaws.com/side.jpg"],
    new Date("2026-08-05T12:00:00.000Z"),
  );
  assert.equal(auction.id, "gsa:ppms:365000");
  assert.equal(auction.endsAt, "2026-08-10T15:00:00.000Z");
  assert.equal(auction.mileage, 78_781);
  assert.equal(auction.odometerStatus, "conflicting-readings");
  assert.match(auction.conditionNotes[0], /78,781.*79,401/i);
  assert.equal(auction.vin, "1FTEW1EG0JFA12345");
  assert.equal(auction.condition, "usable");
  assert.equal(auction.operability, "non-operational");
  assert.equal(auction.transmission, "Automatic");
  assert.equal(auction.fuelType, "Gasoline");
  assert.equal(auction.cylinders, 6);
  assert.equal(auction.openRecall, true);
  assert.ok(auction.damageFlags.includes("body-damage"));
  assert.ok(auction.damageFlags.includes("rust-or-corrosion"));
  assert.ok(auction.issueFlags.includes("odometer-conflict"));
  assert.ok(auction.issueFlags.includes("non-operational"));
  assert.ok(auction.issueFlags.includes("battery-issue"));
  assert.equal(auction.images.length, 2);
  assert.equal(auction.detailEnriched, true);
});

test("rejects a catalog snapshot when every lot detail request fails", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api/v1/auctions")) {
      return Response.json({
        totalPages: 1,
        totalElements: 1,
        auctionDTOList: [{
          lotId: 391952,
          auctionId: 365000,
          lotNumber: 2,
          salesNumber: "TEST26001",
          status: "Active",
          endDate: "2026-08-10T10:00:00",
          lotName: "2018 Ford F-150 Pickup Truck",
        }],
      });
    }
    return new Response(null, { status: 503 });
  };

  await assert.rejects(
    fetchPpmsVehicleAuctions(
      fetchImpl,
      new Date("2026-08-05T12:00:00.000Z"),
      new AbortController().signal,
    ),
    (error) => error instanceof PpmsClientError && error.code === "GSA_PPMS_DETAILS_UNAVAILABLE",
  );
});
