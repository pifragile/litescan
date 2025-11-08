import { ApiPromise, WsProvider } from "@polkadot/api";

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

// Insertion buffer used to collect documents during concurrent parsing
// and flush them in bulk via insertMany to improve performance.
const insertionBuffer = {
    blocks: [],
    events: [],
    extrinsics: [],
};

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

async function insertIntoCollection(collection, document, buffer = false) {
    if (buffer) {
        // push into the in-memory buffer for later bulk insert
        insertionBuffer[collection] = insertionBuffer[collection] || [];
        insertionBuffer[collection].push(document);
        return;
    }

    if (DEBUG) {
        console.log(
            `Inserting document into collection ${collection}: ${JSON.stringify(
                document
            )}`
        );
        return;
    }

    // Default behavior: immediate insertOne
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

// NOTE: insertBuffered removed. Use `insertIntoCollection(collection, document, buffer)`
// to either buffer documents for later bulk insert or write immediately.

async function flushInsertBuffer() {
    if (DEBUG) return;
    if (!db) return;

    const collections = Object.keys(insertionBuffer);
    for (const coll of collections) {
        const docs = insertionBuffer[coll];
        if (!docs || docs.length === 0) continue;
        try {
            console.log(`Inserting ${docs.length} documents into collection ${coll}`);
            await db.collection(coll).insertMany(docs, { ordered: false });
        } catch (e) {
            // ignore duplicate key errors from bulk writes; log others
            const msg = e.message || "";
            if (msg.includes("duplicate key") || msg.includes("E11000")) {
                console.log(
                    `Some duplicate keys skipped when inserting into ${coll}`
                );
            } else {
                console.log(
                    `Error during insertMany into ${coll}: ${e.message}`
                );
                throw e;
            }
        } finally {
            insertionBuffer[coll] = [];
        }
    }
}

function mapTypes(obj) {
    //if (!isNaN(obj)) return Number(obj);
    return obj;
}

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
    swallowNonExistingBlocks = false,
    bufferInserts = false
) {
    try {
        if (!api) {
            const wsProvider = new WsProvider(RPC_NODE);
            api = await ApiPromise.create({
                provider: wsProvider,
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
            author: await getBlockAuthor(apiAt, blockNumber),
            specversion: apiAt.runtimeVersion.specVersion.toNumber(),
        };

        for (
            let extrinsicIndex = 0;
            extrinsicIndex < signedBlock.block.extrinsics.length;
            extrinsicIndex++
        ) {
            const ex = signedBlock.block.extrinsics[extrinsicIndex];
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
            if (["setValidationData"].includes(extrinsic.method.method))
                continue;
            if (
                extrinsic.method.section === "timestamp" &&
                extrinsic.method.method === "set"
            ) {
                block.timestamp = parseInt(
                    extrinsic.method.args.now.replaceAll(",", "")
                );
                continue;
            }

            extrinsic.timestamp = block.timestamp;
            const events = allRecords
                .filter(
                    ({ phase }) =>
                        phase.isApplyExtrinsic &&
                        phase.asApplyExtrinsic.eq(extrinsicIndex)
                )
                .map((e) => e.toHuman());

            for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
                const e = events[eventIndex];
                //e.event.data = mapTypesRecursive(e.event.data);
                e.event.blockNumber = blockNumber;
                e.event.blockHash = blockHash.toHuman();
                e.event._id = `${extrinsic._id}-${eventIndex}`;
                e.event.extrinsicId = extrinsic._id;
                e.event.timestamp = block.timestamp;
                delete e.event.index;
            }

            for (const e of events) {
                if (e.event.method === "ExtrinsicSuccess") {
                    extrinsic.success = true;
                    continue;
                }
                await insertIntoCollection("events", e.event, bufferInserts);
            }

            extrinsic = { ...extrinsic, ...extrinsic.method };

            await insertIntoCollection("extrinsics", extrinsic, bufferInserts);
        }
        const systemEvents = allRecords
            .filter(
                ({ phase }) => phase.isFinalization || phase.isInitialization
            )
            .map((e) => e.toHuman());

        for (
            let eventIndex = 0;
            eventIndex < systemEvents.length;
            eventIndex++
        ) {
            const e = systemEvents[eventIndex];
            //e.event.data = mapTypesRecursive(e.event.data);
            e.event.blockNumber = blockNumber;
            e.event.blockHash = blockHash.toHuman();
            e.event._id = `${blockNumber}-${eventIndex}`;
            e.event.extrinsicId = null;
            e.event.timestamp = block.timestamp;
            delete e.event.index;
            await insertIntoCollection("events", e.event, bufferInserts);
        }
        await insertIntoCollection("blocks", block, bufferInserts);
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
                // buffer inserts during the batch so we can do insertMany
                await Promise.all(
                    indexes.map((idx) => parseBlock(idx, api, false, true))
                );
                // flush buffered docs in bulk
                await flushInsertBuffer();
                break;
            } catch (e) {
                console.log(e);
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
        }
        console.timeEnd(msg);
    }
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
    await Promise.all(
        unprocessedBlockNumbers.map((idx) => parseBlock(idx, api))
    );
    if (unprocessedBlockNumbers.length > 0) {
        console.log(`done parsing blocks ${unprocessedBlockNumbers}`);
    }
}

async function catchUpAndIndexLive(api) {
    // last block number from safe base: 5506899
    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let firstRun = true;
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
                await parseBlock(currentBlockNumber, api);
                break;
            } catch (e) {
                console.log(e);
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
        }
        console.log(`Processed block ${currentBlockNumber}`);

        if (currentBlockNumber % 5 === 0)
            parseUnprocessedBlocks(
                api,
                currentBlockNumber - 20,
                currentBlockNumber
            );
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
    });

    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let currentBlockNumber = await getLastestFinalizedBlockNumber(api);

    while (
        currentBlockNumber - lastProcessedBlockNumber >
        NUM_CONCURRENT_JOBS
    ) {
        await catchUpWithChain(
            api,
            Math.max(
                lastProcessedBlockNumber - 2 * NUM_CONCURRENT_JOBS + 1,
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
