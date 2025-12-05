import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";

import bs58 from "bs58";
import { parseEncointerBalance } from "@encointer/types";

import util from "util";
import BN from "bn.js";
import { MongoClient } from "mongodb";

import * as dotenv from "dotenv";
dotenv.config();

export const DEBUG = process.env.DEBUG === "true";
const config =
    process.env.DB_USE_SSL === "true"
        ? {
              ssl: true,
              sslValidate: true,
          }
        : {};

let dbClient, db;
if (!DEBUG) {
    dbClient = new MongoClient(process.env.DB_URL, config);
    db = dbClient.db(process.env.DB_NAME);
}

export const RPC_NODE = process.env.RPC_NODE;

export const NUM_CONCURRENT_JOBS = parseInt(process.env.NUM_CONCURRENT_JOBS);
export const START_BLOCK = parseInt(process.env.START_BLOCK || 1);

export async function getLastProcessedBlockNumber() {
    try {
        return (
            await db.collection("blocks").findOne({}, { sort: { height: -1 } })
        ).height;
    } catch {
        return START_BLOCK;
    }
}

async function insertIntoCollection(collection, document) {
    if (DEBUG) {
        console.log(
            `Inserting document into collection ${collection}: ${JSON.stringify(
                document
            )}`
        );
        return;
    }
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

function mapTypesRecursive(obj) {
    if (Array.isArray(obj)) {
        return obj.map(mapTypesRecursive);
    } else if (typeof obj === "object" && obj !== null) {
        return Object.fromEntries(
            Object.entries(obj).map(([key, value]) => [
                key,
                mapTypesRecursive(value),
            ])
        );
    }
    return mapTypes(obj);
}

async function parseBlock(
    blockNumber,
    api = null,
    swallowNonExistingBlocks = false
) {
    try {
        if (!api) {
            const wsProvider = new WsProvider(RPC_NODE);
            api = await ApiPromise.create({
                provider: wsProvider,
                signedExtensions: typesBundle.signedExtensions,
                types: typesBundle.types[0].types,
            });
        }

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
            specVersion: apiAt.runtimeVersion.specVersion.toNumber(),
            author: await getBlockAuthor(apiAt, blockNumber),
            specversion: apiAt.runtimeVersion.specVersion.toNumber(),
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

        const extrinsicPromises = signedBlock.block.extrinsics.map(
            async (ex, extrinsicIndex) => {
                let extrinsic = ex.toHuman();
                extrinsic.success = false;
                extrinsic.blockNumber = blockNumber;
                extrinsic.blockHash = blockHash.toHuman();
                extrinsic._id = `${blockNumber}-${extrinsicIndex}`;

                Object.keys(extrinsic.method.args).forEach(function (key) {
                    extrinsic.method.args[key] = mapTypes(
                        extrinsic.method.args[key]
                    );
                });
                if (["setValidationData"].includes(extrinsic.method.method))
                    return;
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

                // Prepare event objects
                events.forEach((e, eventIndex) => {
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

                // Insert all events for this extrinsic
                await Promise.all(
                    events.map(async (e) => {
                        if (e.event.method === "ExtrinsicSuccess") {
                            extrinsic.success = true;
                            return;
                        }
                        await insertIntoCollection("events", e.event);
                    })
                );

                extrinsic = { ...extrinsic, ...extrinsic.method };
                await insertIntoCollection("extrinsics", extrinsic);
            }
        );
        await Promise.all(extrinsicPromises);

        const systemEvents = allRecords
            .filter(
                ({ phase }) => phase.isFinalization || phase.isInitialization
            )
            .map((e) => e.toHuman());

        // Insert all system events
        await Promise.all(
            systemEvents.map(async (e, eventIndex) => {
                e.event.blockNumber = blockNumber;
                e.event.blockHash = blockHash.toHuman();
                e.event._id = `${blockNumber}-${eventIndex}`;
                e.event.extrinsicId = null;
                e.event.timestamp = block.timestamp;
                delete e.event.index;
                await insertIntoCollection("events", e.event);
            })
        );

        await insertIntoCollection("blocks", block);
    } catch (e) {
        throw e;
    }
}

async function catchUpWithChain(api, blockNumber, endBlockNumber) {
    const numConcurrentJobs = NUM_CONCURRENT_JOBS;
    for (let i = blockNumber; i <= endBlockNumber; i += numConcurrentJobs) {
        let indexes = Array.from(Array(numConcurrentJobs).keys()).map(
            (idx) => idx + i
        );
        indexes = indexes.filter((idx) => idx <= endBlockNumber);
        let msg = `processing blocks ${indexes[0]} - ${
            indexes[indexes.length - 1]
        }`;
        console.time(msg);

        while (true) {
            try {
                await Promise.all(indexes.map((idx) => parseBlock(idx, api)));
                break;
            } catch (e) {
                console.log(e);
                await new Promise((r) => setTimeout(r, 5000));
                continue;
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
    if (DEBUG) return [];
    const blocks = db.collection("blocks");
    let processedBlockNumbers = await (
        await blocks
            .find({ height: { $gte: blockNumber, $lte: endBlockNumber } })
            .project({ height: 1, _id: -1 })
    ).toArray();
    processedBlockNumbers = processedBlockNumbers.map((e) => e.height);
    const expectedBlockNumbers = Array(endBlockNumber - blockNumber + 1)
        .fill()
        .map((_, idx) => blockNumber + idx);
    let unprocessedBlockNumbers = expectedBlockNumbers.filter(
        (e) => !processedBlockNumbers.includes(e)
    );
    return unprocessedBlockNumbers;
}

export async function parseUnprocessedBlocks(api, blockNumber, endBlockNumber) {
    const unprocessedBlockNumbers = await findUnprocessedBlockNumbers(
        blockNumber,
        endBlockNumber
    );
    if (unprocessedBlockNumbers.length > 0) {
        console.log("Found some unprocessed blocks:", unprocessedBlockNumbers);
        await batchProcessBlocks(api, unprocessedBlockNumbers);
    }
}

export async function findAllUnprocessedBlockNumbers() {
    const coll = db.collection("blocks");

    // Include START_BLOCK itself
    const cursor = coll
        .find(
            { height: { $gte: START_BLOCK } }, // include START_BLOCK
            { projection: { height: 1, _id: 0 } }
        )
        .sort({ height: 1 });

    let prevHeight = START_BLOCK - 1; // so missing START_BLOCK is detected
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

        // Detect missing heights starting from START_BLOCK
        if (h > prevHeight + 1) {
            for (let m = prevHeight + 1; m < h; m++) {
                missing.push(m);
            }
        }
        prevHeight = h;
    }

    return missing;
}

export async function batchProcessBlocks(api, blockNumbers) {
    if (blockNumbers.length > 0) {
        const batchSize = NUM_CONCURRENT_JOBS || 1;
        for (let i = 0; i < blockNumbers.length; i += batchSize) {
            const batch = blockNumbers.slice(i, i + batchSize);
            const msg = `processing blocks ${batch}`;
            console.time(msg);
            await Promise.all(batch.map((idx) => parseBlock(idx, api)));
            console.timeEnd(msg);
        }
    }
}

async function catchUpAndIndexLive(api) {
    // last block number from safe base: 5506899
    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let firstRun = true;
    let lastCheckAtHeight = lastProcessedBlockNumber;
    await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
        const currentBlockNumber = parseInt(header.number.toString());
        if (firstRun) {
            console.log("catching up with chain");
            catchUpWithChain(
                api,
                // some margin of safety, no harm if the blaock were already indexed
                // and it could be that it just took them very long and were not yet processed
                Math.max(
                    lastProcessedBlockNumber - NUM_CONCURRENT_JOBS * 5,
                    START_BLOCK
                ),
                currentBlockNumber - 1
            );
            firstRun = false;
        }

        console.log(`Chain is at block: #${currentBlockNumber}`);

        while (true) {
            try {
                const start = lastProcessedBlockNumber + 1;
                const end = currentBlockNumber;
                if (start <= end) {
                    const blockNumbers = Array.from(
                        { length: end - start + 1 },
                        (_, i) => start + i
                    );
                    await batchProcessBlocks(api, blockNumbers);
                }

                lastProcessedBlockNumber = currentBlockNumber;
                break;
            } catch (e) {
                console.log(e);
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
        }

        if (currentBlockNumber - lastCheckAtHeight >= 10) {
            await parseUnprocessedBlocks(
                api,
                lastCheckAtHeight,
                currentBlockNumber
            );
            lastCheckAtHeight = currentBlockNumber;
        }
    });
}

async function getLastFinalizedBlock(api) {
    return await api.rpc.chain.getBlock(await api.rpc.chain.getFinalizedHead());
}

async function getLastestFinalizedBlockNumber(api) {
    return parseInt(
        (await getLastFinalizedBlock(api)).block.header
            .toHuman()
            .number.replaceAll(",", "")
    );
}

async function getLastAuthoredBlocks(api) {
    try {
        const lastAuthoredBlocks =
            await api.query.collatorSelection.lastAuthoredBlock.entries();
        return lastAuthoredBlocks.map(([key, value]) => {
            const collator = key.toHuman();
            const blockNumber = value.toNumber();
            return [collator, blockNumber];
        });
    } catch (e) {
        return [];
    }
}

async function getBlockAuthor(api, blockNumber) {
    const lastAuthoredBlocks = await getLastAuthoredBlocks(api);
    const authorEntry = lastAuthoredBlocks.find(
        ([_, authoredBlockNumber]) => authoredBlockNumber === blockNumber
    );
    return authorEntry ? authorEntry[0][0] : null;
}

export async function main() {
    const wsProvider = new WsProvider(RPC_NODE);
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    console.log("Finding unprocessed blocks and process...");
    const unprocessedBlockNumbers = await findAllUnprocessedBlockNumbers();
    console.log(`Found ${unprocessedBlockNumbers.length} unprocessed blocks.`);

    await batchProcessBlocks(api, unprocessedBlockNumbers);

    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let currentBlockNumber = await getLastestFinalizedBlockNumber(api);

    while (
        currentBlockNumber - lastProcessedBlockNumber >
        NUM_CONCURRENT_JOBS
    ) {
        await catchUpWithChain(
            api,
            Math.max(
                lastProcessedBlockNumber - 2 * NUM_CONCURRENT_JOBS,
                START_BLOCK
            ),
            currentBlockNumber
        );
        lastProcessedBlockNumber = await getLastProcessedBlockNumber(api);
        currentBlockNumber = await getLastestFinalizedBlockNumber(api);
        break;
    }

    console.log("Switching to live mode");
    await catchUpAndIndexLive(api);
}
