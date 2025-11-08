import "dotenv/config";
import { MongoClient } from "mongodb";

(async function main() {

    const dbClient = new MongoClient(process.env.DB_URL, {});
    await dbClient.connect();
    try {
        const db = dbClient.db(process.env.DB_NAME);
        const coll = db.collection("blocks");

        const totalBlocks = await coll.countDocuments();
        console.log(`Total blocks (countDocuments): ${totalBlocks}`);

        const heightsSet = new Set();
        await coll
            .find({}, { projection: { height: 1, _id: 0 } })
            .forEach((doc) => {
                const h = Number(doc.height);
                if (!Number.isNaN(h)) heightsSet.add(h);
            });

        const missing = [];
        for (let i = 0; i < totalBlocks; i++) {
            if (!heightsSet.has(i)) missing.push(i);
        }

        if (missing.length === 0) {
            console.log(`All heights 0..${totalBlocks - 1} are present.`);
        } else {
            console.log(
                `Missing ${missing.length} heights in range 0..${
                    totalBlocks - 1
                }. Showing up to first 100 missing:`,
                missing.slice(0, 100)
            );
        }

        // report any heights outside the expected range (>= totalBlocks or negative)
        const outOfRange = [];
        for (const h of heightsSet) {
            if (h < 0 || h >= totalBlocks) outOfRange.push(h);
        }
        if (outOfRange.length) {
            console.log(
                `Found ${outOfRange.length} out-of-range heights (negative or >= ${totalBlocks}). Showing up to first 100:`,
                outOfRange.slice(0, 100)
            );
        }
    } catch (e) {
        console.error("Failed to count extrinsics documents:", e);
    } finally {
        await dbClient.close();
    }
})();
