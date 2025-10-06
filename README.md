![Logo](https://pigu.ch/litescan/litescan_small.png)
# LiteScan - A Lightweight Indexer for Polkadot Chains

## Overview

This is an easy to setup, lightweight indexer for Polkadot chains. It uses MongoDB to store data of blocks, extrinsics and events.

If you quickly need to retrieve and store data of Polkadot or one of its parachains, this indexer is for you.


Example of the data indexed for an extrinsic:

```
{
    _id: '21000002-2',
    isSigned: true,
    method: 'transferAllowDeath',
    assetId: null,
    era: {
        MortalEra: {
            period: '64',
            phase: '62'
        }
    },
    metadataHash: null,
    nonce: '427,799',
    signature: '0x86372deec59dc7902d5cc91684e8c6c451b861fddb4e87f004886aef937b9151eb9c04c90ce9005fa9737ab3aa5c153fe67edcaf77ee2d0df0a7d53a0f54e880',
    signer: {
        Id: '12xtAYsRUrmbniiWQqJtECiBQrMn8AypQcXhnQAc6RB6XkLW'
    },
    tip: '0',
    success: true,
    blockNumber: 21000002,
    blockHash: '0xd79b7267d5908bfe65968bc26d76fc01561caf99c4d81ed4db2e8d3ca0019806',
    timestamp: 1717081314000,
    args: {
        dest: {
            Id: '12yZvHnGeQBAG3H76VaraFhjJSdr9vuCKmkkZqotGXQNeqr7'
        },
        value: '1,000,000,000,000'
    },
    section: 'balances'
}
```



## Quick Testing with Docker

We provide a `docker-compose.yml` that sets up a MongoDB instance with a web interface and runs the indexer for Polkadot starting at block 21000000.

Simply run:\
`docker-compose up --attach indexer`

Now you have the indexer up and running and you get a simple web interface to interact with the DB.

### Webapp Examples:

The Webapp will be available at `http://localhost:8081`

#### Overview

[Blocks](http://localhost:8081/db/indexer/blocks)\
[Extrinsics](http://localhost:8081/db/indexer/extrinsics)\
[Events](http://localhost:8081/db/indexer/events)

#### Detail

[Extrinsic Detail Example](http://localhost:8081/db/indexer/extrinsics/%2221000002-2%22?skip=0)\
[Event Detail Example](http://localhost:8081/db/indexer/events/%2221000001-1-38%22?skip=0)

### Queries
You can now run any [MongoDB Query](https://www.mongodb.com/docs/manual/tutorial/query-documents/) against the database.\
The webapp provides a simple form to perform queries. An example query for getting all `transferAllowDeath` extrinsics would be
```
{
    "method": "transferAllowDeath",
    "section": "balances"
}
```
You can play with the queries [here](`http://localhost:8081/db/indexer/extrinsics?query=%7B%22method%22%3A+%22transferAllowDeath%22%2C+%22section%22%3A+%22balances%22%7D&projection=`)


### Programmatic queries:
You can also easily access the the database directly from your code at `mongodb://root:example@localhost:27017/`, find an example in `example.js`. Simply run
```
npm install
node example.js
```

## Database

A mongo DB instance is required for this indexer to run.
We recommend using a hosted DB cluster on Digital Ocean or similar.
For quick testing, please use the Docker setup above, where a MongoDB instance is set up locally.

## Env Variables

The following environment variables are required:

| Variable    | Description |
| -------- | ------- |
| DB_URL  | Mongo connection string    |
| DB_USE_SSL  | Bool indicating wether DB connection should use SSL. Set to true for prod.    |
| DB_NAME    | Database name    |
| RPC_NODE | RPC node url     |
| DEBUG | if true, enables debug mode and does not connect to db but just prints objects to be inserted to console.     |
| START_BLOCK | Block number from which to start indexing     |
| NUM_CONCURRENT_JOBS    | Number of concurrent blocks indexed (100 is safe on the smallest Digital Ocean droplet, on my MB Pro M3 MAX, 64Gb Ram, I can do up to 5000 (given that the RPC node does not have a rate limit))    |

## Run

```
npm install
node index.js
```
