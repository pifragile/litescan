## setup
create `.env` file with 

```
DB_URL=<mongo_connection_string>
ENCOINTER_RPC=<rpc url>
NUM_CONCURRENT_JOBS=<num concurrent blocks indexed> # 100 is safe on the smallest Digital Ocean droplet, on my MB Pro M3 MAx, 64Gb Ram, I can do up to 5000.
START_BLOCK=<num concurrent blocks indexed>
DB_NAME=<name of the database>
RPC_NODE=<rpc node url>
```

## run

`npm install` 

`node index.js` 

