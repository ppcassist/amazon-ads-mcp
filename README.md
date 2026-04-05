# @ppcassist/amazon-ads-mcp

Local MCP proxy for the Amazon Ads API. Sits between Claude Desktop and Amazon's official Advertising MCP server, handling OAuth authentication and token refresh automatically.

## How it works

1. On startup, exchanges your refresh token for an access token via Amazon OAuth
2. Auto-refreshes the token every 50 minutes
3. Proxies all MCP requests from Claude Desktop to the Amazon Ads MCP server
4. Injects required authentication headers on every request
5. Streams SSE responses back to Claude without buffering

## Prerequisites

You need Amazon Ads API credentials:

- **CLIENT_ID** - Your Amazon Ads API client ID (Login with Amazon)
- **CLIENT_SECRET** - Your Amazon Ads API client secret
- **REFRESH_TOKEN** - OAuth refresh token for your Amazon Ads account
- **PROFILE_ID** - Your Amazon Advertising profile ID
- **REGION** - One of `EU`, `NA`, or `FE`

## Setup with Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "amazon-ads": {
      "command": "npx",
      "args": ["-y", "@ppcassist/amazon-ads-mcp"],
      "env": {
        "CLIENT_ID": "amzn1.application-oa2-client.xxxxx",
        "CLIENT_SECRET": "your-client-secret",
        "REFRESH_TOKEN": "Atzr|your-refresh-token",
        "PROFILE_ID": "your-profile-id",
        "REGION": "EU"
      }
    }
  }
}
```

## Supported regions

| Region | Endpoint |
|--------|----------|
| NA | `https://advertising-ai.amazon.com/mcp` |
| EU | `https://advertising-ai-eu.amazon.com/mcp` |
| FE | `https://advertising-ai-fe.amazon.com/mcp` |

## How it proxies

All MCP JSON-RPC messages (`initialize`, `tools/list`, `tools/call`, etc.) are forwarded to Amazon's MCP server with these headers injected:

- `Authorization: Bearer <access_token>`
- `Amazon-Ads-ClientId: <CLIENT_ID>`
- `Amazon-Advertising-API-Scope: <PROFILE_ID>`
- `Amazon-Ads-AI-Account-Selection-Mode: FIXED`
- `Accept: application/json, text/event-stream`

Responses (including SSE streams) are forwarded back to Claude as-is.

## License

MIT
