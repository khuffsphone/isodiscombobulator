#!/usr/bin/env node
import { run } from './index.js';

const code = await run(process.argv.slice(2));
process.exit(code);
