import { MongoClient } from "mongodb";

const dbClient = new MongoClient("mongodb://root:example@localhost:27017/", {});
const indexer = dbClient.db("indexer");
const extrinsics = indexer.collection("extrinsics");
const query = { method: "transferAllowDeath", section: "balances" };
const result = await extrinsics.find(query, { limit: 3 });
console.log(await result.toArray());
