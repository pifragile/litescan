import "dotenv/config";
import { MongoClient } from "mongodb";

(async function main() {
  const dbClient = new MongoClient(process.env.DB_URL);
  await dbClient.connect();
  try {
    const db = dbClient.db(process.env.DB_NAME);
    const coll = db.collection("blocks");

    // Stream documents sorted by height
    const cursor = coll.find({}, { projection: { height: 1, _id: 0 } }).sort({ height: 1 });

    let prevHeight = -1;
    let totalDocs = 0;
    const missing = [];
    const outOfRange = [];
    let maxHeight = -Infinity;
    let minHeight = Infinity;

    for await (const doc of cursor) {
      const h = Number(doc.height);
      if (Number.isNaN(h)) continue;

      totalDocs++;
      maxHeight = Math.max(maxHeight, h);
      minHeight = Math.min(minHeight, h);

      if (h < 0) outOfRange.push(h);

      // Detect missing heights
      if (h > prevHeight + 1) {
        // Missing some between prevHeight and h
        for (let m = prevHeight + 1; m < h; m++) {
          if (missing.length < 100) missing.push(m); // only store sample
        }
      }
      prevHeight = h;
    }

    console.log(`Total block documents scanned: ${totalDocs}`);
    console.log(`Min height: ${minHeight}, Max height: ${maxHeight}`);

    if (missing.length === 0) {
      console.log(`No missing heights detected between ${minHeight}..${maxHeight}.`);
    } else {
      console.log(`Missing heights (first 100):`, missing);
    }

    if (outOfRange.length) {
      console.log(
        `Found ${outOfRange.length} out-of-range heights (< 0). Showing up to first 100:`,
        outOfRange.slice(0, 100)
      );
    }
  } catch (e) {
    console.error("Failed to count blocks documents:", e);
  } finally {
    await dbClient.close();
  }
})();
