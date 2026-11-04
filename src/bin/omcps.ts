#!/usr/bin/env node
import "zod/compile";
import { main } from "../mcpServer.js";

process.exitCode = await main();
