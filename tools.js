import * as dotenv from "dotenv";
import { db } from "./lib.js";
dotenv.config();

async function main() {
    const events = await (await db.collection("events").find({})).toArray();

    const updateEvent = async (event) => {
        const block = await db
            .collection("blocks")
            .findOne({ _id: event.blockHash });
        await db
            .collection("events")
            .updateOne(
                { _id: event._id },
                { $set: { timestamp: block.timestamp } }
            );
    };

    const chunkSize = 5000;
    for (let i = 0; i < events.length; i += chunkSize) {
        console.log(i);
        const chunk = events.slice(i, i + chunkSize);
        await Promise.all(chunk.map((event) => updateEvent(event)));
    }

    console.log('events done')

    const extrinsics = await (await db.collection("extrinsics").find({})).toArray();

    const updateExtrinsic = async (extrinsic) => {
        const block = await db
            .collection("blocks")
            .findOne({ _id: extrinsic.blockHash });
        await db
            .collection("extrinsics")
            .updateOne(
                { _id: extrinsic._id },
                { $set: { timestamp: block.timestamp } }
            );
    };

    for (let i = 0; i < extrinsics.length; i += chunkSize) {
        console.log(i);
        const chunk = extrinsics.slice(i, i + chunkSize);
        await Promise.all(chunk.map((extrinsic) => updateExtrinsic(extrinsic)));
    }
    console.log('done')
}

main().catch(console.error);
