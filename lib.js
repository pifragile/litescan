import { ApiPromise, WsProvider } from "@polkadot/api";
import pLimit from "p-limit";

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
const MAX_RPC_CONCURRENCY = parseInt(process.env.MAX_RPC_CONCURRENCY || 10);
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || 0);
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_RETRY_DELAY_MS = 5000;

const rpcLimit = pLimit(MAX_RPC_CONCURRENCY);

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
        try {
            await db.collection(collection).insertOne(document);
        } catch (e) {
            if (
                e.name === "MongoServerError" &&
                e.message.includes(
                    "BSONObj exceeds maximum nested object depth"
                )
            ) {
                // Recursively stringify fields that exceed a safe depth
                function stringifyDeepFields(
                    obj,
                    maxDepth = 50,
                    currentDepth = 0
                ) {
                    if (
                        currentDepth > maxDepth &&
                        typeof obj === "object" &&
                        obj !== null
                    ) {
                        return JSON.stringify(obj);
                    }
                    if (Array.isArray(obj)) {
                        return obj.map((item) =>
                            stringifyDeepFields(
                                item,
                                maxDepth,
                                currentDepth + 1
                            )
                        );
                    }
                    if (typeof obj === "object" && obj !== null) {
                        return Object.fromEntries(
                            Object.entries(obj).map(([k, v]) => [
                                k,
                                stringifyDeepFields(
                                    v,
                                    maxDepth,
                                    currentDepth + 1
                                ),
                            ])
                        );
                    }
                    return obj;
                }
                const safeDoc = stringifyDeepFields(document, 50, 0);
                try {
                    await db.collection(collection).insertOne(safeDoc);
                    console.log(
                        `Retried insert with stringified deep fields for document ${document._id} in collection ${collection}`
                    );
                    return;
                } catch (err) {
                    throw err;
                }
            }
            throw e;
        }
    } catch (e) {
        if (e.message.includes("E11000 duplicate key error")) {
            console.log(
                `Skipping dup key ${document._id} in collection ${collection}`
            );
            return;
        }
        throw e;
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
    { swallowNonExistingBlocks = false, cachedAuthoredBlocks = null } = {}
) {
    if (!api) {
        const wsProvider = new WsProvider(RPC_NODE);
        api = await ApiPromise.create({
            provider: wsProvider,
        });
    }

    let signedBlock;
    let blockHash;
    try {
        blockHash = await rpcLimit(() =>
            api.rpc.chain.getBlockHash(blockNumber)
        );
        signedBlock = await rpcLimit(() =>
            api.rpc.chain.getBlock(blockHash)
        );
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
        throw e;
    }

    const apiAt = await rpcLimit(() =>
        api.at(signedBlock.block.header.hash)
    );
    const allRecords = await rpcLimit(() =>
        apiAt.query.system.events()
    );

    const author = cachedAuthoredBlocks
        ? findAuthorFromCache(cachedAuthoredBlocks, blockNumber)
        : await getBlockAuthor(apiAt, blockNumber);

    const block = {
        _id: blockHash.toHuman(),
        height: blockNumber,
        timestamp: null,
        author,
    };

    // Extract timestamp before processing extrinsics concurrently
    for (const ex of signedBlock.block.extrinsics) {
        const extrinsic = ex.toHuman();
        if (
            extrinsic.method.section === "timestamp" &&
            extrinsic.method.method === "set"
        ) {
            block.timestamp = parseInt(
                extrinsic.method.args.now.replaceAll(",", "")
            );
            break;
        }
    }

    // Collect promises for all extrinsics and their events
    const extrinsicPromises = signedBlock.block.extrinsics.map(
        async (ex, extrinsicIndex) => {
            let skipInsertExtrinsic = false;
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
                skipInsertExtrinsic = true;
            if (
                extrinsic.method.section === "timestamp" &&
                extrinsic.method.method === "set"
            )
                skipInsertExtrinsic = true;

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
            if (!skipInsertExtrinsic) {
                await insertIntoCollection("extrinsics", extrinsic);
            }
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
}

async function processBlocksWithRetry(api, blockNumbers) {
    let remaining = [...blockNumbers];
    let delay = INITIAL_RETRY_DELAY_MS;

    // Fetch block authors once for this batch
    const cachedAuthoredBlocks = await getLastAuthoredBlocks(api);

    while (remaining.length > 0) {
        const results = await Promise.allSettled(
            remaining.map((idx) =>
                parseBlock(idx, api, { cachedAuthoredBlocks })
            )
        );

        const failed = [];
        results.forEach((result, i) => {
            if (result.status === "rejected") {
                failed.push(remaining[i]);
                console.log(
                    `Block ${remaining[i]} failed: ${result.reason?.message || result.reason}`
                );
            }
        });

        if (failed.length === 0) break;

        const jitter = Math.random() * delay * 0.3;
        const waitMs = Math.min(delay + jitter, MAX_RETRY_DELAY_MS);
        console.log(
            `Retrying ${failed.length}/${remaining.length} failed blocks in ${Math.round(waitMs / 1000)}s`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
        remaining = failed;
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
        await processBlocksWithRetry(api, indexes);
        console.timeEnd(msg);

        if (BATCH_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
    }
}

export async function findUnprocessedBlockNumbers(blockNumber, endBlockNumber) {
    if (DEBUG) return [];
    const blocks = db.collection("blocks");
    const cursor = blocks
        .find({ height: { $gte: blockNumber, $lte: endBlockNumber } })
        .project({ height: 1, _id: 0 });
    const processedSet = new Set();
    for await (const doc of cursor) {
        processedSet.add(doc.height);
    }
    const unprocessedBlockNumbers = [];
    for (let h = blockNumber; h <= endBlockNumber; h++) {
        if (!processedSet.has(h)) {
            unprocessedBlockNumbers.push(h);
        }
    }
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

export async function findAllUnprocessedBlockNumbers(api, batchCallback) {
    const coll = db.collection("blocks");

    const docCount = await coll.countDocuments({ height: { $gte: START_BLOCK } });
    if (docCount === 0) {
        console.log("Empty DB — skipping gap scan, will index sequentially.");
        return;
    }

    const cursor = coll
        .find(
            { height: { $gte: START_BLOCK } },
            { projection: { height: 1, _id: 0 } }
        )
        .sort({ height: 1 });

    let prevHeight = START_BLOCK - 1;
    let missingBatch = [];
    let totalMissing = 0;
    const CHUNK_SIZE = NUM_CONCURRENT_JOBS || 100;

    for await (const doc of cursor) {
        const h = Number(doc.height);
        if (Number.isNaN(h)) continue;

        if (h > prevHeight + 1) {
            for (let m = prevHeight + 1; m < h; m++) {
                missingBatch.push(m);
                if (missingBatch.length >= CHUNK_SIZE) {
                    totalMissing += missingBatch.length;
                    console.log(
                        `Processing ${missingBatch.length} missing blocks (${totalMissing} total so far)`
                    );
                    await batchCallback(api, missingBatch);
                    missingBatch = [];
                }
            }
        }
        prevHeight = h;
    }

    // Process remaining
    if (missingBatch.length > 0) {
        totalMissing += missingBatch.length;
        console.log(
            `Processing ${missingBatch.length} missing blocks (${totalMissing} total)`
        );
        await batchCallback(api, missingBatch);
    }

    if (totalMissing > 0) {
        console.log(`Finished reprocessing ${totalMissing} missing blocks.`);
    }
}

export async function batchProcessBlocks(api, blockNumbers) {
    if (blockNumbers.length > 0) {
        const batchSize = NUM_CONCURRENT_JOBS || 1;
        for (let i = 0; i < blockNumbers.length; i += batchSize) {
            const batch = blockNumbers.slice(i, i + batchSize);
            const msg = `processing blocks ${batch[0]}-${batch[batch.length - 1]}`;
            console.time(msg);
            await processBlocksWithRetry(api, batch);
            console.timeEnd(msg);

            if (BATCH_DELAY_MS > 0) {
                await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
            }
        }
    }
}

async function catchUpAndIndexLive(api) {
    let lastProcessedBlockNumber = await getLastProcessedBlockNumber();
    let firstRun = true;
    let lastCheckAtHeight = lastProcessedBlockNumber;
    await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
        const currentBlockNumber = parseInt(header.number.toString());
        if (firstRun) {
            firstRun = false;
            console.log("catching up with chain");
            await catchUpWithChain(
                api,
                Math.max(
                    lastProcessedBlockNumber - NUM_CONCURRENT_JOBS * 5,
                    START_BLOCK
                ),
                currentBlockNumber - 1
            );
        }

        console.log(`Chain is at block: #${currentBlockNumber}`);

        const start = lastProcessedBlockNumber + 1;
        const end = currentBlockNumber;
        if (start <= end) {
            const blockNumbers = Array.from(
                { length: end - start + 1 },
                (_, i) => start + i
            );
            // processBlocksWithRetry handles retries with backoff internally
            await batchProcessBlocks(api, blockNumbers);
        }

        lastProcessedBlockNumber = currentBlockNumber;

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
        const lastAuthoredBlocks = await rpcLimit(() =>
            api.query.collatorSelection.lastAuthoredBlock.entries()
        );
        return lastAuthoredBlocks.map(([key, value]) => {
            const collator = key.toHuman();
            const blockNumber = value.toNumber();
            return [collator, blockNumber];
        });
    } catch (e) {
        return [];
    }
}

function findAuthorFromCache(cachedAuthoredBlocks, blockNumber) {
    const authorEntry = cachedAuthoredBlocks.find(
        ([_, authoredBlockNumber]) => authoredBlockNumber === blockNumber
    );
    return authorEntry ? authorEntry[0][0] : null;
}

async function getBlockAuthor(api, blockNumber) {
    const lastAuthoredBlocks = await getLastAuthoredBlocks(api);
    return findAuthorFromCache(lastAuthoredBlocks, blockNumber);
}

export async function main() {
    console.log(
        `Config: NUM_CONCURRENT_JOBS=${NUM_CONCURRENT_JOBS}, MAX_RPC_CONCURRENCY=${MAX_RPC_CONCURRENCY}, BATCH_DELAY_MS=${BATCH_DELAY_MS}`
    );

    const wsProvider = new WsProvider(RPC_NODE);
    const api = await ApiPromise.create({
        provider: wsProvider,
    });

    console.log("Finding unprocessed blocks and process...");
    await findAllUnprocessedBlockNumbers(api, batchProcessBlocks);

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
