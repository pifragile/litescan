import { WsProvider } from "@polkadot/api";
import { ApiPromise } from "@polkadot/api/cjs/bundle";
import "dotenv/config";
import { MongoClient } from "mongodb";

// Wrap the script in a top-level async IIFE so `await` can be used safely
// and ensure the client is closed when finished.
(async function main() {
    const dbClient = new MongoClient(process.env.DB_URL, {});
    try {
        await dbClient.connect();
        const db = dbClient.db(process.env.DB_NAME);
        try {
            await db.collection("extrinsics").drop();
        } catch (e) {}
        try {
            await db.collection("blocks").drop();
        } catch (e) {}
        try {
            await db.collection("events").drop();
        } catch (e) {}
    } finally {
        await dbClient.close();
    }
    const wsProvider = new WsProvider(process.env.RPC_NODE);
    const api = await ApiPromise.create({
        provider: wsProvider,
    });
    const lastHeader = await api.rpc.chain.getHeader();
    console.log(
        `Last block number: ${lastHeader.number.toNumber()} - hash: ${lastHeader.hash.toHex()}`
    );

    const genesisHash = await api.rpc.chain.getBlockHash(0);
    const genesis = await api.rpc.chain.getBlock(genesisHash);

    console.log(`Genesis hash: ${genesisHash.toHex()}`);
    console.log(`Block number: ${genesis.block.header.number.toNumber()}`);
    console.log(`Parent hash: ${genesis.block.header.parentHash.toHex()}`);
    console.log(`Extrinsics (${genesis.block.extrinsics.length}):`);
    genesis.block.extrinsics.forEach((extrinsic, i) => {
        console.log(`${i}: ${extrinsic.method.toString()}`);
    });

    await api.disconnect();

})();
