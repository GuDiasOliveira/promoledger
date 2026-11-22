"""RFC 7807 Problem Details error handling (see docs/api.md §1.5)."""

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_TYPE_BASE = "https://api.promoledger.org/errors/"
PROBLEM_MEDIA_TYPE = "application/problem+json"

_DEFAULT_CODES = {
    400: "BAD_REQUEST",
    401: "NOT_AUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    500: "INTERNAL_SERVER_ERROR",
}


class AppError(Exception):
    """Domain/application error rendered as an RFC 7807 problem response."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str,
        *,
        title: str | None = None,
        errors: list[dict[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.title = title or HTTPStatus(status_code).phrase
        self.errors = errors or []
        self.headers = headers


def problem_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    detail: str,
    title: str | None = None,
    errors: list[dict[str, Any]] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body = {
        "type": PROBLEM_TYPE_BASE + code.lower().replace("_", "-"),
        "title": title or HTTPStatus(status_code).phrase,
        "status": status_code,
        "code": code,
        "detail": detail,
        "instance": request.url.path,
        "errors": errors or [],
    }
    return JSONResponse(
        body, status_code=status_code, headers=headers, media_type=PROBLEM_MEDIA_TYPE
    )


async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return problem_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        detail=exc.detail,
        title=exc.title,
        errors=exc.errors,
        headers=exc.headers,
    )


async def _http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return problem_response(
        request,
        status_code=exc.status_code,
        code=_DEFAULT_CODES.get(exc.status_code, "HTTP_ERROR"),
        detail=str(exc.detail),
        headers=getattr(exc, "headers", None),
    )


async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = [
        {"loc": list(err.get("loc", ())), "msg": err.get("msg", ""), "type": err.get("type", "")}
        for err in exc.errors()
    ]
    return problem_response(
        request,
        status_code=422,
        code="VALIDATION_ERROR",
        detail="Request payload failed validation.",
        errors=errors,
    )


async def _unhandled_exception_handler(request: Request, _: Exception) -> JSONResponse:
    return problem_response(
        request,
        status_code=500,
        code="INTERNAL_SERVER_ERROR",
        detail="An unexpected error occurred.",
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
