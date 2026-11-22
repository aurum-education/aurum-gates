#!/usr/bin/env node
import { cli } from '../src/cli.mjs';

await cli(process.argv.slice(2));
