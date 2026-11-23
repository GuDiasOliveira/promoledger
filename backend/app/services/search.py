def contains_pattern(term: str) -> str:
    """ILIKE "contains" pattern with LIKE wildcards escaped (use with escape="\\\\")."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
