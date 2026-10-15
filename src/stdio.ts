#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWisdomForgeServer } from "./server.js";

const server = createWisdomForgeServer();
const transport = new StdioServerTransport();
await server.connect(transport);
