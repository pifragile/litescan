import { MongoClient } from "mongodb";

(async () => {
    const dbClient = new MongoClient("mongodb://readonly:123456@62.84.182.186:27017/", {});
    try {
        await dbClient.connect();
        const indexer = dbClient.db("litescan_polkadot_assethub");
        const extrinsics = indexer.collection("extrinsics");
        const query = { method: "transferAllowDeath", section: "balances" };
        const result = await extrinsics.find(query, { limit: 3 });
        const docs = await result.toArray();
        console.dir(docs, { depth: null, colors: true });
    } finally {
        await dbClient.close();
    }
})();