#!/usr/bin/env node
import { main } from "../mcpServer.js";

process.exitCode = await main();
