import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";

import bs58 from "bs58";
import { parseEncointerBalance } from "@encointer/types";

import util from "util";
import BN from "bn.js";
import { MongoClient } from "mongodb";

import * as dotenv from "dotenv";
dotenv.config();

const dbClient = new MongoClient(process.env.DB_URL, {
    ssl: true,
    sslValidate: true,
});
const db = dbClient.db("encointerIndexer4");

export const ENCOINTER_RPC =
    process.env.ENCOINTER_RPC || "wss://kusama.api.encointer.org";


async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    let api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    let lastProcessedBlockNumber = (await db.collection("blocks").findOne({}, { sort: { height: -1 } }))
    .height;

    let firstProcessedBlockNumber = (await db.collection("blocks").findOne({}, { sort: { height: 1 } }))
    .height;


    let numBlocks = await db.collection('blocks').countDocuments()

    console.log(numBlocks)
    console.log(lastProcessedBlockNumber - firstProcessedBlockNumber)
}


main().catch(console.error);
