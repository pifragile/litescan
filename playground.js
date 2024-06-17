import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";

import {RPC_NODE, db, findUnprocessedBlockNumbers, getLastProcessedBlockNumber} from "./lib.js"
import * as dotenv from "dotenv";
dotenv.config();

export async function findUnprocessedBlockNumbers2(
    blockNumber,
    endBlockNumber
) {
    console.time('find all missing blocks')
    const blocks = db.collection("blocks");
    let unprocessedBlockNumbers = (await (
        await blocks.aggregate([
            {
                $group: {
                    _id: null,
                    nums: { $push: "$height" },
                },
            },
            {
                $project: {
                    _id: 0,
                    missing_numbers: {
                        $setDifference: [
                            { $range: [blockNumber, endBlockNumber + 1] },
                            "$nums",
                        ],
                    },
                },
            },
        ])
    ).toArray())[0].missing_numbers;

    // for 5m documents, it takes about 2mins
    console.timeEnd('find all missing blocks')
    return unprocessedBlockNumbers;
}
async function main() {
    const wsProvider = new WsProvider(RPC_NODE);
    // Create our API with a default connection to the local node
    let api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });


    let lastProcessedBlockNumber = await getLastProcessedBlockNumber()
    let firstProcessedBlockNumber = (await db.collection("blocks").findOne({}, { sort: { height: 1 } })).height;
    let unprocessedBlockNumbers = await findUnprocessedBlockNumbers2(firstProcessedBlockNumber, lastProcessedBlockNumber)

    //unprocessedBlockNumbers = await findUnprocessedBlockNumbers(508439, lastProcessedBlockNumber)

    console.log(unprocessedBlockNumbers)




    // await parseUnprocessedBlocks(api, lastProcessedBlockNumber - 14400, lastProcessedBlockNumber)

}


main().catch(console.error);
