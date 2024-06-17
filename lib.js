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
const db = dbClient.db("encointerIndexer3");

export const ENCOINTER_RPC =
    process.env.ENCOINTER_RPC || "wss://kusama.api.encointer.org";

export async function getLastProcessedBlockNumber() {
    return (await db.collection("blocks").findOne({}, { sort: { height: -1 } }))
        .height;
}

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

async function parseBlock(
    blockNumber,
    api = null,
    swallowNonExistingBlocks = false
) {
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
        let signedBlock;
        let blockHash;
        try {
            blockHash = await api.rpc.chain.getBlockHash(blockNumber);
            signedBlock = await api.rpc.chain.getBlock(blockHash);
        } catch (e) {
            if (
                e.message.includes(
                    "Unable to retrieve header and parent from supplied hash"
                )
            ) {
                console.log(
                    `Block ${blockNumber} is not yet avaiable, skipping.`
                );
                if (swallowNonExistingBlocks) return;
                throw e;
            }
        }

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

            extrinsic.timestamp = block.timestamp;
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
                e.event.timestamp = block.timestamp;
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
        // console.log(`ERROR processing block ${blockNumber}`);
        // console.log(e);
        throw e;
    }
}

async function catchUpWithChain(api, blockNumber, endBlockNumber) {
    const numConcurrentJobs = 100;
    for (let i = blockNumber; i <= endBlockNumber; i += numConcurrentJobs) {
        let indexes = Array.from(Array(numConcurrentJobs).keys()).map(
            (idx) => idx + i
        );
        indexes = indexes.filter(idx => (idx <= endBlockNumber))
        let msg = `processing blocks ${indexes[0]} - ${indexes[indexes.length - 1]}`
        console.time(msg);


        while(true) {
            try{
                await Promise.all(indexes.map((idx) => parseBlock(idx, api)));
                break
            } catch (e) {
                console.log(e)
                await new Promise(r => setTimeout(r, 5000));
                continue
            }
        }
        console.timeEnd(msg);
    }


    // sequential version
    // for (; blockNumber <= endBlockNumber; blockNumber++) {
    //     console.log(`Catching up: Block ${blockNumber}`)
    //     await parseBlock(blockNumber, api);
    // }
}

export async function findUnprocessedBlockNumbers(blockNumber, endBlockNumber) {
    const blocks = db.collection('blocks')
    let processedBlockNumbers = await (await blocks.find({"height" : {"$gte": blockNumber, "$lte": endBlockNumber}}).project({ height: 1, "_id": -1 })).toArray();
    processedBlockNumbers = processedBlockNumbers.map(e => e.height)
    const expectedBlockNumbers = Array(endBlockNumber - blockNumber + 1).fill().map((_, idx) => blockNumber + idx)
    let unprocessedBlockNumbers = expectedBlockNumbers.filter(e => !processedBlockNumbers.includes(e))
    return unprocessedBlockNumbers
}

export async function parseUnprocessedBlocks(api, blockNumber, endBlockNumber) {
    const unprocessedBlockNumbers = await findUnprocessedBlockNumbers(blockNumber, endBlockNumber)
    await Promise.all(unprocessedBlockNumbers.map((idx) => parseBlock(idx, api)));
    if(unprocessedBlockNumbers.length > 0){
        console.log(`done parsing blocks ${unprocessedBlockNumbers}`)
    }
}

// init timestamp 1716415200000
export async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    // last block number from safe base: 5506899
    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let firstRun = true;
    const unsubscribe = await api.rpc.chain.subscribeFinalizedHeads(
        async (header) => {
            const currentBlockNumber = parseInt(header.number.toString());
            if (firstRun) {
                console.log("catching up with chain");
                catchUpWithChain(
                    api,
                    // some margin of safety, no harm if the blaock were already indexed
                    // and it could be that it just took them very long and were not yet processed
                    lastProcessedBlockNumber - 500,
                    currentBlockNumber - 1
                );
                firstRun = false;
            }

            console.log(`Chain is at block: #${currentBlockNumber}`);
            while(true) {
                try{
                    await parseBlock(currentBlockNumber, api);
                    break
                } catch (e) {
                    console.log(e)
                    await new Promise(r => setTimeout(r, 5000));
                    continue
                }
            }
            console.log(`Processed block ${currentBlockNumber}`);

            if(currentBlockNumber % 5 === 0) parseUnprocessedBlocks(api, currentBlockNumber - 10, currentBlockNumber)
        }
    );

    // let firstRun = true
    // const unsubscribe = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
    //     const currentBlockNumber = parseInt(header.number.toString())
    //     if (firstRun) {
    //         console.log('catching up with chain')
    //         firstRun = false;
    //         const lastBlockNumber = await getLastProcessedBlockNumber()
    //         const numBlocksToProcess = currentBlockNumber - lastBlockNumber;
    //         const numConcurrentJobs = Math.min(5000, numBlocksToProcess)
    //         for (let i = lastBlockNumber; i < currentBlockNumber; i += numConcurrentJobs) {
    //             console.log(`processing blocks ${i} - ${i + numConcurrentJobs}`);
    //             console.time("processing");
    //             let indexes = Array.from(Array(numConcurrentJobs).keys()).map((idx) => idx + i);
    //             await Promise.all(indexes.map((idx) => parseBlock(idx, api)));
    //             console.timeEnd("processing");
    //         }
    //     }

    //     console.log(`Chain is at block: #${currentBlockNumber}`);
    //     await parseBlock(currentBlockNumber, api)
    //     console.log(`Processed block: #${currentBlockNumber}`);
    //   });

    // let blockNumber = 508439 + 320000 - 500;
    // blockNumber = 5520000;

    // const numConcurrentJobs = 5000;
    // for (let i = blockNumber; i < 5530000; i += numConcurrentJobs) {
    //     console.log(`processing blocks ${i} - ${i + numConcurrentJobs}`);
    //     console.time("processing");
    //     let indexes = Array.from(Array(numConcurrentJobs).keys()).map(
    //         (idx) => idx + i
    //     );
    //     await Promise.all(indexes.map((idx) => parseBlock(idx, api)));
    //     console.timeEnd("processing");
    // }
}

// 2500 - 30 sec
// 5000 - 28 sec lol

