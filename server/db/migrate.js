#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { getPool } = require('./pool');
const { migrate } = require('./schema');

(async () => {
  try {
    await migrate(getPool());
    console.log('[migrate] done');
    process.exit(0);
  } catch (e) {
    console.error('[migrate] failed', e);
    process.exit(1);
  }
})();
