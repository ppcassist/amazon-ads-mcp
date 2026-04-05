#!/usr/bin/env node

const { TokenManager } = require("./lib/auth");
const { McpProxy } = require("./lib/proxy");

const log = (msg) => process.stderr.write(`[amazon-ads-mcp] ${msg}\n`);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log(`ERROR: Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const clientId = requireEnv("CLIENT_ID");
  const clientSecret = requireEnv("CLIENT_SECRET");
  const refreshToken = requireEnv("REFRESH_TOKEN");
  const profileId = requireEnv("PROFILE_ID");
  const region = requireEnv("REGION");

  // Initialize OAuth token manager
  const tokenManager = new TokenManager({ clientId, clientSecret, refreshToken });
  try {
    await tokenManager.init();
  } catch (err) {
    log(`Failed to obtain access token: ${err.message}`);
    process.exit(1);
  }

  // Initialize MCP proxy
  const proxy = new McpProxy({ tokenManager, clientId, profileId, region });

  log(`Started (region=${region})`);

  // Read JSON-RPC messages from stdin (newline-delimited)
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    // Process all complete lines in the buffer
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch (err) {
        log(`Failed to parse JSON-RPC message: ${err.message}`);
        continue;
      }

      handleRequest(proxy, request);
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed, shutting down");
    tokenManager.destroy();
    process.exit(0);
  });
}

async function handleRequest(proxy, request) {
  const { id, method } = request;

  try {
    const result = await proxy.forward(request);

    if (result.type === "stream") {
      // SSE stream: buffer chunks, extract JSON from "data: ..." lines,
      // and write as newline-delimited JSON-RPC for Claude Desktop
      let sseBuf = "";
      result.stream.setEncoding("utf8");

      result.stream.on("data", (chunk) => {
        sseBuf += chunk;
        let lineEnd;
        while ((lineEnd = sseBuf.indexOf("\n")) !== -1) {
          const line = sseBuf.slice(0, lineEnd).trim();
          sseBuf = sseBuf.slice(lineEnd + 1);
          if (line.startsWith("data: ")) {
            const json = line.slice(6);
            if (json) {
              process.stdout.write(json + "\n");
            }
          }
        }
      });

      result.stream.on("end", () => {
        // Flush any remaining data in buffer
        const remaining = sseBuf.trim();
        if (remaining.startsWith("data: ")) {
          const json = remaining.slice(6);
          if (json) {
            process.stdout.write(json + "\n");
          }
        }
      });

      result.stream.on("error", (err) => {
        log(`SSE stream error (id=${id}): ${err.message}`);
        writeJsonRpc({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `Stream error: ${err.message}` },
        });
      });
    } else if (result.type === "json") {
      writeJsonRpc(result.data);
    } else {
      // Raw / unexpected response
      log(`Unexpected response (status=${result.statusCode}): ${result.data}`);
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: `Upstream error (HTTP ${result.statusCode})`,
        },
      });
    }
  } catch (err) {
    log(`Proxy error (method=${method}, id=${id}): ${err.message}`);
    writeJsonRpc({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err.message },
    });
  }
}

function writeJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
