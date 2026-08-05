import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGsaPayload,
  sanitizeHtmlToText,
} from "../lib/gsa-normalizer.ts";

const OBSERVED_AT = new Date("2026-08-04T12:00:00.000Z");

test("normalizes a GSA vehicle lot without leaking source HTML", () => {
  const normalized = normalizeGsaPayload(
    {
      results: [
        {
          SaleNo: "41QSCI-26-001",
          LotNo: "0001",
          AucStartDt: "2026-08-01T14:00:00Z",
          AucEndDt: "2026-08-08T14:30:00Z",
          ItemName: "<b>2016 Chevrolet Tahoe LS 4WD</b>",
          AuctionStatus: "A",
          BiddersCount: "7",
          HighBidAmount: "$10,125.50",
          AucIncrement: "100",
          Reserve: "0",
          InactivityTime: "5",
          LotInfo: [
            {
              LotSequence: "1",
              LotDescript:
                "<p>Sport utility vehicle. VIN: <strong>1GNSKAECXGR377492</strong>. Mileage: 59,129.</p><script>steal()</script>",
            },
          ],
          Instruction1: "Government owned &amp; maintained.",
          Instruction2: "&lt;script&gt;alsoBad()&lt;/script&gt;",
          ItemDescURL: "http://gsaauctions.gov/auctions/preview/41QSCI-26-001/0001#lot",
          ImageURL:
            "http://images.gsa.gov/tahoe.jpg#hero | https://images.gsa.gov/tahoe-side.jpg",
          PropertyAddr1: "123 Fleet Way",
          PropertyCity: "Chicago",
          PropertyState: "IL",
          PropertyZip: "60601",
          AgencyCode: "GSA",
          AgencyName: "General Services Administration",
        },
      ],
    },
    OBSERVED_AT,
  );

  assert.equal(normalized.observedAt, OBSERVED_AT.toISOString());
  assert.equal(normalized.auctions.length, 1);
  const [auction] = normalized.auctions;

  assert.equal(auction.id, "gsa:41qsci-26-001:0001");
  assert.equal(auction.title, "2016 Chevrolet Tahoe LS 4WD");
  assert.equal(auction.vin, "1GNSKAECXGR377492");
  assert.equal(auction.mileage, 59_129);
  assert.equal(auction.bodyType, "suv");
  assert.equal(auction.year, 2016);
  assert.equal(auction.make, "Chevrolet");
  assert.equal(auction.status, "active");
  assert.equal(auction.currentBid, 10_125.5);
  assert.equal(auction.bidderCount, 7);
  assert.equal(auction.bidIncrement, 100);
  assert.equal(auction.reserve, 0);
  assert.equal(auction.inactivityMinutes, 5);
  assert.equal(auction.startsAt, "2026-08-01T14:00:00.000Z");
  assert.equal(auction.endsAt, "2026-08-08T14:30:00.000Z");
  assert.equal(
    auction.url,
    "https://gsaauctions.gov/auctions/preview/41QSCI-26-001/0001",
  );
  assert.deepEqual(auction.images, [
    "https://images.gsa.gov/tahoe.jpg",
    "https://images.gsa.gov/tahoe-side.jpg",
  ]);
  assert.equal(auction.imageUrl, "https://images.gsa.gov/tahoe.jpg");
  assert.deepEqual(auction.location.addressLines, ["123 Fleet Way"]);
  assert.equal(auction.location.state, "IL");
  assert.match(auction.description, /Government owned & maintained\./);
  assert.doesNotMatch(auction.description, /<[^>]+>|steal|alsoBad/i);

  assert.deepEqual(normalized.coverage, {
    totalLots: 1,
    vehicleLots: 1,
    excludedLots: 0,
    withVin: 1,
    withMileage: 1,
    withBodyType: 1,
    withImage: 1,
    withCurrentBid: 1,
    statusCounts: { active: 1, preview: 0, scheduled: 0, unknown: 0 },
    exclusionCounts: {},
  });
});

test("rejects vehicle-adjacent false positives even when they contain VIN or mileage evidence", () => {
  const normalized = normalizeGsaPayload(
    {
      Results: [
        {
          ItemName: "Truck tires and wheels",
          LotInfo: [{ LotDescript: "Removed from VIN 1GNSKAECXGR377492" }],
        },
        {
          ItemName: "Vehicle lift and shop equipment",
          LotInfo: [{ LotDescript: "Used for vehicles with 59,129 miles" }],
        },
        {
          ItemName: "2018 utility trailer",
          LotInfo: [{ LotDescript: "VIN: 1M9BU1628JM123456" }],
        },
        {
          ItemName: "John Deere tractor",
          LotInfo: [{ LotDescript: "Odometer: 500" }],
        },
        {
          ItemName: "Forklift truck",
          LotInfo: [{ LotDescript: "Mileage: 1200" }],
        },
        {
          ItemName: "Automotive engine and transmission parts",
          LotInfo: [{ LotDescript: "VIN 1GNSKAECXGR377492" }],
        },
      ],
    },
    OBSERVED_AT,
  );

  assert.equal(normalized.auctions.length, 0);
  assert.equal(normalized.coverage.totalLots, 6);
  assert.equal(normalized.coverage.excludedLots, 6);
  assert.deepEqual(normalized.coverage.exclusionCounts, {
    "parts-or-accessories": 3,
    trailer: 1,
    "heavy-equipment": 1,
    "material-handling-equipment": 1,
  });
});

test("accepts a clearly titled road vehicle and tolerates case-varied feed fields", () => {
  const normalized = normalizeGsaPayload(
    {
      data: {
        items: [
          {
            saleNo: "SALE 9",
            lotNo: "LOT 2",
            itemName: "2019 Ford F-350 Pickup Truck",
            auctionStatus: "Preview",
            highBidAmount: "2,500",
            lotInfo: [{ lotSequence: "02", lotDescript: "Fleet unit &amp; runs." }],
            images: [{ url: "http://example.gov/truck.jpg#main" }],
            itemDescUrl: "javascript:alert(1)",
          },
        ],
      },
    },
    OBSERVED_AT,
  );

  assert.equal(normalized.auctions.length, 1);
  const [auction] = normalized.auctions;
  assert.equal(auction.id, "gsa:sale-9:lot-2");
  assert.equal(auction.bodyType, "pickup");
  assert.equal(auction.year, 2019);
  assert.equal(auction.make, "Ford");
  assert.equal(auction.status, "preview");
  assert.equal(auction.currentBid, 2500);
  assert.equal(auction.url, "https://gsaauctions.gov/auctions/home");
  assert.deepEqual(auction.images, ["https://example.gov/truck.jpg"]);
  assert.equal(auction.description, "Fleet unit & runs.");
});

test("plain-text sanitizer removes executable blocks and decodes entities", () => {
  assert.equal(
    sanitizeHtmlToText(
      "<p>Clean&nbsp;text &#38; more.</p><style>body{display:none}</style>&lt;script&gt;bad()&lt;/script&gt;",
    ),
    "Clean text & more.",
  );
});

test("rejects malformed payload collections", () => {
  assert.throws(
    () => normalizeGsaPayload({ unexpected: true }, OBSERVED_AT),
    /recognized auction collection/i,
  );
});
