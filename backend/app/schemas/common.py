from typing import Annotated

from pydantic import AfterValidator, BaseModel, EmailStr, Field, StringConstraints

NonBlankName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
]
NormalizedEmail = Annotated[EmailStr, Field(max_length=255), AfterValidator(str.lower)]


def _blank_to_none(value: str | None) -> str | None:
    return value or None


# Optional free text: whitespace-stripped; empty string is stored as NULL.
OptionalText = Annotated[
    str | None,
    StringConstraints(strip_whitespace=True, max_length=2000),
    AfterValidator(_blank_to_none),
]
OptionalShortText = Annotated[
    str | None,
    StringConstraints(strip_whitespace=True, max_length=255),
    AfterValidator(_blank_to_none),
]


def reject_explicit_nulls(model: BaseModel, *, nullable: frozenset[str] = frozenset()) -> None:
    """PATCH semantics: omitted = unchanged; explicit `null` only allowed for `nullable` fields."""
    nulls = [name for name in model.model_fields_set - nullable if getattr(model, name) is None]
    if nulls:
        raise ValueError(f"Fields cannot be null: {', '.join(sorted(nulls))}")
