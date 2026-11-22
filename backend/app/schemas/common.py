from typing import Annotated

from pydantic import AfterValidator, EmailStr, Field, StringConstraints

NonBlankName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
]
NormalizedEmail = Annotated[EmailStr, Field(max_length=255), AfterValidator(str.lower)]
