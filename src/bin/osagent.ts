#!/usr/bin/env node
import "zod/compile";
import { main } from "../cli.js";

process.exitCode = await main();
