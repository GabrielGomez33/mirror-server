// db.ts - Database connection pool configuration
// UPDATED: Increased connection pool size, added timeout and queue configuration
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()

export const DB = mysql.createPool({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	waitForConnections: true,
	connectionLimit: parseInt(process.env.DB_POOL_SIZE || '30', 10),
	queueLimit: 100, // Max queued connection requests before rejecting (0 = unlimited)
	connectTimeout: 10000, // 10s connection timeout
	enableKeepAlive: true,
	keepAliveInitialDelay: 30000, // 30s keepalive
	maxIdle: 10, // Keep 10 idle connections in pool
	idleTimeout: 60000, // Close idle connections after 60s
})
