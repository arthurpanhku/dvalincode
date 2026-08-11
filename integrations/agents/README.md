# Coding-agent security gate

Copy [`dvalin-security.md`](dvalin-security.md) into the instruction mechanism
used by your coding agent (for example an `AGENTS.md`, custom-agent body, rule,
or repository instruction file). Configure the generic MCP server from
[`../mcp/dvalin.mcp.json`](../mcp/dvalin.mcp.json), adapting the surrounding
configuration key to your client.

The instructions deliberately keep implementation and verification separate:
the coding agent may change code, but only Dvalin's structured gate result can
declare that the security verification passed.
