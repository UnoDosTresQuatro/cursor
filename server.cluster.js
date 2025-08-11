"use strict";

const cluster = require("cluster");
const os = require("os");

const isPrimary = cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;
const numWorkers = Number(process.env.WEB_CONCURRENCY) || os.cpus().length;

if (isPrimary) {
  const shuttingDown = { value: false };
  console.log(`Primary ${process.pid} starting ${numWorkers} workers`);

  for (let i = 0; i < numWorkers; i += 1) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.warn(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal})`);
    if (!shuttingDown.value) {
      console.log("Spawning a new worker...");
      cluster.fork();
    }
  });

  const graceful = (signal) => {
    console.log(`Primary received ${signal}. Stopping workers...`);
    shuttingDown.value = true;
    for (const id in cluster.workers) {
      const w = cluster.workers[id];
      if (w && w.isConnected()) {
        w.process.kill("SIGTERM");
      }
    }
    // Give workers a moment to exit cleanly
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", () => graceful("SIGINT"));
  process.on("SIGTERM", () => graceful("SIGTERM"));
} else {
  require("./server");
}