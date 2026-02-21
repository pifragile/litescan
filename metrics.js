import { createServer } from "node:http";

const gauges = {};
const counters = {};

export function gauge(name, help) {
    gauges[name] = { help, value: 0 };
    return {
        set(v) { gauges[name].value = v; },
        get() { return gauges[name].value; },
    };
}

export function counter(name, help) {
    counters[name] = { help, value: 0 };
    return {
        inc(n = 1) { counters[name].value += n; },
    };
}

function renderMetrics() {
    const lines = [];
    for (const [name, { help, value }] of Object.entries(gauges)) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name} ${value}`);
    }
    for (const [name, { help, value }] of Object.entries(counters)) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${value}`);
    }
    return lines.join("\n") + "\n";
}

export function startMetricsServer(port = 9615) {
    const server = createServer((req, res) => {
        if (req.url === "/metrics") {
            res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
            res.end(renderMetrics());
        } else {
            res.writeHead(404);
            res.end("Not found\n");
        }
    });
    server.listen(port, () => {
        console.log(`Prometheus metrics at http://0.0.0.0:${port}/metrics`);
    });
    return server;
}
