import assert from "node:assert/strict";
import test from "node:test";

process.env.BIDAI_PUBLIC_MARKETS_TEST = "true";
const { proxibidRecordsFromHtml } = await import("./refresh-public-markets.mjs");

test("Proxibid Next.js lot data yields the page lot and linked active lots", () => {
  const pageUrl = "https://www.proxibid.com/category/item/lotinformation/12345/example-lot";
  const payload = {
    props: {
      pageProps: {
        lotDetails: {
          lotId: 12345,
          title: "Example Camera",
          price: "$125.50",
          lotEndDate: "2099-08-03T02:00:00Z",
          lotStatus: "ACTIVE",
          imageUrl: "https://images.proxibid.com/example.jpg",
          similarLots: [{
            id: "67890",
            title: "Linked Watch",
            price: "$75.00",
            auctionEnded: false,
            lotDetailsUrl: "/watches/linked-watch/lotInformation/67890",
            imageUrl: "https://images.proxibid.com/watch.jpg",
          }, {
            id: "99999",
            title: "Ended Lot",
            price: "$40.00",
            auctionEnded: true,
            lotDetailsUrl: "/collectibles/ended/lotInformation/99999",
          }],
        },
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const records = proxibidRecordsFromHtml(html, pageUrl);

  assert.equal(records.length, 3);
  assert.equal(records[0].externalId, "12345");
  assert.equal(records[0].currentBid, 125.5);
  assert.equal(records[0].endsAt, "2099-08-03T02:00:00.000Z");
  assert.equal(records[0].status, "active");
  assert.equal(records[1].externalId, "67890");
  assert.equal(records[1].url, "https://www.proxibid.com/watches/linked-watch/lotInformation/67890");
  assert.equal(records[1].status, "active");
  assert.equal(records[2].status, "ended");
});

test("Proxibid legacy pages still yield an active current-bid record", () => {
  const pageUrl = "https://www.proxibid.com/Example-Lot/lotinformation/102270738";
  const html = `
    <meta property="og:image" content="https://images.proxibid.com/example.jpg">
    <span id="moreInfoLotTitle" class="moreInfoLotTitle">Example Pallet Jack</span>
    <span id="moreInfoEventEndDate">Friday,&nbsp;August&nbsp;7&nbsp;|&nbsp;1:09 PM&nbsp;&nbsp;Eastern</span>
    <input type="hidden" id="CurrentBid:102270738" name="currentBid" value="1250.50">
    <div class="BigBidWidget lotActive BidWidget"></div>
  `;
  const records = proxibidRecordsFromHtml(html, pageUrl);

  assert.equal(records.length, 1);
  assert.equal(records[0].externalId, "102270738");
  assert.equal(records[0].title, "Example Pallet Jack");
  assert.equal(records[0].currentBid, 1250.5);
  assert.equal(records[0].status, "active");
  assert.match(records[0].endsAt, /T17:09:00\.000Z$/);
});
