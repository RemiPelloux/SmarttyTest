"""Text helpers."""


def slug(s: str) -> str:
    return "-".join(s.lower().split())


def title(s: str) -> str:
    return s.title()
