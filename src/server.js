import http from 'node:http';
import dotenv from 'dotenv';
import app from './app.js';
import { pool } from './db/pool.js';
import { closeSocketGateway, initSocketGateway } from './realtime/socketGateway.js';
import { initScheduler, stopScheduler } from './jobs/scheduler.js';

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const httpServer = http.createServer(app);

// Initialize Socket.io real-time gateway on /realtime namespace
initSocketGateway(httpServer);

let isShuttingDown = false;

async function startServer() {
  try {
    // Verify PostgreSQL connectivity at startup
    const { rows } = await pool.query('SELECT current_database() AS db, now() AS time');
    console.log(
      `[Server] Connected to PostgreSQL database '${rows[0].db}' at ${new Date(rows[0].time).toISOString()}`
    );

    httpServer.listen(PORT, HOST, () => {
      console.log(`[Server] TeethLink Backend listening on http://${HOST}:${PORT}`);
      console.log(`[Server] REST API Base URL: http://${HOST}:${PORT}/api/v1`);
      console.log(`[Server] Socket.io Namespace: ws://${HOST}:${PORT}/realtime`);
      initScheduler();
    });
  } catch (err) {
    console.error('[Server] Fatal startup error while connecting to PostgreSQL:', err);
    process.exit(1);
  }
}

/**
 * Gracefully drains active HTTP connections, closes Socket.io clients,
 * and releases the PostgreSQL connection pool.
 *
 * @param {string} signal
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10000);

  if (typeof forceExitTimer.unref === 'function') {
    forceExitTimer.unref();
  }

  try {
    await new Promise((resolve) => {
      httpServer.close(() => {
        console.log('[Server] HTTP server closed.');
        resolve();
      });
    });

    stopScheduler();
    console.log('[Server] Background cron scheduler stopped.');

    await closeSocketGateway();
    console.log('[Server] Socket.io gateway closed.');

    await pool.end();
    console.log('[Server] PostgreSQL connection pool closed.');

    process.exit(0);
  } catch (err) {
    console.error('[Server] Error during graceful shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

startServer();

export { httpServer };
