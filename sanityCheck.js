import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";
import { MongoClient } from "mongodb";

import * as dotenv from "dotenv";
import { RPC_NODE } from "./lib.js";
dotenv.config();

const dbClient = new MongoClient(process.env.DB_URL, {
    ssl: true,
    sslValidate: true,
});
const db = dbClient.db(process.env.DB_NAME);


async function main() {
    const wsProvider = new WsProvider(RPC_NODE);
    // Create our API with a default connection to the local node
    let api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    let numBlocks = await db.collection('blocks').countDocuments()

    let lastProcessedBlockNumber = (await db.collection("blocks").findOne({}, { sort: { height: -1 } }))
    .height;

    let firstProcessedBlockNumber = (await db.collection("blocks").findOne({}, { sort: { height: 1 } }))
    .height;


    console.log(`expected number of blocks ${lastProcessedBlockNumber - firstProcessedBlockNumber + 1}`)
    console.log(`found number of blocks ${numBlocks}`)
}


main().catch(console.error);
