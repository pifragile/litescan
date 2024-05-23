import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";

import bs58 from "bs58";
import { parseEncointerBalance } from "@encointer/types";

import util from "util";
import BN from "bn.js";
import { parse } from "path";

export const ENCOINTER_RPC =
    process.env.ENCOINTER_RPC || "wss://kusama.api.encointer.org";

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
    return;
    console.log(
        util.inspect(obj, { showHidden: false, depth: null, colors: true })
    );
};

async function parseBlock(blockNumber, api = null) {
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
        hash: blockHash.toHuman(),
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
    signedBlock.block.extrinsics.forEach((ex, index) => {
        // the extrinsics are decoded by the API, human-like view

        let extrinsic = ex.toHuman();
        extrinsic.success = false;
        extrinsic.blockNumber = blockNumber;
        extrinsic.blockHash = blockHash.toHuman();
        extrinsic.id = `${blockNumber}-${index}`;

        //delete extrinsic.method
        Object.keys(extrinsic.method.args).forEach(function (key, index) {
            extrinsic.method.args[key] = mapTypes(extrinsic.method.args[key]);
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
                    phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index)
            )
            .map((e) => e.toHuman());

        events.forEach((e, index) => {
            if (Array.isArray(e)) {
                e.event.data = e.event.data.map(mapTypes);
            } else if (typeof e === "object") {
                Object.keys(e.event.data).forEach(function (key, index) {
                    e.event.data[key] = mapTypes(e.event.data[key]);
                });
            }
            e.event.blockNumber = blockNumber;
            e.event.blockHash = blockHash.toHuman();
            e.event.id = `${blockNumber}-${index}`;
            e.event.extrinsicId = extrinsic.id;
            delete e.event.index;
        });

        print(block);
        events.forEach((e) => {
            if (e.event.method === "ExtrinsicSuccess") {
                extrinsic.success = true;
                return;
            }
            print(e.event);
        });

        extrinsic = { ...extrinsic, ...extrinsic.method };

        print(extrinsic);
        console.log(blockNumber)
    });
}
async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });
    for (let i = 508439; i < 508449; i++) {
        parseBlock(i, api);
    }
}

main().catch(console.error);
