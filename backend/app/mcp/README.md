# PromoLedger MCP server (read-only)

Lets AI assistants (Claude Desktop, Claude Code, any MCP client) read promotion health,
seller rankings, divergence alerts and sales velocity. It **cannot change anything**:
it only calls GET endpoints, and its token is refused by the API for any write.

## 1. Create a token

In the app: **Your promotions → API tokens → Create token**. Copy it immediately
(it starts with `pl_` and is shown only once). Revoke it there at any time.

The token sees exactly what your account sees (your roles in each promotion).

## 2. Configure your client

Replace `/ABSOLUTE/PATH/TO/promoledger/backend` and the token.

**Claude Code**

```bash
claude mcp add promoledger \
  -e PROMOLEDGER_API_URL=http://localhost:8000 \
  -e PROMOLEDGER_TOKEN=pl_your_token \
  -- uv run --directory /ABSOLUTE/PATH/TO/promoledger/backend python -m app.mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "promoledger": {
      "command": "uv",
      "args": ["run", "--directory", "/ABSOLUTE/PATH/TO/promoledger/backend", "python", "-m", "app.mcp"],
      "env": {
        "PROMOLEDGER_API_URL": "http://localhost:8000",
        "PROMOLEDGER_TOKEN": "pl_your_token"
      }
    }
  }
}
```

## Tools

| Tool | Returns | Role needed |
|---|---|---|
| `list_promotions()` | Your promotions, currency, dates, your roles | any member |
| `promotion_health(promotion_id)` | Revenue, collected, outstanding, collection rate, units, divergences, sales window, days to delivery | admin or viewer |
| `seller_ranking(promotion_id, limit=10)` | Sellers by gross revenue, settlement % | admin or viewer |
| `divergence_alerts(promotion_id)` | Delivered-but-unpaid orders (id, short ref, seller, amount, days outstanding) | admin or viewer |
| `sales_velocity(promotion_id, days=7)` | Orders and revenue per day (UTC), cancelled excluded | any member (sellers: own orders) |

Amounts are exact decimal strings in the promotion's currency.

**Privacy:** customer names and contacts are never returned — the data goes to a
third-party AI provider, and customers have not consented to that.
