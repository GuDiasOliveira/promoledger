"""Exact monetary types (CLAUDE.md §2, docs/api.md §1.2).

- `MoneyIn`: request fields. Accepts ONLY JSON strings like "19.9" / "19.90". JSON numbers
  are rejected, because they may already have lost precision as binary floats.
- `MoneyOut`: response fields. Always serialized as a string with exactly 2 decimals.
"""

import re
from decimal import Decimal
from typing import Annotated

from pydantic import AfterValidator, BeforeValidator, PlainSerializer, WithJsonSchema

CENT = Decimal("0.01")
MONEY_PATTERN = r"^\d{1,8}(\.\d{1,2})?$"  # fits NUMERIC(10, 2)
_MONEY_RE = re.compile(MONEY_PATTERN)


def _parse_money(value: object) -> Decimal:
    if not isinstance(value, str):
        raise ValueError('Monetary values must be JSON strings, e.g. "19.90"')
    if not _MONEY_RE.fullmatch(value):
        raise ValueError("Invalid monetary amount: up to 8 integer digits and 2 decimal places")
    return Decimal(value).quantize(CENT)


def _positive(value: Decimal) -> Decimal:
    if value <= 0:
        raise ValueError("Monetary amount must be greater than 0.00")
    return value


def format_money(value: Decimal) -> str:
    return str(value.quantize(CENT))


_STRING_SCHEMA = {"type": "string", "pattern": MONEY_PATTERN, "examples": ["19.90"]}

MoneyIn = Annotated[Decimal, BeforeValidator(_parse_money), WithJsonSchema(_STRING_SCHEMA)]
PositiveMoneyIn = Annotated[MoneyIn, AfterValidator(_positive)]
MoneyOut = Annotated[
    Decimal,
    PlainSerializer(format_money, return_type=str),
    WithJsonSchema({"type": "string", "examples": ["19.90"]}),
]
