from .text import slug


def build(name: str) -> dict:
    return {"name": name, "slug": slug(name)}
