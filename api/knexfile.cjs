require('dotenv').config();

/** @type {import('knex').Knex.Config} */
module.exports = {
  client: 'mysql2',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 5 },
  migrations: {
    directory: './src/infra/migrations',
    tableName: 'knex_migrations',
  },
};
