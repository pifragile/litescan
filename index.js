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
const db = dbClient.db("encointerIndexer");

export const ENCOINTER_RPC =
    process.env.ENCOINTER_RPC || "wss://kusama.api.encointer.org";

async function insertIntoCollection(collection, document) {
    try {
        await db.collection(collection).insertOne(document);
    } catch (e) {
        if (e.message.includes("E11000 duplicate key error")) {
            console.log(
                `Skippping dup key ${document._id} in collection ${collection}`
            );
            return;
        }
        throw e;
    }
}
const cidToString = (input) => {
    const geohash = input["geohash"];
    const digest = input["digest"];
    let buffer;
    if (digest.startsWith("0x")) {
        buffer = Buffer.from(input["digest"].slice(2), "hex");
    } else {
        buffer = Buffer.from(input["digest"], "utf-8");
    }
    let cid = geohash + bs58.encode(Uint8Array.from(buffer));

    // consolidate multiple LEU cids
    if (["u0qj92QX9PQ", "u0qj9QqA2Q"].includes(cid)) cid = "u0qj944rhWE";

    return cid;
};

function mapTypes(obj) {
    if (!isNaN(obj)) return Number(obj);

    if (!obj || typeof obj !== "object") return obj;
    if ("geohash" in obj && "digest" in obj) {
        return cidToString(obj);
    }
    if (Object.keys(obj).length === 1 && "bits" in obj) {
        return parseEncointerBalance(new BN(obj.bits.replaceAll(",", "")));
    }

    return obj;
}

const print = (obj) => {
    console.log(
        util.inspect(obj, { showHidden: false, depth: null, colors: true })
    );
};

async function parseBlock(blockNumber, api = null) {
    try {
        if (!api) {
            const wsProvider = new WsProvider(ENCOINTER_RPC);
            // Create our API with a default connection to the local node
            api = await ApiPromise.create({
                provider: wsProvider,
                signedExtensions: typesBundle.signedExtensions,
                types: typesBundle.types[0].types,
            });
        }

        // returns Hash
        const blockHash = await api.rpc.chain.getBlockHash(blockNumber);

        // returns SignedBlock
        const signedBlock = await api.rpc.chain.getBlock(blockHash);

        const apiAt = await api.at(signedBlock.block.header.hash);
        const allRecords = await apiAt.query.system.events();

        const block = {
            _id: blockHash.toHuman(),
            height: blockNumber,
            timestamp: null,
        };

        let [cindex, phase, nextPhaseTimestamp, reputationLifetime] =
            await apiAt.queryMulti([
                [api.query.encointerScheduler.currentCeremonyIndex],
                [api.query.encointerScheduler.currentPhase],
                [api.query.encointerScheduler.nextPhaseTimestamp],
                [api.query.encointerCeremonies.reputationLifetime],
            ]);

        block.cindex = parseInt(cindex.toString());
        block.phase = phase.toString();
        block.nextPhaseTimestamp = parseInt(nextPhaseTimestamp.toString());
        block.reputationLifetime = parseInt(reputationLifetime.toString());

        // the information for each of the contained extrinsics
        signedBlock.block.extrinsics.forEach(async (ex, extrinsicIndex) => {
            // the extrinsics are decoded by the API, human-like view

            let extrinsic = ex.toHuman();
            extrinsic.success = false;
            extrinsic.blockNumber = blockNumber;
            extrinsic.blockHash = blockHash.toHuman();
            extrinsic._id = `${blockNumber}-${extrinsicIndex}`;

            //delete extrinsic.method
            Object.keys(extrinsic.method.args).forEach(function (key) {
                extrinsic.method.args[key] = mapTypes(
                    extrinsic.method.args[key]
                );
            });
            if (["setValidationData"].includes(extrinsic.method.method)) return;
            if (
                extrinsic.method.section === "timestamp" &&
                extrinsic.method.method === "set"
            ) {
                block.timestamp = parseInt(
                    extrinsic.method.args.now.replaceAll(",", "")
                );
                return;
            }

            const events = allRecords
                .filter(
                    ({ phase }) =>
                        phase.isApplyExtrinsic &&
                        phase.asApplyExtrinsic.eq(extrinsicIndex)
                )
                .map((e) => e.toHuman());

            events.forEach(async (e, eventIndex) => {
                if (Array.isArray(e)) {
                    e.event.data = e.event.data.map(mapTypes);
                } else if (typeof e === "object") {
                    Object.keys(e.event.data).forEach(function (key) {
                        e.event.data[key] = mapTypes(e.event.data[key]);
                    });
                }
                e.event.blockNumber = blockNumber;
                e.event.blockHash = blockHash.toHuman();
                e.event._id = `${extrinsic._id}-${eventIndex}`;
                e.event.extrinsicId = extrinsic._id;
                delete e.event.index;
            });

            events.forEach(async (e) => {
                if (e.event.method === "ExtrinsicSuccess") {
                    extrinsic.success = true;
                    return;
                }
                //db.collection(`ev.${e.event.section}.${e.event.method}`).insertOne(e.event)
                await insertIntoCollection("events", e.event);
            });

            extrinsic = { ...extrinsic, ...extrinsic.method };

            //db.collection(`xt.${extrinsic.section}.${extrinsic.method}`).insertOne(extrinsic)
            await insertIntoCollection("extrinsics", extrinsic);
        });
        await insertIntoCollection("blocks", block);
    } catch (e) {
        console.log(`ERROR processing block ${blockNumber}`);
        console.log(e);
        throw e;
    }
}
async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });
    const blockNumber = 508439 + 270000;

    for (let i = blockNumber; i < 5000000; i += 5000) {
        console.log(`processing blocks ${i} - ${i + 5000}`);
        console.time("processing");
        let indexes = Array.from(Array(5000).keys()).map((idx) => idx + i);
        await Promise.all(indexes.map((idx) => parseBlock(idx, api)));
        console.timeEnd("processing");
    }
}

// 2500 - 30 sec
// 5000 - 28 sec lol

main().catch(console.error);
