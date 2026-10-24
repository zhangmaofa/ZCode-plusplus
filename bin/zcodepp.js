#!/usr/bin/env node
'use strict';
require('../src/cli/main.js')
  .run(process.argv)
  .catch((e) => {
    console.error('error: ' + ((e && e.message) || e));
    process.exit(1);
  });
